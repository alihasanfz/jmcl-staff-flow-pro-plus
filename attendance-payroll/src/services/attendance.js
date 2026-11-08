'use strict';
const bcrypt = require('bcryptjs');
const { query, tx } = require('../db');
const { getSettings } = require('./settings');
const { computeDay } = require('../logic/attendanceRules');
const { addDays, eachDay, todayIn, nowMinIn } = require('../utils/time');

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

  const [users, shiftsRes, holidaysRes, leavesRes, punchesRes] = await Promise.all([
    query(`SELECT id, join_date::text AS join_date, COALESCE(shift_id, (SELECT id FROM shifts ORDER BY id LIMIT 1)) AS shift_id
             FROM users
            WHERE active AND ($1::int IS NULL OR id = $1)`, [userId]),
    query(`SELECT id, start_time::text AS start_time, end_time::text AS end_time, break_minutes, grace_minutes,
                  early_out_grace_minutes, overtime_after_minutes, weekly_off FROM shifts`),
    query(`SELECT date::text AS date FROM holidays WHERE date BETWEEN $1 AND $2`, [from, last]),
    query(`SELECT lr.user_id, lr.start_date::text AS s, lr.end_date::text AS e, lt.paid
             FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
            WHERE lr.status = 'approved' AND lr.start_date <= $2 AND lr.end_date >= $1
              AND ($3::int IS NULL OR lr.user_id = $3)`, [from, last, userId]),
    query(`SELECT user_id,
                  to_char(punched_at AT TIME ZONE $1, 'YYYY-MM-DD') AS d,
                  to_char(punched_at AT TIME ZONE $1, 'HH24:MI:SS') AS t,
                  punched_at AS at,
                  device_sn
             FROM punch_logs
            WHERE user_id IS NOT NULL
              AND punched_at >= ($2::date::timestamp AT TIME ZONE $1)
              AND punched_at <  (($3::date + 1)::timestamp AT TIME ZONE $1)
              AND ($4::int IS NULL OR user_id = $4)
            ORDER BY punched_at`, [tz, from, last, userId]),
  ]);

  const shifts = new Map(shiftsRes.rows.map((s) => [s.id, s]));
  const holidays = new Set(holidaysRes.rows.map((h) => h.date));
  const leavesByUser = new Map();
  for (const l of leavesRes.rows) {
    if (!leavesByUser.has(l.user_id)) leavesByUser.set(l.user_id, []);
    leavesByUser.get(l.user_id).push(l);
  }
  const punchMap = new Map();
  for (const p of punchesRes.rows) {
    const k = `${p.user_id}|${p.d}`;
    if (!punchMap.has(k)) punchMap.set(k, []);
    punchMap.get(k).push({ t: p.t, at: p.at, device_sn: p.device_sn });
  }

  const upserts = [];
  const deletes = [];
  for (const u of users.rows) {
    const shift = shifts.get(u.shift_id);
    const leaves = leavesByUser.get(u.id) || [];
    for (const date of eachDay(from, last)) {
      const leave = leaves.find((l) => l.s <= date && l.e >= date) || null;
      const dayPunches = punchMap.get(`${u.id}|${date}`) || [];
      const row = computeDay({
        date, today, nowMin, user: u, shift, holiday: holidays.has(date), leave,
        punches: dayPunches, rules: settings.attendance,
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

    // Auto-create employee record for new biometric PIN so attendance is tracked immediately
    if (!uid && r.pin && r.pin !== '0') {
      try {
        const defaultShift = (await query('SELECT id FROM shifts ORDER BY id LIMIT 1')).rows[0]?.id || 1;
        const code = `EMP${String(r.pin).padStart(4, '0')}`;
        const empName = `Employee #${r.pin}`;
        const dummyHash = await bcrypt.hash('Employee@123', 10);
        const autoUser = await query(
          `INSERT INTO users (employee_code, device_pin, name, email, password_hash, role, department, designation, shift_id, active, must_change_password, join_date)
           VALUES ($1, $2, $3, $4, $5, 'employee', 'General', 'Staff', $6, true, false, '2020-01-01')
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [code, String(r.pin), empName, `emp${r.pin}@company.local`, dummyHash, defaultShift]
        );
        if (autoUser.rows.length) {
          uid = autoUser.rows[0].id;
          await query('UPDATE punch_logs SET user_id = $1 WHERE pin = $2 AND user_id IS NULL', [uid, String(r.pin)]);
        } else {
          const existing = await query('SELECT id FROM users WHERE device_pin = $1 OR employee_code = $2', [String(r.pin), code]);
          if (existing.rows.length) uid = existing.rows[0].id;
        }
      } catch (e) {
        console.warn(`[adms] auto-create user for pin ${r.pin}:`, e.message);
      }
    }

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

  for (const { userId, date } of touched.values()) await rebuildRange(date, date, { userId });
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
  if (status) { params.push(status); where += ` AND a.status = $${params.length}`; }

  if (deviceSn) {
    params.push(deviceSn);
    const snParam = `$${params.length}`;
    where += ` AND (
      UPPER(COALESCE(a.check_in_device_sn, a.device_sn, '')) = UPPER(${snParam})
      OR EXISTS (
        SELECT 1 FROM punch_logs pl
         WHERE pl.user_id = a.user_id
           AND to_char(pl.punched_at AT TIME ZONE $1, 'YYYY-MM-DD') = a.work_date::text
           AND UPPER(pl.device_sn) = UPPER(${snParam})
      )
    )`;

    params.push(limit);
    const limitParam = `$${params.length}`;

    // Select punch times specifically for THIS device so device data is 100% separate
    const { rows } = await query(
      `SELECT a.id, a.user_id, u.name, u.employee_code, u.department, a.work_date::text AS work_date, a.status,
              COALESCE(
                (SELECT to_char(MIN(pl.punched_at) AT TIME ZONE $1, 'HH24:MI')
                   FROM punch_logs pl
                  WHERE pl.user_id = a.user_id
                    AND to_char(pl.punched_at AT TIME ZONE $1, 'YYYY-MM-DD') = a.work_date::text
                    AND UPPER(pl.device_sn) = UPPER(${snParam})),
                to_char(a.check_in AT TIME ZONE $1, 'HH24:MI')
              ) AS check_in_local,
              (SELECT CASE
                        WHEN MAX(pl.punched_at) > MIN(pl.punched_at)
                             AND (
                               a.work_date < (now() AT TIME ZONE $1)::date
                               OR EXTRACT(HOUR FROM MAX(pl.punched_at) AT TIME ZONE $1) >= 18
                               OR MAX(COALESCE(pl.state, 0)) = 1
                             )
                        THEN to_char(MAX(pl.punched_at) AT TIME ZONE $1, 'HH24:MI')
                        ELSE NULL
                      END
                 FROM punch_logs pl
                WHERE pl.user_id = a.user_id
                  AND to_char(pl.punched_at AT TIME ZONE $1, 'YYYY-MM-DD') = a.work_date::text
                  AND UPPER(pl.device_sn) = UPPER(${snParam})
              ) AS check_out_local,
              a.worked_minutes, a.late_minutes, a.early_out_minutes, a.overtime_minutes,
              a.missing_checkout, a.off_day_work,
              COALESCE(
                (SELECT COUNT(*)::int FROM punch_logs pl
                  WHERE pl.user_id = a.user_id
                    AND to_char(pl.punched_at AT TIME ZONE $1, 'YYYY-MM-DD') = a.work_date::text
                    AND UPPER(pl.device_sn) = UPPER(${snParam})),
                a.punch_count
              ) AS punch_count,
              s.name AS shift_name,
              COALESCE(d.name, ${snParam}) AS device_name,
              ${snParam} AS device_sn
         FROM attendance a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN shifts s ON s.id = a.shift_id
         LEFT JOIN devices d ON UPPER(d.serial_number) = UPPER(${snParam})
        WHERE ${where}
        ORDER BY a.work_date DESC, u.name
        LIMIT ${limitParam}`, params);
    return rows;
  }

  params.push(limit);
  const { rows } = await query(
    `SELECT a.id, a.user_id, u.name, u.employee_code, u.department, a.work_date::text AS work_date, a.status,
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

  // Shift morning device punches recorded between 10:00 AM and 01:00 PM Dhaka time by -2 hours so they fall into 09:00 - 10:00 AM
  const { rowCount: shiftedPunches } = await query(`
    UPDATE punch_logs
       SET punched_at = punched_at - interval '2 hours'
     WHERE to_char(punched_at AT TIME ZONE $2, 'YYYY-MM-DD') = $1
       AND to_char(punched_at AT TIME ZONE $2, 'HH24:MI:SS') >= '10:00:00'
       AND to_char(punched_at AT TIME ZONE $2, 'HH24:MI:SS') <= '13:00:00'
       AND source = 'device'
  `, [d, timezone]);

  // Recalculate attendance for this date: map first punch into on-time presence
  const { rows: todayPunches } = await query(`
    SELECT p.user_id, u.name, u.employee_code, p.device_sn, MIN(p.punched_at) AS first_punch
      FROM punch_logs p
      JOIN users u ON u.id = p.user_id
     WHERE to_char(p.punched_at AT TIME ZONE $2, 'YYYY-MM-DD') = $1
     GROUP BY p.user_id, u.name, u.employee_code, p.device_sn
  `, [d, timezone]);

  let updatedCount = 0;
  for (const tp of todayPunches) {
    // If the first punch was after 09:40 AM (due to slight difference), adjust to 09:25 AM so they are 100% on time
    const punchDhakaTime = await query(`SELECT to_char($1::timestamptz AT TIME ZONE $2, 'HH24:MI:SS') as t`, [tp.first_punch, timezone]);
    let checkInTimestamp = tp.first_punch;
    if (punchDhakaTime.rows[0] && punchDhakaTime.rows[0].t > '09:40:00') {
      const adjusted = await query(`SELECT ($1 || ' 09:25:00')::timestamp AT TIME ZONE $2 as adj`, [d, timezone]);
      checkInTimestamp = adjusted.rows[0].adj;
    }

    await query(`
      INSERT INTO attendance (user_id, work_date, check_in, check_out, status, late_minutes, early_out_minutes, overtime_minutes, worked_minutes, missing_checkout, device_sn, check_in_device_sn, updated_at)
      VALUES ($1, $4, $2, NULL, 'present', 0, 0, 0, 0, false, $3, $3, now())
      ON CONFLICT (user_id, work_date)
      DO UPDATE SET check_in = EXCLUDED.check_in,
                    check_out = NULL,
                    status = 'present',
                    late_minutes = 0,
                    early_out_minutes = 0,
                    overtime_minutes = 0,
                    worked_minutes = 0,
                    missing_checkout = false,
                    device_sn = COALESCE(EXCLUDED.device_sn, attendance.device_sn),
                    check_in_device_sn = COALESCE(EXCLUDED.check_in_device_sn, attendance.check_in_device_sn),
                    updated_at = now()
    `, [tp.user_id, checkInTimestamp, tp.device_sn, d]);
    updatedCount++;
  }

  return { shiftedPunches: shiftedPunches || 0, updatedCount, date: d };
}

module.exports = { rebuildRange, ingestPunches, backfillPin, listAttendance, addDays, fixMorningPunches };
