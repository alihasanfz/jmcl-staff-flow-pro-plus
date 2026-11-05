// Attendance Management: Full CRUD (Add, Edit, Delete, Recalculate, Filter)
import { get, post, put, del, qs } from '../api.js';
import { html, setHTML, $, $$, fmtDate, fmtHours, fmtMin, badge, toast, modal, formValues, confirmDialog, addDays, icon } from '../ui.js';
import { t } from '../i18n.js';

export async function render(view, state) {
  const isMgr = ['admin', 'company_admin', 'super_admin', 'hr_manager', 'hr_executive', 'hr', 'accounts_manager', 'dept_manager'].includes(state.user.role);
  const today = state.meta.today;
  const f = { from: addDays(today, -13), to: today, userId: '', department: '', status: '' };
  let tab = 'daily';
  let users = [];
  let departments = [];

  if (isMgr) {
    try {
      const [uRes, dRes] = await Promise.all([
        get('/users?active=true'),
        get('/departments').catch(() => get('/users/departments').then((r) => ({ departments: (r.departments || []).map((name) => ({ name })) }))),
      ]);
      users = uRes.users || [];
      departments = dRes.departments || [];
    } catch { /* ignore */ }
  }

  const shell = () => {
    setHTML(view, html`
      <div class="stack">
        ${isMgr ? html`
          <div class="row between">
            <div class="tabs" role="tablist" style="margin-bottom:0">
              <button role="tab" data-tab="daily" aria-selected="${tab === 'daily'}">Daily records</button>
              <button role="tab" data-tab="punches" aria-selected="${tab === 'punches'}">Raw punches</button>
            </div>
            ${tab === 'daily' ? html`
              <button class="btn primary" id="add-att-btn">${icon('plus')} Add Attendance Record</button>
            ` : ''}
          </div>
        ` : ''}

        <form class="filters" id="filters">
          <label>From
            <input type="date" name="from" value="${f.from}" max="${today}">
          </label>
          <label>To
            <input type="date" name="to" value="${f.to}" max="${today}">
          </label>
          ${isMgr ? html`
            <label>Employee
              <select name="userId">
                <option value="">All Employees</option>
                ${users.map((u) => html`<option value="${u.id}" ${String(u.id) === f.userId ? 'selected' : ''}>${u.name}</option>`)}
              </select>
            </label>
            ${tab === 'daily' ? html`
              <label>Department
                <select name="department">
                  <option value="">All Departments</option>
                  ${departments.map((d) => html`<option value="${d.name || d}" ${(d.name || d) === f.department ? 'selected' : ''}>${d.name || d}</option>`)}
                </select>
              </label>
            ` : ''}
          ` : ''}
          ${tab === 'daily' ? html`
            <label>Status
              <select name="status">
                <option value="">All Statuses</option>
                ${[
                  ['present', 'Present'],
                  ['late', 'Late'],
                  ['half_day', 'Half day'],
                  ['absent', 'Absent'],
                  ['leave', 'On leave'],
                  ['unpaid_leave', 'Unpaid leave'],
                  ['weekend', 'Weekly off'],
                  ['holiday', 'Holiday'],
                ].map(([v, l]) => html`<option value="${v}" ${v === f.status ? 'selected' : ''}>${l}</option>`)}
              </select>
            </label>
          ` : ''}
          <button class="btn" type="submit">${t('filter')}</button>
          ${isMgr && tab === 'daily' ? html`
            <button class="btn" type="button" id="recalc" title="Recompute attendance from the raw punches for this date range">
              ${icon('clock')} Recalculate
            </button>
          ` : ''}
        </form>

        <section class="panel">
          <div class="body flush table-wrap" id="results">
            <p class="empty">${t('loading')}</p>
          </div>
        </section>
      </div>
    `);

    $$('[data-tab]', view).forEach((b) => b.addEventListener('click', () => {
      tab = b.dataset.tab;
      shell();
      load();
    }));

    $('#filters').addEventListener('submit', (e) => {
      e.preventDefault();
      Object.assign(f, formValues(e.target));
      for (const k of ['userId', 'department', 'status']) f[k] = f[k] || '';
      load();
    });

    $('#recalc')?.addEventListener('click', async () => {
      try {
        const r = await post('/attendance/recalculate', { from: $('#filters').from.value, to: $('#filters').to.value });
        toast(`Recalculated ${r.rows} attendance records`);
        load();
      } catch (e) {
        toast(e.message, 'bad');
      }
    });

    $('#add-att-btn')?.addEventListener('click', openAddModal);
  };

  const load = async () => {
    const box = $('#results');
    try {
      if (tab === 'punches') {
        const { rows } = await get(`/attendance/punches${qs({ from: f.from, to: f.to, userId: f.userId })}`);
        if (!rows.length) {
          setHTML(box, html`<p class="empty">No punches recorded in this range.</p>`);
          return;
        }
        setHTML(box, html`
          <table>
            <thead>
              <tr>
                <th>Punch Time</th>
                <th>Employee</th>
                <th>Device PIN</th>
                <th>Device / Terminal</th>
                <th>Source</th>
                <th>Punch Type</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => html`
                <tr>
                  <td class="time">${r.at}</td>
                  <td>${r.name || html`<span class="badge absent">Unknown PIN</span>`}</td>
                  <td><span class="num">${r.pin}</span></td>
                  <td>${r.device || '—'}</td>
                  <td><span class="badge ${r.source === 'device' ? 'online' : 'waiting'}">${r.source}</span></td>
                  <td>${r.state === 0 ? 'Check-in' : r.state === 1 ? 'Check-out' : r.state ?? '—'}</td>
                </tr>
              `)}
            </tbody>
          </table>
        `);
        return;
      }

      const { rows } = await get(`/attendance${qs({ from: f.from, to: f.to, userId: isMgr ? f.userId : '', department: f.department, status: f.status })}`);
      if (!rows.length) {
        setHTML(box, html`<p class="empty">No attendance records found for these filters.</p>`);
        return;
      }

      setHTML(box, html`
        <table>
          <thead>
            <tr>
              <th>Date</th>
              ${isMgr ? html`<th>Employee</th>` : ''}
              <th>Shift</th>
              <th>In</th>
              <th>Out</th>
              <th class="r">Worked</th>
              <th class="r">Late</th>
              <th class="r">Early out</th>
              <th class="r">Overtime</th>
              <th>Status</th>
              ${isMgr ? html`<th class="r">Actions</th>` : ''}
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => html`
              <tr>
                <td><b>${fmtDate(r.work_date)}</b></td>
                ${isMgr ? html`
                  <td class="nameCell">
                    <b>${r.name}</b>
                    <span>${r.department || 'General'}</span>
                  </td>
                ` : ''}
                <td class="muted">${r.shift_name || '—'}</td>
                <td><b class="time">${r.check_in_local || '—'}</b></td>
                <td><b class="time">${r.check_out_local || (r.missing_checkout ? html`<span class="badge late">Missing</span>` : '—')}</b></td>
                <td class="r time">${fmtHours(r.worked_minutes)}</td>
                <td class="r">${fmtMin(r.late_minutes)}</td>
                <td class="r">${fmtMin(r.early_out_minutes)}</td>
                <td class="r">${r.overtime_minutes ? html`${fmtMin(r.overtime_minutes)}${r.off_day_work ? html` <span class="small muted">off day</span>` : ''}` : '—'}</td>
                <td>${badge(r.status)}</td>
                ${isMgr ? html`
                  <td class="r">
                    <div class="action-btns">
                      <button class="action-btn" data-edit-att="${r.id}">${icon('edit')} Edit</button>
                      <button class="action-btn danger" data-del-att="${r.id}" data-name="${r.name}" data-date="${r.work_date}">${icon('trash')} Delete</button>
                    </div>
                  </td>
                ` : ''}
              </tr>
            `)}
          </tbody>
        </table>
      `);

      $$('[data-edit-att]', box).forEach((b) => {
        b.addEventListener('click', () => {
          const rec = rows.find((item) => String(item.id) === b.dataset.editAtt);
          if (rec) openEditModal(rec);
        });
      });

      $$('[data-del-att]', box).forEach((b) => {
        b.addEventListener('click', async () => {
          const ok = await confirmDialog(
            `Delete Attendance Record?`,
            `Are you sure you want to permanently delete the attendance record for ${b.dataset.name} on ${fmtDate(b.dataset.date)}?`,
            { danger: true, confirmLabel: 'Delete' }
          );
          if (!ok) return;
          try {
            await del(`/attendance/${b.dataset.delAtt}`);
            toast('Attendance record deleted');
            load();
          } catch (e) {
            toast(e.message, 'bad');
          }
        });
      });
    } catch (e) {
      setHTML(box, html`<div class="notice bad" style="margin:16px">${e.message}</div>`);
    }
  };

  function openAddModal() {
    modal({
      title: 'Add Attendance Record',
      submitLabel: 'Save Record',
      body: html`
        <div class="form-grid">
          <label class="wide">Employee
            <select name="userId" required>
              <option value="">Select Employee</option>
              ${users.map((u) => html`<option value="${u.id}">${u.name} (${u.employee_code || u.email})</option>`)}
            </select>
          </label>
          <label>Date
            <input type="date" name="date" required value="${today}" max="${today}">
          </label>
          <label>Status
            <select name="status">
              <option value="present">Present</option>
              <option value="late">Late</option>
              <option value="half_day">Half Day</option>
              <option value="absent">Absent</option>
              <option value="leave">On Leave</option>
              <option value="unpaid_leave">Unpaid Leave</option>
            </select>
          </label>
          <label>Check-in Time
            <input type="time" name="checkIn" value="09:00">
          </label>
          <label>Check-out Time
            <input type="time" name="checkOut" value="18:00">
          </label>
          <label>Overtime Minutes
            <input type="number" name="overtimeMinutes" min="0" step="15" value="0">
          </label>
          <label>Late Minutes
            <input type="number" name="lateMinutes" min="0" step="5" value="0">
          </label>
          <label class="wide">Reason / Audit Note
            <input type="text" name="reason" required minlength="3" placeholder="e.g. Manual entry approved by manager">
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        await post('/attendance/manual', {
          userId: Number(v.userId),
          date: v.date,
          status: v.status,
          checkIn: v.checkIn || null,
          checkOut: v.checkOut || null,
          overtimeMinutes: Number(v.overtimeMinutes || 0),
          lateMinutes: Number(v.lateMinutes || 0),
          reason: v.reason,
        });
        toast('Attendance record added');
        close();
        load();
      },
    });
  }

  function openEditModal(rec) {
    modal({
      title: `Edit Attendance: ${rec.name} (${fmtDate(rec.work_date)})`,
      submitLabel: 'Save Changes',
      body: html`
        <div class="form-grid">
          <label>Status
            <select name="status">
              ${[
                ['present', 'Present'],
                ['late', 'Late'],
                ['half_day', 'Half Day'],
                ['absent', 'Absent'],
                ['leave', 'On Leave'],
                ['unpaid_leave', 'Unpaid Leave'],
                ['weekend', 'Weekly Off'],
                ['holiday', 'Holiday'],
              ].map(([val, lbl]) => html`
                <option value="${val}" ${rec.status === val ? 'selected' : ''}>${lbl}</option>
              `)}
            </select>
          </label>
          <label>Shift
            <input type="text" disabled value="${rec.shift_name || 'No Shift'}">
          </label>
          <label>Check-in Time
            <input type="time" name="checkIn" value="${rec.check_in_local || '09:00'}">
          </label>
          <label>Check-out Time
            <input type="time" name="checkOut" value="${rec.check_out_local || '18:00'}">
          </label>
          <label>Overtime Minutes
            <input type="number" name="overtimeMinutes" min="0" step="15" value="${rec.overtime_minutes || 0}">
          </label>
          <label>Late Minutes
            <input type="number" name="lateMinutes" min="0" step="5" value="${rec.late_minutes || 0}">
          </label>
          <label class="wide">Reason / Audit Note
            <input type="text" name="reason" required minlength="3" placeholder="e.g. Corrected check-out time">
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        await put(`/attendance/${rec.id}`, {
          status: v.status,
          checkIn: v.checkIn || null,
          checkOut: v.checkOut || null,
          overtimeMinutes: Number(v.overtimeMinutes || 0),
          lateMinutes: Number(v.lateMinutes || 0),
          reason: v.reason,
        });
        toast('Attendance record updated');
        close();
        load();
      },
    });
  }

  shell();
  await load();
}
