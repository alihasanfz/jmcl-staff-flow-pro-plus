'use strict';
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { query, tx } = require('../db');
const { bad, notFound } = require('../utils/http');
const { getSettings } = require('./settings');
const { todayIn, monthRange, eachDay, dow, addDays } = require('../utils/time');
const { rebuildRange } = require('./attendance');

/**
 * Ensure off_day_assignments table exists with full audit trail and indices.
 */
async function initOffDaysTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS off_day_assignments (
      id              bigserial PRIMARY KEY,
      user_id         int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date            date NOT NULL,
      department      text,
      assignment_type text NOT NULL CHECK (assignment_type IN ('individual', 'department', 'bulk', 'excel_import')),
      reason          text NOT NULL DEFAULT '',
      assigned_by     int REFERENCES users(id) ON DELETE SET NULL,
      updated_by     int REFERENCES users(id) ON DELETE SET NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, date)
    );
    CREATE INDEX IF NOT EXISTS off_day_assignments_date_idx ON off_day_assignments (date);
    CREATE INDEX IF NOT EXISTS off_day_assignments_user_idx ON off_day_assignments (user_id, date);
    CREATE INDEX IF NOT EXISTS off_day_assignments_dept_idx ON off_day_assignments (department);
  `).catch((err) => {
    console.error('[offDays] Table init warning:', err.message);
  });
}

/**
 * Summary Stats for the top dashboard cards.
 */
async function getStats() {
  await initOffDaysTable();
  const { timezone } = await getSettings();
  const today = todayIn(timezone);

  const { rows: [stats] } = await query(`
    SELECT
      COUNT(*)::int AS total_assignments,
      COUNT(DISTINCT department) FILTER (WHERE department IS NOT NULL AND department <> '')::int AS departments_covered,
      COUNT(DISTINCT user_id)::int AS employees_covered,
      COUNT(*) FILTER (WHERE date >= $1::date)::int AS upcoming_off_days
    FROM off_day_assignments
  `, [today]);

  return {
    totalAssignments: stats?.total_assignments || 0,
    departmentsCovered: stats?.departments_covered || 0,
    employeesCovered: stats?.employees_covered || 0,
    upcomingOffDays: stats?.upcoming_off_days || 0,
  };
}

/**
 * List assignments with pagination and rich filters.
 */
async function listAssignments({
  from,
  to,
  department,
  userId,
  assignmentType,
  q,
  limit = 200,
  offset = 0,
} = {}) {
  await initOffDaysTable();
  const { timezone } = await getSettings();

  const params = [];
  const whereClauses = [];

  if (from) {
    params.push(from);
    whereClauses.push(`o.date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    whereClauses.push(`o.date <= $${params.length}`);
  }
  if (department && department !== 'all') {
    params.push(department);
    whereClauses.push(`(u.department = $${params.length} OR o.department = $${params.length})`);
  }
  if (userId) {
    params.push(userId);
    whereClauses.push(`o.user_id = $${params.length}`);
  }
  if (assignmentType && assignmentType !== 'all') {
    params.push(assignmentType);
    whereClauses.push(`o.assignment_type = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const pIndex = params.length;
    whereClauses.push(`(
      LOWER(u.name) LIKE $${pIndex} OR
      LOWER(u.employee_code) LIKE $${pIndex} OR
      LOWER(COALESCE(u.department, '')) LIKE $${pIndex} OR
      LOWER(COALESCE(u.designation, '')) LIKE $${pIndex} OR
      LOWER(COALESCE(o.reason, '')) LIKE $${pIndex}
    )`);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // Get total count
  const { rows: [{ count }] } = await query(`
    SELECT COUNT(*)::int AS count
      FROM off_day_assignments o
      JOIN users u ON u.id = o.user_id
     ${whereSql}
  `, params);

  // Get paginated list
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const { rows } = await query(`
    SELECT
      o.id,
      o.date::text AS date,
      o.user_id,
      o.department,
      o.assignment_type,
      o.reason,
      o.created_at,
      o.updated_at,
      u.name AS employee_name,
      u.employee_code,
      u.designation,
      u.department AS user_department,
      u.photo,
      u.active,
      ab.name AS assigned_by_name,
      ub.name AS updated_by_name
    FROM off_day_assignments o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN users ab ON ab.id = o.assigned_by
    LEFT JOIN users ub ON ub.id = o.updated_by
    ${whereSql}
    ORDER BY o.date DESC, u.name ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `, params);

  return { total: count, rows };
}

/**
 * Calendar month view data with date-wise counts, badges, and assigned employees.
 */
async function getCalendarData(month, { department } = {}) {
  await initOffDaysTable();
  const { timezone } = await getSettings();
  const ym = month || todayIn(timezone).slice(0, 7);
  const { from, to } = monthRange(ym);

  const params = [from, to];
  let deptClause = '';
  if (department && department !== 'all') {
    params.push(department);
    deptClause = `AND (u.department = $3 OR o.department = $3)`;
  }

  const { rows } = await query(`
    SELECT
      o.id,
      o.date::text AS date,
      o.user_id,
      o.assignment_type,
      o.reason,
      u.name AS employee_name,
      u.employee_code,
      u.department AS employee_department,
      u.designation,
      u.photo
    FROM off_day_assignments o
    JOIN users u ON u.id = o.user_id
    WHERE o.date BETWEEN $1 AND $2 ${deptClause}
    ORDER BY o.date ASC, u.name ASC
  `, params);

  // Group by date
  const byDate = {};
  for (const date of eachDay(from, to)) {
    byDate[date] = {
      date,
      count: 0,
      departments: new Set(),
      types: new Set(),
      assignments: [],
    };
  }

  for (const r of rows) {
    if (!byDate[r.date]) {
      byDate[r.date] = { date: r.date, count: 0, departments: new Set(), types: new Set(), assignments: [] };
    }
    byDate[r.date].count += 1;
    if (r.employee_department) byDate[r.date].departments.add(r.employee_department);
    if (r.assignment_type) byDate[r.date].types.add(r.assignment_type);
    byDate[r.date].assignments.push({
      id: r.id,
      userId: r.user_id,
      name: r.employee_name,
      code: r.employee_code,
      department: r.employee_department,
      designation: r.designation,
      assignmentType: r.assignment_type,
      reason: r.reason,
      photo: r.photo,
    });
  }

  // Also query holidays in this month for context
  const { rows: holidays } = await query(`SELECT date::text AS date, name FROM holidays WHERE date BETWEEN $1 AND $2`, [from, to]);
  const holidayMap = Object.fromEntries(holidays.map((h) => [h.date, h.name]));

  const days = Object.values(byDate).map((d) => ({
    date: d.date,
    count: d.count,
    departments: Array.from(d.departments),
    types: Array.from(d.types),
    assignments: d.assignments,
    holiday: holidayMap[d.date] || null,
    isFriday: dow(d.date) === 5,
  }));

  return { month: ym, from, to, days };
}

/**
 * Preview affected employees and detect potential conflicts before saving.
 */
async function previewAssignment({
  dates = [],
  departments = [],
  userIds = [],
  excludeUserIds = [],
}) {
  await initOffDaysTable();
  if (!dates || !dates.length) throw bad('At least one date is required');

  const cleanDates = [...new Set(dates.map((d) => String(d).trim()))].sort();
  const cleanExclude = new Set((excludeUserIds || []).map(Number));

  // 1. Resolve target employees
  let targetUsers = [];
  if (userIds && userIds.length) {
    const { rows } = await query(`
      SELECT u.id, u.employee_code, u.name, u.department, u.designation, s.weekly_off
        FROM users u
        LEFT JOIN shifts s ON s.id = u.shift_id
       WHERE u.active AND u.id = ANY($1::int[])
       ORDER BY u.name
    `, [userIds.map(Number)]);
    targetUsers = rows;
  } else if (departments && departments.length) {
    const cleanDeptNames = departments.map((d) => String(d).trim().toLowerCase());
    const { rows } = await query(`
      SELECT u.id, u.employee_code, u.name, u.department, u.designation, s.weekly_off
        FROM users u
        LEFT JOIN shifts s ON s.id = u.shift_id
       WHERE u.active AND (
         LOWER(TRIM(u.department)) = ANY($1::text[]) OR
         u.department = ANY($2::text[]) OR
         u.department_id::text = ANY($2::text[])
       )
       ORDER BY u.department, u.name
    `, [cleanDeptNames, departments.map(String)]);
    targetUsers = rows;
  } else {
    throw bad('Specify either departments or employee IDs');
  }

  // Filter out any individually excluded users
  targetUsers = targetUsers.filter((u) => !cleanExclude.has(u.id));

  if (!targetUsers.length) {
    return {
      affectedEmployeeCount: 0,
      totalRecordCount: 0,
      employees: [],
      conflicts: [],
      dates: cleanDates,
    };
  }

  const userIdsArray = targetUsers.map((u) => u.id);

  // 2. Fetch existing assignments for conflict detection
  const { rows: existing } = await query(`
    SELECT o.user_id, o.date::text AS date, o.assignment_type, o.reason, u.name, u.employee_code
      FROM off_day_assignments o
      JOIN users u ON u.id = o.user_id
     WHERE o.user_id = ANY($1::int[])
       AND o.date = ANY($2::date[])
  `, [userIdsArray, cleanDates]);

  // 3. Fetch holidays for conflict detection
  const { rows: holidays } = await query(`
    SELECT date::text AS date, name FROM holidays WHERE date = ANY($1::date[])
  `, [cleanDates]);
  const holidayMap = new Map(holidays.map((h) => [h.date, h.name]));

  const existingMap = new Map();
  for (const e of existing) {
    existingMap.set(`${e.user_id}|${e.date}`, e);
  }

  const conflicts = [];
  const userMap = new Map(targetUsers.map((u) => [u.id, u]));

  for (const date of cleanDates) {
    const hol = holidayMap.get(date);
    const dayOfWeek = dow(date);

    for (const u of targetUsers) {
      const key = `${u.id}|${date}`;
      const exist = existingMap.get(key);
      const isShiftWeeklyOff = (u.weekly_off || []).includes(dayOfWeek) || dayOfWeek === 5;

      if (exist) {
        conflicts.push({
          userId: u.id,
          name: u.name,
          employeeCode: u.employee_code,
          department: u.department,
          date,
          conflictType: 'already_assigned',
          message: `Already assigned as Off Day (${exist.assignment_type}${exist.reason ? `: ${exist.reason}` : ''})`,
        });
      } else if (hol) {
        conflicts.push({
          userId: u.id,
          name: u.name,
          employeeCode: u.employee_code,
          department: u.department,
          date,
          conflictType: 'holiday',
          message: `Already an official company holiday (${hol})`,
        });
      } else if (isShiftWeeklyOff) {
        conflicts.push({
          userId: u.id,
          name: u.name,
          employeeCode: u.employee_code,
          department: u.department,
          date,
          conflictType: 'weekly_off',
          message: `Already a regular weekly off day (Friday/Weekend)`,
        });
      }
    }
  }

  return {
    affectedEmployeeCount: targetUsers.length,
    totalRecordCount: targetUsers.length * cleanDates.length,
    dates: cleanDates,
    employees: targetUsers.map((u) => ({
      id: u.id,
      name: u.name,
      employeeCode: u.employee_code,
      department: u.department,
      designation: u.designation,
    })),
    conflicts,
  };
}

/**
 * Assign off days in bulk or individually with upsert semantics.
 */
async function assignOffDays({
  dates = [],
  userIds = [],
  departments = [],
  excludeUserIds = [],
  assignmentType = 'individual',
  reason = '',
  actorId,
  department = null,
}) {
  await initOffDaysTable();
  if (!dates || !dates.length) throw bad('At least one date is required');

  const cleanDates = [...new Set(dates.map((d) => String(d).trim()))].sort();
  const cleanExclude = new Set((excludeUserIds || []).map(Number));

  // Determine target users
  let targetUserIds = [];
  let detectedDept = department;

  if (userIds && userIds.length) {
    targetUserIds = [...new Set(userIds.map(Number))].filter((id) => !cleanExclude.has(id));
  } else if (departments && departments.length) {
    const cleanDeptNames = departments.map((d) => String(d).trim().toLowerCase());
    const { rows } = await query(`
      SELECT id, department FROM users
       WHERE active AND (
         LOWER(TRIM(department)) = ANY($1::text[]) OR
         department = ANY($2::text[]) OR
         department_id::text = ANY($2::text[])
       )
    `, [cleanDeptNames, departments.map(String)]);
    targetUserIds = rows.map((r) => r.id).filter((id) => !cleanExclude.has(id));
    if (!detectedDept && departments.length === 1) detectedDept = departments[0];
  }

  if (!targetUserIds.length) throw bad('No eligible employees found for assignment');

  const cleanReason = String(reason || '').trim();

  // Upsert records into off_day_assignments
  let inserted = 0;
  await tx(async (db) => {
    for (const userId of targetUserIds) {
      for (const date of cleanDates) {
        await db.query(`
          INSERT INTO off_day_assignments (
            user_id, date, department, assignment_type, reason, assigned_by, updated_by, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $6, now())
          ON CONFLICT (user_id, date) DO UPDATE SET
            department = COALESCE(EXCLUDED.department, off_day_assignments.department),
            assignment_type = EXCLUDED.assignment_type,
            reason = EXCLUDED.reason,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
        `, [userId, date, detectedDept, assignmentType, cleanReason, actorId || null]);
        inserted++;
      }
    }

    // Log in audit trail
    await db.query(`
      INSERT INTO audit_log (user_id, action, entity, entity_id, detail)
      VALUES ($1, 'assign', 'off_day_assignments', $2, $3::jsonb)
    `, [
      actorId || null,
      `${cleanDates[0]}_${cleanDates[cleanDates.length - 1]}`,
      JSON.stringify({
        dates: cleanDates,
        assignmentType,
        employeeCount: targetUserIds.length,
        department: detectedDept,
        reason: cleanReason,
      }),
    ]);
  });

  // Rebuild attendance for the affected date range so status immediately reflects 'weekend' / off day!
  const minDate = cleanDates[0];
  const maxDate = cleanDates[cleanDates.length - 1];
  try {
    await rebuildRange(minDate, maxDate);
  } catch (err) {
    console.error('[offDays] Rebuild range after assignment warning:', err.message);
  }

  return {
    success: true,
    assignedCount: inserted,
    affectedEmployees: targetUserIds.length,
    dates: cleanDates,
  };
}

/**
 * Remove a single off day assignment.
 */
async function deleteAssignment(id, actorId) {
  await initOffDaysTable();
  const { rows: [assignment] } = await query(`
    SELECT o.*, u.name AS employee_name FROM off_day_assignments o
    JOIN users u ON u.id = o.user_id
    WHERE o.id = $1
  `, [id]);

  if (!assignment) throw notFound('Off day assignment not found');

  await tx(async (db) => {
    await db.query(`DELETE FROM off_day_assignments WHERE id = $1`, [id]);
    await db.query(`
      INSERT INTO audit_log (user_id, action, entity, entity_id, detail)
      VALUES ($1, 'delete', 'off_day_assignments', $2, $3::jsonb)
    `, [
      actorId || null,
      String(id),
      JSON.stringify({
        userId: assignment.user_id,
        date: assignment.date,
        employee: assignment.employee_name,
        type: assignment.assignment_type,
      }),
    ]);
  });

  // Recalculate attendance for this employee on this date
  const dateStr = assignment.date instanceof Date ? assignment.date.toISOString().slice(0, 10) : String(assignment.date);
  try {
    await rebuildRange(dateStr, dateStr, { userId: assignment.user_id });
  } catch (err) {
    console.error('[offDays] Rebuild range after delete warning:', err.message);
  }

  return { success: true, deletedId: id, date: dateStr, userId: assignment.user_id };
}

/**
 * Bulk delete assignments by IDs or by filters.
 */
async function bulkDeleteAssignments({ ids, from, to, department, userIds, actorId }) {
  await initOffDaysTable();
  let affectedDates = [];

  await tx(async (db) => {
    if (ids && ids.length) {
      const { rows } = await db.query(`
        SELECT DISTINCT date::text AS date FROM off_day_assignments WHERE id = ANY($1::int[])
      `, [ids.map(Number)]);
      affectedDates = rows.map((r) => r.date);

      await db.query(`DELETE FROM off_day_assignments WHERE id = ANY($1::int[])`, [ids.map(Number)]);
    } else if (from && to) {
      const params = [from, to];
      let sql = `WHERE date BETWEEN $1 AND $2`;
      if (department && department !== 'all') {
        params.push(department);
        sql += ` AND department = $${params.length}`;
      }
      if (userIds && userIds.length) {
        params.push(userIds.map(Number));
        sql += ` AND user_id = ANY($${params.length}::int[])`;
      }

      const { rows } = await db.query(`SELECT DISTINCT date::text AS date FROM off_day_assignments ${sql}`, params);
      affectedDates = rows.map((r) => r.date);

      await db.query(`DELETE FROM off_day_assignments ${sql}`, params);
    } else {
      throw bad('Specify assignment IDs or date range to delete');
    }

    await db.query(`
      INSERT INTO audit_log (user_id, action, entity, entity_id, detail)
      VALUES ($1, 'bulk_delete', 'off_day_assignments', 'bulk', $2::jsonb)
    `, [actorId || null, JSON.stringify({ count: affectedDates.length, dates: affectedDates })]);
  });

  if (affectedDates.length) {
    affectedDates.sort();
    try {
      await rebuildRange(affectedDates[0], affectedDates[affectedDates.length - 1]);
    } catch (err) {
      console.error('[offDays] Rebuild range after bulk delete warning:', err.message);
    }
  }

  return { success: true, affectedDatesCount: affectedDates.length };
}

/**
 * Export off day assignments to XLSX or PDF.
 */
async function exportAssignments({ format = 'xlsx', from, to, department, userId, assignmentType, q }) {
  const { rows } = await listAssignments({ from, to, department, userId, assignmentType, q, limit: 10000 });

  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'JMCL Staff Flow Pro';
    const ws = wb.addWorksheet('Off Day Assignments');

    ws.columns = [
      { header: 'SL', key: 'sl', width: 6 },
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Day', key: 'day', width: 12 },
      { header: 'Employee Code', key: 'code', width: 16 },
      { header: 'Employee Name', key: 'name', width: 24 },
      { header: 'Department', key: 'dept', width: 18 },
      { header: 'Designation', key: 'desig', width: 20 },
      { header: 'Assignment Type', key: 'type', width: 16 },
      { header: 'Reason / Note', key: 'reason', width: 28 },
      { header: 'Assigned By', key: 'assigned_by', width: 20 },
      { header: 'Assigned At', key: 'assigned_at', width: 20 },
    ];

    // Header styling
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    rows.forEach((r, idx) => {
      const d = new Date(`${r.date}T00:00:00Z`);
      const dayName = d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
      ws.addRow({
        sl: idx + 1,
        date: r.date,
        day: dayName,
        code: r.employee_code,
        name: r.employee_name,
        dept: r.user_department || r.department || '—',
        desig: r.designation || '—',
        type: r.assignment_type.toUpperCase(),
        reason: r.reason || '—',
        assigned_by: r.assigned_by_name || 'System / Admin',
        assigned_at: r.created_at ? new Date(r.created_at).toLocaleString('en-GB') : '—',
      });
    });

    return await wb.xlsx.writeBuffer();
  }

  // PDF output
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: 'A4', layout: 'landscape' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).font('Helvetica-Bold').text('Jeans Manufacturing Company Ltd.', { align: 'center' });
    doc.fontSize(12).font('Helvetica').text('Off Day Assignments & Roster Report', { align: 'center' });
    doc.fontSize(9).font('Helvetica-Oblique').text(`Generated on: ${new Date().toLocaleString('en-GB')} | Total Records: ${rows.length}`, { align: 'center' });
    doc.moveDown(1);

    // Table headers
    const startY = doc.y;
    doc.font('Helvetica-Bold').fontSize(8);
    const headers = ['#', 'Date', 'Day', 'Code', 'Employee Name', 'Department', 'Type', 'Reason', 'Assigned By'];
    const colX = [30, 50, 110, 160, 220, 360, 470, 560, 710];

    headers.forEach((h, i) => doc.text(h, colX[i], startY));
    doc.moveTo(30, startY + 12).lineTo(800, startY + 12).stroke();

    let curY = startY + 18;
    doc.font('Helvetica').fontSize(8);

    rows.forEach((r, idx) => {
      if (curY > 540) {
        doc.addPage({ margin: 30, size: 'A4', layout: 'landscape' });
        curY = 40;
      }
      const d = new Date(`${r.date}T00:00:00Z`);
      const dayName = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

      doc.text(String(idx + 1), colX[0], curY);
      doc.text(r.date, colX[1], curY);
      doc.text(dayName, colX[2], curY);
      doc.text(r.employee_code || '—', colX[3], curY);
      doc.text(r.employee_name.slice(0, 24), colX[4], curY);
      doc.text((r.user_department || r.department || '—').slice(0, 18), colX[5], curY);
      doc.text(r.assignment_type.toUpperCase(), colX[6], curY);
      doc.text((r.reason || '—').slice(0, 25), colX[7], curY);
      doc.text((r.assigned_by_name || 'Admin').slice(0, 16), colX[8], curY);

      curY += 15;
    });

    doc.end();
  });
}

module.exports = {
  initOffDaysTable,
  getStats,
  listAssignments,
  getCalendarData,
  previewAssignment,
  assignOffDays,
  deleteAssignment,
  bulkDeleteAssignments,
  exportAssignments,
};
