'use strict';
const router = require('express').Router();
const { query } = require('../db');
const { wrap, parse, forbidden, bad, notFound } = require('../utils/http');
const { requireRole, isManager, canEdit } = require('../middleware/auth');
const leave = require('../services/leave');
const { z, date, id } = require('./schemas');

const leaveReviewer = (req, res, next) => {
  if (canEdit(req.user, 'leave') || isManager(req.user) || ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr', 'dept_manager'].includes(req.user.role)) {
    return next();
  }
  return next(forbidden('Your role cannot access this'));
};

/* ---------------- Leave Types (Full CRUD) ---------------- */

router.get('/types', wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM leave_types ORDER BY id ASC');
  res.json({ types: rows });
}));

router.post('/types', leaveReviewer, wrap(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(1).max(50),
    annualQuota: z.number().int().min(0).nullable().optional(),
    paid: z.boolean().default(true),
    active: z.boolean().default(true),
  }), req.body);

  const { rows: [created] } = await query(
    `INSERT INTO leave_types (name, annual_quota, paid, active)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [b.name, b.annualQuota ?? null, b.paid, b.active]
  );

  // If quota provided, seed for all active users for current year
  if (created.annual_quota !== null) {
    const year = new Date().getUTCFullYear();
    await query(`
      INSERT INTO leave_balances (user_id, leave_type_id, year, allocated, used)
      SELECT u.id, $1, $2, $3, 0
        FROM users u
       WHERE u.active = true
      ON CONFLICT (user_id, leave_type_id, year) DO NOTHING
    `, [created.id, year, created.annual_quota]);
  }

  res.status(201).json({ type: created });
}));

router.put('/types/:id', leaveReviewer, wrap(async (req, res) => {
  const typeId = parse(id, req.params.id);
  const b = parse(z.object({
    name: z.string().trim().min(1).max(50).optional(),
    annualQuota: z.number().int().min(0).nullable().optional(),
    paid: z.boolean().optional(),
    active: z.boolean().optional(),
  }), req.body);

  const { rows: [cur] } = await query('SELECT * FROM leave_types WHERE id = $1', [typeId]);
  if (!cur) throw notFound('Leave type not found');

  const newName = b.name ?? cur.name;
  const newQuota = b.annualQuota !== undefined ? b.annualQuota : cur.annual_quota;
  const newPaid = b.paid !== undefined ? b.paid : cur.paid;
  const newActive = b.active !== undefined ? b.active : cur.active;

  const { rows: [updated] } = await query(
    `UPDATE leave_types SET name = $2, annual_quota = $3, paid = $4, active = $5 WHERE id = $1 RETURNING *`,
    [typeId, newName, newQuota, newPaid, newActive]
  );

  // Update existing balances if quota changed
  if (newQuota !== null && newQuota !== cur.annual_quota) {
    const year = new Date().getUTCFullYear();
    await query(
      `UPDATE leave_balances SET allocated = $2 WHERE leave_type_id = $1 AND year = $3`,
      [typeId, newQuota, year]
    );
  }

  res.json({ type: updated });
}));

router.delete('/types/:id', leaveReviewer, wrap(async (req, res) => {
  const typeId = parse(id, req.params.id);
  // Check if requests exist
  const { rows: [cnt] } = await query('SELECT COUNT(*) AS c FROM leave_requests WHERE leave_type_id = $1', [typeId]);
  if (parseInt(cnt.c, 10) > 0) {
    // If requests exist, soft delete by deactivating
    await query('UPDATE leave_types SET active = false WHERE id = $1', [typeId]);
    return res.json({ id: typeId, deactivated: true, message: 'Leave type deactivated because records exist' });
  }

  await query('DELETE FROM leave_balances WHERE leave_type_id = $1', [typeId]);
  await query('DELETE FROM leave_types WHERE id = $1', [typeId]);
  res.json({ id: typeId, deleted: true });
}));

/* ---------------- Employee Balances ---------------- */

router.get('/balances', wrap(async (req, res) => {
  const uid = isManager(req.user) && req.query.userId ? parse(id, req.query.userId) : req.user.id;
  const year = parseInt(req.query.year, 10) || new Date().getUTCFullYear();
  res.json({ year, balances: await leave.getBalances(uid, year) });
}));

router.get('/all-balances', leaveReviewer, wrap(async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getUTCFullYear();
  res.json({ year, rows: await leave.getAllBalances(year) });
}));

router.put('/balances/:userId/:leaveTypeId', leaveReviewer, wrap(async (req, res) => {
  const userId = parse(id, req.params.userId);
  const leaveTypeId = parse(id, req.params.leaveTypeId);
  const b = parse(z.object({
    allocated: z.number().min(0),
    used: z.number().min(0),
    year: z.number().int().optional(),
  }), req.body);
  const year = b.year || new Date().getUTCFullYear();

  await leave.updateUserBalance(userId, leaveTypeId, year, b.allocated, b.used);
  res.json({ ok: true });
}));

/* ---------------- Leave Requests (Full CRUD) ---------------- */

/** scope=mine (default) | pending (managers: queue) | all (managers) */
router.get('/requests', wrap(async (req, res) => {
  const scope = req.query.scope || 'mine';
  if (scope !== 'mine' && !isManager(req.user) && !canEdit(req.user, 'leave')) throw forbidden();
  const params = [];
  let where = 'TRUE';
  if (scope === 'mine') { params.push(req.user.id); where = `lr.user_id = $${params.length}`; }
  if (scope === 'pending') where = `lr.status = 'pending'`;
  if (['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)) { params.push(req.query.status); where += ` AND lr.status = $${params.length}`; }
  if (req.query.userId) { params.push(parse(id, req.query.userId)); where += ` AND lr.user_id = $${params.length}`; }

  const { rows } = await query(
    `SELECT lr.id, lr.user_id, u.name, u.employee_code, u.department, lt.id AS leave_type_id, lt.name AS type, lt.paid,
            lr.start_date::text AS start_date, lr.end_date::text AS end_date,
            lr.half_day, lr.days, lr.reason, lr.status, rv.name AS reviewer, lr.review_note, lr.created_at
       FROM leave_requests lr JOIN users u ON u.id = lr.user_id JOIN leave_types lt ON lt.id = lr.leave_type_id
       LEFT JOIN users rv ON rv.id = lr.reviewed_by
      WHERE ${where} ORDER BY (lr.status = 'pending') DESC, lr.start_date DESC LIMIT 500`, params);
  res.json({ requests: rows });
}));

// User self-service create
router.post('/requests', wrap(async (req, res) => {
  const b = parse(z.object({
    leaveTypeId: id, startDate: date, endDate: date, halfDay: z.boolean().default(false), reason: z.string().trim().max(500).default(''),
  }), req.body);
  res.status(201).json(await leave.createRequest(req.user, b));
}));

// Admin create on behalf of employee (Direct add / approve)
router.post('/admin-create', leaveReviewer, wrap(async (req, res) => {
  const b = parse(z.object({
    userId: id,
    leaveTypeId: id,
    startDate: date,
    endDate: date,
    halfDay: z.boolean().default(false),
    reason: z.string().trim().max(500).default(''),
    status: z.enum(['approved', 'pending']).default('approved'),
  }), req.body);

  const reqRecord = await leave.adminCreateRequest(req.user, b);
  res.status(201).json({ request: reqRecord });
}));

// Admin edit request
router.put('/requests/:id', leaveReviewer, wrap(async (req, res) => {
  const reqId = parse(id, req.params.id);
  const b = parse(z.object({
    leaveTypeId: id.optional(),
    startDate: date.optional(),
    endDate: date.optional(),
    halfDay: z.boolean().optional(),
    reason: z.string().trim().max(500).optional(),
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  }), req.body);

  const updated = await leave.adminUpdateRequest(reqId, req.user, b);
  res.json({ request: updated });
}));

// Admin delete request
router.delete('/requests/:id', leaveReviewer, wrap(async (req, res) => {
  const reqId = parse(id, req.params.id);
  const result = await leave.adminDeleteRequest(reqId, req.user);
  res.json(result);
}));

const noteSchema = z.object({ note: z.string().trim().max(300).optional() });
router.post('/requests/:id/approve', leaveReviewer, wrap(async (req, res) => {
  res.json(await leave.review(parse(id, req.params.id), req.user, 'approved', parse(noteSchema, req.body ?? {}).note));
}));
router.post('/requests/:id/reject', leaveReviewer, wrap(async (req, res) => {
  res.json(await leave.review(parse(id, req.params.id), req.user, 'rejected', parse(noteSchema, req.body ?? {}).note));
}));
router.post('/requests/:id/cancel', wrap(async (req, res) => {
  res.json(await leave.cancel(parse(id, req.params.id), req.user));
}));

module.exports = router;
