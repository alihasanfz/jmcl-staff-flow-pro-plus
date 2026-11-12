'use strict';
const router = require('express').Router();
const { query } = require('../db');
const { wrap, parse, forbidden, bad, notFound } = require('../utils/http');
const { requireRole, isManager, canEdit, canView } = require('../middleware/auth');
const leave = require('../services/leave');
const { z, date, id } = require('./schemas');

const leaveReviewer = (req, res, next) => {
  if (canEdit(req.user, 'leave') || isManager(req.user) || ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr', 'dept_manager'].includes(req.user.role)) {
    return next();
  }
  return next(forbidden('Your role cannot access this'));
};

const adminHeadOnly = (req, res, next) => {
  if (canEdit(req.user, 'leave') || ['super_admin', 'company_admin', 'admin', 'hr_manager'].includes(req.user.role)) {
    return next();
  }
  return next(forbidden('Only authorized Admin Head / HR Manager can grant final approval'));
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
  const { rows: [cnt] } = await query('SELECT COUNT(*) AS c FROM leave_requests WHERE leave_type_id = $1', [typeId]);
  if (parseInt(cnt.c, 10) > 0) {
    await query('UPDATE leave_types SET active = false WHERE id = $1', [typeId]);
    return res.json({ id: typeId, deactivated: true, message: 'Leave type deactivated because records exist' });
  }

  await query('DELETE FROM leave_balances WHERE leave_type_id = $1', [typeId]);
  await query('DELETE FROM leave_types WHERE id = $1', [typeId]);
  res.json({ id: typeId, deleted: true });
}));

/* ---------------- Employee Balances ---------------- */

