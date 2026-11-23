'use strict';
const router = require('express').Router();
const { wrap, parse, bad, forbidden } = require('../utils/http');
const { canView, canEdit } = require('../middleware/auth');
const { z, date, month, id } = require('./schemas');
const {
  getStats,
  listAssignments,
  getCalendarData,
  previewAssignment,
  assignOffDays,
  deleteAssignment,
  bulkDeleteAssignments,
  exportAssignments,
} = require('../services/offDays');

router.use((req, res, next) => {
  if (
    canView(req.user, 'off_days') ||
    ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr_executive', 'hr', 'dept_manager', 'accounts_manager'].includes(req.user.role)
  ) {
    return next();
  }
  return next(forbidden('Your role cannot view off days'));
});

const editorOnly = (req, res, next) => {
  if (
    canEdit(req.user, 'off_days') ||
    ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr_executive', 'hr'].includes(req.user.role)
  ) {
    return next();
  }
  return next(forbidden('Your role cannot edit off days'));
};

/**
 * GET /api/off-days/stats
 */
router.get('/stats', wrap(async (req, res) => {
  const stats = await getStats();
  res.json({ stats });
}));

/**
 * GET /api/off-days/calendar?month=YYYY-MM&department=...
 */
router.get('/calendar', wrap(async (req, res) => {
  const q = parse(z.object({
    month: month.optional(),
    department: z.string().max(80).optional(),
  }), req.query);

  const data = await getCalendarData(q.month, { department: q.department });
  res.json(data);
}));

/**
 * GET /api/off-days/export?format=xlsx|pdf&from&to&department&userId&assignmentType
 */
router.get('/export', wrap(async (req, res) => {
  const q = parse(z.object({
    format: z.enum(['xlsx', 'pdf']).default('xlsx'),
    from: date.optional(),
    to: date.optional(),
    department: z.string().max(80).optional(),
    userId: id.optional(),
    assignmentType: z.string().max(30).optional(),
    q: z.string().max(100).optional(),
  }), req.query);

  const buffer = await exportAssignments(q);
  const stamp = new Date().toISOString().slice(0, 10);

  if (q.format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="OffDays-${stamp}.xlsx"`);
    return res.send(Buffer.from(buffer));
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="OffDays-${stamp}.pdf"`);
  return res.send(buffer);
}));

/**
 * GET /api/off-days?from&to&department&userId&assignmentType&q&limit&offset
 */
router.get('/', wrap(async (req, res) => {
  const q = parse(z.object({
    from: date.optional(),
    to: date.optional(),
    department: z.string().max(80).optional(),
    userId: id.optional(),
    assignmentType: z.string().max(30).optional(),
    q: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(200),
    offset: z.coerce.number().int().min(0).default(0),
  }), req.query);

  const data = await listAssignments(q);
  res.json(data);
}));

/**
 * POST /api/off-days/preview
 * Validate selections and check conflicts
 */
router.post('/preview', editorOnly, wrap(async (req, res) => {
  const body = parse(z.object({
    dates: z.array(date).min(1),
    departments: z.array(z.string()).optional().default([]),
    userIds: z.array(id).optional().default([]),
    excludeUserIds: z.array(id).optional().default([]),
  }), req.body);

  const preview = await previewAssignment(body);
  res.json(preview);
}));

/**
 * POST /api/off-days
 * Create or update off day assignments
 */
router.post('/', editorOnly, wrap(async (req, res) => {
  const body = parse(z.object({
    dates: z.array(date).min(1),
    departments: z.array(z.string()).optional().default([]),
    userIds: z.array(id).optional().default([]),
    excludeUserIds: z.array(id).optional().default([]),
    assignmentType: z.enum(['individual', 'department', 'bulk', 'excel_import']).default('individual'),
    reason: z.string().max(300).optional().default(''),
    department: z.string().max(80).nullable().optional(),
  }), req.body);

  const result = await assignOffDays({
    ...body,
    actorId: req.user.id,
  });

  res.json(result);
}));

/**
 * POST /api/off-days/import
 * Bulk upload / import records from spreadsheet rows
 */
router.post('/import', editorOnly, wrap(async (req, res) => {
  const body = parse(z.object({
    records: z.array(z.object({
      employeeCode: z.string().min(1),
      date: date,
      reason: z.string().optional().default('Imported from spreadsheet'),
    })).min(1),
  }), req.body);

  const { query: dbQuery } = require('../db');

  // Resolve employee codes to user IDs
  const codes = [...new Set(body.records.map((r) => r.employeeCode.trim()))];
  const { rows: users } = await dbQuery(`
    SELECT id, employee_code, department FROM users WHERE employee_code = ANY($1::text[])
  `, [codes]);

  const userMap = new Map(users.map((u) => [u.employee_code.toLowerCase(), u]));

  let inserted = 0;
  const skipped = [];
  const validDates = new Set();

  for (const item of body.records) {
    const u = userMap.get(item.employeeCode.trim().toLowerCase());
    if (!u) {
      skipped.push({ code: item.employeeCode, date: item.date, reason: 'Employee ID not found' });
      continue;
    }

    await assignOffDays({
      dates: [item.date],
      userIds: [u.id],
      assignmentType: 'excel_import',
      reason: item.reason || 'Imported via Excel/CSV',
      actorId: req.user.id,
      department: u.department,
    });

    validDates.add(item.date);
    inserted++;
  }

  res.json({
    success: true,
    importedCount: inserted,
    skippedCount: skipped.length,
    skipped,
  });
}));

/**
 * DELETE /api/off-days/:id
 */
router.delete('/:id', editorOnly, wrap(async (req, res) => {
  const targetId = Number(req.params.id);
  if (!targetId) throw bad('Invalid ID');
  const result = await deleteAssignment(targetId, req.user.id);
  res.json(result);
}));

/**
 * POST /api/off-days/bulk-delete
 */
router.post('/bulk-delete', editorOnly, wrap(async (req, res) => {
  const body = parse(z.object({
    ids: z.array(id).optional(),
    from: date.optional(),
    to: date.optional(),
    department: z.string().optional(),
    userIds: z.array(id).optional(),
  }), req.body);

  const result = await bulkDeleteAssignments({
    ...body,
    actorId: req.user.id,
  });

  res.json(result);
}));

module.exports = router;
