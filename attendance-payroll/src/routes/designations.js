'use strict';
const router = require('express').Router();
const { query } = require('../db');
const { wrap, parse, notFound, forbidden } = require('../utils/http');
const { requireRole, canEdit } = require('../middleware/auth');
const { z, id } = require('./schemas');

const manager = (req, res, next) => {
  if (canEdit(req.user, 'designations') || ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr'].includes(req.user.role)) {
    return next();
  }
  return next(forbidden('Your role cannot access this'));
};

const designationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  departmentId: id.optional().nullable(),
  description: z.string().trim().max(300).optional().default(''),
});

router.get('/', wrap(async (req, res) => {
  const { rows } = await query(`
    SELECT dg.id, dg.name, dg.name AS title, dg.department_id, dg.description, dg.created_at,
           d.name AS department_name,
           (SELECT COUNT(*)::int FROM users u WHERE u.designation_id = dg.id OR u.designation = dg.name) AS employees,
           (SELECT COUNT(*)::int FROM users u WHERE u.designation_id = dg.id OR u.designation = dg.name) AS employee_count
      FROM designations dg
      LEFT JOIN departments d ON d.id = dg.department_id
     ORDER BY dg.name
  `);
  res.json({ designations: rows });
}));

router.post('/', manager, wrap(async (req, res) => {
  const name = (req.body.name || req.body.title || '').trim();
  if (!name) throw parse(z.string().min(1), '');
  const departmentId = req.body.departmentId || req.body.department_id || null;
  const description = req.body.description || '';
  const { rows: [r] } = await query(
    `INSERT INTO designations (name, department_id, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET department_id = EXCLUDED.department_id, description = EXCLUDED.description
     RETURNING id`,
    [name, departmentId, description]
  );
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'create','designation',$2,$3::jsonb)`,
    [req.user.id, String(r.id), JSON.stringify({ name })]);
  res.status(201).json({ id: r.id });
}));

router.put('/:id', manager, wrap(async (req, res) => {
  const did = parse(id, req.params.id);
  const name = (req.body.name || req.body.title || '').trim();
  if (!name) throw parse(z.string().min(1), '');
  const departmentId = req.body.departmentId || req.body.department_id || null;
  const description = req.body.description || '';
  const { rowCount } = await query(
    `UPDATE designations SET name = $2, department_id = $3, description = $4 WHERE id = $1`,
    [did, name, departmentId, description]
  );
  if (!rowCount) throw notFound('Designation not found');
  await query(`UPDATE users SET designation = $2 WHERE designation_id = $1`, [did, name]);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'update','designation',$2,$3::jsonb)`,
    [req.user.id, String(did), JSON.stringify({ name: d.name })]);
  res.json({ ok: true });
}));

router.delete('/:id', manager, wrap(async (req, res) => {
  const did = parse(id, req.params.id);
  const { rows: [target] } = await query('SELECT name FROM designations WHERE id = $1', [did]);
  if (!target) throw notFound('Designation not found');

  await query('UPDATE users SET designation_id = NULL WHERE designation_id = $1', [did]);
  await query('DELETE FROM designations WHERE id = $1', [did]);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'delete','designation',$2,$3::jsonb)`,
    [req.user.id, String(did), JSON.stringify({ name: target.name })]);
  res.json({ ok: true });
}));

module.exports = router;