router.get('/balances', wrap(async (req, res) => {
  const uid = (isManager(req.user) || canEdit(req.user, 'leave')) && req.query.userId ? parse(id, req.query.userId) : req.user.id;
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

/* ---------------- Leave Dashboard KPI & Statistics ---------------- */

router.get('/stats', leaveReviewer, wrap(async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getUTCFullYear();

  const [countsRes, deptRes, typeRes] = await Promise.all([
    query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'recommended')::int AS recommended,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
        COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
      FROM leave_requests
      WHERE EXTRACT(YEAR FROM start_date) = $1
    `, [year]),
    query(`
      SELECT u.department, COUNT(*)::int AS count
        FROM leave_requests lr
        JOIN users u ON u.id = lr.user_id
       WHERE EXTRACT(YEAR FROM lr.start_date) = $1
       GROUP BY u.department
       ORDER BY count DESC
    `, [year]),
    query(`
      SELECT lt.name AS type, COUNT(*)::int AS count, COALESCE(SUM(lr.days), 0) AS total_days
        FROM leave_requests lr
        JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE EXTRACT(YEAR FROM lr.start_date) = $1
       GROUP BY lt.name
       ORDER BY count DESC
    `, [year])
  ]);

  res.json({
    year,
    summary: countsRes.rows[0] || { total: 0, pending: 0, recommended: 0, approved: 0, rejected: 0 },
    byDepartment: deptRes.rows,
    byType: typeRes.rows
  });
}));

/* ---------------- Leave Requests (Full CRUD & Workflow) ---------------- */

/** scope: mine (default) | pending | recommended | all */
router.get('/requests', wrap(async (req, res) => {
  const scope = req.query.scope || 'mine';
  if (scope !== 'mine' && !isManager(req.user) && !canEdit(req.user, 'leave') && !canView(req.user, 'leave')) {
    throw forbidden();
  }

  const params = [];
  let where = 'TRUE';
  if (scope === 'mine') {
    params.push(req.user.id);
    where = `lr.user_id = $${params.length}`;
  } else if (scope === 'pending') {
    where = `lr.status = 'pending'`;
  } else if (scope === 'recommended') {
    where = `lr.status = 'recommended'`;
  }

  if (req.query.status && ['pending', 'recommended', 'approved', 'rejected', 'cancelled'].includes(req.query.status)) {
    params.push(req.query.status);
    where += ` AND lr.status = $${params.length}`;
  }
  if (req.query.userId) {
    params.push(parse(id, req.query.userId));
    where += ` AND lr.user_id = $${params.length}`;
  }
  if (req.query.department) {
    params.push(req.query.department);
    where += ` AND u.department = $${params.length}`;
  }

  const { rows } = await query(
    `SELECT lr.id, lr.user_id, u.name, u.employee_code, u.department, u.designation,
            COALESCE(u.section, u.department, 'Main Section') AS section, u.phone, u.email,
            lt.id AS leave_type_id, lt.name AS type, lt.paid,
            lr.start_date::text AS start_date, lr.end_date::text AS end_date,
            lr.half_day, lr.days, lr.reason, lr.status,
            lr.address_during_leave, lr.contact_number, lr.document_url,
            lr.applicant_signature, lr.applied_at,
            lr.dept_head_id, lr.dept_head_name, lr.dept_head_recommendation, lr.dept_head_remarks, lr.dept_head_signed_at, lr.dept_head_signature,
            lr.admin_head_id, lr.admin_head_name, lr.admin_head_decision, lr.admin_head_remarks, lr.admin_head_signed_at, lr.admin_head_signature,
            rv.name AS reviewer, lr.review_note, lr.created_at, lr.audit_history
       FROM leave_requests lr
       JOIN users u ON u.id = lr.user_id
       JOIN leave_types lt ON lt.id = lr.leave_type_id
       LEFT JOIN users rv ON rv.id = lr.reviewed_by
      WHERE ${where}
      ORDER BY (lr.status = 'pending') DESC, (lr.status = 'recommended') DESC, lr.start_date DESC
      LIMIT 1000`, params);
  res.json({ requests: rows });
}));

// Single Request details
router.get('/requests/:id', wrap(async (req, res) => {
  const reqId = parse(id, req.params.id);
  const { rows: [r] } = await query(
    `SELECT lr.*, lt.name AS type_name, lt.paid,
            u.name AS emp_name, u.employee_code, u.department, u.designation,
            COALESCE(u.section, u.department, 'Main Section') AS section,
            u.join_date::text AS join_date, u.phone, u.email
       FROM leave_requests lr
       JOIN users u ON u.id = lr.user_id
       JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.id = $1`, [reqId]);
  if (!r) throw notFound('Leave application not found');

  if (r.user_id !== req.user.id && !isManager(req.user) && !canView(req.user, 'leave')) {
    throw forbidden();
  }

  const year = Number(String(r.start_date).slice(0, 4));
  const balances = await leave.getBalances(r.user_id, year);
  res.json({ request: r, balances });
}));

// Generate & Download A4 English Leave Application PDF
router.get('/requests/:id/pdf', wrap(async (req, res) => {
  const reqId = parse(id, req.params.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Leave_Application_${reqId}.pdf"`);
  await leave.generateLeaveApplicationPdf(reqId, res);
}));

// Download Official Blank Leave Application Form (A4 PDF)
router.get('/blank-form/pdf', wrap(async (req, res) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="JMCL_Leave_Application_Form_Blank.pdf"');
  await leave.generateBlankLeaveFormPdf(res);
}));

// Submit Digital Leave Application (by employee or on behalf)
router.post('/requests', wrap(async (req, res) => {
  const canActForOthers = canEdit(req.user, 'leave') || isManager(req.user);
  const targetUserId = req.body.userId && canActForOthers ? parse(id, req.body.userId) : req.user.id;

  const b = parse(z.object({
    userId: id.optional(),
    leaveTypeId: id,
    startDate: date,
    endDate: date,
    halfDay: z.boolean().default(false),
    reason: z.string().trim().max(1000).default(''),
    addressDuringLeave: z.string().trim().max(300).optional(),
    contactNumber: z.string().trim().max(50).optional(),
    documentUrl: z.string().trim().max(500).optional(),
    applicantSignature: z.string().trim().max(100).optional(),
    status: z.enum(['pending', 'recommended', 'approved']).optional(),
  }), req.body);

  const created = await leave.createApplication(req.user, {
    userId: targetUserId,
    leaveTypeId: b.leaveTypeId,
    startDate: b.startDate,
    endDate: b.endDate,
    halfDay: b.halfDay,
    reason: b.reason,
    addressDuringLeave: b.addressDuringLeave,
    contactNumber: b.contactNumber,
    documentUrl: b.documentUrl,
    applicantSignature: b.applicantSignature || req.user.name,
    status: (canActForOthers && b.status) ? b.status : 'pending',
  });

  res.status(201).json({ request: created });
}));

// Admin direct create
router.post('/admin-create', leaveReviewer, wrap(async (req, res) => {
  const b = parse(z.object({
    userId: id,
    leaveTypeId: id,
    startDate: date,
    endDate: date,
    halfDay: z.boolean().default(false),
    reason: z.string().trim().max(1000).default(''),
    addressDuringLeave: z.string().trim().max(300).optional(),
    contactNumber: z.string().trim().max(50).optional(),
    status: z.enum(['pending', 'recommended', 'approved']).default('approved'),
  }), req.body);

  const created = await leave.createApplication(req.user, b);
  res.status(201).json({ request: created });
}));

// Department Head Recommendation
router.post('/requests/:id/recommend', leaveReviewer, wrap(async (req, res) => {
  const reqId = parse(id, req.params.id);
  const b = parse(z.object({
    decision: z.enum(['recommended', 'rejected']),
    remarks: z.string().trim().max(500).optional(),
    signature: z.string().trim().max(100).optional(),
  }), req.body);

  const updated = await leave.recommend(reqId, req.user, {
    decision: b.decision,
    remarks: b.remarks || '',
    signature: b.signature || req.user.name,
  });
  res.json({ request: updated });
}));

// Admin Head Final Approval
router.post('/requests/:id/final-approve', adminHeadOnly, wrap(async (req, res) => {
  const reqId = parse(id, req.params.id);
  const b = parse(z.object({
    decision: z.enum(['approved', 'rejected']),
    remarks: z.string().trim().max(500).optional(),
    signature: z.string().trim().max(100).optional(),
  }), req.body);

  const updated = await leave.finalApprove(reqId, req.user, {
    decision: b.decision,
    remarks: b.remarks || '',
    signature: b.signature || req.user.name,
  });
  res.json({ request: updated });
}));

const noteSchema = z.object({ note: z.string().trim().max(300).optional() });
router.post('/requests/:id/approve', leaveReviewer, wrap(async (req, res) => {
  res.json(await leave.finalApprove(parse(id, req.params.id), req.user, { decision: 'approved', remarks: parse(noteSchema, req.body ?? {}).note }));
}));

router.post('/requests/:id/reject', leaveReviewer, wrap(async (req, res) => {
  res.json(await leave.finalApprove(parse(id, req.params.id), req.user, { decision: 'rejected', remarks: parse(noteSchema, req.body ?? {}).note }));
}));

router.post('/requests/:id/cancel', wrap(async (req, res) => {
  res.json(await leave.cancel(parse(id, req.params.id), req.user));
}));

router.put('/requests/:id', leaveReviewer, wrap(async (req, res) => {
  const reqId = parse(id, req.params.id);
  const b = parse(z.object({
    leaveTypeId: id.optional(),
    startDate: date.optional(),
    endDate: date.optional(),
    halfDay: z.boolean().optional(),
    reason: z.string().trim().max(1000).optional(),
    status: z.enum(['pending', 'recommended', 'approved', 'rejected', 'cancelled']).optional(),
  }), req.body);

  const updated = await leave.adminUpdateRequest(reqId, req.user, b);
  res.json({ request: updated });
}));

router.delete('/requests/:id', leaveReviewer, wrap(async (req, res) => {
  const reqId = parse(id, req.params.id);
  const result = await leave.adminDeleteRequest(reqId, req.user);
  res.json(result);
}));

module.exports = router;
