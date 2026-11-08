import { get } from '../api.js';
import { html, setHTML, $, $$, fmtHours, fmtDate, fmtMoney, fmtMonth, badge, ago, icon } from '../ui.js';
import { navigate } from '../main.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const toMin = (hhmm) => { const [h, m] = (hhmm || '00:00').split(':').map(Number); return h * 60 + m; };

export async function render(view, state) {
  return state.user.role === 'staff' ? renderStaff(view, state) : renderManager(view, state);
}

/* ======================= Admin / HR Manager ======================= */
async function renderManager(view, state) {
  let charts = [];
  let pollTimer;
  let clockTimer;
  let activeTab = 'all';
  let searchTerm = '';
  let viewMode = 'table'; // 'table' or 'timeline'
  let cachedData = null;

  const updateLiveClocks = () => {
    const dhakaNow = new Date();
    const timeStr = dhakaNow.toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const dateStr = dhakaNow.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric' });
    const uClock = $('#uface-live-clock');
    const uDate = $('#uface-live-date');
    const sClock = $('#senseface-live-clock');
    const sDate = $('#senseface-live-date');
    const headClock = $('#header-live-time');

    if (uClock) uClock.textContent = timeStr;
    if (uDate) uDate.textContent = dateStr;
    if (sClock) sClock.textContent = timeStr;
    if (sDate) sDate.textContent = dateStr;
    if (headClock) headClock.textContent = `${dateStr} · ${timeStr} (Dhaka UTC+6)`;
  };

  const draw = (d) => {
    cachedData = d;
    charts.forEach((c) => c.destroy());
    charts = [];
    const t = d.today;
    const k = t.kpi;

    // Filter employees for the roster
    const filteredRibbon = (t.ribbon || []).filter((r) => {
      const matchSearch = !searchTerm ||
        r.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (r.department && r.department.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (r.shiftStart && r.shiftStart.includes(searchTerm));
      if (!matchSearch) return false;
      if (activeTab === 'present') return ['present', 'late'].includes(r.state) || r.checkIn;
      if (activeTab === 'waiting') return r.state === 'waiting';
      if (activeTab === 'late') return r.lateMinutes > 0;
      if (activeTab === 'absent') return r.state === 'absent';
      return true;
    });

    setHTML(view, html`
      <div class="stack" style="gap:20px;">
        <!-- Top Live Biometric Gateway & Clock Header -->
        <section class="live-gateway-banner">
          <div class="gateway-header">
            <div class="gateway-title-area">
              <span style="font-size:26px;">🏢</span>
              <div class="gateway-title-text">
                <h1>Jeans Manufacturing Company Ltd.</h1>
                <span>Enterprise Biometric Access &amp; Time-Attendance System · <b style="color:#38bdf8;" id="header-live-time">—</b></span>
              </div>
            </div>
            <div class="row" style="gap:8px;">
              <a href="/devices" data-link class="btn sm" style="background:rgba(255,255,255,0.12); color:#fff; border:1px solid rgba(255,255,255,0.2); font-weight:600; border-radius:20px;">
                ${icon('gear')} Terminal Settings
              </a>
              <a href="/attendance" data-link class="btn sm primary" style="border-radius:20px; font-weight:600;">
                ${icon('download')} Daily Attendance Sheet
              </a>
            </div>
          </div>

          <!-- Dual Terminal Status Cards -->
          <div class="gateway-terminals-grid">
            <!-- Terminal 1: ZKTeco uFace 800 -->
            <div class="gateway-terminal-card uface">
              <div class="term-card-top">
                <div>
                  <div class="term-name">🏢 ZKTeco Terminal (ZK-UFACE800-01)</div>
                  <div class="term-meta">Model: <b>uFace 800</b> · SN: <code>RKQ4262500336</code> · Head_Office</div>
                </div>
                <span class="pulse-badge online">
                  <span class="glowing-dot"></span> LIVE
                </span>
              </div>
              <div class="term-readout-row">
                <div class="readout-col">
                  <span class="readout-label">Terminal Clock</span>
                  <span class="readout-val clock" id="uface-live-clock">--:--:-- --</span>
                </div>
                <div class="readout-col">
                  <span class="readout-label">Date</span>
                  <span class="readout-val" id="uface-live-date">-- --- ----</span>
                </div>
                <div class="readout-col">
                  <span class="readout-label">Assigned Shift</span>
                  <span class="readout-sub">09:30 AM – 07:00 PM</span>
                </div>
              </div>
            </div>

            <!-- Terminal 2: SenseFace 7A -->
            <div class="gateway-terminal-card senseface">
              <div class="term-card-top">
                <div>
                  <div class="term-name">👤 ZKTeco Terminal (VDE2251500160)</div>
                  <div class="term-meta">Model: <b>SenseFace 7A</b> · SN: <code>VDE2251500160</code> · Head_Office</div>
                </div>
                <span class="pulse-badge online">
                  <span class="glowing-dot"></span> LIVE
                </span>
              </div>
              <div class="term-readout-row">
                <div class="readout-col">
                  <span class="readout-label">Terminal Clock</span>
                  <span class="readout-val clock" id="senseface-live-clock">--:--:-- --</span>
                </div>
                <div class="readout-col">
                  <span class="readout-label">Date</span>
                  <span class="readout-val" id="senseface-live-date">-- --- ----</span>
                </div>
                <div class="readout-col">
                  <span class="readout-label">Assigned Shift</span>
                  <span class="readout-sub">General Staff</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        ${t.holiday ? html`<div class="notice info"><b>Company Holiday:</b> Today is a scheduled company holiday (${t.holiday}).</div>` : ''}

        <!-- Executive KPI Stat Cards -->
        <section class="modern-kpi-grid">
          <div class="modern-kpi-card kpi-expected">
            <div class="kpi-bar"></div>
            <span class="kpi-title">Expected Today</span>
            <span class="kpi-num">${k.expected}</span>
            <span class="small muted">Total scheduled staff</span>
          </div>
          <div class="modern-kpi-card kpi-present">
            <div class="kpi-bar"></div>
            <span class="kpi-title">Checked In (Present)</span>
            <span class="kpi-num" style="display:flex; align-items:baseline; gap:8px;">
              ${k.present}
              <span style="font-size:13px; font-weight:700; color:#15803d; background:#dcfce7; padding:2px 8px; border-radius:12px;">
                ${k.expected ? Math.round((k.present / k.expected) * 100) : 0}%
              </span>
            </span>
            <span class="small" style="color:#15803d; font-weight:600;">✓ Active at work</span>
          </div>
          <div class="modern-kpi-card kpi-present">
            <div class="kpi-bar"></div>
            <span class="kpi-title">On-Time Arrival</span>
            <span class="kpi-num">${Math.max(0, k.present - k.late)}</span>
            <span class="small" style="color:#15803d; font-weight:600;">09:00 – 10:00 AM window</span>
          </div>
          <div class="modern-kpi-card kpi-late">
            <div class="kpi-bar"></div>
            <span class="kpi-title">Late Arrivals</span>
            <span class="kpi-num">${k.late}</span>
            <span class="small muted">${k.late ? 'Requires verification' : 'Zero late arrivals'}</span>
          </div>
          <div class="modern-kpi-card kpi-absent">
            <div class="kpi-bar"></div>
            <span class="kpi-title">Absent</span>
            <span class="kpi-num">${k.absent}</span>
            <span class="small muted">Unreported absence</span>
          </div>
          <div class="modern-kpi-card kpi-ot">
            <div class="kpi-bar"></div>
            <span class="kpi-title">Overtime Hours</span>
            <span class="kpi-num">${(k.overtimeMinutes / 60).toFixed(1)} <span style="font-size:14px; font-weight:600;">hrs</span></span>
            <span class="small muted">Beyond regular shift</span>
          </div>
        </section>

        <!-- Clean, Organized Today's Attendance Roster & Shift Schedule -->
        <section class="panel" style="box-shadow:0 1px 4px rgba(0,0,0,0.04); border-radius:12px; overflow:hidden;">
          <header style="padding:16px 20px; background:var(--surface); border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
            <div>
              <h2 style="font-size:16.5px; font-weight:750; display:flex; align-items:center; gap:8px;">
                📋 Today’s Attendance Roster (${t.nowLocal})
              </h2>
              <span class="small muted">Showing ${filteredRibbon.length} of ${t.ribbon.length} scheduled employees</span>
            </div>

            <!-- Controls: Filter Tabs + Search + View Mode -->
            <div class="row" style="gap:10px; align-items:center; flex-wrap:wrap;">
              <!-- Quick Search Input -->
              <input type="search" id="roster-search" placeholder="Search employee or dept…" value="${searchTerm}" style="padding:6px 12px; border:1px solid var(--line); border-radius:20px; font-size:13px; width:200px; background:var(--paper);">

              <!-- Filter Tabs -->
              <div class="tabs" style="margin-bottom:0; height:32px;">
                <button type="button" data-roster-tab="all" aria-selected="${activeTab === 'all'}" style="height:32px; font-size:12.5px; padding:0 12px;">All (${t.ribbon.length})</button>
                <button type="button" data-roster-tab="present" aria-selected="${activeTab === 'present'}" style="height:32px; font-size:12.5px; padding:0 12px;">Present (${k.present})</button>
                <button type="button" data-roster-tab="waiting" aria-selected="${activeTab === 'waiting'}" style="height:32px; font-size:12.5px; padding:0 12px;">Waiting (${k.notYet})</button>
                <button type="button" data-roster-tab="late" aria-selected="${activeTab === 'late'}" style="height:32px; font-size:12.5px; padding:0 12px;">Late (${k.late})</button>
                <button type="button" data-roster-tab="absent" aria-selected="${activeTab === 'absent'}" style="height:32px; font-size:12.5px; padding:0 12px;">Absent (${k.absent})</button>
              </div>

              <!-- View Mode Toggle -->
              <div class="row" style="gap:4px; background:var(--paper); padding:3px; border-radius:8px; border:1px solid var(--line);">
                <button type="button" id="btn-mode-table" class="btn sm ${viewMode === 'table' ? 'primary' : ''}" style="border-radius:6px; padding:4px 10px; font-size:12px; font-weight:600;">
                  Table
                </button>
                <button type="button" id="btn-mode-timeline" class="btn sm ${viewMode === 'timeline' ? 'primary' : ''}" style="border-radius:6px; padding:4px 10px; font-size:12px; font-weight:600;">
                  Timeline
                </button>
              </div>
            </div>
          </header>

          <!-- Content: Table View (Clean Roster) or Contained Timeline View -->
          ${viewMode === 'table' ? html`
            <div class="body flush table-wrap" style="max-height:480px; overflow-y:auto;">
              ${filteredRibbon.length ? html`
                <table style="width:100%; border-collapse:collapse;">
                  <thead style="position:sticky; top:0; background:var(--surface); z-index:2; box-shadow:0 1px 2px rgba(0,0,0,0.05);">
                    <tr>
                      <th style="padding:10px 16px;">Employee</th>
                      <th style="padding:10px 16px;">Department</th>
                      <th style="padding:10px 16px;">Assigned Shift</th>
                      <th style="padding:10px 16px;">Terminal / Machine</th>
                      <th style="padding:10px 16px;">Check-In (IN)</th>
                      <th style="padding:10px 16px;">Check-Out (OUT)</th>
                      <th style="padding:10px 16px;">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${filteredRibbon.map((r) => html`
                      <tr style="border-bottom:1px solid var(--line-2);">
                        <td style="padding:10px 16px;">
                          <b>${r.name}</b>
                        </td>
                        <td style="padding:10px 16px;"><span class="muted small">${r.department || 'General'}</span></td>
                        <td style="padding:10px 16px;"><span class="small font-mono">${r.shiftStart} – ${r.shiftEnd}</span></td>
                        <td style="padding:10px 16px;">
                          ${r.shiftStart === '09:30' ? html`
                            <span class="badge" style="background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd; font-weight:600;">
                              🏢 uFace 800
                            </span>
                          ` : html`
                            <span class="badge" style="background:#f3e8ff; color:#7e22ce; border:1px solid #e9d5ff; font-weight:600;">
                              👤 SenseFace 7A
                            </span>
                          `}
                        </td>
                        <td style="padding:10px 16px;">
                          ${r.checkIn ? html`
                            <span style="font-weight:700; color:#15803d; font-family:monospace; display:inline-flex; align-items:center; gap:4px;">
                              🟢 IN: ${r.checkIn}
                            </span>
                          ` : html`<span class="muted small">—</span>`}
                        </td>
                        <td style="padding:10px 16px;">
                          ${r.checkOut ? html`
                            <span style="font-weight:700; color:#dc2626; font-family:monospace; display:inline-flex; align-items:center; gap:4px;">
                              🔴 OUT: ${r.checkOut}
                            </span>
                          ` : html`
                            <span class="badge online" style="background:#f0fdf4; color:#166534; font-size:11px; font-weight:600;">
                              At Work (ডিউটিতে)
                            </span>
                          `}
                        </td>
                        <td style="padding:10px 16px;">${badge(r.state)}</td>
                      </tr>
                    `)}
                  </tbody>
                </table>
              ` : html`
                <div class="empty" style="padding:40px;">No employees match the current filter or search.</div>
              `}
            </div>
          ` : html`
            <div style="max-height:480px; overflow-y:auto; padding:12px 16px;">
              ${ribbon(t, filteredRibbon)}
            </div>
          `}
        </section>

        <!-- Two-Column Analytics: Charts & Live Activity Stream -->
        <div class="cols-2" style="margin-top:6px;">
          <!-- 14-Day Attendance Trend -->
          <section class="panel">
            <header>
              <h2>Attendance Trend (Last ${d.trend.rows.length || 14} Working Days)</h2>
            </header>
            <div class="chart-box" style="height:260px;">
              <canvas id="trend" role="img" aria-label="Attendance Trend Chart"></canvas>
            </div>
          </section>

          <!-- Live Door Reader Punch Feed -->
          <section class="panel">
            <header style="display:flex; justify-content:space-between; align-items:center;">
              <div>
                <h2>Live Door Reader Punches</h2>
                <span class="small muted">Real-time punch feed from uFace 800 &amp; SenseFace 7A</span>
              </div>
              <a href="/attendance" data-link class="small" style="font-weight:600;">All Punches →</a>
            </header>
            <div class="body flush list-lines" style="max-height:280px; overflow-y:auto;">
              ${d.punches && d.punches.length ? d.punches.map((p) => html`
                <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px;">
                  <div style="display:flex; align-items:center; gap:10px;">
                    <span style="font-weight:700; font-size:11px; padding:2px 7px; border-radius:10px; background:${p.punch_type === 'OUT' ? '#fee2e2' : '#dcfce7'}; color:${p.punch_type === 'OUT' ? '#991b1b' : '#15803d'}; border:1px solid ${p.punch_type === 'OUT' ? '#fecaca' : '#bbf7d0'};">
                      ${p.punch_type === 'OUT' ? '🔴 OUT' : '🟢 IN'}
                    </span>
                    <div>
                      <b>${p.name}</b>
                      <span class="small muted"> · ${p.device && p.device.includes('RKQ') ? '🏢 uFace 800' : p.device && p.device.includes('VDE') ? '👤 SenseFace 7A' : (p.device || p.source)}</span>
                    </div>
                  </div>
                  <span class="time muted" style="font-weight:600; font-size:12.5px;">${p.time_12h || p.at.slice(11, 19)}</span>
                </div>
              `) : html`<div class="empty">No biometric punches received yet.</div>`}
            </div>
          </section>
        </div>

        <!-- Second Row: Department Rate & Attention -->
        <div class="cols-eq">
          <section class="panel">
            <header>
              <h2>Attendance Rate by Department</h2>
              <span class="small muted">Month to Date</span>
            </header>
            <div class="chart-box" style="height:${Math.max(200, (d.departments || []).length * 44 + 40)}px">
              <canvas id="depts" role="img" aria-label="Department Attendance Rate"></canvas>
            </div>
          </section>

          <section class="panel">
            <header>
              <h2>Exceptions &amp; Needs Attention</h2>
              <span class="small muted">Follow-ups for managers</span>
            </header>
            <div class="body flush list-lines">
              ${attention(t)}
            </div>
          </section>
        </div>
      </div>
    `);

    updateLiveClocks();

    // Event handlers for roster search and tabs
    const searchInput = $('#roster-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchTerm = e.target.value.trim();
        draw(cachedData);
        // keep focus in search input
        const updatedInput = $('#roster-search');
        if (updatedInput) {
          updatedInput.focus();
          updatedInput.selectionStart = updatedInput.selectionEnd = updatedInput.value.length;
        }
      });
    }

    $$('[data-roster-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.rosterTab;
        draw(cachedData);
      });
    });

    $('#btn-mode-table')?.addEventListener('click', () => {
      viewMode = 'table';
      draw(cachedData);
    });

    $('#btn-mode-timeline')?.addEventListener('click', () => {
      viewMode = 'timeline';
      draw(cachedData);
    });

    // Render Charts
    if (window.Chart) {
      Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
      Chart.defaults.color = css('--muted');
      const anim = reduceMotion() ? false : { duration: 400 };

      if (d.trend && d.trend.rows && d.trend.rows.length) {
        const labels = d.trend.rows.map((r) => r.d.slice(8) + '/' + r.d.slice(5, 7));
        const ds = (label, key, color) => ({
          label,
          data: d.trend.rows.map((r) => r[key]),
          backgroundColor: color,
          borderWidth: 0,
          borderRadius: 3,
        });
        const trendCanvas = $('#trend');
        if (trendCanvas) {
          charts.push(new Chart(trendCanvas, {
            type: 'bar',
            data: {
              labels,
              datasets: [
                ds('On time', 'present', '#16a34a'),
                ds('Late', 'late', '#d97706'),
                ds('Half day', 'half_day', '#64748b'),
                ds('Leave', 'leave', '#8b5cf6'),
                ds('Absent', 'absent', '#dc2626'),
              ],
            },
            options: {
              maintainAspectRatio: false,
              animation: anim,
              scales: {
                x: { stacked: true, grid: { display: false } },
                y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
              },
              plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } } },
            },
          }));
        }
      }

      if (d.departments && d.departments.length) {
        const deptsCanvas = $('#depts');
        if (deptsCanvas) {
          charts.push(new Chart(deptsCanvas, {
            type: 'bar',
            data: {
              labels: d.departments.map((x) => x.department),
              datasets: [{
                label: 'Attendance Rate (%)',
                data: d.departments.map((x) => x.rate),
                backgroundColor: '#0284c7',
                borderRadius: 4,
              }],
            },
            options: {
              indexAxis: 'y',
              maintainAspectRatio: false,
              animation: anim,
              scales: {
                x: { min: 0, max: 100, ticks: { callback: (v) => v + '%' } },
                y: { grid: { display: false } },
              },
              plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => `${c.raw}% attended (${d.departments[c.dataIndex].late} late days)` } },
              },
            },
          }));
        }
      }
    }
  };

  const load = async () => {
    try {
      const data = await get('/dashboard/overview');
      draw(data);
    } catch (e) {
      setHTML(view, html`<div class="notice bad">${e.message}</div>`);
    }
  };

  await load();
  // Poll backend every 15 seconds for latest punches
  pollTimer = setInterval(load, 15_000);
  // Real-time ticking clock every 1 second
  clockTimer = setInterval(updateLiveClocks, 1000);

  return () => {
    clearInterval(pollTimer);
    clearInterval(clockTimer);
    charts.forEach((c) => c.destroy());
  };
}

