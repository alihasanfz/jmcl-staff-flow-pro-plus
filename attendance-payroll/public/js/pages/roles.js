// Users & Access Roles Management: RBAC & Permissions Control Center
import { get, post, patch, put, del } from '../api.js';
import { html, setHTML, $, $$, esc, icon, badge, toast, modal, confirmDialog, ago } from '../ui.js';
import { t } from '../i18n.js';
import { MODULES, PRESETS, canView, canEdit, getUserPermission, getPermissionSummary } from '../permissions.js';

const ROLES = [
  { id: 'super_admin', label: 'Super Admin', desc: 'Master system administrator with unrestricted privileges across all modules' },
  { id: 'company_admin', label: 'Company Admin', desc: 'Full company administrator managing all branches, staff and settings' },
  { id: 'admin', label: 'Administrator', desc: 'Full operational access with configurable custom permissions' },
  { id: 'hr_manager', label: 'HR Manager', desc: 'Full HR access: Attendance, staff, departments, shifts, leave & approvals' },
  { id: 'hr_executive', label: 'HR Executive', desc: 'Daily attendance monitoring and leave management' },
  { id: 'hr', label: 'HR Staff', desc: 'Standard HR operational access' },
  { id: 'accounts_manager', label: 'Accounts Manager', desc: 'Payroll processing, salary structures and overtime management' },
  { id: 'dept_manager', label: 'Department Manager', desc: 'Team attendance, department leave approvals and overtime' },
  { id: 'employee', label: 'Employee', desc: 'Self-service portal for viewing attendance, leave requests and payslips' },
  { id: 'staff', label: 'Staff Member', desc: 'Self-service attendance and personal profile' },
];

