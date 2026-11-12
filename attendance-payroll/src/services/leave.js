'use strict';
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { query, tx } = require('../db');
const { HttpError, bad, conflict, forbidden, notFound } = require('../utils/http');
const { eachDay, dow, todayIn } = require('../utils/time');
const { getSettings } = require('./settings');
const { rebuildRange } = require('./attendance');
const { notifyManagers, notifyUsers } = require('./notifications');

function registerFonts(doc) {
  const regular = process.env.PDF_FONT;
  const bold = process.env.PDF_FONT_BOLD || regular;
  if (regular && fs.existsSync(regular)) {
    doc.registerFont('Body', regular);
    doc.registerFont('Body-Bold', bold && fs.existsSync(bold) ? bold : regular);
    return { regular: 'Body', bold: 'Body-Bold' };
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold' };
}

/** Create balance rows for every quota-tracked leave type for a user/year (idempotent). */
async function ensureBalances(userId, year, db = { query }) {
  await db.query(
    `INSERT INTO leave_balances (user_id, leave_type_id, year, allocated)
     SELECT $1, id, $2, annual_quota FROM leave_types WHERE active AND annual_quota IS NOT NULL
     ON CONFLICT DO NOTHING`, [userId, year]);
}

async function getBalances(userId, year) {
  await ensureBalances(userId, year);
  const { rows } = await query(
    `SELECT lt.id AS leave_type_id, lt.name, lt.paid, b.allocated, b.used,
            COALESCE((SELECT SUM(days) FROM leave_requests r
                       WHERE r.user_id = b.user_id AND r.leave_type_id = b.leave_type_id
                         AND r.status IN ('pending', 'recommended') AND EXTRACT(YEAR FROM r.start_date) = b.year), 0) AS pending
       FROM leave_balances b JOIN leave_types lt ON lt.id = b.leave_type_id
      WHERE b.user_id = $1 AND b.year = $2 AND lt.active
      ORDER BY lt.id`, [userId, year]);
  return rows.map((r) => ({ ...r, remaining: Number((r.allocated - r.used).toFixed(1)), available: Number((r.allocated - r.used - r.pending).toFixed(1)) }));
}

/** Working days in [start, end] for this employee: excludes their weekly off days and company holidays. */
async function countWorkingDays(userId, start, end, db = { query }) {
  const [{ rows: u }, { rows: h }] = await Promise.all([
    db.query('SELECT s.weekly_off FROM users u LEFT JOIN shifts s ON s.id = u.shift_id WHERE u.id = $1', [userId]),
    db.query('SELECT date::text AS date FROM holidays WHERE date BETWEEN $1 AND $2', [start, end]),
  ]);
  const off = u[0]?.weekly_off || [5]; // default Friday off
  const holidays = new Set(h.map((x) => x.date));
  return eachDay(start, end).filter((d) => !off.includes(dow(d)) && dow(d) !== 5 && !holidays.has(d)).length;
}

/** Employee self-service application creation */
async function createRequest(user, data) {
  return createApplication(user, { ...data, userId: user.id });
}

/** Full Digital Leave Application Creation (Self or On Behalf) */
async function createApplication(actor, {
  userId, leaveTypeId, startDate, endDate, halfDay, reason,
  addressDuringLeave, contactNumber, documentUrl, applicantSignature, status
}) {
  const targetUserId = userId || actor.id;
  if (endDate < startDate) throw bad('End date must be on or after the start date');
  if (startDate.slice(0, 4) !== endDate.slice(0, 4)) throw bad('A request cannot span two calendar years — submit one request per year');
  if (halfDay && startDate !== endDate) throw bad('A half-day request must be for a single day');
  const year = Number(startDate.slice(0, 4));

  const { rows: [u] } = await query('SELECT * FROM users WHERE id = $1', [targetUserId]);
  if (!u) throw notFound('Employee not found');

  const { rows: [type] } = await query('SELECT * FROM leave_types WHERE id = $1 AND active', [leaveTypeId]);
  if (!type) throw bad('Unknown or inactive leave type');

  const working = await countWorkingDays(targetUserId, startDate, endDate);
  if (working === 0) throw bad('The selected dates are all weekly offs (Friday) or holidays — nothing to request');
  const days = halfDay ? 0.5 : working;

  // Check overlapping active requests
  const { rows: overlap } = await query(
    `SELECT id FROM leave_requests WHERE user_id = $1 AND status IN ('pending', 'recommended', 'approved')
        AND start_date <= $3 AND end_date >= $2 LIMIT 1`, [targetUserId, startDate, endDate]);
  if (overlap.length) throw conflict('An active or approved leave application already overlaps these dates');

  if (type.annual_quota !== null) {
    const balances = await getBalances(targetUserId, year);
    const b = balances.find((x) => x.leave_type_id === type.id);
    if (!b || b.available < days) {
      throw conflict(`Not enough ${type.name} balance: ${b ? b.available : 0} day(s) available, ${days} requested`);
    }
  }

  const reqStatus = ['approved', 'recommended', 'pending'].includes(status) ? status : 'pending';
  const initialAudit = [
    {
      action: 'applied',
      by: actor.name,
      role: actor.role,
      at: new Date().toISOString(),
      note: reason || 'Application submitted'
    }
  ];

  if (reqStatus === 'approved') {
    initialAudit.push({
      action: 'approved',
      by: actor.name,
      role: actor.role,
      at: new Date().toISOString(),
      note: 'Immediate direct approval by authorized administrator'
    });
  }

  const req = await tx(async (db) => {
    if (reqStatus === 'approved' && type.annual_quota !== null) {
      await ensureBalances(targetUserId, year, db);
      await db.query(
        `UPDATE leave_balances SET used = used + $4 WHERE user_id = $1 AND leave_type_id = $2 AND year = $3`,
        [targetUserId, type.id, year, days]);
    }

    const { rows: [newReq] } = await db.query(
      `INSERT INTO leave_requests (
         user_id, leave_type_id, start_date, end_date, half_day, days, reason,
         address_during_leave, contact_number, document_url, applicant_signature,
         status, reviewed_by, reviewed_at, review_note,
         admin_head_id, admin_head_name, admin_head_decision, admin_head_remarks, admin_head_signed_at, admin_head_signature,
         audit_history
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11,
         $12, $13, CASE WHEN $12 = 'approved' THEN now() ELSE NULL END, $14,
         $15, $16, $17, $18, CASE WHEN $12 = 'approved' THEN now() ELSE NULL END, $19,
         $20::jsonb
       ) RETURNING *`,
      [
        targetUserId, type.id, startDate, endDate, !!halfDay, days, reason || '',
        addressDuringLeave || '', contactNumber || u.phone || '', documentUrl || '', applicantSignature || u.name,
        reqStatus, reqStatus === 'approved' ? actor.id : null, reqStatus === 'approved' ? `Approved by ${actor.name}` : null,
        reqStatus === 'approved' ? actor.id : null, reqStatus === 'approved' ? actor.name : '', reqStatus === 'approved' ? 'approved' : 'pending',
        reqStatus === 'approved' ? 'Approved directly' : '', reqStatus === 'approved' ? actor.name : '',
        JSON.stringify(initialAudit)
      ]
    );
    return newReq;
  });

  if (reqStatus === 'approved') {
    await rebuildRange(startDate, endDate, { userId: targetUserId });
  }

  await notifyManagers({
    type: 'leave', severity: 'info', title: `Leave Application: ${u.name}`,
    body: `${type.name}, ${startDate}${startDate !== endDate ? ' to ' + endDate : ''} (${days} days) - ${reqStatus.toUpperCase()}`,
    url: '/leave', dedupe: `leave-req:${req.id}`,
  });

  return req;
}

/** Department Head Recommendation Step */
async function recommend(requestId, deptHead, { decision, remarks, signature }) {
  if (!['recommended', 'rejected'].includes(decision)) throw bad('Decision must be recommended or rejected');

  const result = await tx(async (db) => {
    const { rows: [r] } = await db.query(
      `SELECT lr.*, lt.name AS type_name, lt.annual_quota, u.name AS user_name
         FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id JOIN users u ON u.id = lr.user_id
        WHERE lr.id = $1 FOR UPDATE OF lr`, [requestId]);
    if (!r) throw notFound('Leave application not found');
    if (r.status !== 'pending') throw conflict(`Application is already ${r.status}`);

    const audit = Array.isArray(r.audit_history) ? r.audit_history : [];
    audit.push({
      action: decision,
      by: deptHead.name,
      role: deptHead.role,
      at: new Date().toISOString(),
      remarks: remarks || ''
    });

    const newStatus = decision === 'recommended' ? 'recommended' : 'rejected';

    const { rows: [updated] } = await db.query(
      `UPDATE leave_requests
          SET status = $2,
              dept_head_id = $3,
              dept_head_name = $4,
              dept_head_recommendation = $5,
              dept_head_remarks = $6,
              dept_head_signed_at = now(),
              dept_head_signature = $7,
              audit_history = $8::jsonb
        WHERE id = $1
        RETURNING *`,
      [
        requestId, newStatus, deptHead.id, deptHead.name, decision,
        remarks || '', signature || deptHead.name, JSON.stringify(audit)
      ]
    );
    return { r, updated };
  });

  await notifyUsers([result.r.user_id], {
    type: 'leave',
    severity: decision === 'recommended' ? 'info' : 'warning',
    title: `Leave Application ${decision === 'recommended' ? 'Recommended by Dept Head' : 'Rejected'}`,
    body: `${result.r.type_name}: ${result.r.start_date} (${result.r.days}d)${remarks ? ' — ' + remarks : ''}`,
    url: '/leave',
    dedupe: `leave-rec:${requestId}`,
  });

  return result.updated;
}

/** Admin Head Final Approval Step */
async function finalApprove(requestId, adminHead, { decision, remarks, signature }) {
  if (!['approved', 'rejected'].includes(decision)) throw bad('Decision must be approved or rejected');

  const result = await tx(async (db) => {
    const { rows: [r] } = await db.query(
      `SELECT lr.*, lt.name AS type_name, lt.annual_quota, u.name AS user_name
         FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id JOIN users u ON u.id = lr.user_id
        WHERE lr.id = $1 FOR UPDATE OF lr`, [requestId]);
    if (!r) throw notFound('Leave application not found');
    if (r.status === 'approved') throw conflict('Application is already approved');

    const year = Number(String(r.start_date).slice(0, 4));

    if (decision === 'approved' && r.annual_quota !== null) {
      await ensureBalances(r.user_id, year, db);
      const { rows: [b] } = await db.query(
        `SELECT allocated, used FROM leave_balances WHERE user_id = $1 AND leave_type_id = $2 AND year = $3 FOR UPDATE`,
        [r.user_id, r.leave_type_id, year]);
      if (!b || (b.allocated - b.used) < r.days) {
        throw conflict(`Insufficient ${r.type_name} balance (${b ? b.allocated - b.used : 0} days remaining, ${r.days} requested)`);
      }
      await db.query(
        `UPDATE leave_balances SET used = used + $4 WHERE user_id = $1 AND leave_type_id = $2 AND year = $3`,
        [r.user_id, r.leave_type_id, year, r.days]);
    }

    const audit = Array.isArray(r.audit_history) ? r.audit_history : [];
    audit.push({
      action: decision,
      by: adminHead.name,
      role: adminHead.role,
      at: new Date().toISOString(),
      remarks: remarks || ''
    });

    const { rows: [updated] } = await db.query(
      `UPDATE leave_requests
          SET status = $2,
              reviewed_by = $3,
              reviewed_at = now(),
              review_note = $4,
              admin_head_id = $3,
              admin_head_name = $5,
              admin_head_decision = $2,
              admin_head_remarks = $4,
              admin_head_signed_at = now(),
              admin_head_signature = $6,
              audit_history = $7::jsonb
        WHERE id = $1
        RETURNING *`,
      [
        requestId, decision, adminHead.id, remarks || null,
        adminHead.name, signature || adminHead.name, JSON.stringify(audit)
      ]
    );
    return { r, updated };
  });

  if (decision === 'approved') {
    await rebuildRange(result.r.start_date, result.r.end_date, { userId: result.r.user_id });
  }

  await notifyUsers([result.r.user_id], {
    type: 'leave',
    severity: decision === 'approved' ? 'info' : 'warning',
    title: `Leave ${decision === 'approved' ? 'Final Approved' : 'Rejected by Admin Head'}`,
    body: `${result.r.type_name}: ${result.r.start_date} (${result.r.days}d)${remarks ? ' — ' + remarks : ''}`,
    url: '/leave',
    dedupe: `leave-final:${requestId}`,
  });

  return result.updated;
}

/** Quick Review wrapper */
async function review(requestId, reviewer, decision, note) {
  if (['approved', 'rejected'].includes(decision)) {
    return finalApprove(requestId, reviewer, { decision, remarks: note, signature: reviewer.name });
  } else if (decision === 'recommended') {
    return recommend(requestId, reviewer, { decision: 'recommended', remarks: note, signature: reviewer.name });
  }
  throw bad('Invalid decision');
}

/** Owner can cancel a pending/recommended request; HR/Admin can also cancel an approved one */
async function cancel(requestId, actor) {
  const result = await tx(async (db) => {
    const { rows: [r] } = await db.query(
      `SELECT lr.*, lt.annual_quota FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
        WHERE lr.id = $1 FOR UPDATE OF lr`, [requestId]);
    if (!r) throw notFound('Leave request not found');
    const isOwner = r.user_id === actor.id;
    const isManager = ['admin', 'super_admin', 'company_admin', 'hr_manager', 'hr'].includes(actor.role);
    if (!isOwner && !isManager) throw forbidden();
    if (r.status === 'approved' && !isManager) throw forbidden('Only HR or Admin can cancel an approved leave');
    if (!['pending', 'recommended', 'approved'].includes(r.status)) throw conflict(`This request is already ${r.status}`);

    if (r.status === 'approved' && r.annual_quota !== null) {
      await db.query(
        `UPDATE leave_balances SET used = GREATEST(0, used - $4) WHERE user_id = $1 AND leave_type_id = $2 AND year = $3`,
        [r.user_id, r.leave_type_id, Number(String(r.start_date).slice(0, 4)), r.days]);
    }

    const audit = Array.isArray(r.audit_history) ? r.audit_history : [];
    audit.push({
      action: 'cancelled',
      by: actor.name,
      role: actor.role,
      at: new Date().toISOString(),
      note: 'Application cancelled and withdrawn'
    });

    await db.query(`UPDATE leave_requests SET status = 'cancelled', audit_history = $2::jsonb WHERE id = $1`, [requestId, JSON.stringify(audit)]);
    return r;
  });
  if (result.status === 'approved') await rebuildRange(result.start_date, result.end_date, { userId: result.user_id });
  return { id: requestId, status: 'cancelled' };
}

/** Admin updates an existing leave request (dates, type, status, reason) */
async function adminUpdateRequest(requestId, actor, { leaveTypeId, startDate, endDate, halfDay, reason, status }) {
  const result = await tx(async (db) => {
    const { rows: [old] } = await db.query(
      `SELECT lr.*, lt.annual_quota FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE lr.id = $1 FOR UPDATE OF lr`,
      [requestId]
    );
    if (!old) throw notFound('Leave request not found');

    const newStart = startDate || old.start_date;
    const newEnd = endDate || old.end_date;
    const newTypeId = leaveTypeId || old.leave_type_id;
    const newStatus = status || old.status;
    const newHalf = halfDay !== undefined ? !!halfDay : old.half_day;
    const newReason = reason !== undefined ? reason : old.reason;

    const working = await countWorkingDays(old.user_id, newStart, newEnd, db);
    const newDays = newHalf ? 0.5 : (working || old.days);

    // If it was previously approved and deducted balance, restore old days
    const oldYear = Number(String(old.start_date).slice(0, 4));
    if (old.status === 'approved' && old.annual_quota !== null) {
      await db.query(
        `UPDATE leave_balances SET used = GREATEST(0, used - $4) WHERE user_id = $1 AND leave_type_id = $2 AND year = $3`,
        [old.user_id, old.leave_type_id, oldYear, old.days]
      );
    }

    // If newly approved, deduct new days
    const newYear = Number(String(newStart).slice(0, 4));
    const { rows: [targetType] } = await db.query('SELECT * FROM leave_types WHERE id = $1', [newTypeId]);
    if (newStatus === 'approved' && targetType && targetType.annual_quota !== null) {
      await ensureBalances(old.user_id, newYear, db);
      await db.query(
        `UPDATE leave_balances SET used = used + $4 WHERE user_id = $1 AND leave_type_id = $2 AND year = $3`,
        [old.user_id, newTypeId, newYear, newDays]
      );
    }

    const audit = Array.isArray(old.audit_history) ? old.audit_history : [];
    audit.push({
      action: 'edited',
      by: actor.name,
      role: actor.role,
      at: new Date().toISOString(),
      note: `Updated status to ${newStatus}, dates: ${newStart} to ${newEnd}`
    });

    const { rows: [updated] } = await db.query(
      `UPDATE leave_requests
          SET leave_type_id = $2, start_date = $3, end_date = $4, half_day = $5, days = $6, reason = $7, status = $8,
              reviewed_by = CASE WHEN $8 = 'approved' THEN COALESCE(reviewed_by, $9) ELSE reviewed_by END,
              reviewed_at = CASE WHEN $8 = 'approved' THEN COALESCE(reviewed_at, now()) ELSE reviewed_at END,
              audit_history = $10::jsonb
        WHERE id = $1
        RETURNING *`,
      [requestId, newTypeId, newStart, newEnd, newHalf, newDays, newReason, newStatus, actor.id, JSON.stringify(audit)]
    );

    return { old, updated };
  });

  const minDate = result.old.start_date < result.updated.start_date ? result.old.start_date : result.updated.start_date;
  const maxDate = result.old.end_date > result.updated.end_date ? result.old.end_date : result.updated.end_date;
  await rebuildRange(minDate, maxDate, { userId: result.old.user_id });

  return result.updated;
}

/** Admin deletes a leave request permanently */
async function adminDeleteRequest(requestId, actor) {
  const result = await tx(async (db) => {
    const { rows: [r] } = await db.query(
      `SELECT lr.*, lt.annual_quota FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id WHERE lr.id = $1 FOR UPDATE OF lr`,
      [requestId]
    );
    if (!r) throw notFound('Leave request not found');

    if (r.status === 'approved' && r.annual_quota !== null) {
      const year = Number(String(r.start_date).slice(0, 4));
      await db.query(
        `UPDATE leave_balances SET used = GREATEST(0, used - $4) WHERE user_id = $1 AND leave_type_id = $2 AND year = $3`,
        [r.user_id, r.leave_type_id, year, r.days]
      );
    }

    await db.query('DELETE FROM leave_requests WHERE id = $1', [requestId]);
    return r;
  });

  if (result.status === 'approved') {
    await rebuildRange(result.start_date, result.end_date, { userId: result.user_id });
  }

  return { id: requestId, deleted: true };
}

/** Get all employee balances for a year */
async function getAllBalances(year) {
  const y = parseInt(year, 10) || new Date().getUTCFullYear();
  const { rows } = await query(`
    SELECT u.id AS user_id, u.name, u.employee_code, u.department, u.section, u.designation,
           COALESCE(
             json_agg(
               json_build_object(
                 'leave_type_id', lt.id,
                 'name', lt.name,
                 'allocated', COALESCE(b.allocated, lt.annual_quota, 0),
                 'used', COALESCE(b.used, 0),
                 'remaining', (COALESCE(b.allocated, lt.annual_quota, 0) - COALESCE(b.used, 0))
               ) ORDER BY lt.id
             ) FILTER (WHERE lt.id IS NOT NULL), '[]'
           ) AS balances
      FROM users u
      CROSS JOIN leave_types lt
      LEFT JOIN leave_balances b ON b.user_id = u.id AND b.leave_type_id = lt.id AND b.year = $1
     WHERE u.active = true AND lt.active = true AND lt.annual_quota IS NOT NULL
     GROUP BY u.id, u.name, u.employee_code, u.department, u.section, u.designation
     ORDER BY u.name ASC
  `, [y]);
  return rows;
}

/** Update employee leave balance */
async function updateUserBalance(userId, leaveTypeId, year, allocated, used) {
  await query(`
    INSERT INTO leave_balances (user_id, leave_type_id, year, allocated, used)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, leave_type_id, year)
    DO UPDATE SET allocated = EXCLUDED.allocated, used = EXCLUDED.used
  `, [userId, leaveTypeId, year, allocated, used]);
  return { ok: true };
}

/**
 * Generate Professional A4 English Printable Leave Application PDF
 */
async function generateLeaveApplicationPdf(requestId, res) {
  const { rows: [r] } = await query(`
    SELECT lr.*, lt.name AS type_name, lt.paid,
           u.name AS emp_name, u.employee_code, u.department, u.designation,
           COALESCE(u.section, u.department, 'Main Section') AS section,
           u.join_date::text AS join_date, u.phone, u.email
      FROM leave_requests lr
      JOIN users u ON u.id = lr.user_id
      JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE lr.id = $1
  `, [requestId]);

  if (!r) throw notFound('Leave application record not found');

  const year = Number(String(r.start_date).slice(0, 4));
  const balances = await getBalances(r.user_id, year);

  // Setup Document
  const doc = new PDFDocument({
    size: 'A4',
    margin: 36,
    info: {
      Title: `Leave Application - ${r.employee_code} - ${r.emp_name}`,
      Author: 'Jeans Manufacturing Company Ltd.',
      Subject: 'Official Employee Leave Application Form'
    }
  });

  const f = registerFonts(doc);
  doc.pipe(res);

  const left = 36;
  const width = doc.page.width - 72; // ~523 pt
  const pageHeight = doc.page.height;

  // Colors
  const NAVY = '#0F2942';
  const LIGHT_BLUE = '#F0F9FF';
  const BORDER_COLOR = '#CBD5E1';
  const TEXT_DARK = '#0F172A';
  const TEXT_MUTED = '#475569';

  // --- HEADER BANNER ---
  doc.rect(left, 36, width, 4).fill(NAVY);

  // Company Name & Subtitle
  doc.font(f.bold).fontSize(16).fillColor(NAVY)
    .text('JEANS MANUFACTURING COMPANY LTD.', left, 46, { align: 'center', width });
  doc.font(f.regular).fontSize(9).fillColor(TEXT_MUTED)
    .text('Corporate & Factory Office • Hemayetpur, Savar, Dhaka, Bangladesh • Phone: +880-2-7744112', left, 66, { align: 'center', width });

  // Document Title Box
  const titleY = 82;
  doc.rect(left, titleY, width, 24).fill(LIGHT_BLUE);
  doc.rect(left, titleY, width, 24).strokeColor(BORDER_COLOR).lineWidth(0.8).stroke();
  doc.font(f.bold).fontSize(11).fillColor(NAVY)
    .text('LEAVE APPLICATION & APPROVAL FORM', left, titleY + 6, { align: 'center', width });

  // Reference Metadata Bar
  const refY = 112;
  doc.font(f.regular).fontSize(8.5).fillColor(TEXT_MUTED)
    .text(`Application Ref: `, left, refY, { continued: true })
    .font(f.bold).fillColor(TEXT_DARK).text(`JMCL-LA-${String(r.id).padStart(5, '0')}`)
    .font(f.regular).fillColor(TEXT_MUTED)
    .text(`Applied Date: `, left + 340, refY, { continued: true })
    .font(f.bold).fillColor(TEXT_DARK).text(`${r.applied_at ? String(r.applied_at).slice(0, 10) : String(r.created_at).slice(0, 10)}`);

  // --- SECTION 1: EMPLOYEE INFORMATION ---
  let curY = 130;
  doc.rect(left, curY, width, 18).fill('#E2E8F0');
  doc.font(f.bold).fontSize(9.5).fillColor(NAVY)
    .text('1. EMPLOYEE INFORMATION', left + 8, curY + 4);
  curY += 18;

  const rowHeight = 20;
  const col1 = left;
  const col1W = 130;
  const col2 = left + 130;
  const col2W = 130;
  const col3 = left + 260;
  const col3W = 130;
  const col4 = left + 390;
  const col4W = width - 390;

  const drawInfoRow = (y, l1, v1, l2, v2) => {
    doc.rect(left, y, width, rowHeight).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
    doc.rect(left, y, col1W, rowHeight).fill('#F8FAFC');
    doc.rect(col3, y, col3W, rowHeight).fill('#F8FAFC');

    doc.font(f.regular).fontSize(8.5).fillColor(TEXT_MUTED).text(l1, col1 + 6, y + 5);
    doc.font(f.bold).fontSize(9).fillColor(TEXT_DARK).text(v1 || '—', col2 + 6, y + 5, { width: col2W - 10, lineBreak: false });

    doc.font(f.regular).fontSize(8.5).fillColor(TEXT_MUTED).text(l2, col3 + 6, y + 5);
    doc.font(f.bold).fontSize(9).fillColor(TEXT_DARK).text(v2 || '—', col4 + 6, y + 5, { width: col4W - 10, lineBreak: false });
  };

  drawInfoRow(curY, 'Employee ID:', r.employee_code || `EMP-${r.user_id}`, 'Full Name:', r.emp_name);
  curY += rowHeight;
  drawInfoRow(curY, 'Department:', r.department || 'General', 'Designation:', r.designation || 'Staff');
  curY += rowHeight;
  drawInfoRow(curY, 'Section / Unit:', r.section || r.department || 'Main Unit', 'Joining Date:', r.join_date || '—');
  curY += rowHeight;
  drawInfoRow(curY, 'Contact Number:', r.phone || r.contact_number || '—', 'Official Email:', r.email || '—');
  curY += rowHeight + 10;

  // --- SECTION 2: LEAVE APPLICATION PARTICULARS ---
  doc.rect(left, curY, width, 18).fill('#E2E8F0');
  doc.font(f.bold).fontSize(9.5).fillColor(NAVY)
    .text('2. LEAVE DETAILS & APPLICATION PARTICULARS', left + 8, curY + 4);
  curY += 18;

  drawInfoRow(curY, 'Leave Type:', `${r.type_name} ${r.paid ? '(Paid)' : '(Unpaid)'}`, 'Duration:', r.half_day ? 'Half Day (0.5 Day)' : 'Full Day');
  curY += rowHeight;
  drawInfoRow(curY, 'Start Date (From):', r.start_date, 'End Date (To):', r.end_date);
  curY += rowHeight;
  drawInfoRow(curY, 'Total Working Days:', `${r.days} Day(s) (Excl. Friday & Holidays)`, 'Current Status:', (r.status || 'pending').toUpperCase());
  curY += rowHeight;

  // Reason Box
  const reasonH = 40;
  doc.rect(left, curY, width, reasonH).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
  doc.rect(left, curY, col1W, reasonH).fill('#F8FAFC');
  doc.font(f.regular).fontSize(8.5).fillColor(TEXT_MUTED).text('Reason for Leave:', col1 + 6, curY + 6);
  doc.font(f.regular).fontSize(9).fillColor(TEXT_DARK)
    .text(r.reason || 'Personal reasons / Urgent family affairs', col2 + 6, curY + 6, { width: width - col1W - 12 });
  curY += reasonH;

  // Address & Contact During Leave
  drawInfoRow(curY, 'Address During Leave:', r.address_during_leave || 'Present residence address', 'Emergency Phone:', r.contact_number || r.phone || '—');
  curY += rowHeight + 10;

  // Leave Balances Table Summary
  doc.rect(left, curY, width, 18).fill('#E2E8F0');
  doc.font(f.bold).fontSize(9.5).fillColor(NAVY)
    .text('3. EMPLOYEE LEAVE BALANCE SUMMARY (YEAR ' + year + ')', left + 8, curY + 4);
  curY += 18;

  const balW = width / Math.max(1, balances.length);
  doc.rect(left, curY, width, 28).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
  balances.forEach((b, idx) => {
    const bx = left + (idx * balW);
    if (idx > 0) doc.moveTo(bx, curY).lineTo(bx, curY + 28).strokeColor(BORDER_COLOR).stroke();
    doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text(b.name, bx + 6, curY + 4, { width: balW - 12 });
    doc.font(f.regular).fontSize(8).fillColor(TEXT_MUTED)
      .text(`Remaining: ${b.remaining}d | Used: ${b.used}d | Quota: ${b.allocated}d`, bx + 6, curY + 15, { width: balW - 12 });
  });
  curY += 38;

  // --- SECTION 4: THREE-TIER SIGNATURE & APPROVAL SECTION ---
  doc.rect(left, curY, width, 18).fill('#E2E8F0');
  doc.font(f.bold).fontSize(9.5).fillColor(NAVY)
    .text('4. VERIFICATION, RECOMMENDATION & APPROVAL RECORD', left + 8, curY + 4);
  curY += 22;

  const boxW = (width - 16) / 3;
  const boxH = 110;

  // Box 1: Employee
  const b1X = left;
  doc.rect(b1X, curY, boxW, boxH).strokeColor(BORDER_COLOR).lineWidth(0.8).stroke();
  doc.rect(b1X, curY, boxW, 18).fill(LIGHT_BLUE);
  doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text('APPLICANT / EMPLOYEE', b1X + 6, curY + 5);
  doc.font(f.regular).fontSize(8).fillColor(TEXT_MUTED).text('Signature & Acknowledgement', b1X + 6, curY + 24);

  doc.font(f.bold).fontSize(9).fillColor(TEXT_DARK).text(r.applicant_signature || r.emp_name, b1X + 6, curY + 45, { width: boxW - 12 });
  doc.font(f.regular).fontSize(8).fillColor(TEXT_MUTED).text(`Date: ${r.applied_at ? String(r.applied_at).slice(0, 10) : r.start_date}`, b1X + 6, curY + 60);

  doc.rect(b1X + 6, curY + 80, boxW - 12, 20).fill('#DCFCE7');
  doc.font(f.bold).fontSize(8).fillColor('#15803D').text('✓ DIGITALLY SUBMITTED', b1X + 10, curY + 85);

  // Box 2: Dept Head Recommendation
  const b2X = left + boxW + 8;
  doc.rect(b2X, curY, boxW, boxH).strokeColor(BORDER_COLOR).lineWidth(0.8).stroke();
  doc.rect(b2X, curY, boxW, 18).fill(LIGHT_BLUE);
  doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text('DEPARTMENT HEAD', b2X + 6, curY + 5);

  const deptRec = r.dept_head_recommendation || (r.status === 'recommended' || r.status === 'approved' ? 'recommended' : 'pending');
  const deptRecColor = deptRec === 'recommended' ? '#15803D' : deptRec === 'rejected' ? '#DC2626' : '#D97706';

  doc.font(f.regular).fontSize(8).fillColor(TEXT_MUTED).text('Recommendation & Remarks:', b2X + 6, curY + 24);
  doc.font(f.bold).fontSize(9).fillColor(deptRecColor).text(`Decision: ${deptRec.toUpperCase()}`, b2X + 6, curY + 36);
  doc.font(f.regular).fontSize(8).fillColor(TEXT_DARK).text(r.dept_head_remarks || r.review_note || 'Verified against department schedule.', b2X + 6, curY + 50, { width: boxW - 12 });

  doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text(`By: ${r.dept_head_name || 'Dept Manager'}`, b2X + 6, curY + 75);
  doc.font(f.regular).fontSize(7.5).fillColor(TEXT_MUTED).text(`Date: ${r.dept_head_signed_at ? String(r.dept_head_signed_at).slice(0, 10) : (r.status === 'approved' ? String(r.reviewed_at || '').slice(0, 10) : '—')}`, b2X + 6, curY + 88);

  // Box 3: Admin Head Final Approval
  const b3X = left + (boxW * 2) + 16;
  doc.rect(b3X, curY, boxW, boxH).strokeColor(BORDER_COLOR).lineWidth(0.8).stroke();
  doc.rect(b3X, curY, boxW, 18).fill(LIGHT_BLUE);
  doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text('ADMIN HEAD / FINAL APPROVAL', b3X + 6, curY + 5);

  const adminDecision = r.status === 'approved' ? 'APPROVED' : r.status === 'rejected' ? 'REJECTED' : 'PENDING';
  const adminColor = adminDecision === 'APPROVED' ? '#15803D' : adminDecision === 'REJECTED' ? '#DC2626' : '#D97706';

  doc.font(f.regular).fontSize(8).fillColor(TEXT_MUTED).text('Final Decision & Authorization:', b3X + 6, curY + 24);
  doc.font(f.bold).fontSize(10).fillColor(adminColor).text(adminDecision, b3X + 6, curY + 36);
  doc.font(f.regular).fontSize(8).fillColor(TEXT_DARK).text(r.admin_head_remarks || r.review_note || (r.status === 'approved' ? 'Authorized as per HR rules' : 'Pending final authorization'), b3X + 6, curY + 50, { width: boxW - 12 });

  doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text(`By: ${r.admin_head_name || 'Ali Hasan Sheikh (Admin)'}`, b3X + 6, curY + 75);
  doc.font(f.regular).fontSize(7.5).fillColor(TEXT_MUTED).text(`Date: ${r.admin_head_signed_at ? String(r.admin_head_signed_at).slice(0, 10) : (r.reviewed_at ? String(r.reviewed_at).slice(0, 10) : '—')}`, b3X + 6, curY + 88);

  curY += boxH + 16;

  // --- FOOTER NOTE & VERIFICATION ---
  doc.moveTo(left, curY).lineTo(left + width, curY).strokeColor('#E2E8F0').lineWidth(0.8).stroke();
  doc.font(f.regular).fontSize(7.5).fillColor(TEXT_MUTED)
    .text('Note: This document is an official computer-generated digital record produced by JMCL Staff Flow Pro. Approved leaves are automatically updated in attendance records and salary computation.', left, curY + 6, { width, align: 'center' });
  doc.font(f.bold).fontSize(7.5).fillColor(NAVY)
    .text(`Jeans Manufacturing Company Ltd. • Verification Token: JMCL-L-${r.id}-${year} • Generated: ${new Date().toUTCString()}`, left, curY + 18, { width, align: 'center' });

  doc.end();
}

/**
 * Generate Professional A4 English Blank Printable Leave Application Form
 */
async function generateBlankLeaveFormPdf(res) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 36,
    info: {
      Title: 'Blank Leave Application Form - Jeans Manufacturing Company Ltd.',
      Author: 'Jeans Manufacturing Company Ltd.',
      Subject: 'Official Blank Leave Application Form'
    }
  });

  const f = registerFonts(doc);
  doc.pipe(res);

  const left = 36;
  const width = doc.page.width - 72; // ~523 pt

  const NAVY = '#0F2942';
  const LIGHT_BLUE = '#F0F9FF';
  const BORDER_COLOR = '#CBD5E1';
  const TEXT_DARK = '#0F172A';
  const TEXT_MUTED = '#475569';

  // --- HEADER BANNER ---
  doc.rect(left, 36, width, 4).fill(NAVY);

  doc.font(f.bold).fontSize(16).fillColor(NAVY)
    .text('JEANS MANUFACTURING COMPANY LTD.', left, 46, { align: 'center', width });
  doc.font(f.regular).fontSize(9).fillColor(TEXT_MUTED)
    .text('Corporate & Factory Office • Hemayetpur, Savar, Dhaka, Bangladesh • Phone: +880-2-7744112', left, 66, { align: 'center', width });

  const titleY = 82;
  doc.rect(left, titleY, width, 24).fill(LIGHT_BLUE);
  doc.rect(left, titleY, width, 24).strokeColor(BORDER_COLOR).lineWidth(0.8).stroke();
  doc.font(f.bold).fontSize(11).fillColor(NAVY)
    .text('EMPLOYEE LEAVE APPLICATION & APPROVAL FORM', left, titleY + 6, { align: 'center', width });

  const refY = 112;
  doc.font(f.regular).fontSize(8.5).fillColor(TEXT_MUTED)
    .text(`Form Code: `, left, refY, { continued: true })
    .font(f.bold).fillColor(TEXT_DARK).text(`JMCL-LA-BLANK-A4`)
    .font(f.regular).fillColor(TEXT_MUTED)
    .text(`Application Date: `, left + 340, refY, { continued: true })
    .font(f.bold).fillColor(TEXT_DARK).text(`_____ / _____ / 2026`);

  // --- SECTION 1: EMPLOYEE INFORMATION ---
  let curY = 130;
  doc.rect(left, curY, width, 18).fill('#E2E8F0');
  doc.font(f.bold).fontSize(9.5).fillColor(NAVY)
    .text('1. EMPLOYEE INFORMATION (TO BE FILLED BY APPLICANT)', left + 8, curY + 4);
  curY += 18;

  const rowHeight = 22;
  const col1 = left;
  const col1W = 130;
  const col2 = left + 130;
  const col2W = 130;
  const col3 = left + 260;
  const col3W = 130;
  const col4 = left + 390;
  const col4W = width - 390;

  const drawBlankRow = (y, l1, l2) => {
    doc.rect(left, y, width, rowHeight).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
    doc.rect(left, y, col1W, rowHeight).fill('#F8FAFC');
    doc.rect(col3, y, col3W, rowHeight).fill('#F8FAFC');

    doc.font(f.regular).fontSize(8.5).fillColor(TEXT_MUTED).text(l1, col1 + 6, y + 6);
    doc.font(f.regular).fontSize(8.5).fillColor(TEXT_MUTED).text(l2, col3 + 6, y + 6);
  };

  drawBlankRow(curY, 'Employee ID:', 'Full Name:');
  curY += rowHeight;
  drawBlankRow(curY, 'Department:', 'Designation:');
  curY += rowHeight;
  drawBlankRow(curY, 'Section / Unit:', 'Joining Date:');
  curY += rowHeight;
  drawBlankRow(curY, 'Contact Number:', 'Official Email:');
  curY += rowHeight + 10;

  // --- SECTION 2: LEAVE APPLICATION PARTICULARS ---
  doc.rect(left, curY, width, 18).fill('#E2E8F0');
  doc.font(f.bold).fontSize(9.5).fillColor(NAVY)
    .text('2. LEAVE DETAILS & APPLICATION PARTICULARS', left + 8, curY + 4);
  curY += 18;

  // Type & Duration checkboxes
  doc.rect(left, curY, width, 26).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
  doc.rect(left, curY, col1W, 26).fill('#F8FAFC');
  doc.font(f.regular).fontSize(8.5).fillColor(TEXT_MUTED).text('Leave Category:', col1 + 6, curY + 8);
  doc.font(f.bold).fontSize(8.5).fillColor(TEXT_DARK)
    .text('[  ] Casual Leave (CL)      [  ] Sick Leave (SL)      [  ] Earned Leave (EL)      [  ] Unpaid Leave', col2 + 6, curY + 8);
  curY += 26;

  doc.rect(left, curY, width, 24).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
  doc.rect(left, curY, col1W, 24).fill('#F8FAFC');
  doc.font(f.regular).fontSize(8.5).fillColor(TEXT_MUTED).text('Duration Mode:', col1 + 6, curY + 7);
  doc.font(f.bold).fontSize(8.5).fillColor(TEXT_DARK)
    .text('[  ] Full Day Leave                         [  ] Half Day Leave (0.5 Working Day)', col2 + 6, curY + 7);
  curY += 24;

  drawBlankRow(curY, 'Start Date (From):', 'End Date (To):');
  curY += rowHeight;

  doc.rect(left, curY, width, rowHeight).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
  doc.rect(left, curY, col1W, rowHeight).fill('#F8FAFC');
  doc.font(f.regular).fontSize(8.5).fillColor(TEXT_MUTED).text('Total Working Days:', col1 + 6, curY + 6);
  doc.font(f.regular).fontSize(8.5).fillColor(TEXT_MUTED).text('_________ Working Days (Excluding Friday & Holidays)', col2 + 6, curY + 6);
  curY += rowHeight;

  // Reason Box
  const reasonH = 46;
  doc.rect(left, curY, width, reasonH).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
  doc.rect(left, curY, col1W, reasonH).fill('#F8FAFC');
  doc.font(f.regular).fontSize(8.5).fillColor(TEXT_MUTED).text('Reason for Leave:\n(Be specific)', col1 + 6, curY + 8);
  doc.font(f.regular).fontSize(8).fillColor(TEXT_MUTED)
    .text('_____________________________________________________________________________________________________\n_____________________________________________________________________________________________________', col2 + 6, curY + 12);
  curY += reasonH;

  drawBlankRow(curY, 'Address During Leave:', 'Emergency Phone:');
  curY += rowHeight + 10;

  // --- SECTION 3: LEAVE BALANCE STATUS (OFFICE USE) ---
  doc.rect(left, curY, width, 18).fill('#E2E8F0');
  doc.font(f.bold).fontSize(9.5).fillColor(NAVY)
    .text('3. LEAVE BALANCE STATUS (FOR HR / OFFICE USE ONLY)', left + 8, curY + 4);
  curY += 18;

  const balW = width / 3;
  doc.rect(left, curY, width, 32).strokeColor(BORDER_COLOR).lineWidth(0.5).stroke();
  doc.moveTo(left + balW, curY).lineTo(left + balW, curY + 32).strokeColor(BORDER_COLOR).stroke();
  doc.moveTo(left + (balW * 2), curY).lineTo(left + (balW * 2), curY + 32).strokeColor(BORDER_COLOR).stroke();

  doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text('Casual Leave (CL)', left + 8, curY + 5);
  doc.font(f.regular).fontSize(8).fillColor(TEXT_MUTED).text('Annual Quota: 10 Days\nUsed: _____d | Remaining: _____d', left + 8, curY + 16);

  doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text('Sick Leave (SL)', left + balW + 8, curY + 5);
  doc.font(f.regular).fontSize(8).fillColor(TEXT_MUTED).text('Annual Quota: 14 Days\nUsed: _____d | Remaining: _____d', left + balW + 8, curY + 16);

  doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text('Earned Leave (EL)', left + (balW * 2) + 8, curY + 5);
  doc.font(f.regular).fontSize(8).fillColor(TEXT_MUTED).text('Annual Quota: 15 Days\nUsed: _____d | Remaining: _____d', left + (balW * 2) + 8, curY + 16);
  curY += 42;

  // --- SECTION 4: THREE-TIER SIGNATURE & APPROVAL SECTION ---
  doc.rect(left, curY, width, 18).fill('#E2E8F0');
  doc.font(f.bold).fontSize(9.5).fillColor(NAVY)
    .text('4. VERIFICATION, RECOMMENDATION & APPROVAL RECORD', left + 8, curY + 4);
  curY += 22;

  const boxW = (width - 16) / 3;
  const boxH = 115;

  // Box 1: Employee
  const b1X = left;
  doc.rect(b1X, curY, boxW, boxH).strokeColor(BORDER_COLOR).lineWidth(0.8).stroke();
  doc.rect(b1X, curY, boxW, 18).fill(LIGHT_BLUE);
  doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text('1. APPLICANT / EMPLOYEE', b1X + 6, curY + 5);
  doc.font(f.regular).fontSize(8).fillColor(TEXT_MUTED)
    .text('Applicant Signature:\n\n__________________________________\n\nFull Name:\n__________________________________\n\nDate: _____ / _____ / 2026', b1X + 6, curY + 24);

  // Box 2: Dept Head
  const b2X = left + boxW + 8;
  doc.rect(b2X, curY, boxW, boxH).strokeColor(BORDER_COLOR).lineWidth(0.8).stroke();
  doc.rect(b2X, curY, boxW, 18).fill(LIGHT_BLUE);
  doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text('2. DEPARTMENT HEAD', b2X + 6, curY + 5);
  doc.font(f.regular).fontSize(8).fillColor(TEXT_MUTED)
    .text('Recommendation:\n[  ] Recommended     [  ] Rejected\n\nRemarks:\n__________________________________\n\nSignature & Date:\n__________________________________', b2X + 6, curY + 24);

  // Box 3: Admin Head
  const b3X = left + (boxW * 2) + 16;
  doc.rect(b3X, curY, boxW, boxH).strokeColor(BORDER_COLOR).lineWidth(0.8).stroke();
  doc.rect(b3X, curY, boxW, 18).fill(LIGHT_BLUE);
  doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text('3. ADMIN HEAD / FINAL APPROVAL', b3X + 6, curY + 5);
  doc.font(f.regular).fontSize(8).fillColor(TEXT_MUTED)
    .text('Final Decision:\n[  ] Approved           [  ] Rejected\n\nRemarks:\n__________________________________\n\nAuthorized Signature & Stamp:\n__________________________________', b3X + 6, curY + 24);

  curY += boxH + 16;

  // --- FOOTER NOTE ---
  doc.moveTo(left, curY).lineTo(left + width, curY).strokeColor('#E2E8F0').lineWidth(0.8).stroke();
  doc.font(f.regular).fontSize(7.5).fillColor(TEXT_MUTED)
    .text('Jeans Manufacturing Company Ltd. • Staff Flow Pro HRMS • Official Standard Blank Form (A4)', left, curY + 6, { width, align: 'center' });

  doc.end();
}

module.exports = {
  ensureBalances,
  getBalances,
  countWorkingDays,
  createRequest,
  createApplication,
  recommend,
  finalApprove,
  review,
  cancel,
  adminUpdateRequest,
  adminDeleteRequest,
  getAllBalances,
  updateUserBalance,
  generateLeaveApplicationPdf,
  generateBlankLeaveFormPdf,
};