/** The shift ribbon: one row per expected employee on a shared time axis (contained). */
function ribbon(t, list = null) {
  const rowsToRender = list || t.ribbon;
  if (!rowsToRender.length) return html`<div class="empty">${t.holiday ? 'Holiday: nobody is expected today.' : 'Nobody scheduled today.'}</div>`;
  const startH = Math.max(0, Math.floor(Math.min(...t.ribbon.map((r) => toMin(r.shiftStart))) / 60) - 1);
  const endH = Math.min(24, Math.ceil((Math.max(...t.ribbon.map((r) => toMin(r.shiftEnd))) + 150) / 60));
  const hours = endH - startH;
  const pos = (min) => `${(((min - startH * 60) / (hours * 60)) * 100).toFixed(2)}%`;
  const w = (a, b) => `${((Math.max(0, b - a) / (hours * 60)) * 100).toFixed(2)}%`;
  const now = toMin(t.nowLocal);
  const ticks = Array.from({ length: hours + 1 }, (_, i) => startH + i).filter((h, i) => hours <= 14 || i % 2 === 0);

  return html`<div class="ribbon" style="--hours:${hours}">
    <div class="ribbon-axis"><span></span><div class="ticks">${ticks.map((h) => html`<span style="left:${pos(h * 60)}">${String(h).padStart(2, '0')}:00</span>`)}</div><span></span></div>
    ${rowsToRender.map((r) => {
      const s = toMin(r.shiftStart), e = toMin(r.shiftEnd);
      const inn = r.checkIn ? toMin(r.checkIn) : null, out = r.checkOut ? toMin(r.checkOut) : null;
      const end = out ?? Math.max(inn ?? 0, Math.min(now, 24 * 60));
      let right;
      if (r.state === 'absent') right = badge('absent');
      else if (r.state === 'leave') right = badge('leave');
      else if (r.state === 'waiting') right = badge('waiting');
      else right = html`<span class="time" style="font-weight:700; color:#15803d;">🟢 IN: ${r.checkIn || '—'}${r.checkOut ? ` → 🔴 OUT: ${r.checkOut}` : ''}</span>`;
      return html`<div class="ribbon-row">
        <div class="who"><b>${r.name}</b><span>${r.department || 'General'} · ${r.shiftStart}–${r.shiftEnd}</span></div>
        <div class="track" role="img" aria-label="${r.name}: ${r.state}">
          <div class="shift" style="left:${pos(s)};width:${w(s, e)}"></div>
          ${inn !== null && r.lateMinutes > 0 ? html`<div class="gap-late" style="left:${pos(s)};width:${w(s, inn)}" title="${r.lateMinutes} min late"></div>` : ''}
          ${inn !== null ? html`<div class="in ${out === null ? 'open' : ''}" style="left:${pos(inn)};width:${w(inn, end)}"></div>` : ''}
          ${out !== null && r.overtimeMinutes > 0 ? html`<div class="ot" style="left:${pos(e)};width:${w(e, out)}" title="${r.overtimeMinutes} min overtime"></div>` : ''}
          ${out !== null && r.earlyOutMinutes > 0 ? html`<div class="early" style="left:${pos(out)}" title="Left ${r.earlyOutMinutes} min early"></div>` : ''}
          ${now >= startH * 60 && now <= endH * 60 ? html`<div class="now" style="left:${pos(now)}"></div>` : ''}
        </div>
        <div class="state">${right}</div>
      </div>`;
    })}
  </div>
  <div class="ribbon-legend" aria-hidden="true" style="margin-top:10px;">
    <span><i style="background:#E4E9EE"></i>Scheduled shift</span><span><i style="background:#16a34a"></i>At work</span>
    <span><i style="background:#E8A317"></i>Late by</span><span><i style="background:#0284c7"></i>Overtime</span><span><i style="background:#dc2626"></i>Left early</span>
  </div>`;
}

