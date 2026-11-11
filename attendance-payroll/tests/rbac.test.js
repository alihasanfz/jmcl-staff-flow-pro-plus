'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getUserPermission, canView, canEdit, getPermissionSummary } = require('../src/logic/permissions');

test('RBAC: Super admin has master privileges', () => {
  const superAdmin = { role: 'super_admin' };
  assert.equal(canView(superAdmin, 'attendance'), true);
  assert.equal(canEdit(superAdmin, 'attendance'), true);
  assert.equal(canView(superAdmin, 'payroll'), true);
  assert.equal(canEdit(superAdmin, 'payroll'), true);
  assert.equal(canEdit(superAdmin, 'devices'), true);
  assert.equal(canEdit(superAdmin, 'settings'), true);
  assert.equal(canEdit(superAdmin, 'roles'), true);
  assert.equal(getPermissionSummary(superAdmin).type, 'super');
});

test('RBAC: HR Manager role defaults', () => {
  const hr = { role: 'hr_manager' };
  assert.equal(canView(hr, 'attendance'), true);
  assert.equal(canEdit(hr, 'attendance'), true);
  assert.equal(canView(hr, 'employees'), true);
  assert.equal(canEdit(hr, 'employees'), true);
  assert.equal(canView(hr, 'payroll'), true);
  assert.equal(canEdit(hr, 'payroll'), false); // view only
  assert.equal(canView(hr, 'devices'), false); // no access
  assert.equal(canView(hr, 'roles'), false); // no access
});

test('RBAC: Custom permissions override role defaults (View-Only User)', () => {
  const viewOnlyAdmin = {
    role: 'admin',
    permissions: {
      attendance: { view: true, edit: false },
      employees: { view: true, edit: false },
      payroll: { view: false, edit: false },
      settings: { view: true, edit: false },
    },
  };
  // Can view attendance, but cannot edit
  assert.equal(canView(viewOnlyAdmin, 'attendance'), true);
  assert.equal(canEdit(viewOnlyAdmin, 'attendance'), false);

  // Can view employees, but cannot edit
  assert.equal(canView(viewOnlyAdmin, 'employees'), true);
  assert.equal(canEdit(viewOnlyAdmin, 'employees'), false);

  // Payroll is completely hidden
  assert.equal(canView(viewOnlyAdmin, 'payroll'), false);
  assert.equal(canEdit(viewOnlyAdmin, 'payroll'), false);

  // Settings view only
  assert.equal(canView(viewOnlyAdmin, 'settings'), true);
  assert.equal(canEdit(viewOnlyAdmin, 'settings'), false);

  const summary = getPermissionSummary(viewOnlyAdmin);
  assert.equal(summary.type, 'custom');
});

test('RBAC: Custom permissions grant specific write access', () => {
  const customUser = {
    role: 'staff',
    permissions: {
      attendance: { view: true, edit: true },
      devices: { view: true, edit: false },
    },
  };
  assert.equal(canView(customUser, 'attendance'), true);
  assert.equal(canEdit(customUser, 'attendance'), true);
  assert.equal(canView(customUser, 'devices'), true);
  assert.equal(canEdit(customUser, 'devices'), false);
});

test('RBAC: Department Manager role and custom permissions access', () => {
  const deptMgr = {
    role: 'dept_manager',
    permissions: {
      overview: { view: true, edit: true },
      employees: { view: true, edit: false },
    },
  };
  assert.equal(canView(deptMgr, 'overview'), true);
  assert.equal(canEdit(deptMgr, 'overview'), true);
  assert.equal(canView(deptMgr, 'employees'), true);
  assert.equal(canEdit(deptMgr, 'employees'), false);
  assert.equal(canView(deptMgr, 'attendance'), true);
});

