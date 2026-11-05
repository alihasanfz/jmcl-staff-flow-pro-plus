// Overtime Management: Approval Workflow & Tracker
import { get, post, put, del } from '../api.js';
import { html, setHTML, $, $$, esc, icon, badge, toast, modal, confirmDialog, fmtMoney, fmtHours, fmtDateLong } from '../ui.js';
import { t } from '../i18n.js';

export async function render(view) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  setHTML(view, html`
    <div class="stack">
      <div class="row between">
        <div>
          <h2>${t('overtime')}</h2>
          <p class="muted">Track, verify, and approve overtime hours and calculate overtime payroll pay.</p>
        </div>
        <div class="row">
          <button class="btn primary" id="add-ot">${icon('plus')} Log Manual Overtime</button>
        </div>
      </div>

      <div class="stats-grid">
        <div class="stat-card primary"><span class="lbl">Total OT Logged</span><span class="val" id="ot-total-hrs">—</span></div>
        <div class="stat-card ok"><span class="lbl">Approved Hours</span><span class="val" id="ot-approved-hrs">—</span></div>
        <div class="stat-card late"><span class="lbl">Pending Approval</span><span class="val" id="ot-pending-count">—</span></div>
        <div class="stat-card ot"><span class="lbl">Estimated Payout</span><span class="val" id="ot-payout">—</span></div>
      </div>

      <div class="panel">
        <header>
          <div class="row">
            <label style="min-width: 140px;">
              ${t('month')}
              <input type="month" id="ot-month" value="${currentMonth}">
            </label>
            <div class="search-input-wrap">
              ${icon('search')}
              <input type="text" id="ot-search" placeholder="${t('search')} employee...">
            </div>
            <select id="ot-status-filter" style="width: auto">
              <option value="">${t('all')} Statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
          <span class="small muted" id="ot-count"></span>
        </header>
        <div class="body flush">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Date</th>
                  <th>Overtime Hours</th>
                  <th>Multiplier Rate</th>
                  <th>Status</th>
                  <th>Approver / Notes</th>
                  <th class="r">${t('actions')}</th>
                </tr>
              </thead>
              <tbody id="ot-tbody">
                <tr><td colspan="7" class="empty">${t('loading')}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `);

  let records = [];

  async function load() {
    const month = $('#ot-month').value;
    try {
      const res = await get(`/overtime?month=${month}`);
      records = res.records || [];
      renderTable();
    } catch (e) {
      setHTML($('#ot-tbody'), html`<tr><td colspan="7" class="empty notice bad">${e.message}</td></tr>`);
    }
  }

  function renderTable() {
    const q = ($('#ot-search')?.value || '').toLowerCase().trim();
    const st = $('#ot-status-filter')?.value || '';

    const filtered = records.filter((r) => {
      const matchesSearch = !q || (r.employee_name || '').toLowerCase().includes(q) || (r.employee_code || '').toLowerCase().includes(q);
      const matchesStatus = !st || r.status === st;
      return matchesSearch && matchesStatus;
    });

    const totalMin = filtered.reduce((acc, r) => acc + (r.minutes || 0), 0);
    const approvedMin = filtered.filter((r) => r.status === 'approved').reduce((acc, r) => acc + (r.minutes || 0), 0);
    const pendingCount = filtered.filter((r) => r.status === 'pending').length;

    $('#ot-total-hrs').textContent = `${(totalMin / 60).toFixed(1)} hrs`;
    $('#ot-approved-hrs').textContent = `${(approvedMin / 60).toFixed(1)} hrs`;
    $('#ot-pending-count').textContent = pendingCount;
    $('#ot-payout').textContent = `${fmtMoney(filtered.reduce((acc, r) => acc + Number(r.payout || 0), 0))}`;
    $('#ot-count').textContent = `${filtered.length} record(s)`;

    const tbody = $('#ot-tbody');
    if (!filtered.length) {
      setHTML(tbody, html`<tr><td colspan="7" class="empty">${t('noData')}</td></tr>`);
      return;
    }

    setHTML(tbody, html`
      ${filtered.map((r) => html`
        <tr>
          <td>
            <b>${r.employee_name || 'Staff Member'}</b>
            <div class="small muted">${r.employee_code || ''} · ${r.department || 'General'}</div>
          </td>
          <td><b class="date">${fmtDateLong(r.date)}</b></td>
          <td><b class="time">${fmtHours(r.minutes)}</b></td>
          <td><span class="small">${r.rate_multiplier || 1.0}x</span></td>
          <td>${badge(r.status)}</td>
          <td>
            <span class="small muted">${r.approved_by_name ? `By ${r.approved_by_name}` : r.notes || '—'}</span>
          </td>
          <td class="r">
            <div class="action-btns">
              ${r.status === 'pending' ? html`
                <button class="action-btn" data-approve="${r.id}" style="color:var(--ok)">${icon('check')} Approve</button>
                <button class="action-btn" data-reject="${r.id}" style="color:var(--bad)">Reject</button>
              ` : ''}
              <button class="action-btn danger" data-del="${r.id}">${icon('trash')} ${t('delete')}</button>
            </div>
          </td>
        </tr>
      `)}
    `);

    $$('[data-approve]', tbody).forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          await post(`/overtime/${b.dataset.approve}/approve`);
          toast('Overtime approved');
          load();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      });
    });

    $$('[data-reject]', tbody).forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          await post(`/overtime/${b.dataset.reject}/reject`);
          toast('Overtime rejected');
          load();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      });
    });

    $$('[data-del]', tbody).forEach((b) => {
      b.addEventListener('click', async () => {
        const ok = await confirmDialog('Delete Overtime Record?', 'Are you sure you want to delete this overtime entry?', { danger: true });
        if (!ok) return;
        try {
          await del(`/overtime/${b.dataset.del}`);
          toast('Overtime record deleted');
          load();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      });
    });
  }

  $('#ot-month').addEventListener('change', load);
  $('#ot-search').addEventListener('input', renderTable);
  $('#ot-status-filter').addEventListener('change', renderTable);

  $('#add-ot').addEventListener('click', async () => {
    let users = [];
    try {
      const uRes = await get('/users');
      users = uRes.users || [];
    } catch { /* ignore */ }

    modal({
      title: 'Log Manual Overtime',
      submitLabel: t('save'),
      body: html`
        <div class="form-grid">
          <label class="wide">Employee
            <select name="userId" required>
              <option value="">Select Employee</option>
              ${users.map((u) => html`<option value="${u.id}">${u.name} (${u.employee_id || u.email})</option>`)}
            </select>
          </label>
          <label>Date
            <input type="date" name="date" required value="${new Date().toISOString().slice(0, 10)}">
          </label>
          <label>Overtime Minutes
            <input type="number" name="minutes" min="15" step="15" required value="60">
          </label>
          <label class="wide">Notes / Reason
            <input type="text" name="notes" placeholder="e.g. Month-end closing tasks">
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        await post('/overtime', {
          userId: parseInt(form.userId.value, 10),
          date: form.date.value,
          minutes: parseInt(form.minutes.value, 10),
          notes: form.notes.value.trim() || undefined,
        });
        toast('Overtime logged');
        close();
        load();
      },
    });
  });

  load();
}

