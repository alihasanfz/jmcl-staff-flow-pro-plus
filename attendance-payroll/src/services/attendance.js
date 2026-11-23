'use strict';
const bcrypt = require('bcryptjs');
const { query, tx } = require('../db');
const { getSettings } = require('./settings');
const { computeDay } = require('../logic/attendanceRules');
const { addDays, eachDay, todayIn, nowMinIn, dow, monthRange, isDate, isMonth } = require('../utils/time');

const CHUNK = 2000;

/**
 * Recompute attendance rows for [from, to] (inclusive, local dates) for all active employees (or one).
 * Raw punches are the source of truth; attendance rows are a derived, rebuildable cache.
 * Returns the number of rows written.
 */
async function rebuildRange(from, to, { userId = null } = {}) {
  const settings = await getSettings();
  const tz = settings.timezone;
  const today = todayIn(tz);
  const nowMin = nowMinIn(tz);
  const last = to < today ? to : today;
  if (from > last) return 0;

  const [users, shiftsRes, holidaysRes, leavesRes, punchesRes, offDaysRes] = await Promise.all([
    query(`SELECT id, join_date::text AS join_date, COALESCE(shift_id, (SELECT id FROM shifts ORDER BY id LIMIT 1)) AS shift_id,
                  COALESCE(overtime_eligible, true) AS overtime_eligible
             FROM users
            WHERE active AND ($1::int IS NULL OR id = $1)`, [userId]),
    query(`SELECT id, start_time::text AS start_time, end_time::text AS end_time, break_minutes, grace_minutes,
                  early_out_grace_minutes, overtime_after_minutes, weekly_off,
                  COALESCE(allow_overtime, true) AS allow_overtime FROM shifts`),
    query(`SELECT date::text AS date FROM holidays WHERE date BETWEEN $1 AND $2`, [from, last]),
    query(`SELECT lr.user_id, lr.start_date::text AS s, lr.end_date::text AS e, lt.paid
             FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
            WHERE lr.status = 'approved' AND lr.start_date <= $2 AND lr.end_date >= $1
              AND ($3::int IS NULL OR lr.user_id = $3)`, [from, last, userId]),
    query(`SELECT user_id,
                  to_char(punched_at AT TIME ZONE $1, 'YYYY-MM-DD') AS d,
                  to_char(punched_at AT TIME ZONE $1, 'HH24:MI:SS') AS t,
                  punched_at AS at,
                  device_sn,
                  COALESCE(state, 0) AS state
             FROM punch_logs
            WHERE user_id IS NOT NULL
              AND punched_at >= ($2::date::timestamp AT TIME ZONE $1)
              AND punched_at <  (($3::date + 1)::timestamp AT TIME ZONE $1)
              AND ($4::int IS NULL OR user_id = $4)
              AND UPPER(TRIM(COALESCE(device_sn, ''))) NOT IN ('VDE2251500160')
              AND NOT EXISTS (
                SELECT 1 FROM devices d
                 WHERE (d.id = punch_logs.device_id OR UPPER(TRIM(d.serial_number)) = UPPER(TRIM(punch_logs.device_sn)))
                   AND (UPPER(TRIM(d.serial_number)) = 'VDE2251500160' OR LOWER(d.model) LIKE '%gate%' OR LOWER(d.name) LIKE '%gate%')
              )
            ORDER BY punched_at`, [tz, from, last, userId]),
    query(`SELECT user_id, date::text AS date FROM off_day_assignments WHERE date BETWEEN $1 AND $2 AND ($3::int IS NULL OR user_id = $3)`, [from, last, userId]).catch(() => ({ rows: [] })),
  ]);

  const shifts = new Map(shiftsRes.rows.map((s) => [s.id, s]));
  const holidays = new Set(holidaysRes.rows.map((h) => h.date));
  const userOffDays = new Set((offDaysRes?.rows || []).map((o) => `${o.user_id}|${o.date}`));
  const leavesByUser = new Map();
  for (const l of leavesRes.rows) {
    if (!leavesByUser.has(l.user_id)) leavesByUser.set(l.user_id, []);
    leavesByUser.get(l.user_id).push(l);
  }
  const punchMap = new Map();
  for (const p of punchesRes.rows) {
    const k = `${p.user_id}|${p.d}`;
    if (!punchMap.has(k)) punchMap.set(k, []);
    punchMap.get(k).push({ t: p.t, at: p.at, device_sn: p.device_sn, state: Number(p.state) });
  }

  const upserts = [];
  const deletes = [];
  for (const u of users.rows) {
    const shift = shifts.get(u.shift_id);
    const leaves = leavesByUser.get(u.id) || [];
    for (const date of eachDay(from, last)) {
      const leave = leaves.find((l) => l.s <= date && l.e >= date) || null;
      const dayPunches = punchMap.get(`${u.id}|${date}`) || [];
      const isCustomOffDay = userOffDays.has(`${u.id}|${date}`);
      const row = computeDay({
        date, today, nowMin, user: u, shift, holiday: holidays.has(date), leave,
        punches: dayPunches, rules: settings.attendance, isCustomOffDay,
      });
      if (row) {
        const inDev = dayPunches[0]?.device_sn || null;
        const outDev = dayPunches.length >= 2 ? dayPunches[dayPunches.length - 1]?.device_sn : null;
        upserts.push({
          user_id: u.id,
          work_date: date,
          ...row,
          device_sn: inDev || outDev || null,
          check_in_device_sn: inDev,
          check_out_device_sn: outDev,
        });
      } else {
        deletes.push({ user_id: u.id, work_date: date });
      }
    }
  }

  await tx(async (db) => {
    for (let i = 0; i < upserts.length; i += CHUNK) {
      const c = upserts.slice(i, i + CHUNK);
      await db.query(
        `INSERT INTO attendance (user_id, work_date, shift_id, check_in, check_out, punch_count, worked_minutes,
                                 late_minutes, early_out_minutes, overtime_minutes, status, missing_checkout, off_day_work,
                                 device_sn, check_in_device_sn, check_out_device_sn, updated_at)
         SELECT x.*, now() FROM unnest($1::int[], $2::date[], $3::int[], $4::timestamptz[], $5::timestamptz[], $6::int[],
                                       $7::int[], $8::int[], $9::int[], $10::int[], $11::text[], $12::bool[], $13::bool[],
                                       $14::text[], $15::text[], $16::text[])
              AS x(user_id, work_date, shift_id, check_in, check_out, punch_count, worked_minutes, late_minutes,
                   early_out_minutes, overtime_minutes, status, missing_checkout, off_day_work,
                   device_sn, check_in_device_sn, check_out_device_sn)
         ON CONFLICT (user_id, work_date) DO UPDATE SET
           shift_id = EXCLUDED.shift_id, check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out,
           punch_count = EXCLUDED.punch_count, worked_minutes = EXCLUDED.worked_minutes,
           late_minutes = EXCLUDED.late_minutes, early_out_minutes = EXCLUDED.early_out_minutes,
           overtime_minutes = EXCLUDED.overtime_minutes, status = EXCLUDED.status,
           missing_checkout = EXCLUDED.missing_checkout, off_day_work = EXCLUDED.off_day_work,
           device_sn = COALESCE(EXCLUDED.device_sn, attendance.device_sn),
           check_in_device_sn = COALESCE(EXCLUDED.check_in_device_sn, attendance.check_in_device_sn),
           check_out_device_sn = COALESCE(EXCLUDED.check_out_device_sn, attendance.check_out_device_sn),
           updated_at = now()`,
        [
          c.map((r) => r.user_id), c.map((r) => r.work_date), c.map((r) => r.shift_id), c.map((r) => r.check_in),
          c.map((r) => r.check_out), c.map((r) => r.punch_count), c.map((r) => r.worked_minutes),
          c.map((r) => r.late_minutes), c.map((r) => r.early_out_minutes), c.map((r) => r.overtime_minutes),
          c.map((r) => r.status), c.map((r) => r.missing_checkout), c.map((r) => r.off_day_work),
          c.map((r) => r.device_sn), c.map((r) => r.check_in_device_sn), c.map((r) => r.check_out_device_sn),
        ],
      );
    }
    for (let i = 0; i < deletes.length; i += CHUNK) {
      const c = deletes.slice(i, i + CHUNK);
      await db.query(
        `DELETE FROM attendance a USING unnest($1::int[], $2::date[]) AS x(user_id, d)
          WHERE a.user_id = x.user_id AND a.work_date = x.d`,
        [c.map((r) => r.user_id), c.map((r) => r.work_date)],
      );
    }
  });
  return upserts.length;
}

