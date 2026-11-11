// Attendance Management: Full CRUD (Add, Edit, Delete, Recalculate, Filter)
import { get, post, put, del, qs } from '../api.js';
import { html, setHTML, $, $$, fmtDate, fmtHours, fmtMin, badge, toast, modal, formValues, confirmDialog, addDays, icon } from '../ui.js';
import { t } from '../i18n.js';

export async function render(view, state) {
  const isMgr = ['admin', 'company_admin', 'super_admin', 'hr_manager', 'hr_executive', 'hr', 'accounts_manager', 'dept_manager'].includes(state.user.role);
  const today = state.meta.today;
  // Default to today so single-date daily attendance is shown immediately
  const f = { from: today, to: today, userId: '', department: '', status: '', deviceSn: '' };
  let tab = 'daily';
  let users = [];
  let departments = [];
  let devices = [];
  let autoRefreshTimer = null;

  if (isMgr) {
    try {
      const [uRes, dRes, devRes] = await Promise.all([
        get('/users?active=true'),
        get('/departments').catch(() => get('/users/departments').then((r) => ({ departments: (r.departments || []).map((name) => ({ name })) }))),
        get('/devices').catch(() => ({ devices: [] })),
      ]);
      users = uRes.users || [];
      departments = dRes.departments || [];
      devices = devRes.devices || [];
    } catch { /* ignore */ }
  }

  const shell = () => {
    setHTML(view, html`
      <div class="stack">
        <!-- Dedicated Machine Selector / Multi-Terminal Tabs -->
        <div class="terminal-nav-wrap" style="background:var(--bg-panel, #fff); border:1px solid var(--border, #e2e8f0); border-radius:12px; padding:12px 16px; margin-bottom:14px; box-shadow:0 1px 3px rgba(0,0,0,0.03);">
          <div class="row between" style="gap:12px; flex-wrap:wrap; align-items:center;">
            <div class="row" style="gap:8px; flex-wrap:wrap; align-items:center;">
              <span style="font-weight:700; font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-right:4px;">
                ${icon('globe')} Terminal:
              </span>
              <button type="button" class="btn sm ${f.deviceSn === '' ? 'primary' : ''}" data-term="" style="border-radius:20px; font-weight:600; padding:5px 14px;">
                📋 All Terminals
              </button>
              <button type="button" class="btn sm ${f.deviceSn === 'RKQ4262500336' ? 'primary' : ''}" data-term="RKQ4262500336" style="border-radius:20px; font-weight:600; padding:5px 14px;">
                🏢 ZK-uFace 800 <span style="background:#0284c7; color:#fff; font-size:10px; border-radius:10px; padding:2px 7px; margin-left:6px;">Main Attendance (09:30 AM – 07:00 PM)</span>
              </button>
              <button type="button" class="btn sm ${f.deviceSn === 'VDE2251500160' ? 'primary' : ''}" data-term="VDE2251500160" style="border-radius:20px; font-weight:600; padding:5px 14px;">
                🚪 SenseFace 7A <span style="background:#7e22ce; color:#fff; font-size:10px; border-radius:10px; padding:2px 7px; margin-left:6px;">Barrier Gate Controller</span>
              </button>
            </div>
            <div class="row" style="gap:8px; align-items:center;">
              <span class="badge online" style="font-size:11px;"><span class="pulse-dot online"></span> Auto-Sync Live</span>
            </div>
          </div>

          ${f.deviceSn === 'RKQ4262500336' ? html`
            <div style="margin-top:10px; padding:12px 16px; background:rgba(2,132,199,0.06); border-left:3px solid #0284c7; border-radius:8px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
              <div style="font-size:12.5px; color:#0369a1; line-height:1.45;">
                <b>🏢 ZKTeco Terminal (ZK-UFACE800-01) Filtered Attendance:</b> Official shift time-attendance (<b>09:30 AM to 07:00 PM</b>).
                <div style="font-size:11.5px; color:#0284c7; margin-top:3px;">
                  ℹ️ <b>Out Time Note:</b> Employees are currently on duty. Out Time will automatically record and appear in red (🔴) as soon as staff punch on the uFace 800 machine at shift checkout.
                </div>
              </div>
              <span class="badge online" style="background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd;">SN: RKQ4262500336</span>
            </div>
          ` : f.deviceSn === 'VDE2251500160' ? html`
            <div style="margin-top:10px; padding:10px 14px; background:rgba(147,51,234,0.06); border-left:3px solid #9333ea; border-radius:6px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
              <div style="font-size:12.5px; color:#7e22ce;">
                <b>🚪 SenseFace 7A (Gate Access Controller):</b> Showing barrier gate unlocking and turnstile access passage swipes.
              </div>
              <span class="badge online" style="background:#f3e8ff; color:#7e22ce; border:1px solid #e9d5ff;">SN: VDE2251500160</span>
            </div>
          ` : ''}
        </div>

        ${isMgr ? html`
          <div class="row between" style="margin-bottom:10px; flex-wrap:wrap; gap:8px; align-items:center;">
            <div class="tabs" role="tablist" style="margin-bottom:0">
              <button role="tab" data-tab="daily" aria-selected="${tab === 'daily'}">Daily records</button>
              <button role="tab" data-tab="punches" aria-selected="${tab === 'punches'}">Raw punches</button>
            </div>
            <div class="row" style="gap:6px; flex-wrap:wrap;">
              <span style="font-size:11px; font-weight:700; color:var(--text-muted); align-self:center; text-transform:uppercase;">Quick Date:</span>
              <button type="button" class="btn sm ${f.from === today && f.to === today ? 'primary' : ''}" id="btn-quick-today" style="border-radius:16px; padding:3px 10px; font-size:12px;">
                📅 Today (${today})
              </button>
              <button type="button" class="btn sm ${f.from === addDays(today, -1) && f.to === addDays(today, -1) ? 'primary' : ''}" id="btn-quick-yesterday" style="border-radius:16px; padding:3px 10px; font-size:12px;">
                ⏮ Yesterday
              </button>
              <button type="button" class="btn sm ${f.from === addDays(today, -6) ? 'primary' : ''}" id="btn-quick-7d" style="border-radius:16px; padding:3px 10px; font-size:12px;">
                Last 7 Days
              </button>
              ${tab === 'daily' ? html`
                <button class="btn primary sm" id="add-att-btn" style="border-radius:16px; padding:3px 12px; font-size:12px; margin-left:8px;">${icon('plus')} Add Record</button>
              ` : ''}
            </div>
          </div>
        ` : ''}

        <form class="filters" id="filters">
          <label>From
            <input type="date" name="from" value="${f.from}" max="${today}">
          </label>
          <label>To
            <input type="date" name="to" value="${f.to}" max="${today}">
          </label>
          <label>Terminal / Device
            <select name="deviceSn">
              <option value="">All Terminals</option>
              <option value="RKQ4262500336" ${f.deviceSn === 'RKQ4262500336' ? 'selected' : ''}>🏢 ZK-uFace 800 (Main Attendance 09:30–19:00)</option>
              <option value="VDE2251500160" ${f.deviceSn === 'VDE2251500160' ? 'selected' : ''}>🚪 SenseFace 7A (Gate Controller)</option>
            </select>
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
            <button class="btn" type="button" id="download-pdf" style="background:#fee2e2; color:#991b1b; border-color:#fecaca; font-weight:600; display:inline-flex; align-items:center; gap:5px;" title="Download printable PDF attendance sheet for this date range">
              ${icon('download')} Download Daily PDF
            </button>
            <button class="btn" type="button" id="download-excel" style="background:#f0fdf4; color:#166534; border-color:#bbf7d0; font-weight:600; display:inline-flex; align-items:center; gap:5px;" title="Export attendance to Excel (.xlsx)">
              ${icon('download')} Export Excel
            </button>
            <button class="btn" type="button" id="fix-morning-btn" style="background:#fef3c7; color:#92400e; border-color:#fde68a; font-weight:600; display:inline-flex; align-items:center; gap:5px;" title="Auto-calibrate today's punches that occurred before machine clock was synced">
              ${icon('clock')} Fix Today Punches (09:00–10:00 AM)
            </button>
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

    $$('[data-term]', view).forEach((b) => b.addEventListener('click', () => {
      f.deviceSn = b.dataset.term;
      shell();
      load();
    }));

    $('#filters').addEventListener('submit', (e) => {
      e.preventDefault();
      Object.assign(f, formValues(e.target));
      for (const k of ['userId', 'department', 'status', 'deviceSn']) f[k] = f[k] || '';
      shell();
      load();
    });

    $('#btn-quick-today')?.addEventListener('click', () => {
      f.from = today; f.to = today;
      shell(); load();
    });

    $('#btn-quick-yesterday')?.addEventListener('click', () => {
      const yest = addDays(today, -1);
      f.from = yest; f.to = yest;
      shell(); load();
    });

    $('#btn-quick-7d')?.addEventListener('click', () => {
      f.from = addDays(today, -6); f.to = today;
      shell(); load();
    });

    $('#download-pdf')?.addEventListener('click', () => {
      // Strictly download for the selected single date or chosen date range
      const targetFrom = f.from || f.to || today;
      const targetTo = f.to || f.from || today;
      const url = `/api/reports/attendance?format=pdf&from=${encodeURIComponent(targetFrom)}&to=${encodeURIComponent(targetTo)}`
        + (f.department ? `&department=${encodeURIComponent(f.department)}` : '')
        + (f.status ? `&status=${encodeURIComponent(f.status)}` : '')
        + (f.deviceSn ? `&deviceSn=${encodeURIComponent(f.deviceSn)}` : '');
      window.open(url, '_blank');
    });

    $('#download-excel')?.addEventListener('click', () => {
      const targetFrom = f.from || f.to || today;
      const targetTo = f.to || f.from || today;
      const url = `/api/reports/attendance?format=xlsx&from=${encodeURIComponent(targetFrom)}&to=${encodeURIComponent(targetTo)}`
        + (f.department ? `&department=${encodeURIComponent(f.department)}` : '')
        + (f.status ? `&status=${encodeURIComponent(f.status)}` : '')
        + (f.deviceSn ? `&deviceSn=${encodeURIComponent(f.deviceSn)}` : '');
      window.open(url, '_blank');
    });

    $('#fix-morning-btn')?.addEventListener('click', () => {
      confirmDialog({
        title: 'Fix Today Morning Punches (09:00 - 10:00 AM)',
        message: 'This will adjust today\'s morning punch timestamps by subtracting the machine clock skew, marking all employees who entered between 09:00 AM and 10:00 AM as Present and on-time. Continue?',
        confirmLabel: 'Fix & Recalculate Now',
        danger: false,
        onConfirm: async () => {
          try {
            const res = await post('/attendance/fix-morning-punches', { date: f.to });
            toast(res.message || 'Morning punches successfully corrected!');
            load();
          } catch (err) {
            toast(err.message || 'Error fixing punches', 'bad');
          }
        },
      });
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
        const { rows } = await get(`/attendance/punches${qs({ from: f.from, to: f.to, userId: f.userId, deviceSn: f.deviceSn })}`);
        if (!rows.length) {
          setHTML(box, html`<p class="empty">No punches recorded for this terminal/filter.</p>`);
          return;
        }
        const isGateFilter = f.deviceSn === 'VDE2251500160';
        setHTML(box, html`
          ${isGateFilter ? html`
            <div style="margin-bottom:12px; padding:10px 16px; background:rgba(147,51,234,0.08); border-radius:10px; border:1px solid rgba(147,51,234,0.2); display:flex; justify-content:space-between; align-items:center;">
              <div style="font-weight:700; color:#7e22ce; font-size:13px; display:flex; align-items:center; gap:8px;">
                <span>🚪</span> SenseFace 7A Live Gate Passage Audit Trail (${rows.length} swipe records)
              </div>
              <span class="small muted">Showing who passed through the factory barrier gate and at what exact time.</span>
            </div>
          ` : ''}
          <table>
            <thead>
              <tr>
                <th>${isGateFilter ? 'Gate Passage Time' : 'Punch Time'}</th>
                <th>Employee</th>
                <th>Device PIN</th>
                <th>Terminal / Device</th>
                <th>Source</th>
                <th>${isGateFilter ? 'Gate Action' : 'Punch Type'}</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => html`
                <tr>
                  <td>
                    <div class="time" style="font-weight:750; font-family:monospace; color:var(--text); font-size:13px;">
                      ${r.time_12h || (r.at ? r.at.slice(11, 19) : '—')}
                    </div>
                    <div class="small muted">${r.work_date || (r.at ? r.at.slice(0, 10) : '')}</div>
                  </td>
                  <td>
                    <div style="font-weight:700; color:var(--text);">${r.name || html`<span class="badge absent">Unknown PIN (${r.pin})</span>`}</div>
                    <div class="small muted">${r.employee_code || `PIN: ${r.pin}`} ${r.department ? `· ${r.department}` : ''}</div>
                  </td>
                  <td><span class="num">${r.pin}</span></td>
                  <td>
                    ${r.device_sn === 'RKQ4262500336' || (r.device && r.device.includes('RKQ')) ? html`
                      <span class="badge" style="background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd; font-weight:600; white-space:nowrap;">
                        🏢 uFace 800
                      </span>
                    ` : r.device_sn === 'VDE2251500160' || (r.device && r.device.includes('VDE')) ? html`
                      <span class="badge" style="background:#f3e8ff; color:#7e22ce; border:1px solid #e9d5ff; font-weight:600; white-space:nowrap;">
                        🚪 SenseFace 7A (Gate)
                      </span>
                    ` : html`
                      <span class="muted small">${r.device || '—'}</span>
                    `}
                  </td>
                  <td><span class="badge ${r.source === 'device' ? 'online' : 'waiting'}">${r.source}</span></td>
                  <td>
                    ${(() => {
                      const timeStr = r.at ? r.at.split(' ')[1] || '' : '';
                      const hour = parseInt(timeStr.split(':')[0] || '12', 10);
                      const isOut = r.state === 1 && hour >= 16;
                      const isGate = r.device_sn === 'VDE2251500160' || (r.device && r.device.includes('VDE'));
                      if (isGate) {
                        return isOut
                          ? html`<span class="badge" style="background:#fee2e2; color:#991b1b; font-weight:750; border:1px solid #fca5a5;">🚪 Gate Exit (OUT)</span>`
                          : html`<span class="badge" style="background:#dcfce7; color:#15803d; font-weight:750; border:1px solid #86efac;">🚪 Gate Entry (IN)</span>`;
                      }
                      if (isOut) {
                        return html`<span class="badge" style="background:#fee2e2; color:#991b1b; font-weight:700;">🔴 Check-out (OUT)</span>`;
                      }
                      return html`<span class="badge" style="background:#dcfce7; color:#15803d; font-weight:700;">🟢 Check-in (IN)</span>`;
                    })()}
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        `);
        return;
      }

      const { rows } = await get(`/attendance${qs({ from: f.from, to: f.to, userId: isMgr ? f.userId : '', department: f.department, status: f.status, deviceSn: f.deviceSn })}`);
      if (!rows.length) {
        setHTML(box, html`<p class="empty">No attendance records found for this terminal and date range.</p>`);
        return;
      }

      const isGate = f.deviceSn === 'VDE2251500160';
      setHTML(box, html`
        ${isGate ? html`
          <div style="margin-bottom:12px; padding:10px 16px; background:rgba(147,51,234,0.08); border-radius:10px; border:1px solid rgba(147,51,234,0.2); display:flex; justify-content:space-between; align-items:center;">
            <div style="font-weight:700; color:#7e22ce; font-size:13px; display:flex; align-items:center; gap:8px;">
              <span>🚪</span> SenseFace 7A Factory Barrier Gate Passages (${rows.length} employee records)
            </div>
            <span class="small muted">First gate entry time and last gate exit time recorded by SenseFace 7A.</span>
          </div>
        ` : ''}
        <table>
          <thead>
            <tr>
              <th>Date</th>
              ${isMgr ? html`<th>Employee</th>` : ''}
              <th>${isGate ? 'Gate Device' : 'Terminal'}</th>
              <th>Shift</th>
              <th>${isGate ? 'Gate Entry (IN)' : 'In Time (IN)'}</th>
              <th>${isGate ? 'Gate Exit (OUT)' : 'Out Time (OUT)'}</th>
              <th class="r">${isGate ? 'Duration' : 'Worked'}</th>
              <th class="r">Late</th>
              <th class="r">Early out</th>
              <th class="r">Overtime</th>
              <th>${isGate ? 'Gate Status' : 'Status'}</th>
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
                <td>
                  ${r.device_sn === 'RKQ4262500336' || (r.device_name && r.device_name.includes('RKQ')) ? html`
                    <span class="badge" style="background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd; font-weight:600; white-space:nowrap;">
                      🏢 uFace 800
                    </span>
                  ` : r.device_sn === 'VDE2251500160' || (r.device_name && r.device_name.includes('VDE')) ? html`
                    <span class="badge" style="background:#f3e8ff; color:#7e22ce; border:1px solid #e9d5ff; font-weight:600; white-space:nowrap;">
                      🚪 SenseFace 7A (Gate)
                    </span>
                  ` : html`
                    <span class="muted small">${r.device_name || '—'}</span>
                  `}
                </td>
                <td class="muted small">${r.shift_name || '—'}</td>
                <td>
                  ${r.check_in_local && r.check_in_local !== '—' ? html`
                    <span style="font-weight:700; color:#15803d; font-family:monospace; display:inline-flex; align-items:center; gap:4px;">
                      🟢 ${r.check_in_local}
                    </span>
                  ` : html`<span class="muted font-mono">—</span>`}
                </td>
                <td>
                  ${r.check_out_local && r.check_out_local !== '—' ? html`
                    <span style="font-weight:700; color:#dc2626; font-family:monospace; display:inline-flex; align-items:center; gap:4px;">
                      🔴 ${r.check_out_local}
                    </span>
                  ` : r.check_in_local && r.check_in_local !== '—' ? html`
                    ${(() => {
                      const now = new Date();
                      const dhakaHour = parseInt(now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', hour12: false }), 10);
                      const isPastShift = r.work_date < today || (r.work_date === today && dhakaHour >= 19);
                      return isPastShift ? html`
                        <span class="badge" style="background:#fee2e2; color:#b91c1c; border:1px solid #fecaca; font-size:11px; font-weight:600;">
                          ⚠️ Missing Checkout
                        </span>
                      ` : html`
                        <span class="badge" style="background:rgba(16,185,129,0.1); color:#15803d; border:1px solid rgba(16,185,129,0.25); font-weight:600; font-size:11px; white-space:nowrap;">
                          🟢 At Work (Shift to 07:00 PM)
                        </span>
                      `;
                    })()}
                  ` : html`<span class="muted font-mono">—</span>`}
                </td>
                <td class="r time" style="font-weight:700;">${fmtHours(r.worked_minutes)}</td>
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
