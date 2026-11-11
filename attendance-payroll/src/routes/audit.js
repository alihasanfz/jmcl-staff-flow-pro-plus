'use strict';
const router = require('express').Router();
const { query } = require('../db');
const { wrap, forbidden } = require('../utils/http');
const { requireRole, canView } = require('../middleware/auth');

router.get('/', (req, res, next) => (canView(req.user, 'audit_logs') || ['admin', 'hr', 'company_admin', 'super_admin'].includes(req.user.role) ? next() : next(forbidden('Your role cannot access this'))), wrap(async (req, res) => {
  const { entity, action, limit = 100, offset = 0 } = req.query;
  const conditions = [];
  const params = [];
  if (entity) {
    params.push(entity);
    conditions.push(`l.entity = $${params.length}`);
  }
  if (action) {
    params.push(action);
    conditions.push(`l.action = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  params.push(lim, off);
  const sql = `
    SELECT l.id, l.at, l.action, l.entity, l.entity_id, l.detail, u.name AS actor, u.email AS actor_email
    FROM audit_log l
    LEFT JOIN users u ON u.id = l.user_id
    ${where}
    ORDER BY l.at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const { rows } = await query(sql, params);
  const countSql = `SELECT count(*)::int AS total FROM audit_log l ${where}`;
  const { rows: [{ total }] } = await query(countSql, params.slice(0, conditions.length));
  res.json({ logs: rows, total, limit: lim, offset: off });
}));

module.exports = router;

