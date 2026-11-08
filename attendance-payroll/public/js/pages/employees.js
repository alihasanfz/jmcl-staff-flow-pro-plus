import { get, post, patch, put, del, qs } from '../api.js';
import { html, setHTML, $, $$, fmtMoney, fmtDateLong, badge, toast, modal, formValues, confirmDialog, icon } from '../ui.js';
import { t } from '../i18n.js';

export async function render(view, state) {
  const isAdmin = ['admin', 'company_admin', 'super_admin'].includes(state.user.role);
  const f = { q: '', department: '', active: 'true' };
  
  let shifts = [];
  let departments = [];
  let designations = [];

  try {
    const [sRes, dRes, desRes] = await Promise.all([
      get('/org/shifts').catch(() => ({ shifts: [] })),
      get('/departments').catch(() => ({ departments: [] })),
      get('/designations').catch(() => ({ designations: [] })),
    ]);
    shifts = sRes.shifts || [];
    departments = dRes.departments || [];
    designations = desRes.designations || [];
  } catch { /* ignore */ }

  function formatEmergencyContact(ec) {
    if (!ec) return '';
    if (typeof ec === 'string') {
      if (ec === '[object Object]' || ec.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(ec);
          return formatEmergencyContact(parsed);
        } catch (_) {
          return ec === '[object Object]' ? '' : ec;
        }
      }
      return ec === '[object Object]' ? '' : ec;
    }
    if (typeof ec === 'object') {
      const parts = [ec.contact, ec.name, ec.phone, ec.relationship].filter(Boolean);
      return parts.join(' - ');
    }
    return String(ec);
  }

  const secretDialog = (title, who, pw) => modal({
    title, cancelLabel: t('close'), narrow: true,
    body: html`<p>Share this temporary password with <b>${who}</b> securely. It is shown only once, and they will be prompted to change it at first sign-in:</p><div class="secret">${pw}</div>`,
  });

  const load = async () => {
    const { users } = await get(`/users${qs(f)}`);
    const container = $('#list');
    
    if (!users.length) {
      setHTML(container, html`<p class="empty">${t('noData')}</p>`);
      return;
    }

    setHTML(container, html`
      <table>
        <thead>
          <tr>
            <th>${t('name')}</th>
            <th>${t('department')} &amp; ${t('designation')}</th>
            <th>Biometric PIN</th>
            <th>${t('shift')}</th>
            <th class="r">${t('salary')}</th>
            <th>${t('status')}</th>
            <th class="r">${t('actions')}</th>
          </tr>
        </thead>
        <tbody>
          ${users.map((u) => html`
            <tr>
              <td class="nameCell">
                <b>${u.name}</b>
                <span>${u.employee_code || u.employee_id || '—'} · ${u.email}</span>
              </td>
              <td>
                <span class="badge waiting">${u.department || 'General'}</span>
                <div class="small muted">${u.designation || 'Staff'}</div>
              </td>
              <td><span class="font-mono num">${u.device_pin || u.biometric_pin || '—'}</span></td>
              <td class="muted">${u.shift_name || html`<span class="badge late">No shift</span>`}</td>
              <td class="r">
                <b>${fmtMoney(u.base_salary || u.basic_salary)}</b>
                <div class="small muted">Gross: ${fmtMoney((Number(u.base_salary || 0) + Number(u.allowances || 0)))}</div>
              </td>
              <td>${badge(u.active !== false && u.status !== 'inactive' ? 'active' : 'inactive')}</td>
              <td class="r">
                <div class="action-btns">
                  <button class="action-btn" data-view="${u.id}">${t('view')}</button>
                  <button class="action-btn" data-edit="${u.id}">${icon('edit')} ${t('edit')}</button>
                  ${isAdmin ? html`<button class="action-btn" data-reset="${u.id}" data-name="${u.name}">Reset</button>` : ''}
                  ${isAdmin && u.id !== state.user.id ? html`<button class="action-btn danger" data-del="${u.id}" data-name="${u.name}">${icon('trash')} ${t('delete')}</button>` : ''}
                </div>
              </td>
            </tr>
          `)}
        </tbody>
      </table>
    `);

    $$('[data-view]').forEach((b) => b.addEventListener('click', () => viewProfile(users.find((u) => String(u.id) === b.dataset.view))));
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(users.find((u) => String(u.id) === b.dataset.edit))));
    $$('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await confirmDialog('Reset password?', `A temporary password will be generated for ${b.dataset.name}.`, { danger: true });
      if (!ok) return;
      try {
        const r = await post(`/users/${b.dataset.reset}/reset-password`);
        secretDialog('Temporary password', b.dataset.name, r.temporaryPassword);
      } catch (e) {
        toast(e.message, 'bad');
      }
    }));
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const ok = await confirmDialog(
        `${t('delete')} ${b.dataset.name}?`,
        'Are you sure you want to delete this employee? If attendance or payroll records exist, the employee will be deactivated safely to preserve history.',
        { confirmLabel: t('delete'), danger: true }
      );
      if (!ok) return;
      try {
        await del(`/users/${b.dataset.del}`);
        toast('Employee removed');
        load();
      } catch (e) {
        toast(e.message, 'bad');
      }
    }));
  };

  const viewProfile = (u) => {
    modal({
      title: `Employee Profile: ${u.name}`,
      wide: true,
      cancelLabel: t('close'),
      body: html`
        <div class="stack">
          <div class="row between" style="border-bottom: 1px solid var(--line); padding-bottom: 14px;">
            <div>
              <h2 style="margin-bottom: 4px;">${u.name}</h2>
              <span class="badge ${u.active ? 'active' : 'inactive'}">${u.active ? 'Active Employee' : 'Inactive'}</span>
              <span class="badge waiting" style="margin-left: 6px;">${u.department || 'General'}</span>
            </div>
            <div style="text-align: right;">
              <span class="small muted">Employee ID</span>
              <div style="font-size: 16px; font-weight: 700;">${u.employee_code || u.employee_id || '—'}</div>
              <span class="small muted">Biometric PIN: <b>${u.device_pin || u.biometric_pin || '—'}</b></span>
            </div>
          </div>

          <div class="cols-eq">
            <div class="panel">
              <header><b>Personal &amp; Contact Details</b></header>
              <div class="body stack" style="gap: 8px;">
                <div class="kv"><dt>Email:</dt><dd>${u.email}</dd></div>
                <div class="kv"><dt>Phone:</dt><dd>${u.phone || '—'}</dd></div>
                <div class="kv"><dt>Address:</dt><dd>${u.address || '—'}</dd></div>
                <div class="kv"><dt>NID Number:</dt><dd>${u.nid_number || '—'}</dd></div>
                <div class="kv"><dt>Blood Group:</dt><dd>${u.blood_group || '—'}</dd></div>
                <div class="kv"><dt>Emergency Contact:</dt><dd>${formatEmergencyContact(u.emergency_contact) || '—'}</dd></div>
              </div>
            </div>

            <div class="panel">
              <header><b>Employment &amp; Compensation</b></header>
              <div class="body stack" style="gap: 8px;">
                <div class="kv"><dt>Department:</dt><dd>${u.department || '—'}</dd></div>
                <div class="kv"><dt>Designation:</dt><dd>${u.designation || '—'}</dd></div>
                <div class="kv"><dt>Shift:</dt><dd>${u.shift_name || 'No Shift Assigned'}</dd></div>
                <div class="kv"><dt>Joined:</dt><dd>${fmtDateLong(u.join_date)}</dd></div>
                <div class="kv"><dt>Basic Salary:</dt><dd>${fmtMoney(u.base_salary)}</dd></div>
                <div class="kv"><dt>Allowances:</dt><dd>${fmtMoney(u.allowances)}</dd></div>
                <div class="kv total"><dt>Gross Salary:</dt><dd>${fmtMoney(Number(u.base_salary || 0) + Number(u.allowances || 0))}</dd></div>
              </div>
            </div>
          </div>
        </div>
      `,
    });
  };

  const edit = (u) => {
    const isNew = !u;
    const canRole = isAdmin;

    modal({
      title: isNew ? '⚡ Quick Add Employee (সহজ কর্মী এন্ট্রি — নাম ও আইডি)' : `${t('editEmployee')}: ${u.name}`,
      submitLabel: isNew ? 'Save & Link Device (সংরক্ষণ করুন)' : t('save'),
      wide: true,
      body: html`
        <div class="stack" style="gap:16px;">
          <!-- Primary Quick Register Box: Just Name and ID -->
          <div style="background:var(--paper-2); border:2px solid #2563eb; border-radius:10px; padding:16px; box-shadow:0 2px 8px rgba(37,99,235,0.08);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
              <span style="font-size:14px; font-weight:700; color:#1d4ed8; display:flex; align-items:center; gap:6px;">
                ${icon('plus')} ${isNew ? 'Quick Add (শুধু নাম ও আইডি দিলেই যথেষ্ট)' : 'Primary Biometric Identity'}
              </span>
              <span class="badge online" style="font-size:11px;">Auto-Sync Active</span>
            </div>

            <div class="form-grid" style="grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:14px;">
              <label class="wide" style="font-weight:700;">
                Full Name (কর্মীর পুরো নাম) *
                <input type="text" name="name" required maxlength="120" value="${u?.name || ''}" placeholder="e.g. Md. Rahim / তানভীর আহমেদ" autofocus style="font-size:15px; font-weight:600;">
              </label>

              <label style="font-weight:700;">
                Biometric PIN / Machine ID (মেশিনের পাঞ্চ পিন) *
                <input type="text" name="devicePin" inputmode="numeric" pattern="[0-9]{1,9}" value="${u?.device_pin || u?.biometric_pin || ''}" placeholder="e.g. 55" style="font-size:15px; font-weight:700; font-family:monospace; color:var(--primary);">
                <span class="hint" style="color:#2563eb; font-weight:600;">uFace800 বা SenseFace মেশিনে যে ID সেভ আছে।</span>
              </label>

              <label style="font-weight:700;">
                Employee Code (আইডি কোড)
                <input type="text" name="employeeCode" maxlength="32" value="${u?.employee_code || u?.employee_id || ''}" placeholder="Auto: EMP0055">
                <span class="hint">খালি রাখলে PIN দিয়ে অটো কোড তৈরি হবে।</span>
              </label>

              <label class="wide" style="font-weight:700;">
                Work Shift (কাজের শিফট)
                <select name="shiftId" style="font-weight:600;">
                  ${shifts.map((s) => html`
                    <option value="${s.id}" ${
                      (u?.shift_id === s.id || (!u?.shift_id && s.name.includes('uFace800'))) ? 'selected' : ''
                    }>${s.name} (${s.start_time} - ${s.end_time})</option>
                  `)}
                </select>
                <span class="hint">ডিফল্ট: uFace800 শিফট (সকাল 09:30 AM – রাত 07:00 PM)।</span>
              </label>
            </div>
          </div>

          <!-- Collapsible Optional & Profile Details -->
          <details style="border:1px solid var(--line); border-radius:8px; padding:12px 16px; background:var(--paper);" ${!isNew ? 'open' : ''}>
            <summary style="font-weight:600; color:var(--text); cursor:pointer; font-size:13px; user-select:none;">
              ▼ Additional Profile &amp; Salary Details (ঐচ্ছিক / বিস্তারিত তথ্য - প্রয়োজন হলে ক্লিক করুন)
            </summary>
            <div class="form-grid" style="margin-top:14px;">
              <label>Work Email (Login ID)
                <input type="email" name="email" value="${u?.email || ''}" placeholder="Auto: emp[PIN]@company.local">
              </label>
              <label>Phone Number
                <input type="text" name="phone" value="${u?.phone || ''}" placeholder="+880 1700 000000">
              </label>
              <label>Department
                <select name="department">
                  <option value="General">General</option>
                  ${departments.map((d) => html`
                    <option value="${d.name}" ${(u?.department || 'General') === d.name ? 'selected' : ''}>${d.name}</option>
                  `)}
                </select>
              </label>
              <label>Designation
                <select name="designation">
                  <option value="Staff">Staff</option>
                  ${designations.map((d) => html`
                    <option value="${d.title}" ${(u?.designation || 'Staff') === d.title ? 'selected' : ''}>${d.title}</option>
                  `)}
                </select>
              </label>
              <label>System Role
                <select name="role" ${canRole ? '' : 'disabled'}>
                  ${[
                    ['employee', 'Employee (Staff)'],
                    ['hr', 'HR Staff'],
                    ['hr_manager', 'HR Manager'],
                    ['accounts_manager', 'Accounts Manager'],
                    ['admin', 'Administrator'],
                  ].map(([v, l]) => html`<option value="${v}" ${(u?.role || 'employee') === v ? 'selected' : ''}>${l}</option>`)}
                </select>
              </label>
              <label>Joining Date
                <input type="date" name="joinDate" value="${u?.join_date || state.meta.today}">
              </label>
              <label>Basic Salary (BDT)
                <input type="number" name="baseSalary" min="0" step="0.01" value="${u?.base_salary ?? 0}">
              </label>
              <label>Allowances
                <input type="number" name="allowances" min="0" step="0.01" value="${u?.allowances ?? 0}">
              </label>
              <label class="wide">Address
                <input type="text" name="address" value="${u?.address || ''}" placeholder="Dhaka, Mirpur">
              </label>
              <label>Emergency Contact
                <input type="text" name="emergency_contact" value="${formatEmergencyContact(u?.emergency_contact)}" placeholder="Name &amp; Phone">
              </label>
              <label>NID Number
                <input type="text" name="nid_number" value="${u?.nid_number || ''}" placeholder="National Identity Number">
              </label>
              ${isNew ? html`
                <label class="wide">Initial Password
                  <input type="text" name="password" minlength="8" value="Demo@12345">
                  <span class="hint">Default password is Demo@12345.</span>
                </label>
              ` : html`
                <label class="check" style="align-self:end">
                  <input type="checkbox" name="active" ${u.active !== false ? 'checked' : ''}> Active Employee
                </label>
              `}
            </div>
          </details>
        </div>
      `,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        const pin = String(v.devicePin || v.employeeCode || '').trim();
        const code = String(v.employeeCode || (pin ? 'EMP' + pin.padStart(4, '0') : '')).trim();
        const email = String(v.email || (pin ? `emp${pin}@company.local` : '')).trim();

        const body = {
          name: v.name.trim(),
          email: email || undefined,
          phone: v.phone ? v.phone.trim() : null,
          employeeCode: code || undefined,
          devicePin: pin || undefined,
          department: v.department || 'General',
          designation: v.designation || 'Staff',
          shiftId: v.shiftId ? Number(v.shiftId) : null,
          baseSalary: Number(v.baseSalary || 0),
          allowances: Number(v.allowances || 0),
          joinDate: v.joinDate || undefined,
          address: v.address ? v.address.trim() : null,
          emergencyContact: formatEmergencyContact(v.emergency_contact) || null,
          nidNumber: v.nid_number ? v.nid_number.trim() : null,
          ...(canRole ? { role: v.role } : {}),
        };

        if (isNew) {
          const r = await post('/users', { ...body, password: v.password || 'Demo@12345' });
          close();
          toast(`Employee "${v.name}" added & linked to machine PIN ${pin || 'auto'}!`);
          await load();
          if (r.temporaryPassword) secretDialog('Employee Created', v.name, r.temporaryPassword);
        } else {
          await patch(`/users/${u.id}`, { ...body, active: v.active });
          close();
          toast('Employee profile updated successfully');
          load();
        }
      },
    });

    // Smart auto-fill listeners
    setTimeout(() => {
      const pinInput = document.querySelector('input[name="devicePin"]');
      const codeInput = document.querySelector('input[name="employeeCode"]');
      const emailInput = document.querySelector('input[name="email"]');
      if (pinInput && isNew) {
        pinInput.addEventListener('input', () => {
          const val = pinInput.value.trim();
          if (val) {
            if (codeInput && (!codeInput.value || codeInput.value.startsWith('EMP'))) {
              codeInput.value = `EMP${val.padStart(4, '0')}`;
            }
            if (emailInput && (!emailInput.value || emailInput.value.endsWith('@company.local'))) {
              emailInput.value = `emp${val}@company.local`;
            }
          }
        });
      }
    }, 50);
  };

  // Export to CSV
  const exportEmployees = async () => {
    const { users } = await get(`/users${qs(f)}`);
    if (!users.length) return toast('No employees to export', 'bad');

    const headers = ['Employee ID', 'Name', 'Email', 'Phone', 'Department', 'Designation', 'Biometric PIN', 'Shift', 'Base Salary', 'Allowances', 'Gross Salary', 'Joining Date', 'Status'];
    const rows = users.map((u) => [
      `"${u.employee_code || u.employee_id || ''}"`,
      `"${u.name || ''}"`,
      `"${u.email || ''}"`,
      `"${u.phone || ''}"`,
      `"${u.department || ''}"`,
      `"${u.designation || ''}"`,
      `"${u.device_pin || u.biometric_pin || ''}"`,
      `"${u.shift_name || ''}"`,
      u.base_salary || 0,
      u.allowances || 0,
      Number(u.base_salary || 0) + Number(u.allowances || 0),
      `"${u.join_date || ''}"`,
      `"${u.active ? 'Active' : 'Inactive'}"`,
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `employees_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  setHTML(view, html`
    <div class="stack">
      <div class="row between">
        <div>
          <h2>${t('employees')}</h2>
          <p class="muted">Add, manage, and configure staff profiles, biometric IDs, shifts, and salary structures.</p>
        </div>
        <div class="row">
          <button class="btn" id="export-emp">${icon('download')} ${t('exportCsv')}</button>
          <button class="btn primary" id="add-emp">${icon('plus')} ${t('addEmployee')}</button>
        </div>
      </div>

      <form class="filters" id="filters">
        <div class="search-input-wrap">
          ${icon('search')}
          <input type="text" name="q" placeholder="${t('search')} name, code, email...">
        </div>
        <label>
          <select name="department">
            <option value="">${t('all')} ${t('departments')}</option>
            ${departments.map((d) => html`<option value="${d.name}">${d.name}</option>`)}
          </select>
        </label>
        <label>
          <select name="active">
            <option value="true">Active Only</option>
            <option value="false">Inactive Only</option>
            <option value="">${t('all')} Status</option>
          </select>
        </label>
        <button class="btn" type="submit">${t('filter')}</button>
      </form>

      <section class="panel">
        <div class="body flush table-wrap" id="list">
          <p class="empty">${t('loading')}</p>
        </div>
      </section>
    </div>
  `);

  $('#filters').addEventListener('submit', (e) => {
    e.preventDefault();
    Object.assign(f, {
      q: e.target.q.value,
      department: e.target.department.value,
      active: e.target.active.value,
    });
    load();
  });

  $('#export-emp').addEventListener('click', exportEmployees);
  $('#add-emp').addEventListener('click', () => edit(null));

  await load();
}
