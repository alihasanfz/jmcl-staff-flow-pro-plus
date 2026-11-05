'use strict';
const router = require('express').Router();
const { query } = require('../db');
const { wrap, parse, bad, notFound, conflict } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const { z, id } = require('./schemas');

const manager = requireRole('super_admin', 'company_admin', 'admin', 'hr_manager', 'hr');

const departmentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().max(20).optional().nullable(),
  headId: id.optional().nullable(),
  description: z.string().trim().max(300).optional().default(''),
});

router.get('/', wrap(async (req, res) => {
  const { rows } = await query(`
    SELECT d.id, d.name, d.code, d.head_id, d.description, d.created_at,
           u.name AS head_name,
           (SELECT COUNT(*)::int FROM users usr WHERE usr.department_id = d.id OR usr.department = d.name) AS employees
      FROM departments d
      LEFT JOIN users u ON u.id = d.head_id
     ORDER BY d.name
  `);
  res.json({ departments: rows });
}));

router.post('/', manager, wrap(async (req, res) => {
  const d = parse(departmentSchema, req.body);
  const { rows: [r] } = await query(
    `INSERT INTO departments (name, code, head_id, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description
     RETURNING id`,
    [d.name, d.code || null, d.headId || null, d.description || '']
  );
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'create','department',$2,$3::jsonb)`,
    [req.user.id, String(r.id), JSON.stringify({ name: d.name })]);
  res.status(201).json({ id: r.id });
}));

router.put('/:id', manager, wrap(async (req, res) => {
  const did = parse(id, req.params.id);
  const d = parse(departmentSchema, req.body);
  const { rowCount } = await query(
    `UPDATE departments SET name = $2, code = $3, head_id = $4, description = $5 WHERE id = $1`,
    [did, d.name, d.code || null, d.headId || null, d.description || '']
  );
  if (!rowCount) throw notFound('Department not found');
  await query(`UPDATE users SET department = $2 WHERE department_id = $1`, [did, d.name]);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'update','department',$2,$3::jsonb)`,
    [req.user.id, String(did), JSON.stringify({ name: d.name })]);
  res.json({ ok: true });
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

