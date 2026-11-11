// Frontend Permissions & RBAC Module

export const MODULES = [
  { key: 'overview', label: 'Overview / Dashboard', desc: 'Main statistics, attendance overview and metrics', icon: 'home', category: 'General' },
  { key: 'attendance', label: 'Daily Attendance', desc: 'View, filter, edit attendance and punch records', icon: 'clock', category: 'Time & Attendance' },
  { key: 'live_attendance', label: 'Live Biometric Monitor', desc: 'Real-time terminal punch feed and terminal monitor', icon: 'live', category: 'Time & Attendance' },
  { key: 'employees', label: 'Employee Management', desc: 'Add, view, edit and manage employee profiles', icon: 'people', category: 'Organization' },
  { key: 'departments', label: 'Departments', desc: 'Create and organize company departments', icon: 'department', category: 'Organization' },
  { key: 'designations', label: 'Designations', desc: 'Manage company job titles and roles', icon: 'designation', category: 'Organization' },
  { key: 'shifts', label: 'Shift Management', desc: 'Define shift hours, grace period and overtime rules', icon: 'shift', category: 'Time & Attendance' },
  { key: 'leave', label: 'Leave Management', desc: 'View, apply, approve and reject leave applications', icon: 'leave', category: 'Time & Attendance' },
  { key: 'holidays', label: 'Holiday Calendar', desc: 'Manage official company holidays and calendar', icon: 'holiday', category: 'Time & Attendance' },
  { key: 'payroll', label: 'Payroll Management', desc: 'Generate salary runs, adjustments and payslips', icon: 'pay', category: 'Finance & Payroll' },
  { key: 'overtime', label: 'Overtime', desc: 'Overtime calculations, records and approvals', icon: 'overtime', category: 'Finance & Payroll' },
  { key: 'reports', label: 'Reports & Analytics', desc: 'Generate and export PDF/Excel attendance & payroll reports', icon: 'report', category: 'Reports' },
  { key: 'devices', label: 'Biometric Devices', desc: 'Register, configure and sync ZKTeco biometric terminals', icon: 'device', category: 'System Administration' },
  { key: 'roles', label: 'Users & Roles (RBAC)', desc: 'Manage login accounts, passwords and access permissions', icon: 'role', category: 'System Administration' },
  { key: 'notifications', label: 'Notifications', desc: 'System alerts, punch reminders and announcements', icon: 'bell', category: 'General' },
  { key: 'audit_logs', label: 'Audit Logs', desc: 'View system activity and security audit trail', icon: 'audit', category: 'System Administration' },
  { key: 'settings', label: 'Settings', desc: 'Company profile, working hours, and system options', icon: 'gear', category: 'System Administration' },
];

export const PRESETS = {
  full_admin: {
    label: 'Full Admin (All Access)',
    icon: 'crown',
    perms: MODULES.reduce((acc, m) => ({ ...acc, [m.key]: { view: true, edit: true } }), {}),
  },
  view_only: {
    label: 'View Only (All Modules)',
    icon: 'eye',
    perms: MODULES.reduce((acc, m) => ({ ...acc, [m.key]: { view: true, edit: false } }), {}),
  },
  hr_manager: {
    label: 'HR Manager',
    icon: 'people',
    perms: {
      overview: { view: true, edit: false },
      attendance: { view: true, edit: true },
      live_attendance: { view: true, edit: false },
      employees: { view: true, edit: true },
      departments: { view: true, edit: true },
      designations: { view: true, edit: true },
      shifts: { view: true, edit: true },
      leave: { view: true, edit: true },
      holidays: { view: true, edit: true },
      payroll: { view: true, edit: false },
      overtime: { view: true, edit: true },
      reports: { view: true, edit: false },
      devices: { view: false, edit: false },
      roles: { view: false, edit: false },
      notifications: { view: true, edit: true },
      audit_logs: { view: true, edit: false },
      settings: { view: false, edit: false },
    },
  },
  accounts: {
    label: 'Accounts / Payroll',
    icon: 'money',
    perms: {
      overview: { view: true, edit: false },
      attendance: { view: true, edit: false },
      live_attendance: { view: false, edit: false },
      employees: { view: true, edit: false },
      departments: { view: false, edit: false },
      designations: { view: false, edit: false },
      shifts: { view: false, edit: false },
      leave: { view: false, edit: false },
      holidays: { view: true, edit: false },
      payroll: { view: true, edit: true },
      overtime: { view: true, edit: true },
      reports: { view: true, edit: false },
      devices: { view: false, edit: false },
      roles: { view: false, edit: false },
      notifications: { view: true, edit: true },
      audit_logs: { view: false, edit: false },
      settings: { view: false, edit: false },
    },
  },
  dept_manager: {
    label: 'Department Manager',
    icon: 'people',
    perms: {
      overview: { view: true, edit: false },
      attendance: { view: true, edit: true },
      live_attendance: { view: true, edit: false },
      employees: { view: true, edit: false },
      departments: { view: false, edit: false },
      designations: { view: false, edit: false },
      shifts: { view: false, edit: false },
      leave: { view: true, edit: true },
      holidays: { view: true, edit: false },
      payroll: { view: false, edit: false },
      overtime: { view: true, edit: true },
      reports: { view: true, edit: false },
      devices: { view: false, edit: false },
      roles: { view: false, edit: false },
      notifications: { view: true, edit: true },
      audit_logs: { view: false, edit: false },
      settings: { view: false, edit: false },
    },
  },
  clear: {
    label: 'No Access (Clear)',
    icon: 'slash',
    perms: MODULES.reduce((acc, m) => ({ ...acc, [m.key]: { view: false, edit: false } }), {}),
  },
};