export async function render(view) {
  setHTML(view, html`
    <div class="stack">
      <div class="row between" style="flex-wrap:wrap; gap:12px; align-items:center;">
        <div>
          <h2>${t('roles')}</h2>
          <p class="muted">Configure system login credentials, assign administrator roles, and grant granular permissions (Can View / Can Edit) per section.</p>
        </div>
        <button class="btn primary" id="add-user" style="display:inline-flex; align-items:center; gap:6px;">
          ${icon('plus')} Add User Account
        </button>
      </div>

      <!-- Overview Stats Cards -->
      <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin-bottom:8px;">
        <div class="card" style="padding:14px 18px; border-radius:10px; background:var(--bg-panel); border:1px solid var(--border);">
          <div class="small muted" style="text-transform:uppercase; font-weight:600; letter-spacing:0.5px;">Total Users</div>
          <div style="font-size:24px; font-weight:700; margin-top:4px;" id="stat-total">—</div>
        </div>
        <div class="card" style="padding:14px 18px; border-radius:10px; background:var(--bg-panel); border:1px solid var(--border);">
          <div class="small muted" style="text-transform:uppercase; font-weight:600; letter-spacing:0.5px;">Full Administrators</div>
          <div style="font-size:24px; font-weight:700; margin-top:4px; color:#15803d;" id="stat-admin">—</div>
        </div>
        <div class="card" style="padding:14px 18px; border-radius:10px; background:var(--bg-panel); border:1px solid var(--border);">
          <div class="small muted" style="text-transform:uppercase; font-weight:600; letter-spacing:0.5px;">Custom RBAC Rules</div>
          <div style="font-size:24px; font-weight:700; margin-top:4px; color:#0284c7;" id="stat-custom">—</div>
        </div>
        <div class="card" style="padding:14px 18px; border-radius:10px; background:var(--bg-panel); border:1px solid var(--border);">
          <div class="small muted" style="text-transform:uppercase; font-weight:600; letter-spacing:0.5px;">View-Only Accounts</div>
          <div style="font-size:24px; font-weight:700; margin-top:4px; color:#b45309;" id="stat-viewonly">—</div>
        </div>
      </div>

      <div class="panel">
        <header>
          <div class="row" style="gap:10px; flex-wrap:wrap; align-items:center;">
            <div class="search-input-wrap" style="min-width:240px;">
              ${icon('search')}
              <input type="text" id="user-search" placeholder="Search name, email, employee code, PIN...">
            </div>
            <select id="user-role-filter" style="width: auto">
              <option value="">${t('all')} Roles</option>
              ${ROLES.map((r) => html`<option value="${r.id}">${r.label}</option>`)}
            </select>
            <select id="user-access-filter" style="width: auto">
              <option value="">All Access Levels</option>
              <option value="full">Full Admin Access</option>
              <option value="custom">Custom Permissions</option>
              <option value="view_only">View-Only Access</option>
              <option value="staff">Staff Self-Service</option>
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
                  <th>Access Rights & Permissions</th>
                  <th>Biometric ID</th>
                  <th>Account Status</th>
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
      updateStats();
      renderTable();
    } catch (e) {
      setHTML($('#user-tbody'), html`<tr><td colspan="6" class="empty notice bad">${e.message}</td></tr>`);
    }
  }

  function updateStats() {
    let admins = 0;
    let custom = 0;
    let viewOnly = 0;
    for (const u of users) {
      const s = getPermissionSummary(u);
      if (s.type === 'super' || s.type === 'full') admins++;
      else if (s.type === 'custom') custom++;
      else if (s.type === 'view_only') viewOnly++;
    }
    $('#stat-total').textContent = users.length;
    $('#stat-admin').textContent = admins;
    $('#stat-custom').textContent = custom;
    $('#stat-viewonly').textContent = viewOnly;
  }

  function renderTable() {
    const q = ($('#user-search')?.value || '').toLowerCase().trim();
    const roleFilter = $('#user-role-filter')?.value || '';
    const accessFilter = $('#user-access-filter')?.value || '';

    const filtered = users.filter((u) => {
      const matchesSearch = !q ||
        (u.name || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.employee_code || '').toLowerCase().includes(q) ||
        (u.device_pin || '').toLowerCase().includes(q);

      const matchesRole = !roleFilter || u.role === roleFilter;

      let matchesAccess = true;
      if (accessFilter) {
        const sum = getPermissionSummary(u);
        if (accessFilter === 'full') matchesAccess = ['super', 'full'].includes(sum.type);
        else if (accessFilter === 'custom') matchesAccess = sum.type === 'custom';
        else if (accessFilter === 'view_only') matchesAccess = sum.type === 'view_only';
        else if (accessFilter === 'staff') matchesAccess = sum.type === 'staff';
      }

      return matchesSearch && matchesRole && matchesAccess;
    });

    $('#user-count').textContent = `${filtered.length} account(s)`;

    const tbody = $('#user-tbody');
    if (!filtered.length) {
      setHTML(tbody, html`<tr><td colspan="6" class="empty">${t('noData')}</td></tr>`);
      return;
    }

    setHTML(tbody, html`
      ${filtered.map((u) => {
        const roleObj = ROLES.find((r) => r.id === u.role) || { label: u.role };
        const isSuper = ['super_admin', 'company_admin'].includes(u.role);
        const isAdmin = isSuper || u.role === 'admin';
        const isHR = u.role.startsWith('hr');
        const isAccounts = u.role.startsWith('account');
        const permSummary = getPermissionSummary(u);

        return html`
          <tr>
            <td>
              <div style="font-weight:700; color:var(--text); font-size:14px;">${u.name}</div>
              <div class="small muted" style="margin-top:2px;">
                ${u.email} · <span class="font-mono">${u.employee_code || '—'}</span>
              </div>
            </td>
            <td>
              <span class="badge ${isAdmin ? 'present' : isHR ? 'leave' : isAccounts ? 'ot' : 'waiting'}" style="font-weight:600;">
                ${roleObj.label}
              </span>
            </td>
            <td>
              <span class="badge ${permSummary.color}" style="font-weight:600; display:inline-flex; align-items:center; gap:4px;">
                ${permSummary.label}
              </span>
            </td>
            <td><span class="font-mono" style="font-weight:600;">${u.device_pin || '—'}</span></td>
            <td>
              <span class="badge ${u.active !== false ? 'present' : 'bad'}" style="font-size:11px;">
                ${u.active !== false ? 'Active' : 'Suspended'}
              </span>
            </td>
            <td class="r">
              <div class="action-btns">
                <button class="action-btn" data-edit-perm="${u.id}" style="color:#0284c7; border-color:#bae6fd; background:#f0f9ff; font-weight:600;" title="Edit user role and granular permissions">
                  ${icon('role')} Permissions & Role
                </button>
                <button class="action-btn" data-reset="${u.id}" title="Reset login password">Reset PW</button>
                <button class="action-btn danger" data-del="${u.id}" data-name="${u.name}" title="Delete account">${icon('trash')}</button>
              </div>
            </td>
          </tr>
        `;
      })}
    `);

    $$('[data-edit-perm]', tbody).forEach((b) => {
      b.addEventListener('click', () => {
        const u = users.find((item) => String(item.id) === b.dataset.editPerm);
        if (u) openPermissionsModal(u);
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

  /**
   * Permissions and Role Editor Modal
   */
  function openPermissionsModal(user, isNew = false) {
    const isSuper = user && ['super_admin', 'company_admin'].includes(user.role);
    let currentPerms = (user && user.permissions && typeof user.permissions === 'object') ? { ...user.permissions } : {};

    // Helper to evaluate current state of a module
    const getModPerm = (modKey) => {
      if (currentPerms[modKey] !== undefined) {
        const p = currentPerms[modKey];
        if (typeof p === 'boolean') return { view: p, edit: p };
        return { view: Boolean(p.view), edit: Boolean(p.view && p.edit) };
      }
      return getUserPermission(user || { role: 'employee' }, modKey);
    };

    const renderPermRows = () => {
      return MODULES.map((m) => {
        const p = getModPerm(m.key);
        const statusText = isSuper ? 'Master Admin' : (!p.view ? 'No Access' : (p.edit ? 'Full Access' : 'View Only'));
        const statusClass = isSuper ? 'present' : (!p.view ? 'muted' : (p.edit ? 'present' : 'waiting'));

        return html`
          <tr data-mod-row="${m.key}">
            <td style="padding:10px 12px;">
              <div style="font-weight:600; font-size:13px; color:var(--text); display:flex; align-items:center; gap:6px;">
                ${icon(m.icon || 'circle')} ${m.label}
              </div>
              <div class="small muted" style="margin-top:2px; font-size:11px;">${m.desc}</div>
            </td>
            <td style="text-align:center; vertical-align:middle;">
              <input type="checkbox" class="perm-cb perm-view" data-mod="${m.key}" data-type="view" ${p.view || isSuper ? 'checked' : ''} ${isSuper ? 'disabled' : ''} style="cursor:pointer; transform:scale(1.2);">
            </td>
            <td style="text-align:center; vertical-align:middle;">
              <input type="checkbox" class="perm-cb perm-edit" data-mod="${m.key}" data-type="edit" ${p.edit || isSuper ? 'checked' : ''} ${(!p.view && !isSuper) ? 'disabled' : ''} ${isSuper ? 'disabled' : ''} style="cursor:pointer; transform:scale(1.2);">
            </td>
            <td style="padding:10px 12px; text-align:center; vertical-align:middle;">
              <span class="badge ${statusClass} status-pill" style="font-size:11px; font-weight:600;">
                ${statusText}
              </span>
            </td>
          </tr>
        `;
      }).join('');
    };

    modal({
      title: isNew ? 'Add New User Account & Set Permissions' : `Edit Permissions & Role: ${user.name}`,
      submitLabel: t('save'),
      body: html`
        <div class="stack" style="gap:16px; max-width:820px;">
          <!-- Basic Account Fields -->
          <div style="background:var(--bg-card, #f8fafc); border:1px solid var(--border); border-radius:10px; padding:16px;">
            <div style="font-weight:700; font-size:14px; margin-bottom:12px; color:var(--text); display:flex; align-items:center; gap:6px;">
              ${icon('people')} Account Details
            </div>
            <div class="form-grid">
              <label>Full Name
                <input type="text" name="name" required value="${user?.name || ''}" placeholder="e.g. Shakib Al Hasan">
              </label>
              <label>Email Address (Login Username)
                <input type="email" name="email" required value="${user?.email || ''}" placeholder="shakib@company.test">
              </label>
              <label>System Role
                <select name="role" id="modal-role-select">
                  ${ROLES.map((r) => html`
                    <option value="${r.id}" ${user?.role === r.id ? 'selected' : ''}>${r.label} — ${r.desc}</option>
                  `)}
                </select>
              </label>
              <label>Biometric PIN
                <input type="text" name="device_pin" value="${user?.device_pin || ''}" placeholder="Enrolled Machine ID">
              </label>
              <label>Account Status
                <select name="active">
                  <option value="true" ${user?.active !== false ? 'selected' : ''}>Active (Can Sign In)</option>
                  <option value="false" ${user?.active === false ? 'selected' : ''}>Suspended (Access Disabled)</option>
                </select>
              </label>
              ${isNew ? html`
                <label>Initial Password
                  <input type="password" name="password" value="Demo@12345" minlength="6">
                </label>
              ` : html`
                <label>Change Password (optional)
                  <input type="password" name="password" placeholder="Leave blank to keep current">
                </label>
              `}
            </div>
          </div>

          <!-- RBAC Granular Permissions Section -->
          <div style="background:var(--bg-panel); border:1px solid var(--border); border-radius:10px; padding:16px;">
            <div class="row between" style="gap:12px; flex-wrap:wrap; align-items:center; margin-bottom:12px;">
              <div>
                <div style="font-weight:700; font-size:14px; color:var(--text); display:flex; align-items:center; gap:6px;">
                  ${icon('role')} Granular Module Permissions (View & Edit Rights)
                </div>
                <div class="small muted" style="margin-top:2px;">
                  Choose which sections of the admin panel this user can access. If "Can Edit" is unchecked, the user will have read-only access (no add, edit, or delete actions).
                </div>
              </div>
              <div class="row" style="gap:6px; flex-wrap:wrap;">
                <span class="small muted" style="font-weight:600; align-self:center;">Presets:</span>
                <button type="button" class="btn sm" id="preset-full" style="border-radius:14px; font-size:11px; padding:3px 10px; background:#f0fdf4; color:#166534; border-color:#bbf7d0; font-weight:600;">
                  👑 Full Admin
                </button>
                <button type="button" class="btn sm" id="preset-view" style="border-radius:14px; font-size:11px; padding:3px 10px; background:#fffbeb; color:#92400e; border-color:#fef3c7; font-weight:600;">
                  👁️ View Only
                </button>
                <button type="button" class="btn sm" id="preset-hr" style="border-radius:14px; font-size:11px; padding:3px 10px; font-weight:600;">
                  👥 HR Preset
                </button>
                <button type="button" class="btn sm" id="preset-acc" style="border-radius:14px; font-size:11px; padding:3px 10px; font-weight:600;">
                  💰 Accounts
                </button>
                <button type="button" class="btn sm danger" id="preset-clear" style="border-radius:14px; font-size:11px; padding:3px 10px; font-weight:600;">
                  ❌ Clear
                </button>
              </div>
            </div>

            ${isSuper ? html`
              <div class="notice" style="background:#f0fdf4; border:1px solid #bbf7d0; color:#166534; padding:8px 12px; border-radius:6px; font-size:12px; margin-bottom:12px;">
                <b>Super Administrator Protection:</b> This account is a master system administrator. Super administrators always retain complete system permissions.
              </div>
            ` : ''}

            <div class="table-wrap" style="max-height:360px; overflow-y:auto; border:1px solid var(--border); border-radius:8px;">
              <table style="margin:0; width:100%; border-collapse:collapse;">
                <thead style="position:sticky; top:0; background:var(--bg-panel); z-index:2; box-shadow:0 1px 2px rgba(0,0,0,0.05);">
                  <tr>
                    <th style="padding:10px 12px;">Admin Module / Section</th>
                    <th style="padding:10px 12px; text-align:center; width:120px;">
                      <label style="cursor:pointer; display:inline-flex; align-items:center; gap:4px; font-weight:700; margin:0;">
                        <input type="checkbox" id="toggle-all-view" style="cursor:pointer;"> Can View 👁️
                      </label>
                    </th>
                    <th style="padding:10px 12px; text-align:center; width:120px;">
                      <label style="cursor:pointer; display:inline-flex; align-items:center; gap:4px; font-weight:700; margin:0;">
                        <input type="checkbox" id="toggle-all-edit" style="cursor:pointer;"> Can Edit ✏️
                      </label>
                    </th>
                    <th style="padding:10px 12px; text-align:center; width:130px;">Access Level</th>
                  </tr>
                </thead>
                <tbody id="perm-tbody">
                  ${renderPermRows()}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `,
      onSubmit: async (form, close) => {
        const name = form.name.value.trim();
        const email = form.email.value.trim();
        const role = form.role.value;
        const active = form.active.value === 'true';
        const devicePin = form.device_pin.value.trim() || undefined;
        const password = form.password.value.trim() || undefined;

        // Build clean permissions object
        const permsObj = {};
        $$('[data-mod-row]').forEach((row) => {
          const mod = row.dataset.modRow;
          const vBox = row.querySelector('.perm-view');
          const eBox = row.querySelector('.perm-edit');
          const v = vBox ? vBox.checked : false;
          const e = eBox ? eBox.checked : false;
          permsObj[mod] = { view: v, edit: v && e };
        });

        const payload = {
          name,
          email,
          role,
          active,
          devicePin,
          permissions: permsObj,
        };
        if (password) payload.password = password;

        try {
          if (isNew) {
            await post('/users', payload);
            toast('User account created with customized permissions');
          } else {
            await patch(`/users/${user.id}`, payload);
            toast(`Permissions & role updated for "${name}"`);
          }
          close();
          load();
        } catch (err) {
          toast(err.message, 'bad');
        }
      },
    });

    // Wire up checkbox reactivity and preset buttons in modal
    setTimeout(() => {
      const updateRowBadge = (row, v, e) => {
        const pill = row.querySelector('.status-pill');
        if (!pill) return;
        if (!v) {
          pill.className = 'badge waiting status-pill';
          pill.textContent = 'No Access';
          pill.style.opacity = '0.5';
        } else if (e) {
          pill.className = 'badge present status-pill';
          pill.textContent = 'Full Access';
          pill.style.opacity = '1';
        } else {
          pill.className = 'badge ot status-pill';
          pill.textContent = 'View Only';
          pill.style.opacity = '1';
        }
      };

      const bindRowEvents = () => {
        $$('[data-mod-row]').forEach((row) => {
          const vBox = row.querySelector('.perm-view');
          const eBox = row.querySelector('.perm-edit');
          if (!vBox || !eBox) return;

          vBox.addEventListener('change', () => {
            if (!vBox.checked) {
              eBox.checked = false;
              eBox.disabled = true;
            } else {
              eBox.disabled = false;
            }
            updateRowBadge(row, vBox.checked, eBox.checked);
          });

          eBox.addEventListener('change', () => {
            if (eBox.checked) {
              vBox.checked = true;
              eBox.disabled = false;
            }
            updateRowBadge(row, vBox.checked, eBox.checked);
          });
        });
      };

      bindRowEvents();

      // Apply preset map
      const applyPresetMap = (map) => {
        $$('[data-mod-row]').forEach((row) => {
          const mod = row.dataset.modRow;
          const vBox = row.querySelector('.perm-view');
          const eBox = row.querySelector('.perm-edit');
          const conf = map[mod] || { view: false, edit: false };
          if (vBox && !vBox.disabled) vBox.checked = Boolean(conf.view);
          if (eBox && !eBox.disabled) {
            eBox.checked = Boolean(conf.view && conf.edit);
            eBox.disabled = !conf.view;
          }
          updateRowBadge(row, Boolean(conf.view), Boolean(conf.view && conf.edit));
        });
      };

      $('#preset-full')?.addEventListener('click', () => applyPresetMap(PRESETS.full_admin.perms));
      $('#preset-view')?.addEventListener('click', () => applyPresetMap(PRESETS.view_only.perms));
      $('#preset-hr')?.addEventListener('click', () => applyPresetMap(PRESETS.hr_manager.perms));
      $('#preset-acc')?.addEventListener('click', () => applyPresetMap(PRESETS.accounts.perms));
      $('#preset-clear')?.addEventListener('click', () => applyPresetMap(PRESETS.clear.perms));

      $('#toggle-all-view')?.addEventListener('change', (e) => {
        const val = e.target.checked;
        $$('.perm-view').forEach((cb) => {
          if (!cb.disabled) {
            cb.checked = val;
            cb.dispatchEvent(new Event('change'));
          }
        });
      });

      $('#toggle-all-edit')?.addEventListener('change', (e) => {
        const val = e.target.checked;
        $$('.perm-edit').forEach((cb) => {
          if (!cb.disabled) {
            cb.checked = val;
            cb.dispatchEvent(new Event('change'));
          }
        });
      });
    }, 50);
  }

  $('#add-user').addEventListener('click', () => {
    openPermissionsModal({ role: 'employee', active: true, permissions: {} }, true);
  });

  $('#user-search').addEventListener('input', renderTable);
  $('#user-role-filter').addEventListener('change', renderTable);
  $('#user-access-filter').addEventListener('change', renderTable);

  load();
}
