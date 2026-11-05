// Users & Roles Management: RBAC & Account Administration
import { get, post, put, del } from '../api.js';
import { html, setHTML, $, $$, esc, icon, badge, toast, modal, confirmDialog, ago } from '../ui.js';
import { t } from '../i18n.js';

const ROLES = [
  { id: 'super_admin', label: 'Super Admin', desc: 'Full system and multi-company access' },
  { id: 'company_admin', label: 'Company Admin', desc: 'Company-level settings, branches & users' },
  { id: 'admin', label: 'Administrator', desc: 'Full operational access' },
  { id: 'hr_manager', label: 'HR Manager', desc: 'Employee, attendance, leave & approvals' },
  { id: 'hr_executive', label: 'HR Executive', desc: 'Attendance and daily operational tasks' },
  { id: 'hr', label: 'HR Staff', desc: 'Standard HR access' },
  { id: 'accounts_manager', label: 'Accounts Manager', desc: 'Payroll processing & financial exports' },
  { id: 'dept_manager', label: 'Department Manager', desc: 'Team attendance and leave approvals' },
  { id: 'employee', label: 'Employee', desc: 'Self-service attendance & payslips' },
  { id: 'staff', label: 'Staff Member', desc: 'Self-service portal access' },
];

export async function render(view) {
  setHTML(view, html`
    <div class="stack">
      <div class="row between">
        <div>
          <h2>${t('roles')}</h2>
          <p class="muted">Manage system login credentials, permissions, and role-based access control (RBAC).</p>
        </div>
        <button class="btn primary" id="add-user">${icon('plus')} Add User Account</button>
      </div>

      <div class="panel">
        <header>
          <div class="row">
            <div class="search-input-wrap">
              ${icon('search')}
              <input type="text" id="user-search" placeholder="${t('search')} name, email, employee ID...">
            </div>
            <select id="user-role-filter" style="width: auto">
              <option value="">${t('all')} Roles</option>
              ${ROLES.map((r) => html`<option value="${r.id}">${r.label}</option>`)}
            </select>
          </div>
          <span class="small muted" id="user-count"></span>
        </header>
        <div class="body flush">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>User / Employee</th>
                  <th>System Role</th>
                  <th>Biometric ID</th>
                  <th>Account Status</th>
                  <th>Last Seen</th>
                  <th class="r">${t('actions')}</th>
                </tr>
              </thead>
              <tbody id="user-tbody">
                <tr><td colspan="6" class="empty">${t('loading')}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `);

  let users = [];

  async function load() {
    try {
      const res = await get('/users');
      users = res.users || [];
      renderTable();
    } catch (e) {
      setHTML($('#user-tbody'), html`<tr><td colspan="6" class="empty notice bad">${e.message}</td></tr>`);
    }
  }

  function renderTable() {
    const q = ($('#user-search')?.value || '').toLowerCase().trim();
    const roleFilter = $('#user-role-filter')?.value || '';

    const filtered = users.filter((u) => {
      const matchesSearch = !q ||
        (u.name || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.employee_id || '').toLowerCase().includes(q);
      const matchesRole = !roleFilter || u.role === roleFilter;
      return matchesSearch && matchesRole;
    });

    $('#user-count').textContent = `${filtered.length} user account(s)`;

    const tbody = $('#user-tbody');
    if (!filtered.length) {
      setHTML(tbody, html`<tr><td colspan="6" class="empty">${t('noData')}</td></tr>`);
      return;
    }

    setHTML(tbody, html`
      ${filtered.map((u) => {
        const roleObj = ROLES.find((r) => r.id === u.role) || { label: u.role };
        const isRoleAdmin = u.role.includes('admin');
        const isRoleHR = u.role.includes('hr');
        const isRoleAccounts = u.role.includes('account');

        return html`
          <tr>
            <td>
              <b>${u.name}</b>
              <div class="small muted">${u.email}</div>
            </td>
            <td>
              <span class="badge ${isRoleAdmin ? 'present' : isRoleHR ? 'leave' : isRoleAccounts ? 'ot' : 'waiting'}">
                ${roleObj.label}
              </span>
            </td>
            <td><span class="small font-mono">${u.biometric_pin || u.employee_id || '—'}</span></td>
            <td>
              <span class="badge ${u.status === 'active' || u.active !== false ? 'active' : 'inactive'}">
                ${u.status === 'active' || u.active !== false ? t('active') : t('inactive')}
              </span>
            </td>
            <td><span class="small muted">${u.last_login ? ago(u.last_login) : 'Never'}</span></td>
            <td class="r">
              <div class="action-btns">
                <button class="action-btn" data-edit="${u.id}">${icon('edit')} Edit Role</button>
                <button class="action-btn" data-reset="${u.id}">Reset PW</button>
                <button class="action-btn danger" data-del="${u.id}" data-name="${u.name}">${icon('trash')} ${t('delete')}</button>
              </div>
            </td>
          </tr>
        `;
      })}
    `);

    $$('[data-edit]', tbody).forEach((b) => {
      b.addEventListener('click', () => {
        const u = users.find((item) => String(item.id) === b.dataset.edit);
        if (u) openEditUserModal(u);
      });
    });

    $$('[data-reset]', tbody).forEach((b) => {
      b.addEventListener('click', async () => {
        const u = users.find((item) => String(item.id) === b.dataset.reset);
        if (!u) return;
        const ok = await confirmDialog(`Reset Password for ${u.name}?`, `A temporary random password will be generated for ${u.email}.`);
        if (!ok) return;
        try {
          const res = await post(`/users/${u.id}/reset-password`);
          modal({
            title: 'Temporary Password Generated',
            narrow: true,
            body: html`
              <p>Share this temporary password with <b>${u.name}</b>. They will be required to change it upon first login:</p>
              <div class="secret">${res.temporaryPassword || res.password || 'Demo@12345'}</div>
            `,
          });
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      });
    });

    $$('[data-del]', tbody).forEach((b) => {
      b.addEventListener('click', async () => {
        const ok = await confirmDialog(
          `${t('delete')} User "${b.dataset.name}"?`,
          `Are you sure you want to delete this user account? If attendance or payroll records exist, the account will be deactivated safely.`,
          { danger: true, confirmLabel: t('delete') }
        );
        if (!ok) return;
        try {
          await del(`/users/${b.dataset.del}`);
          toast(`User "${b.dataset.name}" removed/deactivated`);
          load();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      });
    });
  }

  function openEditUserModal(user) {
    modal({
      title: `Edit User: ${user.name}`,
      submitLabel: t('save'),
      body: html`
        <div class="form-grid">
          <label class="wide">Full Name
            <input type="text" name="name" required value="${user.name}">
          </label>
          <label class="wide">Email Address
            <input type="email" name="email" required value="${user.email}">
          </label>
          <label class="wide">System Role
            <select name="role">
              ${ROLES.map((r) => html`
                <option value="${r.id}" ${user.role === r.id ? 'selected' : ''}>${r.label} — ${r.desc}</option>
              `)}
            </select>
          </label>
          <label>Status
            <select name="active">
              <option value="true" ${user.active !== false ? 'selected' : ''}>Active (Can Sign In)</option>
              <option value="false" ${user.active === false ? 'selected' : ''}>Inactive (Suspended)</option>
            </select>
          </label>
          <label>Biometric PIN
            <input type="text" name="biometric_pin" value="${user.biometric_pin || ''}">
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        await put(`/users/${user.id}`, {
          name: form.name.value.trim(),
          email: form.email.value.trim(),
          role: form.role.value,
          active: form.active.value === 'true',
          biometric_pin: form.biometric_pin.value.trim() || null,
        });
        toast('User account updated');
        close();
        load();
      },
    });
  }

  $('#add-user').addEventListener('click', () => {
    modal({
      title: 'Add New User Account',
      submitLabel: t('save'),
      body: html`
        <div class="form-grid">
          <label class="wide">Full Name
            <input type="text" name="name" required placeholder="e.g. Shakib Al Hasan">
          </label>
          <label class="wide">Email Address (Login Username)
            <input type="email" name="email" required placeholder="shakib@company.test">
          </label>
          <label class="wide">Initial Password
            <input type="password" name="password" required minlength="8" value="Demo@12345">
            <span class="hint">User will be prompted to set their own password on first login.</span>
          </label>
          <label class="wide">Role
            <select name="role">
              ${ROLES.map((r) => html`<option value="${r.id}">${r.label} — ${r.desc}</option>`)}
            </select>
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        await post('/users', {
          name: form.name.value.trim(),
          email: form.email.value.trim(),
          password: form.password.value,
          role: form.role.value,
        });
        toast('User account created');
        close();
        load();
      },
    });
  });

  $('#user-search').addEventListener('input', renderTable);
  $('#user-role-filter').addEventListener('change', renderTable);

  load();
}

