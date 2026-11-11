'use strict';
const router = require('express').Router();
const { query, tx } = require('../db');
const { wrap, parse, bad, notFound } = require('../utils/http');
const { requireRole, isManager, requirePermission, canView } = require('../middleware/auth');
const { listAttendance, rebuildRange } = require('../services/attendance');
const { getSettings } = require('../services/settings');
const { addDays, todayIn, diffDays, monthRange, isMonth } = require('../utils/time');
const { z, date, time, id } = require('./schemas');

const manager = (req, res, next) => {
  if (canView(req.user, 'attendance') || isManager(req.user) || ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr', 'dept_manager'].includes(req.user.role)) {
    return next();
  }
  return next(forbidden('Your role cannot access this'));
};
const editAttendance = requirePermission('attendance', 'edit');

/** Staff only ever see their own records; managers or users with attendance view permission may filter by employee. */
const scopeUser = (req) => ((isManager(req.user) || canView(req.user, 'attendance')) ? (req.query.userId ? parse(id, req.query.userId) : null) : req.user.id);

router.get('/live', wrap(async (req, res) => {
  const { timezone } = await getSettings();
  const today = todayIn(timezone);
  const devSn = req.query.deviceSn ? String(req.query.deviceSn).trim() : null;

  const { rows: punches } = await query(`
    SELECT p.id, to_char(p.punched_at AT TIME ZONE $1, 'HH24:MI:SS') AS at,
           p.punched_at, p.punched_at AS punch_time, p.pin, p.device_sn, p.source,
           p.state, p.state AS punch_state, p.verify,
           u.id AS user_id, u.name, u.name AS employee_name, u.employee_code, u.department, u.photo,
           COALESCE(d.name, p.device_sn) AS device_name, d.location AS device_location
      FROM punch_logs p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN devices d ON (d.id = p.device_id OR UPPER(d.serial_number) = UPPER(p.device_sn))
     WHERE ($2::text IS NULL OR UPPER(p.device_sn) = UPPER($2))
     ORDER BY p.punched_at DESC
     LIMIT 100
  `, [timezone, devSn]);

  const { rows: attendance } = await query(`
    SELECT a.id, a.user_id, u.name, u.employee_code, u.department, u.photo,
           s.name AS shift_name,
           to_char(a.check_in AT TIME ZONE $1, 'HH24:MI') AS check_in,
           to_char(a.check_out AT TIME ZONE $1, 'HH24:MI') AS check_out,
           a.worked_minutes, a.late_minutes, a.early_out_minutes, a.overtime_minutes, a.status,
           a.missing_checkout,
           COALESCE(d.name, a.device_sn, a.check_in_device_sn, '—') AS device_name,
           COALESCE(a.device_sn, a.check_in_device_sn, '') AS device_sn
      FROM users u
      LEFT JOIN attendance a ON a.user_id = u.id AND a.work_date = $2
      LEFT JOIN shifts s ON s.id = COALESCE(a.shift_id, u.shift_id)
      LEFT JOIN devices d ON UPPER(d.serial_number) = UPPER(COALESCE(a.check_in_device_sn, a.device_sn, u.primary_device_sn))
     WHERE u.active = true
       AND ($3::text IS NULL OR (
         UPPER(COALESCE(a.check_in_device_sn, a.device_sn, '')) = UPPER($3)
         OR EXISTS (
           SELECT 1 FROM punch_logs pl
            WHERE pl.user_id = u.id
              AND to_char(pl.punched_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2::text
              AND UPPER(pl.device_sn) = UPPER($3)
         )
       ))
     ORDER BY (a.check_in IS NOT NULL) DESC, a.check_in DESC, u.name
  `, [timezone, today, devSn]);

  const totalEmployees = attendance.length;
  const present = attendance.filter((r) => ['present', 'late', 'half_day'].includes(r.status)).length;
  const late = attendance.filter((r) => r.status === 'late' || (r.late_minutes > 0)).length;
  const absent = attendance.filter((r) => r.status === 'absent').length;
  const onLeave = attendance.filter((r) => ['leave', 'unpaid_leave'].includes(r.status)).length;

  res.json({
    today,
    stats: { totalEmployees, present, late, absent, onLeave },
    punches,
    attendance,
  });
}));

