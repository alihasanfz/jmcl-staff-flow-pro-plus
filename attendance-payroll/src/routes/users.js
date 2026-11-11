'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('../db');
const { wrap, parse, bad, forbidden, notFound } = require('../utils/http');
const { requireRole, isManager, canEdit, canView } = require('../middleware/auth');
const { MODULES } = require('../logic/permissions');
const { ensureBalances } = require('./../services/leave');
const { backfillPin, rebuildRange } = require('../services/attendance');
const { todayIn, addDays } = require('../utils/time');
const { getSettings } = require('../services/settings');
const { z, date, id, money, password } = require('./schemas');

router.use((req, res, next) => {
  if (
    canView(req.user, 'employees') ||
    canView(req.user, 'roles') ||
    isManager(req.user) ||
    ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr_executive', 'hr', 'dept_manager'].includes(req.user.role)
  ) {
    return next();
  }
  return next(forbidden('Your role cannot access this'));
});

const COLS = `u.id, u.employee_code, u.device_pin, u.name, u.email, u.phone, u.address, u.photo, u.role,
              u.department, u.department_id, u.designation, u.designation_id, u.branch_id,
              u.employment_type, u.gender, u.dob::text AS dob, u.blood_group, u.nid_number,
              u.emergency_contact, u.manager_id, u.shift_id, s.name AS shift_name,
              u.base_salary, u.allowances, u.join_date::text AS join_date, u.active, u.must_change_password,
              COALESCE(u.raw_password, 'Demo@12345') AS raw_password,
              COALESCE(u.overtime_eligible, true) AS overtime_eligible,
              COALESCE(u.permissions, '{}'::jsonb) AS permissions,
              COALESCE(ss.basic_salary, u.base_salary) AS basic_salary,
              COALESCE(ss.house_rent, 0) AS house_rent,
              COALESCE(ss.medical_allowance, 0) AS medical_allowance,
              COALESCE(ss.conveyance, 0) AS conveyance,
              COALESCE(ss.other_allowances, u.allowances) AS other_allowances,
              COALESCE(ss.gross_salary, u.base_salary + u.allowances) AS gross_salary,
              COALESCE(ss.tax_deduction, 0) AS tax_deduction,
              COALESCE(ss.provident_fund, 0) AS provident_fund`;

const body = z.object({
  employeeCode: z.string().trim().min(1).max(32).nullable().optional().or(z.literal('').transform(() => undefined)),
  devicePin: z.string().trim().regex(/^\d{1,9}$/, 'must be 1–9 digits, as enrolled on the device').nullable().optional().or(z.literal('').transform(() => undefined)),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().trim().max(30).nullable().optional().default(''),
  address: z.string().trim().max(300).nullable().optional().default(''),
  photo: z.string().trim().nullable().optional().default(''),
  role: z.enum([
    'super_admin', 'company_admin', 'admin',
    'hr_manager', 'hr_executive', 'hr',
    'accounts_manager', 'dept_manager',
    'employee', 'staff'
  ]).default('employee'),
  permissions: z.any().optional().default({}),
  department: z.string().trim().max(80).default('General'),
  departmentId: id.nullable().optional(),
  designation: z.string().trim().max(80).default('Staff'),
  designationId: id.nullable().optional(),
  branchId: id.nullable().optional(),
  managerId: id.nullable().optional(),
  employmentType: z.enum(['permanent', 'probation', 'contract', 'intern', 'part_time']).default('permanent'),
  gender: z.string().trim().max(20).nullable().optional().default(''),
  dob: date.nullable().optional(),
  bloodGroup: z.string().trim().max(10).nullable().optional().default(''),
  nidNumber: z.string().trim().max(40).nullable().optional().default(''),
  emergencyContact: z.any().nullable().optional().default({}),
  shiftId: id.nullable().optional(),
  baseSalary: money.default(0),
  allowances: money.default(0),
  basicSalary: money.optional(),
  houseRent: money.optional(),
  medicalAllowance: money.optional(),
  conveyance: money.optional(),
  otherAllowances: money.optional(),
  taxDeduction: money.optional(),
  providentFund: money.optional(),
  joinDate: date.optional(),
  active: z.boolean().default(true),
  overtimeEligible: z.boolean().optional().default(true),
  password: password.optional(),
});

