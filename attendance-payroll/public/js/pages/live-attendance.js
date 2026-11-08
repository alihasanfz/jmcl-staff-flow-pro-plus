// Live Attendance Monitor: Real-time punch stream, device feed & today's presence
import { get, post } from '../api.js';
import { html, setHTML, $, $$, esc, icon, badge, toast, modal, fmtHours, ago } from '../ui.js';
import { t } from '../i18n.js';

let pollTimer = null;

export async function render(view, state) {
  let depts = [];
  let selectedDeviceSn = '';
  try {
    const res = await get('/departments');
    depts = res.departments || [];
  } catch { /* ignore */ }

  const renderShell = () => {
    setHTML(view, html`
      <div class="stack">
        <!-- Dedicated Machine Selector / Multi-Terminal Tabs -->
        <div class="terminal-nav-wrap" style="background:var(--bg-panel, #fff); border:1px solid var(--border, #e2e8f0); border-radius:12px; padding:12px 16px; margin-bottom:14px; box-shadow:0 1px 3px rgba(0,0,0,0.03);">
          <div class="row between" style="gap:12px; flex-wrap:wrap; align-items:center;">
            <div class="row" style="gap:8px; flex-wrap:wrap; align-items:center;">
              <span style="font-weight:700; font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px; margin-right:4px;">
                ${icon('globe')} বায়োমেট্রিক টার্মিনাল:
              </span>
              <button type="button" class="btn sm ${selectedDeviceSn === '' ? 'primary' : ''}" data-term="" style="border-radius:20px; font-weight:600; padding:5px 14px;">
                📋 সব মেশিন (All Devices)
              </button>
              <button type="button" class="btn sm ${selectedDeviceSn === 'RKQ4262500336' ? 'primary' : ''}" data-term="RKQ4262500336" style="border-radius:20px; font-weight:600; padding:5px 14px;">
                🏢 ZK-uFace 800 <span style="background:#0284c7; color:#fff; font-size:10px; border-radius:10px; padding:2px 7px; margin-left:6px;">09:30 AM – 07:00 PM</span>
              </button>
              <button type="button" class="btn sm ${selectedDeviceSn === 'VDE2251500160' ? 'primary' : ''}" data-term="VDE2251500160" style="border-radius:20px; font-weight:600; padding:5px 14px;">
                👤 SenseFace 7A <span style="background:#7e22ce; color:#fff; font-size:10px; border-radius:10px; padding:2px 7px; margin-left:6px;">Face &amp; Finger</span>
              </button>
            </div>
            <div class="row" style="gap:8px; align-items:center;">
              <span class="badge online" style="font-size:11px;"><span class="pulse-dot online"></span> Auto-Sync Live</span>
            </div>
          </div>

          ${selectedDeviceSn === 'RKQ4262500336' ? html`
            <div style="margin-top:10px; padding:10px 14px; background:rgba(2,132,199,0.06); border-left:3px solid #0284c7; border-radius:6px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
              <div style="font-size:12.5px; color:#0369a1;">
                <b>🏢 ZKTeco Terminal (ZK-UFACE800-01) আলাদা লাইভ উপস্থিতি:</b> শিফট সময় <b>সকাল ০৯:৩০ AM থেকে রাত ০৭:০০ PM</b>।
              </div>
              <span class="badge online" style="background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd;">SN: RKQ4262500336</span>
            </div>
          ` : selectedDeviceSn === 'VDE2251500160' ? html`
            <div style="margin-top:10px; padding:10px 14px; background:rgba(147,51,234,0.06); border-left:3px solid #9333ea; border-radius:6px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
              <div style="font-size:12.5px; color:#7e22ce;">
                <b>👤 SenseFace 7A আলাদা লাইভ উপস্থিতি:</b> ফেস ও ফিঙ্গারপ্রিন্ট টার্মিনালের লাইভ পাঞ্চ স্ট্রিম।
              </div>
              <span class="badge online" style="background:#f3e8ff; color:#7e22ce; border:1px solid #e9d5ff;">SN: VDE2251500160</span>
            </div>
          ` : ''}
        </div>

        <div class="row between">
          <div class="row">
            <div class="pulse-indicator">
              <span class="pulse-dot"></span>
              <span>${t('liveAttendance')}</span>
            </div>
            <span class="badge online">${t('online')}</span>
          </div>
          <div class="row">
            <button class="btn sm" id="refresh-live">${icon('clock')} ${t('refresh')}</button>
            <button class="btn sm primary" id="add-punch">${icon('plus')} ${t('manualEntry')}</button>
          </div>
        </div>

        <div class="stats-grid" id="live-stats">
          <div class="stat-card primary"><span class="lbl">${t('expectedToday')}</span><span class="val" id="st-expected">—</span></div>
          <div class="stat-card ok"><span class="lbl">${t('checkedIn')}</span><span class="val" id="st-present">—</span></div>
          <div class="stat-card late"><span class="lbl">${t('lateToday')}</span><span class="val" id="st-late">—</span></div>
          <div class="stat-card bad"><span class="lbl">${t('absentToday')}</span><span class="val" id="st-absent">—</span></div>
          <div class="stat-card leave"><span class="lbl">${t('onLeaveToday')}</span><span class="val" id="st-leave">—</span></div>
          <div class="stat-card ot"><span class="lbl">${t('overtimeHours')}</span><span class="val" id="st-ot">—</span></div>
        </div>

        <div class="panel">
          <header>
            <h2>${t('recentPunches')} ${selectedDeviceSn === 'RKQ4262500336' ? '(ZK-uFace 800)' : selectedDeviceSn === 'VDE2251500160' ? '(SenseFace 7A)' : ''}</h2>
            <div class="row">
              <div class="search-input-wrap">
                ${icon('search')}
                <input type="text" id="live-search" placeholder="${t('search')}">
              </div>
              <select id="live-dept-filter" style="width: auto">
                <option value="">${t('all')} ${t('departments')}</option>
                ${depts.map((d) => html`<option value="${d.name}">${d.name}</option>`)}
              </select>
            </div>
          </header>
          <div class="body flush">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>${t('date')} &amp; Time</th>
                    <th>${t('name')}</th>
                    <th>${t('employeeId')}</th>
                    <th>${t('department')}</th>
                    <th>${t('punchSource')}</th>
                    <th>Punch Type</th>
                    <th>Device / Terminal</th>
                  </tr>
                </thead>
                <tbody id="live-tbody">
                  <tr><td colspan="7" class="empty">${t('loading')}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `);

    // Attach terminal button events
    $$('.terminal-nav-wrap button[data-term]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedDeviceSn = btn.dataset.term;
        renderShell();
        loadData();
      });
    });

    $('#refresh-live')?.addEventListener('click', loadData);
    $('#live-search')?.addEventListener('input', loadData);
    $('#live-dept-filter')?.addEventListener('change', loadData);

    $('#add-punch')?.addEventListener('click', () => {
      modal({
        title: t('manualEntry'),
        submitLabel: t('save'),
        body: html`
          <div class="form-grid">
            <label class="wide">Employee Biometric ID / PIN
              <input type="text" name="pin" required placeholder="e.g. 1001">
            </label>
            <label>Date
              <input type="date" name="date" required value="${new Date().toISOString().slice(0, 10)}">
            </label>
            <label>Time
              <input type="time" name="time" required value="${new Date().toTimeString().slice(0, 5)}">
            </label>
            <label class="wide">Punch Type
              <select name="punchType">
                <option value="in">Check-in (Punch In)</option>
                <option value="out">Check-out (Punch Out)</option>
              </select>
            </label>
          </div>
        `,
        onSubmit: async (form, close) => {
          const pin = form.pin.value.trim();
          const d = form.date.value;
          const tm = form.time.value;
          const punchType = form.punchType.value;
          await post('/attendance/manual', {
            userId: parseInt(pin, 10),
            date: d,
            checkIn: punchType === 'in' ? tm : undefined,
            checkOut: punchType === 'out' ? tm : undefined,
            reason: 'Live manual punch entry',
          });
          toast('Manual punch recorded');
          close();
          loadData();
        },
      });
    });
  };

  async function loadData() {
    try {
      const liveUrl = selectedDeviceSn ? `/attendance/live?deviceSn=${encodeURIComponent(selectedDeviceSn)}` : '/attendance/live';
      const [dash, live] = await Promise.all([
        get('/dashboard/overview').catch(() => get('/dashboard').catch(() => ({}))),
        get(liveUrl).catch(() => ({ punches: [] })),
      ]);

      const l = dash.today?.kpi || dash.today || {};
      $('#st-expected').textContent = l.expected ?? 0;
      $('#st-present').textContent = l.present ?? 0;
      $('#st-late').textContent = l.late ?? 0;
      $('#st-absent').textContent = l.absent ?? 0;
      $('#st-leave').textContent = l.onLeave ?? l.leave ?? 0;
      $('#st-ot').textContent = typeof l.overtimeMinutes === 'number'
        ? `${(l.overtimeMinutes / 60).toFixed(1)}h`
        : `${((l.overtime_minutes || 0) / 60).toFixed(1)}h`;

      const search = ($('#live-search')?.value || '').toLowerCase().trim();
      const deptFilter = $('#live-dept-filter')?.value || '';

      const punches = (live.punches || []).filter((p) => {
        const empName = p.employee_name || p.name || '';
        const empCode = p.employee_code || '';
        const pin = p.pin || '';
        const matchesSearch = !search ||
          empName.toLowerCase().includes(search) ||
          empCode.toLowerCase().includes(search) ||
          pin.toLowerCase().includes(search);
        const matchesDept = !deptFilter || (p.department || 'General') === deptFilter;
        return matchesSearch && matchesDept;
      });

      const tbody = $('#live-tbody');
      if (!punches.length) {
        setHTML(tbody, html`<tr><td colspan="7" class="empty">${t('noData')}</td></tr>`);
        return;
      }

      setHTML(tbody, html`
        ${punches.slice(0, 100).map((p) => {
          const pt = p.punch_time || p.punched_at;
          const timeStr = pt ? new Date(pt).toLocaleTimeString('en-GB', { hour12: false }) : (p.at || '—');
          const agoStr = pt ? ago(pt) : '';
          const isOut = p.punch_type === 'out' || p.punch_state === 1 || p.state === 1;
          const displayName = p.employee_name || p.name || (p.pin ? `PIN ${p.pin}` : 'Unassigned User');
          const sn = (p.device_sn || '').toUpperCase();
          const isUFace = sn === 'RKQ4262500336' || (p.device_name || '').toLowerCase().includes('uface');
          const isSense = sn === 'VDE2251500160' || (p.device_name || '').toLowerCase().includes('senseface');
          const termBadge = isUFace
            ? html`<span class="badge" style="background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd; font-weight:600;">🏢 uFace 800</span>`
            : isSense
              ? html`<span class="badge" style="background:#f3e8ff; color:#7e22ce; border:1px solid #e9d5ff; font-weight:600;">👤 SenseFace 7A</span>`
              : html`<span class="small muted">${p.device_name || p.terminal_alias || 'Biometric Terminal'}</span>`;

          return html`
            <tr>
              <td>
                <b class="time">${timeStr}</b>
                <div class="small muted">${agoStr}</div>
              </td>
              <td><b>${displayName}</b></td>
              <td><span class="small">${p.employee_code || (p.pin ? 'PIN ' + p.pin : '—')}</span></td>
              <td><span class="badge waiting">${p.department || 'General'}</span></td>
              <td><span class="badge ${p.source === 'device' ? 'online' : 'waiting'}">${p.source || 'device'}</span></td>
              <td><span class="badge ${isOut ? 'late' : 'present'}">${isOut ? t('checkOut') : t('checkIn')}</span></td>
              <td>${termBadge}</td>
            </tr>
          `;
        })}
      `);
    } catch (e) {
      console.error('live-attendance error:', e);
      const tbody = $('#live-tbody');
      if (tbody) setHTML(tbody, html`<tr><td colspan="7" class="empty notice bad">${e.message || 'Error loading live attendance'}</td></tr>`);
    }
  }

  renderShell();
  loadData();
  pollTimer = setInterval(loadData, 6000);

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };
}