router.get('/', wrap(async (req, res) => {
  const { timezone } = await getSettings();
  const to = req.query.to ? parse(date, req.query.to) : todayIn(timezone);
  const from = req.query.from ? parse(date, req.query.from) : addDays(to, -13);
  if (from > to) throw bad('"from" must not be after "to"');
  if (diffDays(from, to) > 366) throw bad('Choose a range of up to one year');
  const rows = await listAttendance({
    from, to, userId: scopeUser(req),
    department: isManager(req.user) ? req.query.department : undefined,
    status: req.query.status || undefined,
    deviceSn: req.query.deviceSn ? String(req.query.deviceSn).trim() : undefined,
    limit: 2000,
  });
  res.json({ from, to, rows });
}));

router.get('/summary', wrap(async (req, res) => {
  const { timezone } = await getSettings();
  const month = req.query.month || todayIn(timezone).slice(0, 7);
  if (!isMonth(month)) throw bad('month must look like 2026-10');
  const { from, to } = monthRange(month);
  const uid = scopeUser(req);
  const { rows: [s] } = await query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('present','late','half_day'))::int AS present,
            COUNT(*) FILTER (WHERE late_minutes > 0)::int AS late_days,
            COALESCE(SUM(late_minutes), 0)::int AS late_minutes,
            COUNT(*) FILTER (WHERE early_out_minutes > 0)::int AS early_out_days,
            COUNT(*) FILTER (WHERE status = 'half_day')::int AS half_days,
            COUNT(*) FILTER (WHERE status IN ('leave','unpaid_leave'))::int AS leave_days,
            COUNT(*) FILTER (WHERE status = 'absent')::int AS absent,
            COALESCE(SUM(worked_minutes), 0)::int AS worked_minutes,
            COALESCE(SUM(overtime_minutes), 0)::int AS overtime_minutes
       FROM attendance WHERE work_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR user_id = $3)`, [from, to, uid]);
  res.json({ month, summary: s });
}));

/** Raw device punches (audit trail). */
router.get('/punches', manager, wrap(async (req, res) => {
  const { timezone } = await getSettings();
  const to = req.query.to ? parse(date, req.query.to) : todayIn(timezone);
  const from = req.query.from ? parse(date, req.query.from) : addDays(to, -2);
  const uid = req.query.userId ? parse(id, req.query.userId) : null;
  const devSn = req.query.deviceSn ? String(req.query.deviceSn).trim() : null;
  const { rows } = await query(
    `SELECT p.id, p.pin, p.user_id, COALESCE(u.name, 'Employee #' || p.pin) AS name,
            u.employee_code, u.department,
            p.source, p.state, p.verify,
            COALESCE(d.name, p.device_sn) AS device, p.device_sn,
            to_char(p.punched_at AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI:SS') AS at,
            to_char(p.punched_at AT TIME ZONE $1, 'HH12:MI:SS AM') AS time_12h,
            to_char(p.punched_at AT TIME ZONE $1, 'YYYY-MM-DD') AS work_date
       FROM punch_logs p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN devices d ON (d.id = p.device_id OR UPPER(d.serial_number) = UPPER(p.device_sn))
      WHERE p.punched_at >= ($2::date::timestamp AT TIME ZONE $1) AND p.punched_at < (($3::date + 1)::timestamp AT TIME ZONE $1)
        AND ($4::int IS NULL OR p.user_id = $4)
        AND ($5::text IS NULL OR UPPER(p.device_sn) = UPPER($5))
      ORDER BY p.punched_at DESC LIMIT 1000`, [timezone, from, to, uid, devSn]);
  res.json({ rows });
}));

/** Add or record manual attendance */
router.post('/manual', editAttendance, wrap(async (req, res) => {
  const userId = parse(id, req.body.userId);
  const dateVal = parse(date, req.body.date);
  const status = req.body.status || 'present';
  const rawCheckIn = req.body.checkIn ? String(req.body.checkIn).trim() : null;
  const checkIn = (rawCheckIn && rawCheckIn !== '00:00' && rawCheckIn !== '00') ? rawCheckIn : null;
  const rawCheckOut = req.body.checkOut ? String(req.body.checkOut).trim() : null;
  const checkOut = (rawCheckOut && rawCheckOut !== '00:00' && rawCheckOut !== '00') ? rawCheckOut : null;

  const overtimeMinutes = checkOut ? (parseInt(req.body.overtimeMinutes, 10) || 0) : 0;
  const lateMinutes = parseInt(req.body.lateMinutes, 10) || 0;
  const earlyOutMinutes = checkOut ? (parseInt(req.body.earlyOutMinutes, 10) || 0) : 0;
  const workedMinutes = checkOut ? (req.body.workedMinutes ? parseInt(req.body.workedMinutes, 10) : 480) : null;
  const reason = (req.body.reason || 'Manual entry').trim();

  const { timezone } = await getSettings();
  const { rows: [u] } = await query('SELECT id, name, device_pin, shift_id FROM users WHERE id = $1', [userId]);
  if (!u) throw notFound('Employee not found');

  const cinTs = checkIn ? `${dateVal} ${checkIn.length === 5 ? checkIn + ':00' : checkIn}` : null;
  const coutTs = checkOut ? `${dateVal} ${checkOut.length === 5 ? checkOut + ':00' : checkOut}` : null;

  await tx(async (db) => {
    await db.query(
      `DELETE FROM punch_logs WHERE user_id = $1
          AND punched_at >= ($2::date::timestamp AT TIME ZONE $3) AND punched_at < (($2::date + 1)::timestamp AT TIME ZONE $3)`,
      [u.id, dateVal, timezone]);
    if (checkIn) {
      await db.query(
        `INSERT INTO punch_logs (device_sn, pin, user_id, punched_at, state, source)
         VALUES ('MANUAL', $1, $2, ($3::timestamp AT TIME ZONE $4), 0, 'manual') ON CONFLICT DO NOTHING`,
        [u.device_pin, u.id, cinTs, timezone]);
    }
    if (checkOut) {
      await db.query(
        `INSERT INTO punch_logs (device_sn, pin, user_id, punched_at, state, source)
         VALUES ('MANUAL', $1, $2, ($3::timestamp AT TIME ZONE $4), 1, 'manual') ON CONFLICT DO NOTHING`,
        [u.device_pin, u.id, coutTs, timezone]);
    }

    await db.query(
      `INSERT INTO attendance (user_id, work_date, shift_id, check_in, check_out, punch_count, worked_minutes,
                               late_minutes, early_out_minutes, overtime_minutes, status, updated_at)
       VALUES ($1, $2, $3,
               CASE WHEN $4::text IS NOT NULL THEN ($4::timestamp AT TIME ZONE $10) ELSE NULL END,
               CASE WHEN $5::text IS NOT NULL THEN ($5::timestamp AT TIME ZONE $10) ELSE NULL END,
               $6, $7, $8, $9, $11, $12, now())
       ON CONFLICT (user_id, work_date) DO UPDATE SET
         shift_id = EXCLUDED.shift_id,
         check_in = EXCLUDED.check_in,
         check_out = EXCLUDED.check_out,
         punch_count = EXCLUDED.punch_count,
         worked_minutes = EXCLUDED.worked_minutes,
         late_minutes = EXCLUDED.late_minutes,
         early_out_minutes = EXCLUDED.early_out_minutes,
         overtime_minutes = EXCLUDED.overtime_minutes,
         status = EXCLUDED.status,
         updated_at = now()`,
      [
        u.id, dateVal, u.shift_id, cinTs, coutTs,
        (checkIn ? 1 : 0) + (checkOut ? 1 : 0),
        workedMinutes,
        lateMinutes, earlyOutMinutes, timezone, overtimeMinutes, status
      ]
    );

    await db.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'add-attendance','attendance',$2,$3::jsonb)`,
      [req.user.id, `${u.id}:${dateVal}`, JSON.stringify({ name: u.name, date: dateVal, status, checkIn, checkOut, reason })]
    );
  });

  res.status(201).json({ ok: true });
}));

