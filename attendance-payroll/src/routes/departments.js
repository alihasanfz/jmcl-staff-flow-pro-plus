'use strict';
const router = require('express').Router();
const { query } = require('../db');
const { wrap, parse, bad, notFound, conflict, forbidden } = require('../utils/http');
const { requireRole, canEdit } = require('../middleware/auth');
const { z, id } = require('./schemas');

const manager = (req, res, next) => {
  if (canEdit(req.user, 'departments') || ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr'].includes(req.user.role)) {
    return next();
  }
  return next(forbidden('Your role cannot access this'));
};

const departmentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().max(20).optional().nullable(),
  headId: id.optional().nullable(),
  description: z.string().trim().max(300).optional().default(''),
  defaultShiftId: id.optional().nullable(),
  overtimeEligible: z.boolean().optional().default(true),
  applyToEmployees: z.boolean().optional().default(true),
});

router.get('/', wrap(async (req, res) => {
  const { rows } = await query(`
    SELECT d.id, d.name, d.code, d.head_id, d.description, d.created_at,
           d.default_shift_id, COALESCE(d.overtime_eligible, true) AS overtime_eligible,
           s.name AS shift_name,
           u.name AS head_name,
           (SELECT COUNT(*)::int FROM users usr WHERE usr.department_id = d.id OR usr.department = d.name) AS employees
      FROM departments d
      LEFT JOIN shifts s ON s.id = d.default_shift_id
      LEFT JOIN users u ON u.id = d.head_id
     ORDER BY d.name
  `);
  res.json({ departments: rows });
}));

router.post('/', manager, wrap(async (req, res) => {
  const d = parse(departmentSchema, req.body);
  const { rows: [r] } = await query(
    `INSERT INTO departments (name, code, head_id, description, default_shift_id, overtime_eligible)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE SET 
       code = EXCLUDED.code, description = EXCLUDED.description,
       default_shift_id = EXCLUDED.default_shift_id,
       overtime_eligible = EXCLUDED.overtime_eligible
     RETURNING id`,
    [d.name, d.code || null, d.headId || null, d.description || '', d.defaultShiftId || null, d.overtimeEligible !== false]
  );
  if (d.applyToEmployees && d.defaultShiftId) {
    await query(`UPDATE users SET shift_id = $1, overtime_eligible = $2 WHERE department_id = $3 OR department = $4`,
      [d.defaultShiftId, d.overtimeEligible !== false, r.id, d.name]);
    try {
      const { getSettings } = require('../services/settings');
      const { todayIn, addDays } = require('../utils/time');
      const { rebuildRange } = require('../services/attendance');
      const settings = await getSettings();
      const today = todayIn(settings.timezone);
      await rebuildRange(addDays(today, -7), today);
    } catch (_) {}
  }
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'create','department',$2,$3::jsonb)`,
    [req.user.id, String(r.id), JSON.stringify({ name: d.name })]);
  res.status(201).json({ id: r.id });
}));

router.put('/:id', manager, wrap(async (req, res) => {
  const did = parse(id, req.params.id);
  const d = parse(departmentSchema, req.body);
  const { rowCount } = await query(
    `UPDATE departments SET name = $2, code = $3, head_id = $4, description = $5, default_shift_id = $6, overtime_eligible = $7 WHERE id = $1`,
    [did, d.name, d.code || null, d.headId || null, d.description || '', d.defaultShiftId || null, d.overtimeEligible !== false]
  );
  if (!rowCount) throw notFound('Department not found');
  await query(`UPDATE users SET department = $2 WHERE department_id = $1`, [did, d.name]);
  if (d.applyToEmployees && d.defaultShiftId) {
    await query(`UPDATE users SET shift_id = $1, overtime_eligible = $2 WHERE department_id = $3 OR department = $4`,
      [d.defaultShiftId, d.overtimeEligible !== false, did, d.name]);
    try {
      const { getSettings } = require('../services/settings');
      const { todayIn, addDays } = require('../utils/time');
      const { rebuildRange } = require('../services/attendance');
      const settings = await getSettings();
      const today = todayIn(settings.timezone);
      await rebuildRange(addDays(today, -7), today);
    } catch (_) {}
  }
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'update','department',$2,$3::jsonb)`,
    [req.user.id, String(did), JSON.stringify({ name: d.name })]);
  res.json({ ok: true });
}));

router.post('/:id/assign-shift', manager, wrap(async (req, res) => {
  const did = parse(id, req.params.id);
  const shiftId = parse(id, req.body.shiftId);
  const overtimeEligible = req.body.overtimeEligible !== false;
  const { rows: [dept] } = await query('SELECT name FROM departments WHERE id = $1', [did]);
  if (!dept) throw notFound('Department not found');

  await query('UPDATE departments SET default_shift_id = $1, overtime_eligible = $2 WHERE id = $3', [shiftId, overtimeEligible, did]);
  const { rowCount } = await query('UPDATE users SET shift_id = $1, overtime_eligible = $2 WHERE department_id = $3 OR department = $4',
    [shiftId, overtimeEligible, did, dept.name]);

  try {
    const { getSettings } = require('../services/settings');
    const { todayIn, addDays } = require('../utils/time');
    const { rebuildRange } = require('../services/attendance');
    const settings = await getSettings();
    const today = todayIn(settings.timezone);
    await rebuildRange(addDays(today, -7), today);
  } catch (_) {}

  res.json({ ok: true, updatedEmployees: rowCount });
}));

router.delete('/:id', manager, wrap(async (req, res) => {
  const did = parse(id, req.params.id);
  const { rows: [target] } = await query('SELECT name FROM departments WHERE id = $1', [did]);
  if (!target) throw notFound('Department not found');

  await query('UPDATE users SET department_id = NULL WHERE department_id = $1', [did]);
  await query('UPDATE designations SET department_id = NULL WHERE department_id = $1', [did]);
  await query('DELETE FROM departments WHERE id = $1', [did]);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'delete','department',$2,$3::jsonb)`,
    [req.user.id, String(did), JSON.stringify({ name: target.name })]);
  res.json({ ok: true });
}));

module.exports = router;