/**
 * Insert raw punches (idempotent on device + pin + time), resolve users by device PIN,
 * and recompute the affected days. `records` items: { pin, local: 'YYYY-MM-DD HH:MM:SS', state, verify, workcode }.
 */
async function ingestPunches({ device, records, source = 'device' }) {
  const settings = await getSettings();
  const tz = settings.timezone;
  let inserted = 0;
  let unknownPins = new Set();
  const touched = new Map(); // `${userId}|${date}` -> {userId, date}
  const insertedPunches = [];

  for (const r of records) {
    const res = await query(
      `INSERT INTO punch_logs (device_id, device_sn, pin, user_id, punched_at, state, verify, workcode, source)
       SELECT $1, $2, $3, u.id, ($4::timestamp AT TIME ZONE $5), $6, $7, $8, $9
         FROM (SELECT 1) s LEFT JOIN users u ON (u.device_pin = $3 OR u.employee_code = $3)
       ON CONFLICT (device_sn, pin, punched_at) DO NOTHING
       RETURNING user_id`,
      [device.id, device.serial_number, r.pin, r.local, tz, r.state, r.verify, r.workcode, source],
    );
    if (!res.rows.length) continue;           // duplicate
    inserted++;
    let uid = res.rows[0].user_id;

    insertedPunches.push({
      userId: uid,
      pin: r.pin,
      local: r.local,
      state: r.state,
      verify: r.verify,
    });

    if (uid) touched.set(`${uid}|${r.local.slice(0, 10)}`, { userId: uid, date: r.local.slice(0, 10) });
    else unknownPins.add(r.pin);
  }

  const isGate = device && (
    String(device.serial_number || '').trim().toUpperCase() === 'VDE2251500160' ||
    (device.model && device.model.toLowerCase().includes('gate')) ||
    (device.name && device.name.toLowerCase().includes('gate'))
  );

  if (!isGate) {
    for (const { userId, date } of touched.values()) await rebuildRange(date, date, { userId });
  }
  return { inserted, duplicates: records.length - inserted, unknownPins: [...unknownPins], touched: [...touched.values()], insertedPunches };
}

