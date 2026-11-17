import { get } from '../api.js';
import { html, setHTML, $, $$, fmtHours, fmtDate, fmtMoney, fmtMonth, badge, ago, icon } from '../ui.js';
import { navigate } from '../main.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const toMin = (hhmm) => { const [h, m] = (hhmm || '00:00').split(':').map(Number); return h * 60 + m; };

export async function render(view, state) {
  const hasCustomOverview = Boolean(state.user?.permissions?.overview?.view);
  const isSelfService = (state.user?.role === 'staff' || state.user?.role === 'employee') && !hasCustomOverview;
  return isSelfService ? renderStaff(view, state) : renderManager(view, state);
}

/* ======================= Admin / HR Manager Analytics Dashboard ======================= */
async function renderManager(view, state) {
  let charts = [];
  let pollTimer;
  let clockTimer;
  let activeTab = 'all';
  let searchTerm = '';
  let viewMode = 'table'; // 'table' or 'timeline'
  let cachedData = null;
  let rosterCollapsed = false;

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
    const term = d.terminals || { uface: {}, gate: {} };
    const ufacePunches = term.uface?.total_punches || 0;
    const gatePunches = term.gate?.total_punches || 0;

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

    const onTimeCount = k.onTime ?? Math.max(0, k.present - k.late);
    const presentPct = k.presentRate ?? (k.expected ? Math.round((k.present / k.expected) * 100) : 0);
    const onTimePct = k.onTimeRate ?? (k.present ? Math.round((onTimeCount / k.present) * 100) : 0);

    setHTML(view, html`
      <div class="stack" style="gap:20px;">
        <!-- 1. Executive KPI Cards (Row of 6) -->
        <section class="modern-kpi-grid">
          <!-- Card 1: Scheduled Staff -->
          <div class="kpi-stat-card">
            <div class="kpi-card-header">
              <div class="kpi-icon-box" style="background:#e0f2fe; color:#0284c7;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </div>
            </div>
            <div class="kpi-card-title">Scheduled Staff</div>
            <div class="kpi-card-val-row">
              <span class="kpi-card-val">${k.expected}</span>
              <span class="kpi-card-badge" style="background:#e0f2fe; color:#0284c7;">+ 100%</span>
            </div>
            <div class="kpi-sparkline">
              <svg viewBox="0 0 100 24" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="gradStaff" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#0284c7" stop-opacity="0.25"/>
                    <stop offset="100%" stop-color="#0284c7" stop-opacity="0.0"/>
                  </linearGradient>
                </defs>
                <path d="M 0,16 Q 25,18 50,12 T 100,6 L 100,24 L 0,24 Z" fill="url(#gradStaff)"/>
                <path d="M 0,16 Q 25,18 50,12 T 100,6" fill="none" stroke="#0284c7" stroke-width="2.2" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="kpi-card-foot">Total active workforce</div>
          </div>

          <!-- Card 2: Checked In (Present) -->
          <div class="kpi-stat-card">
            <div class="kpi-card-header">
              <div class="kpi-icon-box" style="background:#dcfce7; color:#16a34a;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
            </div>
            <div class="kpi-card-title">Checked In (Present)</div>
            <div class="kpi-card-val-row">
              <span class="kpi-card-val" style="color:#15803d;">${k.present}</span>
              <span class="kpi-card-badge" style="background:#dcfce7; color:#16a34a;">+ ${presentPct}%</span>
            </div>
            <div class="kpi-sparkline">
              <svg viewBox="0 0 100 24" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="gradPres" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#16a34a" stop-opacity="0.25"/>
                    <stop offset="100%" stop-color="#16a34a" stop-opacity="0.0"/>
                  </linearGradient>
                </defs>
                <path d="M 0,20 Q 30,19 60,9 T 100,5 L 100,24 L 0,24 Z" fill="url(#gradPres)"/>
                <path d="M 0,20 Q 30,19 60,9 T 100,5" fill="none" stroke="#16a34a" stroke-width="2.2" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="kpi-card-foot" style="color:#16a34a; font-weight:600;">✓ Active at work</div>
          </div>

          <!-- Card 3: On-Time Arrivals -->
          <div class="kpi-stat-card">
            <div class="kpi-card-header">
              <div class="kpi-icon-box" style="background:#f3e8ff; color:#9333ea;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
            </div>
            <div class="kpi-card-title">On-Time Arrivals</div>
            <div class="kpi-card-val-row">
              <span class="kpi-card-val" style="color:#581c87;">${onTimeCount}</span>
              <span class="kpi-card-badge" style="background:#f3e8ff; color:#9333ea;">+ ${onTimePct}%</span>
            </div>
            <div class="kpi-sparkline">
              <svg viewBox="0 0 100 24" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="gradOntime" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#9333ea" stop-opacity="0.25"/>
                    <stop offset="100%" stop-color="#9333ea" stop-opacity="0.0"/>
                  </linearGradient>
                </defs>
                <path d="M 0,21 Q 35,20 65,7 T 100,8 L 100,24 L 0,24 Z" fill="url(#gradOntime)"/>
                <path d="M 0,21 Q 35,20 65,7 T 100,8" fill="none" stroke="#9333ea" stroke-width="2.2" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="kpi-card-foot">Within 09:00 – 10:00 AM window</div>
          </div>

          <!-- Card 4: Late Arrivals -->
          <div class="kpi-stat-card">
            <div class="kpi-card-header">
              <div class="kpi-icon-box" style="background:#fef3c7; color:#d97706;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 22h14M5 2h14M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>
              </div>
            </div>
            <div class="kpi-card-title">Late Arrivals</div>
            <div class="kpi-card-val-row">
              <span class="kpi-card-val" style="color:#b45309;">${k.late}</span>
              <span class="kpi-card-badge" style="background:#fef3c7; color:#d97706;">+ ${k.present ? Math.round((k.late / k.present) * 100) : 0}%</span>
            </div>
            <div class="kpi-sparkline">
              <svg viewBox="0 0 100 24" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="gradLate" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#d97706" stop-opacity="0.25"/>
                    <stop offset="100%" stop-color="#d97706" stop-opacity="0.0"/>
                  </linearGradient>
                </defs>
                <path d="M 0,16 Q 40,19 70,11 T 100,10 L 100,24 L 0,24 Z" fill="url(#gradLate)"/>
                <path d="M 0,16 Q 40,19 70,11 T 100,10" fill="none" stroke="#d97706" stroke-width="2.2" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="kpi-card-foot" style="color:#d97706;">Requires supervisor follow-up</div>
          </div>

          <!-- Card 5: Absent -->
          <div class="kpi-stat-card">
            <div class="kpi-card-header">
              <div class="kpi-icon-box" style="background:#e0f2fe; color:#0891b2;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/></svg>
              </div>
            </div>
            <div class="kpi-card-title">Absent</div>
            <div class="kpi-card-val-row">
              <span class="kpi-card-val">${k.absent}</span>
              <span class="kpi-card-badge" style="background:#e0f2fe; color:#0891b2;">+ 0.0%</span>
            </div>
            <div class="kpi-sparkline">
              <svg viewBox="0 0 100 24" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="gradAbs" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#0891b2" stop-opacity="0.25"/>
                    <stop offset="100%" stop-color="#0891b2" stop-opacity="0.0"/>
                  </linearGradient>
                </defs>
                <path d="M 0,18 Q 40,16 70,19 T 100,15 L 100,24 L 0,24 Z" fill="url(#gradAbs)"/>
                <path d="M 0,18 Q 40,16 70,19 T 100,15" fill="none" stroke="#0891b2" stroke-width="2.2" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="kpi-card-foot">Zero unreported absences</div>
          </div>

          <!-- Card 6: Overtime Hours -->
          <div class="kpi-stat-card">
            <div class="kpi-card-header">
              <div class="kpi-icon-box" style="background:#fce7f3; color:#db2777;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              </div>
            </div>
            <div class="kpi-card-title">Overtime Hours</div>
            <div class="kpi-card-val-row">
              <span class="kpi-card-val" style="color:#db2777;">${(k.overtimeMinutes / 60).toFixed(1)} <span style="font-size:15px; font-weight:600;">hrs</span></span>
              <span class="kpi-card-badge" style="background:#fce7f3; color:#db2777;">Regular Shift</span>
            </div>
            <div class="kpi-sparkline">
              <svg viewBox="0 0 100 24" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="gradOt" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#db2777" stop-opacity="0.25"/>
                    <stop offset="100%" stop-color="#db2777" stop-opacity="0.0"/>
                  </linearGradient>
                </defs>
                <path d="M 0,20 Q 35,21 70,14 T 100,9 L 100,24 L 0,24 Z" fill="url(#gradOt)"/>
                <path d="M 0,20 Q 35,21 70,14 T 100,9" fill="none" stroke="#db2777" stroke-width="2.2" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="kpi-card-foot">Shift ends at 07:00 PM</div>
          </div>
        </section>

        <!-- 2. Charts Row 1: Today's Influx vs Breakdown -->
        <div class="dashboard-grid-2-1">
          <!-- Chart A: Today's Attendance & Lateness Trend -->
          <div class="analytics-chart-panel">
            <div class="analytics-chart-head">
              <div>
                <div class="analytics-chart-title">
                  <span class="chart-title-icon" style="color:#2563eb;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
                  </span>
                  <span>Today's Attendance &amp; Lateness Trend</span>
                </div>
                <span class="analytics-chart-sub">Hourly-by-hour throughput comparing uFace 800 arrivals vs SenseFace 7A barrier gate passes</span>
              </div>
              <div class="pill-btn date-pill sm">
                ${icon('calendar')} <span>Today ⌵</span>
              </div>
            </div>
            <!-- Custom Legend Matching Reference Image -->
            <div class="chart-custom-legend">
              <span class="legend-dot" style="background:#2563eb;"></span>
              <span class="legend-text"><b>uFace 800</b> (Attendance Punches)</span>
              <span class="legend-dot" style="background:#9333ea; margin-left:14px;"></span>
              <span class="legend-text"><b>SenseFace 7A</b> (Gate Passes)</span>
            </div>
            <div style="height:235px; position:relative;">
              <canvas id="hourly-chart" role="img" aria-label="Hourly Biometric Flow Curve"></canvas>
            </div>
          </div>

          <!-- Chart B: Attendance Breakdown -->
          <div class="analytics-chart-panel">
            <div class="analytics-chart-head">
              <div>
                <div class="analytics-chart-title">
                  <span class="chart-title-icon" style="color:#d97706;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                  </span>
                  <span>Attendance Breakdown</span>
                </div>
                <span class="analytics-chart-sub">Today's roster status composition</span>
              </div>
            </div>
            <div style="height:185px; position:relative; display:grid; place-items:center;">
              <canvas id="donut-chart" role="img" aria-label="Workforce Composition Donut"></canvas>
              <div class="donut-center-metric">
                <div class="pct" style="color:#10b981;">${presentPct}%</div>
                <div class="lbl">PRESENT</div>
              </div>
            </div>
            <div class="donut-legend-grid">
              <div class="legend-item"><span class="legend-dot" style="background:#10b981;"></span> On-time: <b>${onTimeCount}</b></div>
              <div class="legend-item"><span class="legend-dot" style="background:#f59e0b;"></span> Late: <b>${k.late}</b></div>
              <div class="legend-item"><span class="legend-dot" style="background:#38bdf8;"></span> Waiting: <b>${k.notYet}</b></div>
              <div class="legend-item"><span class="legend-dot" style="background:#ef4444;"></span> Absent: <b>${k.absent}</b></div>
            </div>
          </div>
        </div>

        <!-- 3. Charts Row 2: 14-Day Trend vs Department Rate -->
        <div class="dashboard-grid-eq">
          <!-- 14-Day Attendance Trend -->
          <div class="analytics-chart-panel">
            <div class="analytics-chart-head">
              <div>
                <div class="analytics-chart-title">
                  <span class="chart-title-icon" style="color:#10b981;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
                  </span>
                  <span>14-Day Attendance &amp; Lateness Trend</span>
                </div>
                <span class="analytics-chart-sub">Daily attendance patterns across working days</span>
              </div>
            </div>
            <div style="height:230px; position:relative;">
              <canvas id="trend" role="img" aria-label="Attendance Trend Chart"></canvas>
            </div>
          </div>

          <!-- Department Attendance Rate -->
          <div class="analytics-chart-panel">
            <div class="analytics-chart-head">
              <div>
                <div class="analytics-chart-title">
                  <span class="chart-title-icon" style="color:#2563eb;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                  </span>
                  <span>Department Attendance Rate</span>
                </div>
                <span class="analytics-chart-sub">Month-to-date percentage benchmark</span>
              </div>
            </div>
            <div style="height:230px; position:relative;">
              <canvas id="depts" role="img" aria-label="Department Attendance Rate"></canvas>
            </div>
          </div>
        </div>

        <!-- 4. Operational Feeds: Live Punches & Manager Attention -->
        <div class="dashboard-grid-eq">
          <!-- Live Biometric Punch Stream -->
          <div class="analytics-chart-panel" style="padding:0; overflow:hidden;">
            <div class="feed-header">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="pulse-dot online"></span>
                <div>
                  <h2 style="font-size:14.5px; font-weight:750; margin:0; color:#0f172a;">Live Biometric Punch Stream</h2>
                  <span class="small muted">Instant punch feed from uFace 800 &amp; SenseFace 7A Gate</span>
                </div>
              </div>
              <a href="/attendance" data-link class="small view-audit-link">View Audit Log →</a>
            </div>
            <div class="body flush feed-scroll-body">
              ${d.punches && d.punches.length ? d.punches.map((p) => html`
                <div class="stream-item">
                  <div style="display:flex; align-items:center; gap:10px;">
                    <div class="emp-avatar">
                      ${(p.name || 'E').slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div class="stream-emp-name">${p.name}</div>
                      <div class="stream-subtext">
                        <span class="stream-device-dot" style="background:${p.device && p.device.includes('VDE') ? '#a855f7' : '#0284c7'};"></span>
                        <span>${p.device && p.device.includes('VDE') ? 'SenseFace 7A (Gate)' : 'uFace 800'}</span>
                        <span>•</span>
                        <span>PIN: ${p.pin}</span>
                      </div>
                    </div>
                  </div>
                  <div style="display:flex; align-items:center; gap:12px;">
                    <span class="stream-time">${p.time_12h || p.at.slice(11, 19)}</span>
                    <span class="stream-badge ${p.punch_type === 'OUT' ? 'bad' : 'ok'}">
                      ${p.punch_type === 'OUT' ? '− OUT' : '+ IN'}
                    </span>
                  </div>
                </div>
              `) : html`<div class="empty" style="padding:28px;">No biometric punches received yet today.</div>`}
            </div>
          </div>

          <!-- Exceptions & Manager Follow-Ups -->
          <div class="analytics-chart-panel" style="padding:0; overflow:hidden;">
            <div class="feed-header">
              <div style="display:flex; align-items:center; gap:8px;">
                <div class="feed-icon-box" style="background:#fef3c7; color:#d97706;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </div>
                <div>
                  <h2 style="font-size:14.5px; font-weight:750; margin:0; color:#0f172a;">Exceptions &amp; Manager Follow-Ups</h2>
                  <span class="small muted">Late arrivals and pending check-ins</span>
                </div>
              </div>
              <span class="pill-badge" style="background:#fef3c7; color:#b45309; font-weight:700;">
                ${k.late} Late Today
              </span>
            </div>
            <div class="body flush feed-scroll-body list-lines">
              ${attention(t)}
            </div>
          </div>
        </div>

        <!-- 5. Compact & Interactive Daily Attendance Roster -->
        <section class="analytics-chart-panel" style="padding:0; overflow:hidden;">
          <header class="roster-header">
            <div style="display:flex; align-items:center; gap:10px;">
              <div class="roster-icon-box">👥</div>
              <div>
                <h2 style="font-size:16px; font-weight:750; margin:0; color:#0f172a;">
                  Today's Workforce Attendance Roster
                </h2>
                <span class="small muted">Showing ${filteredRibbon.length} of ${t.ribbon.length} scheduled employees · Sorted by status</span>
              </div>
            </div>

            <div class="roster-controls">
              <!-- Search Input -->
              <div class="roster-search-wrap">
                <span class="search-icon">${icon('search')}</span>
                <input type="search" id="roster-search" placeholder="Search employee or department..." value="${searchTerm}" class="roster-search-input">
              </div>

              <!-- Filter Tabs -->
              <div class="roster-filter-pills">
                <button type="button" data-roster-tab="all" class="roster-pill ${activeTab === 'all' ? 'active' : ''}">All (${t.ribbon.length})</button>
                <button type="button" data-roster-tab="present" class="roster-pill ${activeTab === 'present' ? 'active' : ''}">Present (${k.present})</button>
                <button type="button" data-roster-tab="late" class="roster-pill ${activeTab === 'late' ? 'active' : ''}">Late (${k.late})</button>
                <button type="button" data-roster-tab="waiting" class="roster-pill ${activeTab === 'waiting' ? 'active' : ''}">Waiting (${k.notYet})</button>
                <button type="button" data-roster-tab="absent" class="roster-pill ${activeTab === 'absent' ? 'active' : ''}">Absent (${k.absent})</button>
              </div>

              <!-- View Switcher -->
              <div class="roster-view-switcher">
                <button type="button" id="btn-mode-table" class="switcher-btn ${viewMode === 'table' ? 'active' : ''}">
                  ${icon('table') || '📋'} Table
                </button>
                <button type="button" id="btn-mode-timeline" class="switcher-btn ${viewMode === 'timeline' ? 'active' : ''}">
                  Timeline
                </button>
                <button type="button" id="btn-toggle-roster" class="switcher-btn">
                  ${rosterCollapsed ? 'Expand ▴' : 'Collapse ▾'}
                </button>
              </div>
            </div>
          </header>

          ${!rosterCollapsed ? (viewMode === 'table' ? html`
            <div class="table-wrap roster-table-wrap">
              ${filteredRibbon.length ? html`
                <table class="roster-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Department</th>
                      <th>Assigned Shift</th>
                      <th>Terminal / Machine</th>
                      <th>Check-In (IN)</th>
                      <th>Check-Out (OUT)</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${filteredRibbon.map((r) => html`
                      <tr>
                        <td>
                          <div class="roster-emp-cell">
                            <div class="roster-avatar">
                              ${(r.name || 'E').slice(0, 2).toUpperCase()}
                            </div>
                            <span class="roster-emp-name">${r.name}</span>
                          </div>
                        </td>
                        <td><span class="muted small">${r.department || 'General'}</span></td>
                        <td><span class="small font-mono">${r.shiftStart} – ${r.shiftEnd}</span></td>
                        <td>
                          ${r.shiftStart === '09:30' ? html`
                            <span class="device-tag uface-tag">
                              <span class="device-dot blue"></span> uFace 800
                            </span>
                          ` : html`
                            <span class="device-tag gate-tag">
                              <span class="device-dot purple"></span> SenseFace 7A (Gate)
                            </span>
                          `}
                        </td>
                        <td>
                          ${r.checkIn ? html`
                            <span class="time-in-val">
                              ${r.checkIn}
                            </span>
                          ` : html`<span class="muted small font-mono">—</span>`}
                        </td>
                        <td>
                          ${r.checkOut ? html`
                            <span class="time-out-val">
                              ${r.checkOut}
                            </span>
                          ` : html`<span class="muted small font-mono">—</span>`}
                        </td>
                        <td>
                          ${r.state === 'waiting' ? html`
                            <span class="status-pill waiting">◆ Waiting</span>
                          ` : r.state === 'late' ? html`
                            <span class="status-pill late">◆ Late</span>
                          ` : r.state === 'absent' ? html`
                            <span class="status-pill absent">◆ Absent</span>
                          ` : html`
                            <span class="status-pill present">◆ Present</span>
                          `}
                        </td>
                      </tr>
                    `)}
                  </tbody>
                </table>
              ` : html`
                <div class="empty" style="padding:40px;">No employees match the current filter or search.</div>
              `}
            </div>
          ` : html`
            <div style="max-height:420px; overflow-y:auto; padding:12px 16px;">
              ${ribbon(t, filteredRibbon)}
            </div>
          `) : html`
            <div style="padding:16px 20px; color:var(--muted); font-size:12.5px; text-align:center;">
              Roster table minimized. Click "Expand ▴" above to view records.
            </div>
          `}
        </section>
      </div>
    `);

    updateLiveClocks();

    // Event handlers for roster search and tabs
    const searchInput = $('#roster-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchTerm = e.target.value.trim();
        draw(cachedData);
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

    $('#btn-toggle-roster')?.addEventListener('click', () => {
      rosterCollapsed = !rosterCollapsed;
      draw(cachedData);
    });

    // Render All Analytics Charts
    if (window.Chart) {
      Chart.defaults.font.family = getComputedStyle(document.body).fontFamily || 'Inter, sans-serif';
      Chart.defaults.color = css('--muted') || '#64748b';
      const anim = reduceMotion() ? false : { duration: 400 };

      // 1. Hourly Biometric Flow Curve (Line/Area Chart)
      const hourlyCanvas = $('#hourly-chart');
      if (hourlyCanvas && d.hourly && d.hourly.length) {
        charts.push(new Chart(hourlyCanvas, {
          type: 'line',
          data: {
            labels: d.hourly.map((h) => h.label),
            datasets: [
              {
                label: 'uFace 800 (Attendance Punches)',
                data: d.hourly.map((h) => h.uface),
                borderColor: '#2563eb',
                backgroundColor: 'rgba(37, 99, 235, 0.12)',
                borderWidth: 2.5,
                fill: true,
                tension: 0.45,
                pointRadius: 3,
                pointBackgroundColor: '#2563eb',
                pointHoverRadius: 6,
              },
              {
                label: 'SenseFace 7A (Gate Passes)',
                data: d.hourly.map((h) => h.gate),
                borderColor: '#9333ea',
                backgroundColor: 'rgba(147, 51, 234, 0.08)',
                borderWidth: 2.5,
                fill: true,
                tension: 0.45,
                pointRadius: 3,
                pointBackgroundColor: '#9333ea',
                pointHoverRadius: 6,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: anim,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (c) => ` ${c.dataset.label}: ${c.raw} punch(es)`,
                },
              },
            },
            scales: {
              x: { grid: { display: false } },
              y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(226, 232, 240, 0.6)' } },
            },
          },
        }));
      }

      // 2. Workforce Composition Donut Chart
      const donutCanvas = $('#donut-chart');
      if (donutCanvas) {
        charts.push(new Chart(donutCanvas, {
          type: 'doughnut',
          data: {
            labels: ['On-time Present', 'Late Arrivals', 'Waiting to Check-in', 'Absent'],
            datasets: [{
              data: [
                onTimeCount,
                k.late || 0,
                k.notYet || 0,
                k.absent || 0,
              ],
              backgroundColor: ['#10b981', '#f59e0b', '#38bdf8', '#ef4444'],
              borderWidth: 0,
              hoverOffset: 4,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: anim,
            cutout: '76%',
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (c) => ` ${c.label}: ${c.raw} staff`,
                },
              },
            },
          },
        }));
      }

      // 3. 14-Day Attendance Trend
      if (d.trend && d.trend.rows && d.trend.rows.length) {
        const labels = d.trend.rows.map((r) => r.d.slice(8) + '/' + r.d.slice(5, 7));
        const ds = (label, key, color) => ({
          label,
          data: d.trend.rows.map((r) => r[key]),
          backgroundColor: color,
          borderWidth: 0,
          borderRadius: 3,
          maxBarThickness: 16,
        });
        const trendCanvas = $('#trend');
        if (trendCanvas) {
          charts.push(new Chart(trendCanvas, {
            type: 'bar',
            data: {
              labels,
              datasets: [
                ds('On time', 'present', '#10b981'),
                ds('Late', 'late', '#f59e0b'),
                ds('Half day', 'half_day', '#38bdf8'),
                ds('Leave', 'leave', '#8b5cf6'),
                ds('Absent', 'absent', '#ef4444'),
              ],
            },
            options: {
              maintainAspectRatio: false,
              animation: anim,
              scales: {
                x: { stacked: true, grid: { display: false } },
                y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(226, 232, 240, 0.6)' } },
              },
              plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, font: { size: 11.5, weight: '600' } } } },
            },
          }));
        }
      }

      // 4. Department Attendance Leaderboard
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
                backgroundColor: '#2563eb',
                borderRadius: 6,
                barThickness: 11,
              }],
            },
            options: {
              indexAxis: 'y',
              maintainAspectRatio: false,
              animation: anim,
              scales: {
                x: { min: 0, max: 100, ticks: { callback: (v) => v + '%' }, grid: { color: 'rgba(226, 232, 240, 0.6)' } },
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
  pollTimer = setInterval(load, 15_000);
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
    if (r.state === 'absent') items.push({ w: 0, n: r.name, badge: html`<span class="stream-badge bad">Absent</span>`, sub: `shift ${r.shiftStart}` });
    else if (r.lateMinutes > 0) items.push({ w: 1, n: r.name, badge: html`<span class="status-pill late">◆ ${r.lateMinutes} min late</span>`, sub: `in ${r.checkIn || '—'}` });
    else if (r.state === 'waiting' && toMin(t.nowLocal) > toMin(r.shiftStart) + 30) items.push({ w: 2, n: r.name, badge: html`<span class="status-pill waiting">◆ Waiting</span>`, sub: `shift started ${r.shiftStart}` });
  }
  items.sort((a, b) => a.w - b.w || a.n.localeCompare(b.n));
  if (!items.length) return html`<div class="empty" style="padding:24px;">✓ All employees arrived on time. Nothing needs attention.</div>`;
  return items.slice(0, 8).map((i) => html`
    <div class="stream-item">
      <div>
        <div style="font-weight:700; font-size:13.5px; color:#0f172a;">${i.n}</div>
        <div class="small muted" style="margin-top:2px;">${i.sub}</div>
      </div>
      <div>${i.badge}</div>
    </div>
  `);
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