function assertCanManage(actor, targetRole, newRole) {
  if (['super_admin', 'company_admin', 'admin'].includes(actor.role) || canEdit(actor, 'roles')) return;
  if (!['dept_manager', 'employee', 'staff'].includes(actor.role) && canEdit(actor, 'employees') && ['hr_manager', 'hr_executive', 'hr'].includes(actor.role)) {
    if (!['staff', 'employee'].includes(targetRole) || (newRole && !['staff', 'employee'].includes(newRole))) {
      throw forbidden('You can only manage Staff/Employee accounts');
    }
    return;
  }
  throw forbidden('You do not have permission to manage accounts');
}

function assertCanManagePermissions(actor) {
  if (['super_admin', 'company_admin', 'admin'].includes(actor.role) || canEdit(actor, 'roles')) return;
  throw forbidden('Only administrators can configure user roles and custom permissions');
}

const tempPassword = () => `Tmp-${crypto.randomBytes(6).toString('base64url')}`;

router.get('/', wrap(async (req, res) => {
  const params = [];
  let where = 'TRUE';
  if (req.query.q) {
    params.push(`%${String(req.query.q).slice(0, 60)}%`);
    where += ` AND (u.name ILIKE $${params.length} OR u.employee_code ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`;
  }
  if (req.query.department) {
    params.push(req.query.department);
    where += ` AND u.department = $${params.length}`;
  }
  if (req.query.departmentId) {
    params.push(parse(id, req.query.departmentId));
    where += ` AND u.department_id = $${params.length}`;
  }
  if (req.query.active === 'true' || req.query.active === 'false') {
    params.push(req.query.active === 'true');
    where += ` AND u.active = $${params.length}`;
  }
  const { rows } = await query(`
    SELECT ${COLS}
      FROM users u
      LEFT JOIN shifts s ON s.id = u.shift_id
      LEFT JOIN salary_structures ss ON ss.user_id = u.id
     WHERE ${where}
     ORDER BY u.name
  `, params);

  const canSeePw = ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr_executive', 'hr'].includes(req.user.role) || canView(req.user, 'roles');
  if (!canSeePw) {
    for (const r of rows) {
      delete r.raw_password;
    }
  }

  res.json({ users: rows });
}));

router.get('/departments', wrap(async (req, res) => {
  const { rows } = await query('SELECT DISTINCT department FROM users WHERE department IS NOT NULL AND department != \'\' ORDER BY department');
  res.json({ departments: rows.map((r) => r.department) });
}));

router.get('/meta/modules', wrap(async (req, res) => {
  res.json({ modules: MODULES });
}));