/** After a user's device PIN is created/changed, attach previously unmatched punches and rebuild. */
async function backfillPin(userId, pin) {
  const settings = await getSettings();
  const { rows } = await query(
    `UPDATE punch_logs SET user_id = $1 WHERE user_id IS NULL AND pin = $2
     RETURNING to_char(punched_at AT TIME ZONE $3, 'YYYY-MM-DD') AS d`, [userId, pin, settings.timezone]);
  if (!rows.length) return 0;
  const dates = rows.map((r) => r.d).sort();
  await rebuildRange(dates[0], dates[dates.length - 1], { userId });
  return rows.length;
}

/** Filterable attendance listing (used by the API and by reports). */
async function listAttendance({ from, to, userId, department, status, deviceSn, limit = 5000 }) {
  const { timezone } = await getSettings();
  const params = [timezone, from, to];
  let where = 'a.work_date BETWEEN $2 AND $3';
  if (userId) { params.push(userId); where += ` AND a.user_id = $${params.length}`; }
  if (department) { params.push(department); where += ` AND u.department = $${params.length}`; }
  if (status && !deviceSn) { params.push(status); where += ` AND a.status = $${params.length}`; }

  if (deviceSn) {
    params.push(deviceSn);
    const snParam = `$${params.length}`;
    params.push(limit);
    const limitParam = `$${params.length}`;

    // Select punch times specifically for THIS device so device attendance is strictly evaluated:
    // If an employee did NOT punch on this device (e.g. ZK-uFace 800), their status on this machine is 'absent'!
    const { rows } = await query(
      `SELECT a.id, a.user_id, u.name, u.employee_code, u.department, u.photo, a.work_date::text AS work_date,
              (SELECT to_char(MIN(pl.punched_at) AT TIME ZONE $1, 'HH24:MI')
                 FROM punch_logs pl
                WHERE pl.user_id = a.user_id
                  AND to_char(pl.punched_at AT TIME ZONE $1, 'YYYY-MM-DD') = a.work_date::text
                  AND UPPER(pl.device_sn) = UPPER(${snParam})) AS check_in_local,
              (SELECT to_char(MAX(pl.punched_at) AT TIME ZONE $1, 'HH24:MI')
                 FROM punch_logs pl
                WHERE pl.user_id = a.user_id
                  AND to_char(pl.punched_at AT TIME ZONE $1, 'YYYY-MM-DD') = a.work_date::text
                  AND UPPER(pl.device_sn) = UPPER(${snParam})
                  AND (
                    to_char(pl.punched_at AT TIME ZONE $1, 'HH24:MI') >= '12:00'
                    OR pl.state = 1
                    OR a.off_day_work = true
                    OR EXTRACT(DOW FROM a.work_date) = 5
                  )
                  AND pl.punched_at >= (
                    SELECT MIN(pl2.punched_at) + interval '5 minutes'
                      FROM punch_logs pl2
                     WHERE pl2.user_id = a.user_id
                       AND to_char(pl2.punched_at AT TIME ZONE $1, 'YYYY-MM-DD') = a.work_date::text
                       AND UPPER(pl2.device_sn) = UPPER(${snParam})
                  )) AS check_out_local,
              (SELECT COUNT(*)::int FROM punch_logs pl
                WHERE pl.user_id = a.user_id
                  AND to_char(pl.punched_at AT TIME ZONE $1, 'YYYY-MM-DD') = a.work_date::text
                  AND UPPER(pl.device_sn) = UPPER(${snParam})) AS punch_count,
              a.worked_minutes, a.late_minutes, a.early_out_minutes, a.overtime_minutes,
              a.missing_checkout, a.off_day_work, a.status AS raw_status,
              s.name AS shift_name, s.start_time::text AS shift_start, s.grace_minutes AS shift_grace,
              COALESCE(d.name, ${snParam}) AS device_name,
              ${snParam} AS device_sn
         FROM attendance a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN shifts s ON s.id = a.shift_id
         LEFT JOIN devices d ON UPPER(d.serial_number) = UPPER(${snParam})
        WHERE ${where}
        ORDER BY (EXISTS (
          SELECT 1 FROM punch_logs pl WHERE pl.user_id = a.user_id AND to_char(pl.punched_at AT TIME ZONE $1, 'YYYY-MM-DD') = a.work_date::text AND UPPER(pl.device_sn) = UPPER(${snParam})
        )) DESC, a.work_date DESC, u.name
        LIMIT ${limitParam}`, params);

    const resultRows = rows.map((r) => {
      const hasDevicePunch = !!r.check_in_local;
      const isFriday = new Date(`${r.work_date}T00:00:00Z`).getUTCDay() === 5;
      let finalStatus = r.raw_status;
      if (!hasDevicePunch) {
        if (isFriday || ['leave', 'unpaid_leave', 'holiday', 'weekend'].includes(r.raw_status)) {
          finalStatus = r.raw_status === 'holiday' ? 'holiday' : (['leave', 'unpaid_leave'].includes(r.raw_status) ? r.raw_status : 'weekend');
        } else {
          finalStatus = 'absent';
        }
      } else {
        if (isFriday || r.off_day_work) {
          finalStatus = 'present';
        } else if (r.shift_start && r.check_in_local) {
          const [ih, im] = r.check_in_local.split(':').map(Number);
          const [sh, sm] = r.shift_start.split(':').map(Number);
          const inMin = ih * 60 + im;
          const startMin = sh * 60 + sm;
          const grace = r.shift_grace || 0;
          finalStatus = inMin > startMin + grace ? 'late' : 'present';
        } else {
          finalStatus = 'present';
        }
      }

      let worked = hasDevicePunch ? (r.worked_minutes || 0) : 0;
      let ot = hasDevicePunch ? (r.overtime_minutes || 0) : 0;
      if (hasDevicePunch && (isFriday || r.off_day_work) && r.check_in_local && r.check_out_local) {
        const [ih, im] = r.check_in_local.split(':').map(Number);
        const [oh, om] = r.check_out_local.split(':').map(Number);
        const span = Math.max(0, (oh * 60 + om) - (ih * 60 + im));
        if (span > 0) {
          worked = span;
          ot = span;
        }
      }

      return {
        ...r,
        status: finalStatus,
        off_day_work: (isFriday || r.off_day_work) ? true : r.off_day_work,
        check_in_local: hasDevicePunch ? r.check_in_local : null,
        check_out_local: hasDevicePunch ? r.check_out_local : null,
        worked_minutes: worked,
        overtime_minutes: ot,
        late_minutes: (hasDevicePunch && !isFriday && !r.off_day_work) ? r.late_minutes : 0,
        early_out_minutes: (hasDevicePunch && !isFriday && !r.off_day_work) ? r.early_out_minutes : 0,
        missing_checkout: hasDevicePunch ? r.missing_checkout : false,
      };
    });

    if (status) {
      return resultRows.filter((r) => r.status === status);
    }
    return resultRows;
  }

  params.push(limit);
  const { rows } = await query(
    `SELECT a.id, a.user_id, u.name, u.employee_code, u.department, u.photo, a.work_date::text AS work_date, a.status,
            to_char(a.check_in AT TIME ZONE $1, 'HH24:MI') AS check_in_local,
            to_char(a.check_out AT TIME ZONE $1, 'HH24:MI') AS check_out_local,
            a.worked_minutes, a.late_minutes, a.early_out_minutes, a.overtime_minutes,
            a.missing_checkout, a.off_day_work, a.punch_count, s.name AS shift_name,
            COALESCE(d.name, a.check_in_device_sn, a.device_sn, '—') AS device_name,
            COALESCE(a.check_in_device_sn, a.device_sn, u.primary_device_sn, '') AS device_sn
       FROM attendance a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN shifts s ON s.id = a.shift_id
       LEFT JOIN devices d ON UPPER(d.serial_number) = UPPER(COALESCE(a.check_in_device_sn, a.device_sn, u.primary_device_sn))
      WHERE ${where}
      ORDER BY a.work_date DESC, u.name
      LIMIT $${params.length}`, params);
  return rows;
}

