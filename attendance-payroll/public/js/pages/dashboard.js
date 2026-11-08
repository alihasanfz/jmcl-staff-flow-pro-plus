import { get } from '../api.js';
import { html, setHTML, $, $$, fmtHours, fmtDate, fmtMoney, fmtMonth, badge, ago, icon } from '../ui.js';
import { navigate } from '../main.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const toMin = (hhmm) => { const [h, m] = (hhmm || '00:00').split(':').map(Number); return h * 60 + m; };

export async function render(view, state) {
  return state.user.role === 'staff' ? renderStaff(view, state) : renderManager(view, state);
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
      <div class="stack" style="gap:22px;">
        <!-- 1. Executive Telemetry & Command Center -->
        <section class="analytics-hero-banner">
          <div class="row between" style="align-items:center; flex-wrap:wrap; gap:14px; position:relative; z-index:1;">
            <div style="display:flex; align-items:center; gap:14px;">
              <div style="width:46px; height:46px; border-radius:12px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.18); display:grid; place-items:center; font-size:24px;">
                🏭
              </div>
              <div>
                <h1 style="font-size:20px; font-weight:800; color:#fff; margin:0 0 2px 0; letter-spacing:-0.3px;">
                  Jeans Manufacturing Company Ltd.
                </h1>
                <div style="font-size:12.5px; color:#94a3b8; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                  <span>Biometric Workforce Intelligence &amp; Access Analytics</span>
                  <span>·</span>
                  <span style="color:#38bdf8; font-weight:600; display:inline-flex; align-items:center; gap:5px;" id="header-live-time">
                    <span class="pulse-dot online"></span> Calculating...
                  </span>
                </div>
              </div>
            </div>

            <div class="row" style="gap:8px; flex-wrap:wrap;">
              <a href="/attendance" data-link class="btn sm primary" style="border-radius:20px; font-weight:600; padding:6px 14px; background:#0284c7; border-color:#0284c7;">
                ${icon('calendar')} Daily Sheet
              </a>
              <a href="/attendance?tab=live" data-link class="btn sm" style="background:rgba(255,255,255,0.12); color:#fff; border:1px solid rgba(255,255,255,0.2); font-weight:600; border-radius:20px; padding:6px 14px;">
                ${icon('live')} Live Monitor
              </a>
              <a href="/devices" data-link class="btn sm" style="background:rgba(255,255,255,0.12); color:#fff; border:1px solid rgba(255,255,255,0.2); font-weight:600; border-radius:20px; padding:6px 14px;">
                ${icon('device')} Terminals
              </a>
            </div>
          </div>

          <!-- Dual Biometric Telemetry Cards -->
          <div class="hero-telemetry-row">
            <!-- Terminal 1: ZKTeco uFace 800 -->
            <div class="telemetry-card uface">
              <div class="telemetry-head">
                <div>
                  <div class="telemetry-title">
                    <span>🏢</span> ZKTeco Terminal (ZK-UFACE800-01)
                  </div>
                  <div class="telemetry-meta">
                    Model: <b>uFace 800</b> · SN: <code>RKQ4262500336</code> · Main Attendance Entrance
                  </div>
                </div>
                <span class="pulse-badge online" style="background:rgba(34,197,94,0.15); color:#4ade80; border:1px solid rgba(34,197,94,0.3); font-size:10.5px; font-weight:700; border-radius:20px; padding:3px 9px;">
                  <span class="glowing-dot"></span> LIVE SYNC
                </span>
              </div>
              <div class="telemetry-stats-strip">
                <div class="telemetry-stat-item">
                  <span class="telemetry-stat-label">Clock (Dhaka)</span>
                  <span class="telemetry-stat-val clock" id="uface-live-clock">--:--:-- --</span>
                </div>
                <div class="telemetry-stat-item">
                  <span class="telemetry-stat-label">Punches Today</span>
                  <span class="telemetry-stat-val" style="color:#38bdf8;">${ufacePunches} logged</span>
                </div>
                <div class="telemetry-stat-item">
                  <span class="telemetry-stat-label">Assigned Shift</span>
                  <span class="telemetry-stat-val" style="color:#f8fafc; font-size:12px;">09:30 – 19:00</span>
                </div>
              </div>
            </div>

            <!-- Terminal 2: SenseFace 7A Gate Controller -->
            <div class="telemetry-card gate">
              <div class="telemetry-head">
                <div>
                  <div class="telemetry-title">
                    <span>🚪</span> ZKTeco Terminal (VDE2251500160)
                  </div>
                  <div class="telemetry-meta">
                    Model: <b>SenseFace 7A</b> · SN: <code>VDE2251500160</code> · Factory Barrier Gate
                  </div>
                </div>
                <span class="pulse-badge online" style="background:rgba(168,85,247,0.15); color:#c084fc; border:1px solid rgba(168,85,247,0.3); font-size:10.5px; font-weight:700; border-radius:20px; padding:3px 9px;">
                  <span class="glowing-dot" style="background:#c084fc;"></span> GATE ACTIVE
                </span>
              </div>
              <div class="telemetry-stats-strip">
                <div class="telemetry-stat-item">
                  <span class="telemetry-stat-label">Clock (Dhaka)</span>
                  <span class="telemetry-stat-val clock" id="senseface-live-clock">--:--:-- --</span>
                </div>
                <div class="telemetry-stat-item">
                  <span class="telemetry-stat-label">Gate Swipes</span>
                  <span class="telemetry-stat-val" style="color:#c084fc;">${gatePunches} passes</span>
                </div>
                <div class="telemetry-stat-item">
                  <span class="telemetry-stat-label">Primary Role</span>
                  <span class="telemetry-stat-val" style="color:#c084fc; font-size:12px;">Barrier Access</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 2. Executive KPI Analytics Grid -->
        <section class="modern-kpi-grid" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">
          <!-- Total Expected -->
          <div class="kpi-stat-card">
            <div class="kpi-stat-top">
              <span class="kpi-stat-label">Scheduled Staff</span>
              <div class="kpi-stat-icon" style="background:#e0f2fe; color:#0284c7;">👥</div>
            </div>
            <div class="kpi-stat-main">
              <span class="kpi-stat-val">${k.expected}</span>
              <span class="kpi-stat-pill" style="background:#f1f5f9; color:#475569;">100% Rostered</span>
            </div>
            <div class="kpi-progress-track">
              <div class="kpi-progress-fill" style="width:100%; background:#0284c7;"></div>
            </div>
            <span class="kpi-stat-foot">Total active workforce</span>
          </div>

          <!-- Present Today -->
          <div class="kpi-stat-card">
            <div class="kpi-stat-top">
              <span class="kpi-stat-label">Checked In (Present)</span>
              <div class="kpi-stat-icon" style="background:#dcfce7; color:#15803d;">🟢</div>
            </div>
            <div class="kpi-stat-main">
              <span class="kpi-stat-val" style="color:#15803d;">${k.present}</span>
              <span class="kpi-stat-pill" style="background:#dcfce7; color:#15803d;">${presentPct}% Present</span>
            </div>
            <div class="kpi-progress-track">
              <div class="kpi-progress-fill" style="width:${presentPct}%; background:#10b981;"></div>
            </div>
            <span class="kpi-stat-foot" style="color:#15803d; font-weight:600;">✓ Active at work</span>
          </div>

          <!-- On-Time Arrival -->
          <div class="kpi-stat-card">
            <div class="kpi-stat-top">
              <span class="kpi-stat-label">On-Time Arrivals</span>
              <div class="kpi-stat-icon" style="background:#ecfeff; color:#0891b2;">⏱</div>
            </div>
            <div class="kpi-stat-main">
              <span class="kpi-stat-val" style="color:#0891b2;">${onTimeCount}</span>
              <span class="kpi-stat-pill" style="background:#ecfeff; color:#0891b2;">${onTimePct}% Punctual</span>
            </div>
            <div class="kpi-progress-track">
              <div class="kpi-progress-fill" style="width:${onTimePct}%; background:#06b6d4;"></div>
            </div>
            <span class="kpi-stat-foot">Within 09:00 – 10:00 AM window</span>
          </div>

          <!-- Late Arrivals -->
          <div class="kpi-stat-card">
            <div class="kpi-stat-top">
              <span class="kpi-stat-label">Late Arrivals</span>
              <div class="kpi-stat-icon" style="background:#fef3c7; color:#d97706;">⚠️</div>
            </div>
            <div class="kpi-stat-main">
              <span class="kpi-stat-val" style="color:#d97706;">${k.late}</span>
              <span class="kpi-stat-pill" style="background:#fef3c7; color:#b45309;">${k.present ? Math.round((k.late / k.present) * 100) : 0}% of Present</span>
            </div>
            <div class="kpi-progress-track">
              <div class="kpi-progress-fill" style="width:${k.present ? Math.round((k.late / k.present) * 100) : 0}%; background:#f59e0b;"></div>
            </div>
            <span class="kpi-stat-foot" style="color:#d97706;">Requires supervisor follow-up</span>
          </div>

          <!-- Absent -->
          <div class="kpi-stat-card">
            <div class="kpi-stat-top">
              <span class="kpi-stat-label">Absent</span>
              <div class="kpi-stat-icon" style="background:#fee2e2; color:#dc2626;">🛡</div>
            </div>
            <div class="kpi-stat-main">
              <span class="kpi-stat-val" style="color:#64748b;">${k.absent}</span>
              <span class="kpi-stat-pill" style="background:#f1f5f9; color:#475569;">0.0% Absenteeism</span>
            </div>
            <div class="kpi-progress-track">
              <div class="kpi-progress-fill" style="width:0%; background:#ef4444;"></div>
            </div>
            <span class="kpi-stat-foot">Zero unreported absences</span>
          </div>

          <!-- Overtime Hours -->
          <div class="kpi-stat-card">
            <div class="kpi-stat-top">
              <span class="kpi-stat-label">Overtime Hours</span>
              <div class="kpi-stat-icon" style="background:#f3e8ff; color:#7e22ce;">⚡</div>
            </div>
            <div class="kpi-stat-main">
              <span class="kpi-stat-val" style="color:#7e22ce;">${(k.overtimeMinutes / 60).toFixed(1)} <span style="font-size:14px; font-weight:600;">hrs</span></span>
              <span class="kpi-stat-pill" style="background:#f3e8ff; color:#7e22ce;">Regular Shift</span>
            </div>
            <div class="kpi-progress-track">
              <div class="kpi-progress-fill" style="width:0%; background:#8b5cf6;"></div>
            </div>
            <span class="kpi-stat-foot">Shift ends at 07:00 PM</span>
          </div>
        </section>

        <!-- 3. Core Analytics Visualizations Grid (FRONT & CENTER) -->
        <div style="display:grid; grid-template-columns: 2fr 1fr; gap:16px; align-items:stretch;">
          <!-- Chart A: Hourly Biometric Influx & Gate Throughput Peak Flow -->
          <div class="analytics-chart-panel">
            <div class="analytics-chart-head">
              <div>
                <div class="analytics-chart-title">
                  <span>📈</span> Today’s Biometric Influx &amp; Gate Flow Peak Curve
                </div>
                <span class="analytics-chart-sub">Hour-by-hour throughput comparing uFace 800 arrivals vs SenseFace 7A barrier gate passes</span>
              </div>
              <span class="badge" style="background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd; font-weight:600;">
                Workday (07:00 AM – 08:00 PM)
              </span>
            </div>
            <div style="height:250px; position:relative;">
              <canvas id="hourly-chart" role="img" aria-label="Hourly Biometric Flow Curve"></canvas>
            </div>
          </div>

          <!-- Chart B: Today's Workforce Composition Donut Gauge -->
          <div class="analytics-chart-panel">
            <div class="analytics-chart-head">
              <div>
                <div class="analytics-chart-title">
                  <span>🍩</span> Attendance Breakdown
                </div>
                <span class="analytics-chart-sub">Today’s roster status composition</span>
              </div>
            </div>
            <div style="height:180px; position:relative; display:grid; place-items:center;">
              <canvas id="donut-chart" role="img" aria-label="Workforce Composition Donut"></canvas>
              <div class="donut-center-metric">
                <div class="pct" style="color:#10b981;">${presentPct}%</div>
                <div class="lbl">Present</div>
              </div>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px; font-size:11.5px; border-top:1px solid var(--line-2); padding-top:10px;">
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="width:9px; height:9px; border-radius:50%; background:#10b981;"></span>
                <span>On-time: <b>${onTimeCount}</b></span>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="width:9px; height:9px; border-radius:50%; background:#f59e0b;"></span>
                <span>Late: <b>${k.late}</b></span>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="width:9px; height:9px; border-radius:50%; background:#38bdf8;"></span>
                <span>Waiting: <b>${k.notYet}</b></span>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <span style="width:9px; height:9px; border-radius:50%; background:#ef4444;"></span>
                <span>Absent: <b>${k.absent}</b></span>
              </div>
            </div>
          </div>
        </div>

        <!-- 4. Historical Trend & Department Leaderboard Grid -->
        <div style="display:grid; grid-template-columns: 1.5fr 1fr; gap:16px;">
          <!-- Chart C: 14-Day Attendance Trend -->
          <div class="analytics-chart-panel">
            <div class="analytics-chart-head">
              <div>
                <div class="analytics-chart-title">
                  <span>📊</span> 14-Day Attendance &amp; Lateness Trend
                </div>
                <span class="analytics-chart-sub">Daily attendance patterns across working days</span>
              </div>
            </div>
            <div style="height:230px; position:relative;">
              <canvas id="trend" role="img" aria-label="Attendance Trend Chart"></canvas>
            </div>
          </div>

          <!-- Chart D: Department Attendance Leaderboard -->
          <div class="analytics-chart-panel">
            <div class="analytics-chart-head">
              <div>
                <div class="analytics-chart-title">
                  <span>🏢</span> Department Attendance Rate
                </div>
                <span class="analytics-chart-sub">Month-to-date presence benchmark</span>
              </div>
            </div>
            <div style="height:230px; position:relative;">
              <canvas id="depts" role="img" aria-label="Department Attendance Rate"></canvas>
            </div>
          </div>
        </div>

        <!-- 5. Operational Feeds: Live Punches & Manager Attention -->
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px;">
          <!-- Live Terminal Door Punch Stream -->
          <div class="panel" style="border-radius:14px; overflow:hidden;">
            <header style="display:flex; justify-content:space-between; align-items:center; padding:14px 18px;">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="pulse-dot online"></span>
                <div>
                  <h2 style="font-size:14.5px; font-weight:750; margin:0;">Live Biometric Punch Stream</h2>
                  <span class="small muted">Instant punch feed from uFace 800 &amp; SenseFace 7A Gate</span>
                </div>
              </div>
              <a href="/attendance" data-link class="small" style="font-weight:700; color:#0284c7;">View Audit Log →</a>
            </header>
            <div class="body flush" style="max-height:280px; overflow-y:auto;">
              ${d.punches && d.punches.length ? d.punches.map((p) => html`
                <div class="stream-item">
                  <div style="display:flex; align-items:center; gap:10px;">
                    <div class="emp-avatar">
                      ${(p.name || 'E').slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div style="font-weight:700; font-size:13px; color:var(--text);">
                        ${p.name}
                      </div>
                      <div style="font-size:11px; color:var(--muted); display:flex; align-items:center; gap:6px; margin-top:2px;">
                        ${p.device && p.device.includes('RKQ') ? html`
                          <span style="color:#0284c7; font-weight:600;">🏢 uFace 800</span>
                        ` : p.device && p.device.includes('VDE') ? html`
                          <span style="color:#7e22ce; font-weight:600;">🚪 SenseFace 7A (Gate)</span>
                        ` : html`<span>${p.device || p.source}</span>`}
                        <span>·</span>
                        <span>PIN: ${p.pin}</span>
                      </div>
                    </div>
                  </div>
                  <div style="text-align:right;">
                    <span style="font-weight:750; font-size:11px; padding:3px 8px; border-radius:12px; background:${p.punch_type === 'OUT' ? '#fee2e2' : '#dcfce7'}; color:${p.punch_type === 'OUT' ? '#991b1b' : '#15803d'}; border:1px solid ${p.punch_type === 'OUT' ? '#fecaca' : '#bbf7d0'};">
                      ${p.punch_type === 'OUT' ? '🔴 OUT' : '🟢 IN'}
                    </span>
                    <div class="time muted" style="font-size:11.5px; margin-top:3px; font-weight:600; font-family:monospace;">
                      ${p.time_12h || p.at.slice(11, 19)}
                    </div>
                  </div>
                </div>
              `) : html`<div class="empty" style="padding:28px;">No biometric punches received yet today.</div>`}
            </div>
          </div>

          <!-- Exceptions & Needs Attention -->
          <div class="panel" style="border-radius:14px; overflow:hidden;">
            <header style="display:flex; justify-content:space-between; align-items:center; padding:14px 18px;">
              <div>
                <h2 style="font-size:14.5px; font-weight:750; margin:0;">Exceptions &amp; Manager Follow-Ups</h2>
                <span class="small muted">Late arrivals and pending check-ins</span>
              </div>
              <span class="badge" style="background:#fef3c7; color:#92400e; border:1px solid #fde68a; font-weight:700;">
                ${k.late} Late Today
              </span>
            </header>
            <div class="body flush list-lines" style="max-height:280px; overflow-y:auto;">
              ${attention(t)}
            </div>
          </div>
        </div>

        <!-- 6. Compact & Interactive Daily Attendance Roster -->
        <section class="panel" style="box-shadow:0 2px 6px rgba(0,0,0,0.03); border-radius:14px; overflow:hidden;">
          <header style="padding:16px 20px; background:var(--surface); border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
            <div style="display:flex; align-items:center; gap:12px;">
              <div>
                <h2 style="font-size:16px; font-weight:750; margin:0; display:flex; align-items:center; gap:8px;">
                  📋 Today’s Workforce Attendance Roster
                </h2>
                <span class="small muted">Showing ${filteredRibbon.length} of ${t.ribbon.length} scheduled employees · Sorted by status</span>
              </div>
            </div>

            <div class="row" style="gap:10px; align-items:center; flex-wrap:wrap;">
              <!-- Quick Search Input -->
              <input type="search" id="roster-search" placeholder="Search employee or dept…" value="${searchTerm}" style="padding:6px 12px; border:1px solid var(--line); border-radius:20px; font-size:12.5px; width:190px; background:var(--paper);">

              <!-- Filter Tabs -->
              <div class="tabs" style="margin-bottom:0; height:32px;">
                <button type="button" data-roster-tab="all" aria-selected="${activeTab === 'all'}" style="height:32px; font-size:12px; padding:0 11px;">All (${t.ribbon.length})</button>
                <button type="button" data-roster-tab="present" aria-selected="${activeTab === 'present'}" style="height:32px; font-size:12px; padding:0 11px;">Present (${k.present})</button>
                <button type="button" data-roster-tab="late" aria-selected="${activeTab === 'late'}" style="height:32px; font-size:12px; padding:0 11px;">Late (${k.late})</button>
                <button type="button" data-roster-tab="waiting" aria-selected="${activeTab === 'waiting'}" style="height:32px; font-size:12px; padding:0 11px;">Waiting (${k.notYet})</button>
                <button type="button" data-roster-tab="absent" aria-selected="${activeTab === 'absent'}" style="height:32px; font-size:12px; padding:0 11px;">Absent (${k.absent})</button>
              </div>

              <!-- View Mode Switcher -->
              <div class="row" style="gap:4px; background:var(--paper); padding:3px; border-radius:8px; border:1px solid var(--line);">
                <button type="button" id="btn-mode-table" class="btn sm ${viewMode === 'table' ? 'primary' : ''}" style="border-radius:6px; padding:4px 10px; font-size:11.5px; font-weight:600;">
                  Table
                </button>
                <button type="button" id="btn-mode-timeline" class="btn sm ${viewMode === 'timeline' ? 'primary' : ''}" style="border-radius:6px; padding:4px 10px; font-size:11.5px; font-weight:600;">
                  Timeline
                </button>
              </div>

              <!-- Toggle Collapse -->
              <button type="button" id="btn-toggle-roster" class="btn sm" style="border-radius:6px; padding:4px 10px; font-size:11.5px; font-weight:600; color:var(--muted);">
                ${rosterCollapsed ? '🔼 Expand' : '🔽 Collapse'}
              </button>
            </div>
          </header>

          ${!rosterCollapsed ? (viewMode === 'table' ? html`
            <div class="body flush table-wrap" style="max-height:420px; overflow-y:auto;">
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
                          <div style="display:flex; align-items:center; gap:8px;">
                            <div class="emp-avatar" style="width:28px; height:28px; font-size:11px;">
                              ${(r.name || 'E').slice(0, 2).toUpperCase()}
                            </div>
                            <b>${r.name}</b>
                          </div>
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
                              🚪 SenseFace 7A (Gate)
                            </span>
                          `}
                        </td>
                        <td style="padding:10px 16px;">
                          ${r.checkIn ? html`
                            <span style="font-weight:700; color:#15803d; font-family:monospace; display:inline-flex; align-items:center; gap:4px;">
                              🟢 IN: ${r.checkIn}
                            </span>
                          ` : html`<span class="muted small font-mono">—</span>`}
                        </td>
                        <td style="padding:10px 16px;">
                          ${r.checkOut ? html`
                            <span style="font-weight:700; color:#dc2626; font-family:monospace; display:inline-flex; align-items:center; gap:4px;">
                              🔴 OUT: ${r.checkOut}
                            </span>
                          ` : html`<span class="muted small font-mono">—</span>`}
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
            <div style="max-height:420px; overflow-y:auto; padding:12px 16px;">
              ${ribbon(t, filteredRibbon)}
            </div>
          `) : html`
            <div style="padding:16px 20px; color:var(--muted); font-size:12.5px; text-align:center;">
              Roster table minimized. Click "🔼 Expand" above to view all 72 employee records.
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
                label: '🏢 uFace 800 (Attendance Punches)',
                data: d.hourly.map((h) => h.uface),
                borderColor: '#0284c7',
                backgroundColor: 'rgba(2, 132, 199, 0.15)',
                borderWidth: 2.5,
                fill: true,
                tension: 0.35,
                pointRadius: 3,
                pointHoverRadius: 6,
              },
              {
                label: '🚪 SenseFace 7A (Gate Passes)',
                data: d.hourly.map((h) => h.gate),
                borderColor: '#a855f7',
                backgroundColor: 'rgba(168, 85, 247, 0.12)',
                borderWidth: 2.5,
                fill: true,
                tension: 0.35,
                pointRadius: 3,
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
              legend: {
                position: 'top',
                labels: { boxWidth: 12, boxHeight: 12, font: { weight: '600', size: 11.5 } },
              },
              tooltip: {
                callbacks: {
                  label: (c) => ` ${c.dataset.label}: ${c.raw} punch(es)`,
                },
              },
            },
            scales: {
              x: { grid: { display: false } },
              y: { beginAtZero: true, ticks: { precision: 0 } },
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
            cutout: '72%',
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
                ds('Half day', 'half_day', '#64748b'),
                ds('Leave', 'leave', '#8b5cf6'),
                ds('Absent', 'absent', '#ef4444'),
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