router.post('/', wrap(async (req, res) => {
  const d = parse(body, req.body);
  if ((d.role && !['staff', 'employee'].includes(d.role)) || (d.permissions && Object.keys(d.permissions).length > 0)) {
    assertCanManagePermissions(req.user);
  } else {
    assertCanManage(req.user, 'staff', d.role);
  }
  const pw = d.password || 'Demo@12345';

  // Smart derivation of Device PIN and Employee Code
  let pin = (d.devicePin || (/^\d{1,9}$/.test(d.employeeCode || '') ? d.employeeCode : '') || '').trim();
  let code = (d.employeeCode || '').trim();
  if (!pin && !code) {
    const { rows: [maxPin] } = await query(`SELECT COALESCE(MAX(device_pin::int), 100) + 1 AS next_pin FROM users WHERE device_pin ~ '^[0-9]+$'`);
    pin = String(maxPin?.next_pin || 101);
  } else if (!pin && code) {
    pin = code.replace(/\D/g, '') || String(Math.floor(100 + Math.random() * 900));
  }
  if (!code) {
    code = `EMP${String(pin).padStart(4, '0')}`;
  }

  // Auto-generate email if not provided
  let email = (d.email || '').trim().toLowerCase();
  if (!email) {
    const cleanId = String(pin || code).toLowerCase().replace(/[^a-z0-9]/g, '') || 'staff';
    email = `emp${cleanId}@company.local`;
    const { rows: existingEmail } = await query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existingEmail.length > 0) {
      email = `emp${cleanId}_${Date.now().toString().slice(-4)}@company.local`;
    }
  }

  // Ensure default shift (prefer uFace800 shift: 09:30 - 19:00)
  let shiftId = d.shiftId || null;
  if (!shiftId) {
    const { rows: [defShift] } = await query(`SELECT id FROM shifts ORDER BY (name LIKE '%uFace800%') DESC, id ASC LIMIT 1`);
    if (defShift) shiftId = defShift.id;
  }

  // Emergency contact formatting (prevent [object Object])
  let emergencyContactObj = {};
  if (typeof d.emergencyContact === 'string') {
    const cleanEc = d.emergencyContact.trim();
    if (cleanEc && cleanEc !== '[object Object]') {
      emergencyContactObj = { contact: cleanEc };
    }
  } else if (typeof d.emergencyContact === 'object' && d.emergencyContact !== null) {
    emergencyContactObj = d.emergencyContact;
  }

  // Sync department name if departmentId is supplied
  let deptName = d.department || 'General';
  if (d.departmentId) {
    const { rows: [dept] } = await query('SELECT name FROM departments WHERE id = $1', [d.departmentId]);
    if (dept) deptName = dept.name;
  }
  let desgName = d.designation || 'Staff';
  if (d.designationId) {
    const { rows: [desg] } = await query('SELECT name FROM designations WHERE id = $1', [d.designationId]);
    if (desg) desgName = desg.name;
  }

  // Calculate salary components
  const basic = d.basicSalary ?? d.baseSalary ?? 0;
  const houseRent = d.houseRent ?? 0;
  const medical = d.medicalAllowance ?? 0;
  const conv = d.conveyance ?? 0;
  const other = d.otherAllowances ?? d.allowances ?? 0;
  const totalAllow = houseRent + medical + conv + other;
  const gross = basic + totalAllow;

  const { rows: [u] } = await query(
    `INSERT INTO users (employee_code, device_pin, name, email, phone, address, photo, password_hash, raw_password, role,
                        department, department_id, designation, designation_id, branch_id, manager_id,
                        employment_type, gender, dob, blood_group, nid_number, emergency_contact,
                        shift_id, base_salary, allowances, join_date, active, must_change_password, permissions, overtime_eligible)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25,COALESCE($26::date, CURRENT_DATE),$27,false,COALESCE($28::jsonb, '{}'::jsonb), $29)
     RETURNING id`,
    [code, pin, d.name, email, d.phone || '', d.address || '', d.photo || '', await bcrypt.hash(pw, 10), pw, d.role || 'employee',
     deptName, d.departmentId || null, desgName, d.designationId || null, d.branchId || null, d.managerId || null,
     d.employmentType || 'permanent', d.gender || '', d.dob || null, d.bloodGroup || '', d.nidNumber || '', JSON.stringify(emergencyContactObj),
     shiftId, basic, totalAllow, d.joinDate || null, d.active !== false, JSON.stringify(d.permissions || {}), d.overtimeEligible !== false]
  );

  // Save salary structure
  await query(`
    INSERT INTO salary_structures (user_id, basic_salary, house_rent, medical_allowance, conveyance, other_allowances, gross_salary, tax_deduction, provident_fund)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (user_id) DO UPDATE SET
      basic_salary = EXCLUDED.basic_salary, house_rent = EXCLUDED.house_rent,
      medical_allowance = EXCLUDED.medical_allowance, conveyance = EXCLUDED.conveyance,
      other_allowances = EXCLUDED.other_allowances, gross_salary = EXCLUDED.gross_salary,
      tax_deduction = EXCLUDED.tax_deduction, provident_fund = EXCLUDED.provident_fund, updated_at = now()
  `, [u.id, basic, houseRent, medical, conv, other, gross, d.taxDeduction || 0, d.providentFund || 0]);

  await ensureBalances(u.id, new Date().getUTCFullYear());
  const matched = await backfillPin(u.id, pin);

  // Immediately rebuild today's attendance so employee's status appears right away
  try {
    const { timezone } = await getSettings();
    const today = todayIn(timezone);
    await rebuildRange(today, today, { userId: u.id });
  } catch (_) {}

  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1,'create','user',$2)`, [req.user.id, String(u.id)]);
  res.status(201).json({ id: u.id, temporaryPassword: d.password ? undefined : pw, matchedPunches: matched });
}));

const handleUserUpdate = async (req, res) => {
  const uid = parse(id, req.params.id);
  const { rows: [target] } = await query('SELECT id, role, device_pin FROM users WHERE id = $1', [uid]);
  if (!target) throw notFound('Employee not found');
  const updateBody = body.extend({
    password: z.string().trim().min(1).optional().or(z.literal('').transform(() => undefined)),
  });
  const d = parse(updateBody.partial(), req.body);
  if (d.role !== undefined || d.permissions !== undefined || req.body.password) {
    assertCanManagePermissions(req.user);
  } else {
    assertCanManage(req.user, target.role, d.role);
  }
  if (uid === req.user.id && (d.active === false || (d.role && d.role !== req.user.role))) {
    throw forbidden('You cannot deactivate or change the role of your own account');
  }

  // Update department/designation names if IDs are changed
  if (d.departmentId) {
    const { rows: [dept] } = await query('SELECT name FROM departments WHERE id = $1', [d.departmentId]);
    if (dept) d.department = dept.name;
  }
  if (d.designationId) {
    const { rows: [desg] } = await query('SELECT name FROM designations WHERE id = $1', [d.designationId]);
    if (desg) d.designation = desg.name;
  }

  const map = {
    employeeCode: 'employee_code', devicePin: 'device_pin', name: 'name', email: 'email', phone: 'phone',
    address: 'address', photo: 'photo', role: 'role', department: 'department', departmentId: 'department_id',
    designation: 'designation', designationId: 'designation_id', branchId: 'branch_id', managerId: 'manager_id',
    employmentType: 'employment_type', gender: 'gender', dob: 'dob', bloodGroup: 'blood_group',
    nidNumber: 'nid_number', shiftId: 'shift_id', baseSalary: 'base_salary', allowances: 'allowances',
    joinDate: 'join_date', active: 'active', overtimeEligible: 'overtime_eligible',
  };
  const sets = [];
  const params = [uid];
  for (const [k, col] of Object.entries(map)) {
    if (d[k] !== undefined) { params.push(d[k]); sets.push(`${col} = $${params.length}`); }
  }
  if (d.emergencyContact !== undefined) {
    let ec = d.emergencyContact;
    if (typeof ec === 'string') {
      const cleanEc = ec.trim();
      ec = (cleanEc && cleanEc !== '[object Object]') ? { contact: cleanEc } : {};
    } else if (!ec || typeof ec !== 'object') {
      ec = {};
    }
    params.push(JSON.stringify(ec));
    sets.push(`emergency_contact = $${params.length}::jsonb`);
  }
  if (d.permissions !== undefined) {
    params.push(JSON.stringify(d.permissions || {}));
    sets.push(`permissions = $${params.length}::jsonb`);
  }

  // Handle password update if supplied
  if (req.body.password && typeof req.body.password === 'string' && req.body.password.trim()) {
    const pw = req.body.password.trim();
    if (pw.length < 4) throw bad('Password must be at least 4 characters');
    const pwHash = await bcrypt.hash(pw, 10);
    params.push(pwHash);
    sets.push(`password_hash = $${params.length}`);
    params.push(pw);
    sets.push(`raw_password = $${params.length}`);
    sets.push(`must_change_password = false`);
  }

  if (sets.length) {
    await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
  }

  // Update salary structure if any salary component is present
  if (d.basicSalary !== undefined || d.houseRent !== undefined || d.medicalAllowance !== undefined ||
      d.conveyance !== undefined || d.otherAllowances !== undefined || d.baseSalary !== undefined) {
    const { rows: [currentSS] } = await query('SELECT * FROM salary_structures WHERE user_id = $1', [uid]);
    const basic = d.basicSalary ?? d.baseSalary ?? currentSS?.basic_salary ?? 0;
    const houseRent = d.houseRent ?? currentSS?.house_rent ?? 0;
    const medical = d.medicalAllowance ?? currentSS?.medical_allowance ?? 0;
    const conv = d.conveyance ?? currentSS?.conveyance ?? 0;
    const other = d.otherAllowances ?? currentSS?.other_allowances ?? 0;
    const gross = basic + houseRent + medical + conv + other;

    await query(`
      INSERT INTO salary_structures (user_id, basic_salary, house_rent, medical_allowance, conveyance, other_allowances, gross_salary, tax_deduction, provident_fund)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (user_id) DO UPDATE SET
        basic_salary = EXCLUDED.basic_salary, house_rent = EXCLUDED.house_rent,
        medical_allowance = EXCLUDED.medical_allowance, conveyance = EXCLUDED.conveyance,
        other_allowances = EXCLUDED.other_allowances, gross_salary = EXCLUDED.gross_salary,
        tax_deduction = COALESCE(EXCLUDED.tax_deduction, salary_structures.tax_deduction),
        provident_fund = COALESCE(EXCLUDED.provident_fund, salary_structures.provident_fund),
        updated_at = now()
    `, [uid, basic, houseRent, medical, conv, other, gross, d.taxDeduction || 0, d.providentFund || 0]);

    await query('UPDATE users SET base_salary = $2, allowances = $3 WHERE id = $1', [uid, basic, (houseRent + medical + conv + other)]);
  }

  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'update','user',$2,$3::jsonb)`,
    [req.user.id, String(uid), JSON.stringify({ fields: Object.keys(d) })]);

  if (d.devicePin && d.devicePin !== target.device_pin) await backfillPin(uid, d.devicePin);
  if (d.shiftId !== undefined || d.joinDate !== undefined || d.overtimeEligible !== undefined) {
    const { timezone } = await getSettings();
    const today = todayIn(timezone);
    await rebuildRange(addDays(today, -7), today, { userId: uid });
  }
  res.json({ ok: true });
};