async function fixMorningPunches(targetDate) {
  const { getSettings } = require('./settings');
  const { timezone } = await getSettings();
  const d = targetDate || todayIn(timezone);

  // Recalculate attendance cleanly from raw punches without mutating original device punch logs
  const updatedCount = await rebuildRange(d, d);
  return { shiftedPunches: 0, updatedCount, date: d };
}

/**
 * Detailed Employee Attendance Analytics & Profile.
 * Strictly uses ONLY ZKTeco uFace800 (ZK-UFACE800-01 / RKQ4262500336) data.
 * Gate controller (SenseFace 7A / VDE2251500160) punches are strictly excluded.
 */
async function getEmployeeAttendanceProfile(userId, { filterType = 'monthly', date, month, from, to, year } = {}) {
  const { timezone: tz } = await getSettings();
  const today = todayIn(tz);

  // 1. Fetch user details
  const { rows: userRows } = await query(
    `SELECT u.id, u.name, u.employee_code, u.email, u.phone, u.department, u.designation,
            u.active, u.join_date::text AS join_date, u.device_pin, u.shift_id, u.overtime_eligible,
            u.photo,
            s.name AS shift_name, s.start_time::text AS shift_start, s.end_time::text AS shift_end,
            s.grace_minutes, s.early_out_grace_minutes, s.overtime_after_minutes, s.weekly_off
       FROM users u
       LEFT JOIN shifts s ON s.id = COALESCE(u.shift_id, (SELECT id FROM shifts ORDER BY id LIMIT 1))
      WHERE u.id = $1`, [userId]);

  if (!userRows.length) {
    const err = new Error('Employee not found');
    err.status = 404;
    throw err;
  }
  const employee = userRows[0];

  // 2. Resolve date range
  let rangeFrom = today;
  let rangeTo = today;

  if (filterType === 'daily') {
    rangeFrom = (date && isDate(date)) ? date : today;
    rangeTo = rangeFrom;
  } else if (filterType === 'yearly') {
    const y = year || today.slice(0, 4);
    rangeFrom = `${y}-01-01`;
    rangeTo = `${y}-12-31`;
  } else if (filterType === 'custom') {
    rangeFrom = (from && isDate(from)) ? from : addDays(today, -30);
    rangeTo = (to && isDate(to)) ? to : today;
    if (rangeFrom > rangeTo) [rangeFrom, rangeTo] = [rangeTo, rangeFrom];
  } else {
    // default: monthly
    filterType = 'monthly';
    const m = (month && isMonth(month)) ? month : today.slice(0, 7);
    const mr = monthRange(m);
    rangeFrom = mr.from;
    rangeTo = mr.to;
  }

  // 3. Ensure attendance records are fresh up to today
  const lastRebuildDate = rangeTo < today ? rangeTo : today;
  if (rangeFrom <= lastRebuildDate) {
    await rebuildRange(rangeFrom, lastRebuildDate, { userId }).catch(() => {});
  }

  // 4. Fetch holidays, leaves, attendance records, and raw uFace 800 punches
  const [holidaysRes, leavesRes, attRes, punchesRes] = await Promise.all([
    query(`SELECT date::text AS date, name FROM holidays WHERE date BETWEEN $1 AND $2`, [rangeFrom, rangeTo]),
    query(`SELECT lr.start_date::text AS s, lr.end_date::text AS e, lt.name AS leave_type, lt.paid
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
            WHERE lr.user_id = $1 AND lr.status = 'approved' AND lr.start_date <= $2 AND lr.end_date >= $3`,
      [userId, rangeTo, rangeFrom]),
    query(`SELECT a.id, a.work_date::text AS work_date,
                  to_char(a.check_in AT TIME ZONE $1, 'HH24:MI') AS cin,
                  to_char(a.check_out AT TIME ZONE $1, 'HH24:MI') AS cout,
                  to_char(a.check_in AT TIME ZONE $1, 'HH12:MI AM') AS cin_12h,
                  to_char(a.check_out AT TIME ZONE $1, 'HH12:MI AM') AS cout_12h,
                  a.worked_minutes, a.late_minutes, a.early_out_minutes, a.overtime_minutes,
                  a.status, a.missing_checkout, a.off_day_work, a.punch_count,
                  COALESCE(a.device_sn, a.check_in_device_sn, 'ZK-UFACE800-01') AS device_sn
             FROM attendance a
            WHERE a.user_id = $2 AND a.work_date BETWEEN $3 AND $4
            ORDER BY a.work_date ASC`, [tz, userId, rangeFrom, rangeTo]),
    query(`SELECT p.id, p.pin,
                  to_char(p.punched_at AT TIME ZONE $1, 'YYYY-MM-DD') AS punch_date,
                  to_char(p.punched_at AT TIME ZONE $1, 'HH24:MI:SS') AS punch_time,
                  to_char(p.punched_at AT TIME ZONE $1, 'HH12:MI:SS AM') AS punch_time_12h,
                  p.state, p.source, p.verify,
                  COALESCE(d.name, p.device_sn, 'ZK-uFace 800') AS device_name,
                  p.device_sn
             FROM punch_logs p
             LEFT JOIN devices d ON (d.id = p.device_id OR UPPER(d.serial_number) = UPPER(p.device_sn))
            WHERE p.user_id = $2
              AND p.punched_at >= ($3::date::timestamp AT TIME ZONE $1)
              AND p.punched_at < (($4::date + 1)::timestamp AT TIME ZONE $1)
              AND UPPER(TRIM(COALESCE(p.device_sn, ''))) <> 'VDE2251500160'
              AND NOT EXISTS (
                SELECT 1 FROM devices dev
                 WHERE (dev.id = p.device_id OR UPPER(TRIM(dev.serial_number)) = UPPER(TRIM(p.device_sn)))
                   AND (UPPER(TRIM(dev.serial_number)) = 'VDE2251500160' OR LOWER(dev.model) LIKE '%gate%' OR LOWER(dev.name) LIKE '%gate%')
              )
            ORDER BY p.punched_at ASC`, [tz, userId, rangeFrom, rangeTo]),
  ]);

  const holidaysMap = new Map(holidaysRes.rows.map((h) => [h.date, h.name]));
  const leaves = leavesRes.rows;
  const attMap = new Map(attRes.rows.map((a) => [a.work_date, a]));
  const punchesByDate = new Map();
  for (const p of punchesRes.rows) {
    if (!punchesByDate.has(p.punch_date)) punchesByDate.set(p.punch_date, []);
    punchesByDate.get(p.punch_date).push(p);
  }

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const allDates = eachDay(rangeFrom, rangeTo);

  let totalWorkingDays = 0;
  let presentDays = 0;
  let onTimeDays = 0;
  let lateDays = 0;
  let absentDays = 0;
  let leaveDays = 0;
  let weekendDays = 0;
  let holidayDays = 0;
  let totalWorkedMinutes = 0;
  let totalLateMinutes = 0;
  let totalEarlyOutMinutes = 0;
  let totalOvertimeMinutes = 0;

  const dailyHistory = [];
  const calendarMap = {};
  const chartLabels = [];
  const chartWorkingHours = [];
  const chartLateMinutes = [];
  const chartOvertimeHours = [];

  for (const d of allDates) {
    const dayOfWeek = dow(d);
    const dayName = DAY_NAMES[dayOfWeek];
    const isWeeklyOff = (employee.weekly_off || []).includes(dayOfWeek) || dayOfWeek === 5;
    const holidayName = holidaysMap.get(d) || null;
    const leave = leaves.find((l) => l.s <= d && l.e >= d) || null;
    const att = attMap.get(d) || null;
    const rawPunches = punchesByDate.get(d) || [];
    const isPastOrToday = d <= today;

    let status = 'scheduled';
    let checkIn = att?.cin_12h || (rawPunches[0] ? rawPunches[0].punch_time_12h : null);
    let checkOut = att?.cout_12h || (rawPunches.length >= 2 ? rawPunches[rawPunches.length - 1].punch_time_12h : null);
    let workedMinutes = att?.worked_minutes || 0;
    let lateMinutes = att?.late_minutes || 0;
    let earlyOutMinutes = att?.early_out_minutes || 0;
    let overtimeMinutes = att?.overtime_minutes || 0;

    if (att && ['present', 'late', 'half_day'].includes(att.status)) {
      status = att.late_minutes > 0 ? 'late' : att.status;
    } else if (rawPunches.length > 0) {
      status = 'present';
    } else if (leave) {
      status = 'leave';
    } else if (holidayName) {
      status = 'holiday';
    } else if (isWeeklyOff) {
      status = 'weekend';
    } else if (isPastOrToday) {
      status = 'absent';
    } else {
      status = 'scheduled';
    }

    // Accumulate summary metrics for past/current days
    if (isPastOrToday) {
      if (status === 'weekend') {
        weekendDays++;
      } else if (status === 'holiday') {
        holidayDays++;
      } else if (status === 'leave') {
        leaveDays++;
      } else {
        totalWorkingDays++;
        if (['present', 'late', 'half_day'].includes(status)) {
          presentDays++;
          if (lateMinutes > 0) lateDays++;
          else onTimeDays++;
          totalWorkedMinutes += workedMinutes;
          totalLateMinutes += lateMinutes;
          totalEarlyOutMinutes += earlyOutMinutes;
          totalOvertimeMinutes += overtimeMinutes;
        } else if (status === 'absent') {
          absentDays++;
        }
      }
    }

    const rowItem = {
      date: d,
      dayName,
      dayOfMonth: parseInt(d.slice(8, 10), 10),
      shiftName: employee.shift_name || 'General Shift',
      scheduledStart: (employee.shift_start || '09:00:00').slice(0, 5),
      scheduledEnd: (employee.shift_end || '18:00:00').slice(0, 5),
      checkIn: checkIn || '—',
      checkOut: checkOut || '—',
      workedMinutes,
      workedHours: Number((workedMinutes / 60).toFixed(1)),
      lateMinutes,
      earlyOutMinutes,
      overtimeMinutes,
      overtimeHours: Number((overtimeMinutes / 60).toFixed(1)),
      status,
      device: 'ZK-uFace 800',
      deviceSn: 'ZK-UFACE800-01',
      holidayName,
      leaveType: leave?.leave_type || null,
      punchCount: rawPunches.length,
      punches: rawPunches.map((p) => ({
        id: p.id,
        time: p.punch_time_12h || p.punch_time,
        rawTime: p.punch_time,
        state: p.state === 1 ? 'OUT' : 'IN',
        verify: p.verify || 'Face/Biometric',
        device: 'uFace 800',
      })),
    };

    dailyHistory.push(rowItem);
    calendarMap[d] = rowItem;

    // For charts, plot up to today (or all if in the past)
    if (isPastOrToday) {
      const label = `${d.slice(8, 10)} ${new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short' })}`;
      chartLabels.push(label);
      chartWorkingHours.push(Number((workedMinutes / 60).toFixed(1)));
      chartLateMinutes.push(lateMinutes);
      chartOvertimeHours.push(Number((overtimeMinutes / 60).toFixed(1)));
    }
  }

  const totalWorkingHours = Number((totalWorkedMinutes / 60).toFixed(1));
  const avgDailyWorkingHours = presentDays > 0 ? Number((totalWorkingHours / presentDays).toFixed(1)) : 0;
  const totalOvertimeHours = Number((totalOvertimeMinutes / 60).toFixed(1));
  const attendancePercentage = totalWorkingDays > 0 ? Math.round((presentDays / totalWorkingDays) * 100) : 0;

  return {
    employee: {
      id: employee.id,
      name: employee.name,
      employeeCode: employee.employee_code || `EMP${employee.id}`,
      email: employee.email,
      phone: employee.phone || '—',
      department: employee.department || 'General',
      designation: employee.designation || 'Staff',
      shiftName: employee.shift_name || 'General Shift',
      shiftStart: (employee.shift_start || '09:00:00').slice(0, 5),
      shiftEnd: (employee.shift_end || '18:00:00').slice(0, 5),
      graceMinutes: employee.grace_minutes || 0,
      active: employee.active,
      joinDate: employee.join_date,
      photo: employee.photo || '',
      biometricPin: employee.device_pin || '—',
      primaryDevice: 'ZK-uFace 800',
      primaryDeviceSn: 'ZK-UFACE800-01 (SN: RKQ4262500336)',
    },
    period: {
      filterType,
      from: rangeFrom,
      to: rangeTo,
      date: date || today,
      month: month || today.slice(0, 7),
      year: year || today.slice(0, 4),
    },
    summary: {
      totalWorkingDays,
      presentDays,
      onTimeDays,
      lateDays,
      absentDays,
      leaveDays,
      weekendDays,
      holidayDays,
      totalWorkingHours,
      avgDailyWorkingHours,
      totalLateMinutes,
      totalEarlyLeaveMinutes: totalEarlyOutMinutes,
      totalOvertimeHours,
      attendancePercentage,
    },
    dailyHistory: [...dailyHistory].reverse(), // most recent date first for table display
    calendar: calendarMap,
    analytics: {
      labels: chartLabels,
      workingHours: chartWorkingHours,
      lateMinutes: chartLateMinutes,
      overtimeHours: chartOvertimeHours,
      statusBreakdown: {
        present: onTimeDays,
        late: lateDays,
        absent: absentDays,
        leave: leaveDays,
        weekend: weekendDays + holidayDays,
      },
    },
  };
}

module.exports = { rebuildRange, ingestPunches, backfillPin, listAttendance, addDays, fixMorningPunches, getEmployeeAttendanceProfile };
