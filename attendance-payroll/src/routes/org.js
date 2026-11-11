'use strict';
// Shifts, holidays and leave types: reference data shared by attendance, leave and payroll.
const router = require('express').Router();
const { query } = require('../db');
const { wrap, parse, notFound, conflict, forbidden } = require('../utils/http');
const { requireRole, canEdit } = require('../middleware/auth');
const { z, date, time, id } = require('./schemas');

const shiftManager = (req, res, next) => {
  if (canEdit(req.user, 'shifts') || ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr'].includes(req.user.role)) {
    return next();
  }
  return next(forbidden('Your role cannot access this'));
};

const holidayManager = (req, res, next) => {
  if (canEdit(req.user, 'holidays') || ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr'].includes(req.user.role)) {
    return next();
  }
  return next(forbidden('Your role cannot access this'));
};

const leaveTypeManager = (req, res, next) => {
  if (canEdit(req.user, 'leave') || ['super_admin', 'company_admin', 'admin'].includes(req.user.role)) {
    return next();
  }
  return next(forbidden('Your role cannot access this'));
};

/* ---------- shifts ---------- */
const shift = z.object({
  name: z.string().trim().min(1).max(60),
  startTime: time, endTime: time,
  breakMinutes: z.coerce.number().int().min(0).max(240).default(60),
  graceMinutes: z.coerce.number().int().min(0).max(120).default(10),
  earlyOutGraceMinutes: z.coerce.number().int().min(0).max(120).default(10),
  overtimeAfterMinutes: z.coerce.number().int().min(0).max(240).default(30),
  weeklyOff: z.array(z.number().int().min(0).max(6)).max(6).default([5]),
  isNightShift: z.boolean().optional().default(false),
  allowOvertime: z.boolean().optional().default(true),
});

const SHIFT_COLS = `id, name, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time, break_minutes,
  grace_minutes, early_out_grace_minutes, overtime_after_minutes, weekly_off, COALESCE(is_night_shift, false) AS is_night_shift,
  COALESCE(allow_overtime, true) AS allow_overtime, (SELECT COUNT(*)::int FROM users u WHERE u.shift_id = shifts.id) AS employees`;