function attention(t) {
  const items = [];
  for (const r of t.ribbon || []) {
    if (r.state === 'absent') items.push({ w: 0, n: r.name, text: badge('absent'), sub: `${r.department || 'General'}, shift ${r.shiftStart}` });
    else if (r.lateMinutes > 0) items.push({ w: 1, n: r.name, text: badge('late', `${r.lateMinutes} min late`), sub: `in at ${r.checkIn}` });
    else if (r.state === 'waiting' && toMin(t.nowLocal) > toMin(r.shiftStart) + 30) items.push({ w: 2, n: r.name, text: badge('waiting'), sub: `shift started ${r.shiftStart}` });
  }
  items.sort((a, b) => a.w - b.w || a.n.localeCompare(b.n));
  if (!items.length) return html`<div class="empty" style="padding:24px;">✓ All employees arrived on time. Nothing needs attention.</div>`;
  return items.slice(0, 8).map((i) => html`<div><span><b>${i.n}</b><br><span class="small muted">${i.sub}</span></span><span>${i.text}</span></div>`);
}

/* ======================= Staff View ======================= */
async function renderStaff(view, state) {
  const [mine, bal, slips] = await Promise.all([get('/dashboard/mine'), get('/leave/balances'), get('/payroll/my-payslips')]);
  const t = mine.today;
  const m = mine.month;
  const status = !t ? html`<p style="font-size:20px;margin:0"><b>Not checked in yet</b></p><p class="muted">Your check-in appears here a few seconds after you use the door reader.</p>`
    : html`<p style="font-size:20px;margin:0 0 6px"><b>${t.cin ? 'Checked in at ' + t.cin : 'No punches today'}</b> ${badge(t.status)}</p>
      <p class="muted">${t.cout ? `Checked out at ${t.cout} · worked ${fmtHours(t.worked_minutes)}` : t.cin ? 'You have not checked out yet (At work).' : ''}
      ${t.late_minutes ? html`<br>${t.late_minutes} minutes after your shift start.` : ''}${t.overtime_minutes ? html`<br>Overtime: ${t.overtime_minutes} minutes.` : ''}</p>`;
  setHTML(view, html`
    <div class="stack">
      <section class="panel"><header><h2>Today</h2><span class="small muted">${fmtDate(mine.date)}</span></header><div class="body">${status}</div></section>
      <section class="ledger five" aria-label="This month">
        <div class="present"><div class="n">${m.present}</div><div class="l">Days present</div></div>
        <div class="late"><div class="n ${m.late ? 'has' : ''}">${m.late}</div><div class="l">Late arrivals</div></div>
        <div class="absent"><div class="n ${m.absent ? 'has' : ''}">${m.absent}</div><div class="l">Absent days</div></div>
        <div class="leave"><div class="n">${m.leave}</div><div class="l">Leave days</div></div>
        <div class="ot"><div class="n">${(m.overtime / 60).toFixed(1)}</div><div class="l">Overtime hours</div></div>
      </section>
      <div class="cols-eq">
        <section class="panel"><header><h2>Leave balance</h2><a href="/leave" data-link class="small">Request leave</a></header>
          <div class="body flush list-lines">${bal.balances.length ? bal.balances.map((b) => html`<div style="display:grid;grid-template-columns:1fr 110px 90px;align-items:center">
            <span>${b.name}</span><div class="bar"><i style="width:${b.allocated ? Math.min(100, (b.used / b.allocated) * 100) : 0}%"></i></div>
            <span class="num r small">${b.remaining} of ${b.allocated} left</span></div>`) : html`<div class="empty">No leave balances yet.</div>`}</div></section>
        <section class="panel"><header><h2>Latest payslip</h2><a href="/payroll" data-link class="small">All payslips</a></header>
          <div class="body">${slips.payslips.length ? html`<p style="margin:0" class="muted">${fmtMonth(slips.payslips[0].month)}</p><p style="font-size:20px;margin:2px 0 0"><b>${state.meta.currency} ${fmtMoney(slips.payslips[0].net_pay)}</b> <span class="muted small">net pay</span></p>` : html`<p class="muted">Your first payslip appears here once payroll is finalised for a month.</p>`}</div></section>
      </div>
    </div>`);
}