/** Edit an existing attendance record directly */
router.put('/:id', editAttendance, wrap(async (req, res) => {
  const attId = parse(id, req.params.id);
  const { timezone } = await getSettings();
  const { rows: [att] } = await query('SELECT * FROM attendance WHERE id = $1', [attId]);
  if (!att) throw notFound('Attendance record not found');

  const { rows: [u] } = await query('SELECT id, name, device_pin FROM users WHERE id = $1', [att.user_id]);
  const dateStr = att.work_date.toISOString ? att.work_date.toISOString().slice(0, 10) : String(att.work_date).slice(0, 10);

  const status = req.body.status || att.status;

  const hasCheckInProp = req.body.checkIn !== undefined;
  const rawCheckIn = hasCheckInProp && req.body.checkIn ? String(req.body.checkIn).trim() : null;
  const cleanCheckIn = (rawCheckIn && rawCheckIn !== '00:00' && rawCheckIn !== '00') ? rawCheckIn : null;

  const hasCheckOutProp = req.body.checkOut !== undefined;
  const rawCheckOut = hasCheckOutProp && req.body.checkOut ? String(req.body.checkOut).trim() : null;
  const cleanCheckOut = (rawCheckOut && rawCheckOut !== '00:00' && rawCheckOut !== '00') ? rawCheckOut : null;

  const clearCheckIn = hasCheckInProp && cleanCheckIn === null;
  const clearCheckOut = hasCheckOutProp && cleanCheckOut === null;

  const overtimeMinutes = (cleanCheckOut && req.body.overtimeMinutes !== undefined)
    ? parseInt(req.body.overtimeMinutes, 10)
    : (clearCheckOut ? 0 : att.overtime_minutes);

  const lateMinutes = req.body.lateMinutes !== undefined
    ? parseInt(req.body.lateMinutes, 10)
    : att.late_minutes;

  const earlyOutMinutes = (cleanCheckOut && req.body.earlyOutMinutes !== undefined)
    ? parseInt(req.body.earlyOutMinutes, 10)
    : (clearCheckOut ? 0 : att.early_out_minutes);

  const workedMinutes = (cleanCheckOut && req.body.workedMinutes !== undefined)
    ? parseInt(req.body.workedMinutes, 10)
    : (clearCheckOut ? null : att.worked_minutes);

  const reason = (req.body.reason || 'Manual edit').trim();

  const cinTs = cleanCheckIn ? `${dateStr} ${cleanCheckIn.length === 5 ? cleanCheckIn + ':00' : cleanCheckIn}` : null;
  const coutTs = cleanCheckOut ? `${dateStr} ${cleanCheckOut.length === 5 ? cleanCheckOut + ':00' : cleanCheckOut}` : null;

  await tx(async (db) => {
    if (hasCheckInProp || hasCheckOutProp) {
      await db.query(
        `DELETE FROM punch_logs WHERE user_id = $1
            AND punched_at >= ($2::date::timestamp AT TIME ZONE $3) AND punched_at < (($2::date + 1)::timestamp AT TIME ZONE $3)`,
        [att.user_id, dateStr, timezone]);
      if (cinTs && u) {
        await db.query(
          `INSERT INTO punch_logs (device_sn, pin, user_id, punched_at, state, source)
           VALUES ('MANUAL', $1, $2, ($3::timestamp AT TIME ZONE $4), 0, 'manual') ON CONFLICT DO NOTHING`,
          [u.device_pin, u.id, cinTs, timezone]);
      }
      if (coutTs && u) {
        await db.query(
          `INSERT INTO punch_logs (device_sn, pin, user_id, punched_at, state, source)
           VALUES ('MANUAL', $1, $2, ($3::timestamp AT TIME ZONE $4), 1, 'manual') ON CONFLICT DO NOTHING`,
          [u.device_pin, u.id, coutTs, timezone]);
      }
    }

    await db.query(
      `UPDATE attendance
          SET status = $2,
              check_in = CASE WHEN $3::text IS NOT NULL THEN ($3::timestamp AT TIME ZONE $4) WHEN $10::boolean = true THEN NULL ELSE check_in END,
              check_out = CASE WHEN $5::text IS NOT NULL THEN ($5::timestamp AT TIME ZONE $4) WHEN $11::boolean = true THEN NULL ELSE check_out END,
              overtime_minutes = $6,
              late_minutes = $7,
              early_out_minutes = $8,
              worked_minutes = $9,
              punch_count = (CASE WHEN $3::text IS NOT NULL THEN 1 WHEN $10::boolean = true THEN 0 ELSE (CASE WHEN check_in IS NOT NULL THEN 1 ELSE 0 END) END)
                          + (CASE WHEN $5::text IS NOT NULL THEN 1 WHEN $11::boolean = true THEN 0 ELSE (CASE WHEN check_out IS NOT NULL THEN 1 ELSE 0 END) END),
              updated_at = now()
        WHERE id = $1`,
      [
        attId, status, cinTs, timezone, coutTs, overtimeMinutes, lateMinutes, earlyOutMinutes, workedMinutes,
        clearCheckIn, clearCheckOut
      ]
    );

    await db.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'edit-attendance','attendance',$2,$3::jsonb)`,
      [req.user.id, String(attId), JSON.stringify({ userId: att.user_id, date: dateStr, status, checkIn: cleanCheckIn, checkOut: cleanCheckOut, reason })]
    );
  });

  res.json({ ok: true });
}));

/** Delete an attendance record directly */
router.delete('/:id', editAttendance, wrap(async (req, res) => {
  const attId = parse(id, req.params.id);
  const { timezone } = await getSettings();
  const { rows: [att] } = await query('SELECT * FROM attendance WHERE id = $1', [attId]);
  if (!att) throw notFound('Attendance record not found');

  const dateStr = att.work_date.toISOString ? att.work_date.toISOString().slice(0, 10) : String(att.work_date).slice(0, 10);

  await tx(async (db) => {
    await db.query(
      `DELETE FROM punch_logs WHERE user_id = $1
          AND punched_at >= ($2::date::timestamp AT TIME ZONE $3) AND punched_at < (($2::date + 1)::timestamp AT TIME ZONE $3)`,
      [att.user_id, dateStr, timezone]);
    await db.query('DELETE FROM attendance WHERE id = $1', [attId]);
    await db.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'delete-attendance','attendance',$2,$3::jsonb)`,
      [req.user.id, String(attId), JSON.stringify({ userId: att.user_id, date: dateStr })]
    );
  });

  res.json({ ok: true });
}));