router.get('/shifts', wrap(async (req, res) => {
  res.json({ shifts: (await query(`SELECT ${SHIFT_COLS} FROM shifts ORDER BY start_time, name`)).rows });
}));
router.post('/shifts', shiftManager, wrap(async (req, res) => {
  const s = parse(shift, req.body);
  const isNight = s.isNightShift || s.endTime <= s.startTime;
  const { rows: [r] } = await query(
    `INSERT INTO shifts (name, start_time, end_time, break_minutes, grace_minutes, early_out_grace_minutes, overtime_after_minutes, weekly_off, is_night_shift, allow_overtime)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [s.name, s.startTime, s.endTime, s.breakMinutes, s.graceMinutes, s.earlyOutGraceMinutes, s.overtimeAfterMinutes, s.weeklyOff, isNight, s.allowOvertime !== false]);
  res.status(201).json({ id: r.id });
}));
router.put('/shifts/:id', shiftManager, wrap(async (req, res) => {
  const sid = parse(id, req.params.id);
  const s = parse(shift, req.body);
  const isNight = s.isNightShift || s.endTime <= s.startTime;
  const { rowCount } = await query(
    `UPDATE shifts SET name=$2, start_time=$3, end_time=$4, break_minutes=$5, grace_minutes=$6, early_out_grace_minutes=$7,
            overtime_after_minutes=$8, weekly_off=$9, is_night_shift=$10, allow_overtime=$11 WHERE id=$1`,
    [sid, s.name, s.startTime, s.endTime, s.breakMinutes, s.graceMinutes, s.earlyOutGraceMinutes, s.overtimeAfterMinutes, s.weeklyOff, isNight, s.allowOvertime !== false]);
  if (!rowCount) throw notFound('Shift not found');
  try {
    const { getSettings } = require('../services/settings');
    const { todayIn, addDays } = require('../utils/time');
    const { rebuildRange } = require('../services/attendance');
    const settings = await getSettings();
    const today = todayIn(settings.timezone);
    await rebuildRange(addDays(today, -7), today);
  } catch (_) {}
  res.json({ ok: true, note: 'Attendance recalculated with updated shift timings.' });
}));
router.delete('/shifts/:id', shiftManager, wrap(async (req, res) => {
  const sid = parse(id, req.params.id);
  const { rows: [c] } = await query('SELECT COUNT(*)::int AS n FROM users WHERE shift_id = $1', [sid]);
  if (c.n) throw conflict(`${c.n} employee(s) are assigned to this shift. Move them first.`);
  await query('UPDATE attendance SET shift_id = NULL WHERE shift_id = $1', [sid]); // keep history, just detach it
  const { rowCount } = await query('DELETE FROM shifts WHERE id = $1', [sid]);
  if (!rowCount) throw notFound('Shift not found');
  res.json({ ok: true });
}));

/* ---------- holidays ---------- */
router.get('/holidays', wrap(async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getUTCFullYear();
  const { rows } = await query(`SELECT date::text AS date, name FROM holidays WHERE EXTRACT(YEAR FROM date) = $1 ORDER BY date`, [year]);
  res.json({ holidays: rows });
}));
router.post('/holidays', holidayManager, wrap(async (req, res) => {
  const h = parse(z.object({ date, name: z.string().trim().min(1).max(100) }), req.body);
  await query('INSERT INTO holidays (date, name) VALUES ($1,$2) ON CONFLICT (date) DO UPDATE SET name = EXCLUDED.name', [h.date, h.name]);
  res.status(201).json({ ok: true });
}));
router.delete('/holidays/:date', holidayManager, wrap(async (req, res) => {
  const d = parse(date, req.params.date);
  await query('DELETE FROM holidays WHERE date = $1', [d]);
  res.json({ ok: true });
}));

/* ---------- leave types ---------- */
const leaveType = z.object({
  name: z.string().trim().min(1).max(60),
  annualQuota: z.coerce.number().min(0).max(366).nullable().default(null),
  paid: z.boolean().default(true),
  active: z.boolean().default(true),
});
router.get('/leave-types', wrap(async (req, res) => {
  res.json({ leaveTypes: (await query('SELECT id, name, annual_quota, paid, active FROM leave_types ORDER BY id')).rows });
}));
router.post('/leave-types', leaveTypeManager, wrap(async (req, res) => {
  const t = parse(leaveType, req.body);
  const { rows: [r] } = await query('INSERT INTO leave_types (name, annual_quota, paid, active) VALUES ($1,$2,$3,$4) RETURNING id', [t.name, t.annualQuota, t.paid, t.active]);
  res.status(201).json({ id: r.id });
}));
router.put('/leave-types/:id', leaveTypeManager, wrap(async (req, res) => {
  const tid = parse(id, req.params.id);
  const t = parse(leaveType, req.body);
  const { rowCount } = await query('UPDATE leave_types SET name=$2, annual_quota=$3, paid=$4, active=$5 WHERE id=$1', [tid, t.name, t.annualQuota, t.paid, t.active]);
  if (!rowCount) throw notFound('Leave type not found');
  // Keep this year's entitlements in step with the new quota (existing "used" days are preserved).
  if (t.annualQuota !== null) {
    await query('UPDATE leave_balances SET allocated = $2 WHERE leave_type_id = $1 AND year = $3', [tid, t.annualQuota, new Date().getUTCFullYear()]);
  }
  res.json({ ok: true });
}));

router.delete('/leave-types/:id', leaveTypeManager, wrap(async (req, res) => {
  const tid = parse(id, req.params.id);
  const { rows: [c] } = await query('SELECT COUNT(*)::int AS n FROM leave_requests WHERE leave_type_id = $1', [tid]);
  if (c.n) throw conflict(`${c.n} leave request(s) exist for this leave type. Cannot delete.`);
  await query('DELETE FROM leave_balances WHERE leave_type_id = $1', [tid]);
  const { rowCount } = await query('DELETE FROM leave_types WHERE id = $1', [tid]);
  if (!rowCount) throw notFound('Leave type not found');
  res.json({ ok: true });
}));

module.exports = router;
