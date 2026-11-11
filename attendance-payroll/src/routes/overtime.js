'use strict';
const router = require('express').Router();
const { query } = require('../db');
const { wrap, parse, notFound, bad, forbidden } = require('../utils/http');
const { requireRole, isManager, canEdit } = require('../middleware/auth');
const { z, id, date, money } = require('./schemas');

const manager = (req, res, next) => {
  if (
    canEdit(req.user, 'overtime') ||
    isManager(req.user) ||
    ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr', 'accounts_manager', 'dept_manager'].includes(req.user.role)
  ) {
    return next();
  }
  return next(forbidden('Your role cannot access this'));
};

router.get('/', wrap(async (req, res) => {
  const isMgr = isManager(req.user);
  const uid = !isMgr ? req.user.id : (req.query.userId ? parse(id, req.query.userId) : null);
  const month = req.query.month; // 'YYYY-MM'
  const params = [];
  let where = 'TRUE';

  if (uid) { params.push(uid); where += ` AND o.user_id = $${params.length}`; }
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    params.push(month);
    where += ` AND to_char(o.work_date, 'YYYY-MM') = $${params.length}`;
  }
  if (req.query.status) {
    params.push(req.query.status);
    where += ` AND o.status = $${params.length}`;
  }

  const { rows } = await query(`
    SELECT o.id, o.user_id, o.work_date, o.minutes, o.hourly_rate, o.multiplier, o.amount, o.status,
           o.note, o.created_at,
           u.name AS employee_name, u.employee_code, u.department,
           appr.name AS approved_by_name
      FROM overtime_records o
      JOIN users u ON u.id = o.user_id
      LEFT JOIN users appr ON appr.id = o.approved_by
     WHERE ${where}
     ORDER BY o.work_date DESC, o.id DESC
     LIMIT 500
  `, params);

  res.json({ overtime: rows, records: rows });
}));

router.post('/', manager, wrap(async (req, res) => {
  const userId = parse(id, req.body.userId || req.body.user_id);
  const workDate = parse(date, req.body.workDate || req.body.date);
  const minutes = parseInt(req.body.minutes, 10);
  if (!minutes || minutes < 1 || minutes > 1440) throw bad('Minutes must be between 1 and 1440');
  const multiplier = Number(req.body.multiplier || req.body.rate_multiplier || 1.0);
  const note = (req.body.note || req.body.notes || '').trim();

  const { rows: [u] } = await query('SELECT base_salary FROM users WHERE id = $1', [userId]);
  if (!u) throw notFound('Employee not found');

  const hourly = req.body.hourlyRate ?? (Number(u.base_salary || 0) / (22 * 8));
  const hours = minutes / 60;
  const amount = Math.round(hours * hourly * multiplier * 100) / 100;

  const { rows: [r] } = await query(`
    INSERT INTO overtime_records (user_id, work_date, minutes, hourly_rate, multiplier, amount, status, approved_by, approved_at, note)
    VALUES ($1, $2, $3, $4, $5, $6, 'approved', $7, now(), $8)
    ON CONFLICT (user_id, work_date) DO UPDATE
      SET minutes = EXCLUDED.minutes, amount = EXCLUDED.amount, multiplier = EXCLUDED.multiplier,
          hourly_rate = EXCLUDED.hourly_rate, status = 'approved', approved_by = EXCLUDED.approved_by, approved_at = now(), note = EXCLUDED.note
    RETURNING id
  `, [userId, workDate, minutes, hourly, multiplier, amount, req.user.id, note]);

  // Sync with attendance table so reports and daily attendance reflect the approved overtime
  await query('UPDATE attendance SET overtime_minutes = $3 WHERE user_id = $1 AND work_date = $2', [userId, workDate, minutes]).catch(() => {});

  res.status(201).json({ id: r.id, amount });
}));

router.post('/:id/approve', manager, wrap(async (req, res) => {
  const oid = parse(id, req.params.id);
  const { rows: [rec] } = await query(`
    UPDATE overtime_records
       SET status = 'approved', approved_by = $2, approved_at = now()
     WHERE id = $1
    RETURNING user_id, work_date, minutes
  `, [oid, req.user.id]);
  if (!rec) throw notFound('Overtime record not found');
  await query('UPDATE attendance SET overtime_minutes = $3 WHERE user_id = $1 AND work_date = $2',
    [rec.user_id, rec.work_date, rec.minutes]).catch(() => {});
  res.json({ ok: true });
}));

router.post('/:id/reject', manager, wrap(async (req, res) => {
  const oid = parse(id, req.params.id);
  const { rows: [rec] } = await query(`
    UPDATE overtime_records
       SET status = 'rejected', approved_by = $2, approved_at = now()
     WHERE id = $1
    RETURNING user_id, work_date
  `, [oid, req.user.id]);
  if (!rec) throw notFound('Overtime record not found');
  await query('UPDATE attendance SET overtime_minutes = 0 WHERE user_id = $1 AND work_date = $2',
    [rec.user_id, rec.work_date]).catch(() => {});
  res.json({ ok: true });
}));

router.delete('/:id', manager, wrap(async (req, res) => {
  const oid = parse(id, req.params.id);
  const { rows: [rec] } = await query('DELETE FROM overtime_records WHERE id = $1 RETURNING user_id, work_date', [oid]);
  if (!rec) throw notFound('Overtime record not found');
  await query('UPDATE attendance SET overtime_minutes = 0 WHERE user_id = $1 AND work_date = $2',
    [rec.user_id, rec.work_date]).catch(() => {});
  res.json({ ok: true });
}));

module.exports = router;