router.patch('/:id', wrap(handleUserUpdate));
router.put('/:id', wrap(handleUserUpdate));

router.post('/:id/reset-password', wrap(async (req, res) => {
  const uid = parse(id, req.params.id);
  const { rows: [target] } = await query('SELECT role FROM users WHERE id = $1', [uid]);
  if (!target) throw notFound('Employee not found');
  assertCanManage(req.user, target.role);
  const pw = tempPassword();
  await query('UPDATE users SET password_hash = $2, raw_password = $3, must_change_password = false WHERE id = $1', [uid, await bcrypt.hash(pw, 10), pw]);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1,'reset-password','user',$2)`, [req.user.id, String(uid)]);
  res.json({ temporaryPassword: pw, password: pw });
}));

router.delete('/:id', wrap(async (req, res) => {
  const uid = parse(id, req.params.id);
  assertCanManagePermissions(req.user);
  if (uid === req.user.id) throw forbidden('You cannot delete your own account');
  const { rows: [target] } = await query('SELECT id, name FROM users WHERE id = $1', [uid]);
  if (!target) throw notFound('Employee not found');

  try {
    await query('DELETE FROM payslips WHERE user_id = $1', [uid]);
    await query('DELETE FROM salary_structures WHERE user_id = $1', [uid]);
    await query('DELETE FROM overtime_records WHERE user_id = $1', [uid]);
    await query('DELETE FROM manual_punches WHERE user_id = $1', [uid]);
    await query('UPDATE leave_requests SET reviewed_by = NULL WHERE reviewed_by = $1', [uid]);
    await query('UPDATE adjustments SET created_by = NULL WHERE created_by = $1', [uid]);
    await query('UPDATE payroll_runs SET generated_by = NULL WHERE generated_by = $1', [uid]);
    await query('UPDATE payroll_runs SET finalized_by = NULL WHERE finalized_by = $1', [uid]);
    await query('UPDATE users SET manager_id = NULL WHERE manager_id = $1', [uid]);
    await query('DELETE FROM users WHERE id = $1', [uid]);
  } catch (err) {
    // If foreign key constraint prevents hard delete (e.g. historical punch logs), deactivate safely
    await query('UPDATE users SET active = false, permissions = \'{}\'::jsonb WHERE id = $1', [uid]);
  }

  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'delete','user',$2,$3::jsonb)`,
    [req.user.id, String(uid), JSON.stringify({ name: target.name })]);
  res.json({ ok: true });
}));

module.exports = router;