function normalizeKey(k) {
  return String(k || '').toLowerCase().replace(/[-_\s]/g, '');
}

export function getUserPermission(user, moduleKey) {
  if (!user) return { view: false, edit: false };

  const normKey = normalizeKey(moduleKey);

  // 1. Check custom user permissions if configured (takes top precedence)
  const custom = user.permissions;
  if (custom && typeof custom === 'object') {
    let match = custom[moduleKey];
    if (match === undefined) {
      for (const [k, v] of Object.entries(custom)) {
        if (normalizeKey(k) === normKey) { match = v; break; }
      }
    }
    if (match !== undefined) {
      if (typeof match === 'boolean') {
        return { view: match, edit: match };
      }
      if (typeof match === 'object' && match !== null) {
        const view = Boolean(match.view);
        const edit = Boolean(match.view && match.edit);
        return { view, edit };
      }
    }
  }

  // 2. Administrators default to full access if no custom override
  if (['super_admin', 'company_admin', 'admin'].includes(user.role)) {
    return { view: true, edit: true };
  }

  // 3. Fall back to role defaults
  const presetKey = user.role.startsWith('hr') ? 'hr_manager' :
                    user.role.startsWith('account') ? 'accounts' :
                    user.role === 'dept_manager' ? 'dept_manager' :
                    ['admin', 'super_admin', 'company_admin'].includes(user.role) ? 'full_admin' : null;

  if (presetKey && PRESETS[presetKey]) {
    const roleMap = PRESETS[presetKey].perms;
    let fallback = roleMap[moduleKey];
    if (!fallback) {
      for (const [k, v] of Object.entries(roleMap)) {
        if (normalizeKey(k) === normKey) { fallback = v; break; }
      }
    }
    if (fallback) {
      return { view: Boolean(fallback.view), edit: Boolean(fallback.view && fallback.edit) };
    }
  }

  // Staff self-service defaults
  if (['overview', 'attendance', 'leave', 'holidays', 'payroll', 'notifications'].includes(moduleKey)) {
    return { view: true, edit: moduleKey === 'leave' };
  }

  return { view: false, edit: false };
}

export function canView(user, moduleKey) {
  return getUserPermission(user, moduleKey).view;
}

export function canEdit(user, moduleKey) {
  return getUserPermission(user, moduleKey).edit;
}

export function getPermissionSummary(user) {
  if (!user) return { type: 'none', label: 'No Access', color: 'bad' };
  if (['super_admin', 'company_admin'].includes(user.role)) {
    return { type: 'super', label: 'Super Admin', color: 'present' };
  }

  const perms = user.permissions;
  const isCustom = perms && typeof perms === 'object' && Object.keys(perms).length > 0;

  let viewCount = 0;
  let editCount = 0;
  for (const m of MODULES) {
    const p = getUserPermission(user, m.key);
    if (p.view) viewCount++;
    if (p.edit) editCount++;
  }

  if (viewCount === MODULES.length && editCount === MODULES.length) {
    return { type: 'full', label: `Full Admin (${MODULES.length}/${MODULES.length})`, color: 'present' };
  }
  if (isCustom) {
    if (editCount === 0 && viewCount > 0) {
      return { type: 'view_only', label: `View Only (${viewCount})`, color: 'waiting' };
    }
    return { type: 'custom', label: `Custom RBAC (${viewCount}V / ${editCount}E)`, color: 'ot' };
  }
  if (user.role.startsWith('hr')) {
    return { type: 'hr', label: `HR (${viewCount} modules)`, color: 'leave' };
  }
  if (user.role.startsWith('account')) {
    return { type: 'accounts', label: `Accounts (${viewCount} modules)`, color: 'ot' };
  }
  return { type: 'staff', label: 'Staff Self-Service', color: 'waiting' };
}