router.delete('/manual/:userId/:date', editAttendance, wrap(async (req, res) => {
  const uid = parse(id, req.params.userId);
  const d = parse(date, req.params.date);
  const { timezone } = await getSettings();

  const { rows: [u] } = await query('SELECT id, name FROM users WHERE id = $1', [uid]);
  if (!u) throw notFound('Employee not found');

  await query(
    `DELETE FROM punch_logs WHERE user_id = $1
        AND punched_at >= ($2::date::timestamp AT TIME ZONE $3) AND punched_at < (($2::date + 1)::timestamp AT TIME ZONE $3)`,
    [uid, d, timezone]);
  await query('DELETE FROM attendance WHERE user_id = $1 AND work_date = $2', [uid, d]);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'delete-punches','attendance',$2,$3::jsonb)`,
    [req.user.id, `${uid}:${d}`, JSON.stringify({ name: u.name, date: d })]);
  res.json({ ok: true });
}));

/** Recompute derived attendance, e.g. after changing shifts, holidays or settings. */
router.post('/recalculate', editAttendance, wrap(async (req, res) => {
  const b = parse(z.object({ from: date, to: date }), req.body);
  if (b.from > b.to) throw bad('"from" must not be after "to"');
  if (diffDays(b.from, b.to) > 92) throw bad('Recalculate up to 93 days at a time');
  const rows = await rebuildRange(b.from, b.to);
  res.json({ ok: true, rows });
}));

/** Correct morning punches and attendance when machine time was skewed earlier in the day */
router.post('/fix-morning-punches', editAttendance, wrap(async (req, res) => {
  const { fixMorningPunches } = require('../services/attendance');
  const result = await fixMorningPunches(req.body.date);
  res.json({
    ok: true,
    message: `Corrected ${result.shiftedPunches} punch(es) and updated ${result.updatedCount} attendance record(s) for ${result.date} to Present (On-time 09:00–10:00 AM arrival).`,
    ...result,
  });
}));

module.exports = router;
