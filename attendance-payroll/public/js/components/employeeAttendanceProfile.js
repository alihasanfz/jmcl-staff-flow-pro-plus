// Employee Attendance Analytics & Detailed Profile Component
// Strictly uses ONLY ZKTeco uFace 800 (ZK-UFACE800-01 / RKQ4262500336) actual attendance records.
import { get, patch } from '../api.js';
import { html, setHTML, $, $$, esc, icon, toast } from '../ui.js';

let activeProfileOverlay = null;
let charts = [];

export async function showEmployeeAttendanceProfile(userId, initialFilter = {}) {
  // If an overlay already exists, remove it
  if (activeProfileOverlay) {
    activeProfileOverlay.remove();
    activeProfileOverlay = null;
  }

  // Create full-screen modal overlay
  const overlay = document.createElement('div');
  overlay.className = 'eap-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  document.body.appendChild(overlay);
  activeProfileOverlay = overlay;

  // Initial filter state
  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);
  const currentDate = now.toISOString().slice(0, 10);
  const currentYear = String(now.getFullYear());

  let filter = {
    filterType: initialFilter.filterType || 'monthly',
    month: initialFilter.month || currentMonth,
    date: initialFilter.date || currentDate,
    year: initialFilter.year || currentYear,
    from: initialFilter.from || `${currentMonth}-01`,
    to: initialFilter.to || currentDate,
  };

  let cachedData = null;
  let historySearch = '';
  let historyStatusFilter = 'all';
  let historyPage = 1;
  const PAGE_SIZE = 15;

  const closeProfile = () => {
    charts.forEach((c) => c.destroy());
    charts = [];
    if (activeProfileOverlay) {
      activeProfileOverlay.remove();
      activeProfileOverlay = null;
    }
    document.removeEventListener('keydown', onKeyDown);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') closeProfile();
  };
  document.addEventListener('keydown', onKeyDown);

  const loadData = async () => {
    overlay.innerHTML = `
      <div class="eap-container loading-state">
        <div class="eap-spinner"></div>
        <p style="margin-top:14px; font-weight:600; color:var(--muted);">Loading ZK-uFace 800 Employee Attendance Analytics...</p>
      </div>`;

    try {
      const q = new URLSearchParams({
        filterType: filter.filterType,
        month: filter.month,
        date: filter.date,
        year: filter.year,
        from: filter.from,
        to: filter.to,
      });
      const data = await get(`/attendance/employee-analytics/${userId}?${q.toString()}`);
      cachedData = data;
      historyPage = 1;
      renderUI(data);
    } catch (err) {
      overlay.innerHTML = `
        <div class="eap-container error-state">
          <div style="font-size:36px; margin-bottom:12px;">⚠️</div>
          <h3 style="margin-bottom:8px;">Failed to load attendance profile</h3>
          <p style="color:var(--muted); margin-bottom:20px;">${esc(err.message)}</p>
          <div style="display:flex; gap:10px;">
            <button type="button" class="btn" id="eap-err-retry">Retry</button>
            <button type="button" class="btn btn-subtle" id="eap-err-close">Close</button>
          </div>
        </div>`;
      $('#eap-err-retry', overlay)?.addEventListener('click', loadData);
      $('#eap-err-close', overlay)?.addEventListener('click', closeProfile);
    }
  };

  const renderUI = (data) => {
    charts.forEach((c) => c.destroy());
    charts = [];

    const emp = data.employee;
    const s = data.summary;
    const p = data.period;

    // Filter history table records
    const filteredHistory = (data.dailyHistory || []).filter((row) => {
      const matchSearch = !historySearch ||
        row.date.includes(historySearch) ||
        row.dayName.toLowerCase().includes(historySearch.toLowerCase()) ||
        row.status.toLowerCase().includes(historySearch.toLowerCase());
      if (!matchSearch) return false;
      if (historyStatusFilter === 'present') return ['present', 'late', 'half_day'].includes(row.status);
      if (historyStatusFilter === 'late') return row.lateMinutes > 0;
      if (historyStatusFilter === 'absent') return row.status === 'absent';
      if (historyStatusFilter === 'leave') return row.status === 'leave';
      if (historyStatusFilter === 'weekend') return ['weekend', 'holiday'].includes(row.status);
      return true;
    });

    const totalPages = Math.ceil(filteredHistory.length / PAGE_SIZE) || 1;
    const currentPage = Math.min(historyPage, totalPages);
    const pagedHistory = filteredHistory.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

    setHTML(overlay, html`
      <div class="eap-container" id="eap-printable-area">
        <!-- 1. Header Banner -->
        <header class="eap-header">
          <div class="eap-header-left">
            <div class="eap-avatar-wrap" id="eap-avatar-wrap" title="Click to upload or update employee photo">
              <div class="eap-avatar" id="eap-avatar-box">
                ${emp.photo ? html`<img src="${emp.photo}" alt="${emp.name}" class="eap-avatar-img" />` : (emp.name || 'E').slice(0, 2).toUpperCase()}
              </div>
              <div class="eap-avatar-camera-btn" title="Upload/Change Photo">📷</div>
              <input type="file" id="eap-photo-input" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none;" />
            </div>
            <div>
              <div class="eap-name-row">
                <h1 class="eap-name">${emp.name}</h1>
                <span class="eap-pill ${emp.active ? 'active' : 'inactive'}">
                  ${emp.active ? '● Active Employee' : '○ Inactive'}
                </span>
                <span class="eap-pill dept">${emp.department || 'General'}</span>
                <span class="eap-pill desig">${emp.designation || 'Staff'}</span>
              </div>
              <div class="eap-meta-sub">
                <span><b>ID:</b> <span class="font-mono">${emp.employeeCode}</span></span>
                <span>•</span>
                <span><b>PIN:</b> <span class="font-mono">${emp.biometricPin}</span></span>
                <span>•</span>
                <span><b>Shift:</b> ${emp.shiftName} (${emp.shiftStart} – ${emp.shiftEnd})</span>
                <span>•</span>
                <span><b>Joined:</b> ${emp.joinDate || '—'}</span>
              </div>
              <div class="eap-device-source">
                <span class="dot-live"></span>
                <strong>Authoritative Device:</strong>
                <span>ZKTeco Terminal: ZK-UFACE800-01 (uFace800 · SN: RKQ4262500336)</span>
                <span class="eap-iso-badge">Isolated from Gate Controller</span>
              </div>
            </div>
          </div>

          <div class="eap-header-actions no-print">
            <button type="button" class="eap-btn-action" id="eap-btn-print" title="Print Attendance Report">
              ${icon('printer') || '🖨️'} Print
            </button>
            <button type="button" class="eap-btn-action" id="eap-btn-csv" title="Export to CSV/Excel">
              ${icon('download') || '📥'} Export CSV
            </button>
            <button type="button" class="eap-btn-close" id="eap-btn-close" aria-label="Close Profile">×</button>
          </div>
        </header>

        <!-- 2. Advanced Date Filters Bar -->
        <div class="eap-filter-bar no-print">
          <div class="eap-mode-tabs">
            <button type="button" class="eap-mode-btn ${filter.filterType === 'monthly' ? 'active' : ''}" data-mode="monthly">
              Monthly Report
            </button>
            <button type="button" class="eap-mode-btn ${filter.filterType === 'daily' ? 'active' : ''}" data-mode="daily">
              Daily Report
            </button>
            <button type="button" class="eap-mode-btn ${filter.filterType === 'custom' ? 'active' : ''}" data-mode="custom">
              Custom Range
            </button>
            <button type="button" class="eap-mode-btn ${filter.filterType === 'yearly' ? 'active' : ''}" data-mode="yearly">
              Yearly Report
            </button>
          </div>

          <div class="eap-controls-right">
            ${filter.filterType === 'monthly' ? html`
              <div class="eap-date-picker-wrap">
                <button type="button" class="eap-nav-btn" id="eap-prev-month">◀</button>
                <input type="month" id="eap-input-month" value="${filter.month}" class="eap-input">
                <button type="button" class="eap-nav-btn" id="eap-next-month">▶</button>
              </div>
            ` : filter.filterType === 'daily' ? html`
              <div class="eap-date-picker-wrap">
                <button type="button" class="eap-nav-btn" id="eap-prev-day">◀</button>
                <input type="date" id="eap-input-date" value="${filter.date}" class="eap-input">
                <button type="button" class="eap-nav-btn" id="eap-next-day">▶</button>
              </div>
            ` : filter.filterType === 'yearly' ? html`
              <div class="eap-date-picker-wrap">
                <select id="eap-select-year" class="eap-input" style="font-weight:700;">
                  ${['2027', '2026', '2025', '2024'].map((y) => html`
                    <option value="${y}" ${filter.year === y ? 'selected' : ''}>Year ${y}</option>
                  `)}
                </select>
              </div>
            ` : html`
              <div class="eap-custom-range-wrap">
                <span>From:</span>
                <input type="date" id="eap-input-from" value="${filter.from}" class="eap-input sm">
                <span>To:</span>
                <input type="date" id="eap-input-to" value="${filter.to}" class="eap-input sm">
                <button type="button" id="eap-btn-apply-custom" class="btn btn-primary sm">Apply</button>
              </div>
            `}

            <div class="eap-quick-pills">
              <button type="button" class="eap-quick-pill" data-quick="today">Today</button>
              <button type="button" class="eap-quick-pill" data-quick="this-month">This Month</button>
              <button type="button" class="eap-quick-pill" data-quick="last-month">Last Month</button>
            </div>
          </div>
        </div>

        <!-- 3. Attendance Summary Cards (12 Modern Metric Cards) -->
        <section class="eap-summary-grid">
          <!-- 1. Total Working Days -->
          <div class="eap-card">
            <div class="eap-card-top">
              <span class="eap-card-label">Total Working Days</span>
              <div class="eap-card-icon blue">📅</div>
            </div>
            <div class="eap-card-val">${s.totalWorkingDays}</div>
            <div class="eap-card-foot">Excludes weekends &amp; holidays</div>
          </div>

          <!-- 2. Present Days -->
          <div class="eap-card">
            <div class="eap-card-top">
              <span class="eap-card-label">Present Days</span>
              <div class="eap-card-icon green">✔</div>
            </div>
            <div class="eap-card-val text-green">${s.presentDays}</div>
            <div class="eap-card-foot">${s.attendancePercentage}% Attendance Rate</div>
          </div>

          <!-- 3. Absent Days -->
          <div class="eap-card">
            <div class="eap-card-top">
              <span class="eap-card-label">Absent Days</span>
              <div class="eap-card-icon red">✖</div>
            </div>
            <div class="eap-card-val text-red">${s.absentDays}</div>
            <div class="eap-card-foot">Unpunched on uFace 800</div>
          </div>

          <!-- 4. On-Time Days -->
          <div class="eap-card">
            <div class="eap-card-top">
              <span class="eap-card-label">On-Time Days</span>
              <div class="eap-card-icon teal">⏱</div>
            </div>
            <div class="eap-card-val text-teal">${s.onTimeDays}</div>
            <div class="eap-card-foot">Within shift start + grace</div>
          </div>

          <!-- 5. Late Arrivals -->
          <div class="eap-card">
            <div class="eap-card-top">
              <span class="eap-card-label">Late Arrivals</span>
              <div class="eap-card-icon amber">⏳</div>
            </div>
            <div class="eap-card-val text-amber">${s.lateDays}</div>
            <div class="eap-card-foot">Total ${s.totalLateMinutes} mins late</div>
          </div>

          <!-- 6. Leave Days -->
          <div class="eap-card">
            <div class="eap-card-top">
              <span class="eap-card-label">Approved Leave</span>
              <div class="eap-card-icon purple">🌴</div>
            </div>
            <div class="eap-card-val text-purple">${s.leaveDays}</div>
            <div class="eap-card-foot">Authorized leave days</div>
          </div>

          <!-- 7. Total Working Hours -->
          <div class="eap-card">
            <div class="eap-card-top">
              <span class="eap-card-label">Total Working Hours</span>
              <div class="eap-card-icon blue">⚡</div>
            </div>
            <div class="eap-card-val text-blue">${s.totalWorkingHours} <span class="unit">hrs</span></div>
            <div class="eap-card-foot">Calculated from uFace IN/OUT</div>
          </div>

          <!-- 8. Average Daily Hours -->
          <div class="eap-card">
            <div class="eap-card-top">
              <span class="eap-card-label">Avg Daily Hours</span>
              <div class="eap-card-icon cyan">📊</div>
            </div>
            <div class="eap-card-val text-cyan">${s.avgDailyWorkingHours} <span class="unit">hrs/day</span></div>
            <div class="eap-card-foot">Average per present day</div>
          </div>

          <!-- 9. Total Late Minutes -->
          <div class="eap-card">
            <div class="eap-card-top">
              <span class="eap-card-label">Total Late Duration</span>
              <div class="eap-card-icon amber">⚠️</div>
            </div>
            <div class="eap-card-val text-amber">${s.totalLateMinutes} <span class="unit">mins</span></div>
            <div class="eap-card-foot">Cumulative late arrival</div>
          </div>

          <!-- 10. Early Leave Duration -->
          <div class="eap-card">
            <div class="eap-card-top">
              <span class="eap-card-label">Early Leave Duration</span>
              <div class="eap-card-icon orange">🚪</div>
            </div>
            <div class="eap-card-val text-orange">${s.totalEarlyLeaveMinutes} <span class="unit">mins</span></div>
            <div class="eap-card-foot">Departures before shift end</div>
          </div>

          <!-- 11. Overtime Hours -->
          <div class="eap-card">
            <div class="eap-card-top">
              <span class="eap-card-label">Total Overtime</span>
              <div class="eap-card-icon pink">🔥</div>
            </div>
            <div class="eap-card-val text-pink">${s.totalOvertimeHours} <span class="unit">hrs</span></div>
            <div class="eap-card-foot">ZK-uFace 800 overtime punches</div>
          </div>

          <!-- 12. Attendance Rate -->
          <div class="eap-card">
            <div class="eap-card-top">
              <span class="eap-card-label">Attendance Rate</span>
              <div class="eap-card-icon emerald">🎯</div>
            </div>
            <div class="eap-card-val text-emerald">${s.attendancePercentage}%</div>
            <div class="eap-card-foot">Present / Working days</div>
          </div>
        </section>

        <!-- 4. Attendance Analytics Charts -->
        <section class="eap-charts-grid no-print">
          <!-- Chart 1: Daily Working Hours Trend -->
          <div class="eap-chart-panel">
            <div class="eap-chart-head">
              <div>
                <h3 class="eap-chart-title">Daily Working Hours &amp; Shift Benchmark</h3>
                <span class="eap-chart-sub">Hours worked each day recorded by ZK-uFace 800</span>
              </div>
            </div>
            <div style="height:210px; position:relative;">
              <canvas id="eap-hours-chart"></canvas>
            </div>
          </div>

          <!-- Chart 2: Late Arrival vs Overtime Trend -->
          <div class="eap-chart-panel">
            <div class="eap-chart-head">
              <div>
                <h3 class="eap-chart-title">Late Minutes vs Overtime Hours</h3>
                <span class="eap-chart-sub">Punctuality and extra work comparison</span>
              </div>
            </div>
            <div style="height:210px; position:relative;">
              <canvas id="eap-punctuality-chart"></canvas>
            </div>
          </div>

          <!-- Chart 3: Status Breakdown Donut -->
          <div class="eap-chart-panel" style="max-width:320px;">
            <div class="eap-chart-head">
              <div>
                <h3 class="eap-chart-title">Status Breakdown</h3>
                <span class="eap-chart-sub">Period attendance composition</span>
              </div>
            </div>
            <div style="height:160px; position:relative; display:grid; place-items:center;">
              <canvas id="eap-donut-chart"></canvas>
              <div class="donut-center-metric">
                <div class="pct" style="color:#10b981; font-size:18px;">${s.attendancePercentage}%</div>
                <div class="lbl" style="font-size:9px;">ATTENDANCE</div>
              </div>
            </div>
            <div class="eap-donut-legend">
              <span class="item"><span class="dot" style="background:#10b981;"></span> On-time (${s.onTimeDays})</span>
              <span class="item"><span class="dot" style="background:#f59e0b;"></span> Late (${s.lateDays})</span>
              <span class="item"><span class="dot" style="background:#ef4444;"></span> Absent (${s.absentDays})</span>
              <span class="item"><span class="dot" style="background:#a855f7;"></span> Leave (${s.leaveDays})</span>
            </div>
          </div>
        </section>

        <!-- 5. Monthly Attendance Calendar (when in monthly mode) -->
        ${filter.filterType === 'monthly' ? html`
          <section class="eap-calendar-panel no-print">
            <header class="eap-cal-head">
              <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-size:18px;">🗓️</span>
                <div>
                  <h3 style="font-size:15px; font-weight:750; margin:0;">Monthly Attendance Calendar</h3>
                  <span class="small muted">Click any calendar cell to view that day's biometric punch logs</span>
                </div>
              </div>
              <div class="eap-cal-legend">
                <span class="cal-leg-item"><span class="cal-dot green"></span> Present</span>
                <span class="cal-leg-item"><span class="cal-dot orange"></span> Late</span>
                <span class="cal-leg-item"><span class="cal-dot red"></span> Absent</span>
                <span class="cal-leg-item"><span class="cal-dot purple"></span> Leave</span>
                <span class="cal-leg-item"><span class="cal-dot gray"></span> Weekend / Off</span>
              </div>
            </header>
            <div class="eap-cal-grid">
              ${['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d) => html`
                <div class="eap-cal-weekday">${d}</div>
              `)}
              ${renderCalendarDays(data.calendar, p.from, p.to)}
            </div>
          </section>
        ` : ''}

        <!-- 6. Daily Attendance History Table -->
        <section class="eap-history-panel">
          <header class="eap-table-head no-print">
            <div style="display:flex; align-items:center; gap:10px;">
              <span style="font-size:18px;">📋</span>
              <div>
                <h3 style="font-size:15px; font-weight:750; margin:0;">Daily Attendance History Table</h3>
                <span class="small muted">Showing ${filteredHistory.length} record(s) · ZK-uFace 800 Attendance Logs</span>
              </div>
            </div>

            <div class="eap-table-controls">
              <!-- Search Input -->
              <input type="search" id="eap-search-history" placeholder="Search date, day or status..." value="${historySearch}" class="eap-input sm" style="width:200px;">

              <!-- Status Filter -->
              <select id="eap-filter-status" class="eap-input sm">
                <option value="all" ${historyStatusFilter === 'all' ? 'selected' : ''}>All Statuses</option>
                <option value="present" ${historyStatusFilter === 'present' ? 'selected' : ''}>Present</option>
                <option value="late" ${historyStatusFilter === 'late' ? 'selected' : ''}>Late Arrivals</option>
                <option value="absent" ${historyStatusFilter === 'absent' ? 'selected' : ''}>Absent</option>
                <option value="leave" ${historyStatusFilter === 'leave' ? 'selected' : ''}>Approved Leave</option>
                <option value="weekend" ${historyStatusFilter === 'weekend' ? 'selected' : ''}>Weekend / Off</option>
              </select>
            </div>
          </header>

          <div class="table-wrap" style="max-height:480px; overflow-y:auto;">
            <table class="roster-table eap-table">
              <thead>
                <tr>
                  <th>Date &amp; Day</th>
                  <th>Shift Schedule</th>
                  <th>Check-In (IN)</th>
                  <th>Check-Out (OUT)</th>
                  <th>Working Hours</th>
                  <th>Late Duration</th>
                  <th>Early Leave</th>
                  <th>Overtime</th>
                  <th>Status</th>
                  <th>Terminal / Machine</th>
                  <th class="no-print">Audit Punches</th>
                </tr>
              </thead>
              <tbody>
                ${pagedHistory.length ? pagedHistory.map((row) => html`
                  <tr>
                    <td>
                      <div style="font-weight:700; color:var(--text);">${row.date}</div>
                      <span class="muted" style="font-size:11px;">${row.dayName}</span>
                    </td>
                    <td>
                      <span class="small">${row.shiftName}</span>
                      <div class="muted small font-mono">${row.scheduledStart} – ${row.scheduledEnd}</div>
                    </td>
                    <td>
                      ${row.checkIn !== '—' ? html`
                        <span class="time-in-val">${row.checkIn}</span>
                      ` : html`<span class="muted small font-mono">—</span>`}
                    </td>
                    <td>
                      ${row.checkOut !== '—' ? html`
                        <span class="time-out-val">${row.checkOut}</span>
                      ` : html`<span class="muted small font-mono">—</span>`}
                    </td>
                    <td>
                      ${row.workedMinutes > 0 ? html`
                        <span style="font-weight:750; color:var(--text);">${row.workedHours} hrs</span>
                      ` : html`<span class="muted small font-mono">—</span>`}
                    </td>
                    <td>
                      ${row.lateMinutes > 0 ? html`
                        <span class="pill-badge" style="background:#fef3c7; color:#b45309; font-weight:700;">
                          ${row.lateMinutes} mins late
                        </span>
                      ` : html`<span class="muted small font-mono">—</span>`}
                    </td>
                    <td>
                      ${row.earlyOutMinutes > 0 ? html`
                        <span class="pill-badge" style="background:#fee2e2; color:#b91c1c;">
                          ${row.earlyOutMinutes} mins
                        </span>
                      ` : html`<span class="muted small font-mono">—</span>`}
                    </td>
                    <td>
                      ${row.overtimeMinutes > 0 ? html`
                        <span class="ot-pill">+${row.overtimeHours} hrs</span>
                      ` : html`<span class="muted small font-mono">—</span>`}
                    </td>
                    <td>
                      ${row.status === 'present' ? html`
                        <span class="status-pill present">◆ Present</span>
                      ` : row.status === 'late' ? html`
                        <span class="status-pill late">◆ Late</span>
                      ` : row.status === 'absent' ? html`
                        <span class="status-pill absent">◆ Absent</span>
                      ` : row.status === 'leave' ? html`
                        <span class="status-pill leave">🌴 Leave</span>
                      ` : row.status === 'holiday' ? html`
                        <span class="status-pill waiting">🎉 Holiday</span>
                      ` : row.status === 'weekend' ? html`
                        <span class="status-pill waiting">☕ Weekend</span>
                      ` : html`
                        <span class="status-pill waiting">Scheduled</span>
                      `}
                    </td>
                    <td>
                      <span class="device-tag uface-tag">
                        <span class="device-dot blue"></span> ZK-uFace 800
                      </span>
                    </td>
                    <td class="no-print">
                      <button type="button" class="action-btn eap-btn-punches" data-date="${row.date}">
                        ${row.punchCount} punch(es)
                      </button>
                    </td>
                  </tr>
                `) : html`
                  <tr>
                    <td colspan="11" class="empty" style="padding:40px; text-align:center;">
                      No attendance history records match the current filter.
                    </td>
                  </tr>
                `}
              </tbody>
            </table>
          </div>

          <!-- Pagination -->
          ${totalPages > 1 ? html`
            <div class="eap-pagination no-print">
              <span class="small muted">Page ${currentPage} of ${totalPages} (${filteredHistory.length} records)</span>
              <div style="display:flex; gap:6px;">
                <button type="button" class="eap-nav-btn sm" id="eap-page-prev" ${currentPage <= 1 ? 'disabled' : ''}>Previous</button>
                <button type="button" class="eap-nav-btn sm" id="eap-page-next" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
              </div>
            </div>
          ` : ''}
        </section>
      </div>
    `);

    attachEvents(data);
    renderCharts(data.analytics);
  };

  const renderCalendarDays = (calendar, fromDate, toDate) => {
    // Generate calendar starting on Saturday
    // In UTC, Saturday is 6, Sunday is 0, etc.
    const startObj = new Date(`${fromDate}T00:00:00Z`);
    const endObj = new Date(`${toDate}T00:00:00Z`);

    // We start week on Saturday (index 0 for display)
    // Map JS getUTCDay (0=Sun, 1=Mon, ..., 6=Sat) to Saturday-first:
    // Sat: 0, Sun: 1, Mon: 2, Tue: 3, Wed: 4, Thu: 5, Fri: 6
    const toSatFirst = (d) => (d + 1) % 7;
    const startOffset = toSatFirst(startObj.getUTCDay());

    const cells = [];
    // Leading empty slots
    for (let i = 0; i < startOffset; i++) {
      cells.push(html`<div class="eap-cal-day empty"></div>`);
    }

    // Days of month
    let cur = new Date(startObj);
    while (cur <= endObj) {
      const dStr = cur.toISOString().slice(0, 10);
      const dayNum = cur.getUTCDate();
      const rec = calendar[dStr] || { status: 'scheduled' };

      cells.push(html`
        <div class="eap-cal-day status-${rec.status}" data-cal-date="${dStr}">
          <div class="cal-day-top">
            <span class="cal-day-num">${dayNum}</span>
            <span class="cal-status-tag ${rec.status}">${rec.status}</span>
          </div>
          <div class="cal-day-body">
            ${rec.checkIn && rec.checkIn !== '—' ? html`
              <div class="cal-time in">IN: ${rec.checkIn}</div>
            ` : ''}
            ${rec.checkOut && rec.checkOut !== '—' ? html`
              <div class="cal-time out">OUT: ${rec.checkOut}</div>
            ` : ''}
            ${rec.workedMinutes > 0 ? html`
              <div class="cal-hours">${rec.workedHours}h</div>
            ` : ''}
          </div>
        </div>
      `);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    return cells;
  };

  const renderCharts = (analytics) => {
    if (!window.Chart || !analytics) return;

    // 1. Daily Working Hours Bar Chart
    const hoursCanvas = $('#eap-hours-chart', overlay);
    if (hoursCanvas) {
      charts.push(new Chart(hoursCanvas, {
        type: 'bar',
        data: {
          labels: analytics.labels,
          datasets: [{
            label: 'Worked Hours (hrs)',
            data: analytics.workingHours,
            backgroundColor: 'rgba(37, 99, 235, 0.75)',
            borderColor: '#2563eb',
            borderWidth: 1,
            borderRadius: 4,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 12, font: { size: 10 } } },
            y: { beginAtZero: true, suggestedMax: 12, ticks: { font: { size: 10 } } },
          },
        },
      }));
    }

    // 2. Late Minutes vs Overtime Hours
    const punctCanvas = $('#eap-punctuality-chart', overlay);
    if (punctCanvas) {
      charts.push(new Chart(punctCanvas, {
        type: 'line',
        data: {
          labels: analytics.labels,
          datasets: [
            {
              label: 'Late Minutes',
              data: analytics.lateMinutes,
              borderColor: '#f59e0b',
              backgroundColor: 'rgba(245, 158, 11, 0.1)',
              yAxisID: 'yLate',
              tension: 0.3,
              fill: true,
            },
            {
              label: 'Overtime Hours',
              data: analytics.overtimeHours,
              borderColor: '#db2777',
              backgroundColor: 'rgba(219, 39, 119, 0.1)',
              yAxisID: 'yOt',
              tension: 0.3,
              fill: true,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'top', labels: { boxWidth: 10, font: { size: 11 } } } },
          scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 12, font: { size: 10 } } },
            yLate: { type: 'linear', position: 'left', beginAtZero: true, title: { display: true, text: 'Mins', font: { size: 10 } }, ticks: { font: { size: 10 } } },
            yOt: { type: 'linear', position: 'right', beginAtZero: true, grid: { display: false }, title: { display: true, text: 'Hours', font: { size: 10 } }, ticks: { font: { size: 10 } } },
          },
        },
      }));
    }

    // 3. Status Breakdown Donut
    const donutCanvas = $('#eap-donut-chart', overlay);
    if (donutCanvas) {
      const b = analytics.statusBreakdown;
      charts.push(new Chart(donutCanvas, {
        type: 'doughnut',
        data: {
          labels: ['On-time', 'Late', 'Absent', 'Leave', 'Weekend/Off'],
          datasets: [{
            data: [b.present, b.late, b.absent, b.leave, b.weekend],
            backgroundColor: ['#10b981', '#f59e0b', '#ef4444', '#a855f7', '#94a3b8'],
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '76%',
          plugins: { legend: { display: false } },
        },
      }));
    }
  };

  const attachEvents = (data) => {
    $('#eap-btn-close', overlay)?.addEventListener('click', closeProfile);

    // Interactive Employee Photo Upload from Attendance Profile
    const avatarWrap = $('#eap-avatar-wrap', overlay);
    const photoInput = $('#eap-photo-input', overlay);
    const avatarBox = $('#eap-avatar-box', overlay);

    if (avatarWrap && photoInput) {
      avatarWrap.addEventListener('click', () => {
        photoInput.click();
      });
      photoInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
          toast('Photo file must be under 10MB', 'bad');
          return;
        }
        const reader = new FileReader();
        reader.onload = (re) => {
          const img = new Image();
          img.onload = async () => {
            const canvas = document.createElement('canvas');
            const MAX = 320;
            let w = img.width, h = img.height;
            if (w > h) { if (w > MAX) { h = Math.round((h * MAX) / w); w = MAX; } }
            else { if (h > MAX) { w = Math.round((w * MAX) / h); h = MAX; } }
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
            try {
              await patch(`/users/${data.employee.id}`, { photo: dataUrl });
              data.employee.photo = dataUrl;
              setHTML(avatarBox, html`<img src="${dataUrl}" alt="${data.employee.name}" class="eap-avatar-img" />`);
              toast('Employee photo updated successfully!', 'ok');
            } catch (err) {
              toast(err.message || 'Failed to update employee photo', 'bad');
            }
          };
          img.src = re.target.result;
        };
        reader.readAsDataURL(file);
      });
    }

    // Print
    $('#eap-btn-print', overlay)?.addEventListener('click', () => {
      window.print();
    });

    // Export CSV
    $('#eap-btn-csv', overlay)?.addEventListener('click', () => {
      exportCSV(data);
    });

    // Mode tabs
    $$('.eap-mode-btn', overlay).forEach((btn) => {
      btn.addEventListener('click', () => {
        filter.filterType = btn.dataset.mode;
        loadData();
      });
    });

    // Monthly navigation
    $('#eap-input-month', overlay)?.addEventListener('change', (e) => {
      filter.month = e.target.value;
      loadData();
    });
    $('#eap-prev-month', overlay)?.addEventListener('click', () => {
      const [y, m] = filter.month.split('-').map(Number);
      const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
      filter.month = prev;
      loadData();
    });
    $('#eap-next-month', overlay)?.addEventListener('click', () => {
      const [y, m] = filter.month.split('-').map(Number);
      const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
      filter.month = next;
      loadData();
    });

    // Daily navigation
    $('#eap-input-date', overlay)?.addEventListener('change', (e) => {
      filter.date = e.target.value;
      loadData();
    });
    $('#eap-prev-day', overlay)?.addEventListener('click', () => {
      const d = new Date(`${filter.date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      filter.date = d.toISOString().slice(0, 10);
      loadData();
    });
    $('#eap-next-day', overlay)?.addEventListener('click', () => {
      const d = new Date(`${filter.date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      filter.date = d.toISOString().slice(0, 10);
      loadData();
    });

    // Yearly select
    $('#eap-select-year', overlay)?.addEventListener('change', (e) => {
      filter.year = e.target.value;
      loadData();
    });

    // Custom range apply
    $('#eap-btn-apply-custom', overlay)?.addEventListener('click', () => {
      const fromVal = $('#eap-input-from', overlay)?.value;
      const toVal = $('#eap-input-to', overlay)?.value;
      if (fromVal && toVal) {
        filter.from = fromVal;
        filter.to = toVal;
        loadData();
      }
    });

    // Quick pills
    $$('.eap-quick-pill', overlay).forEach((qp) => {
      qp.addEventListener('click', () => {
        const q = qp.dataset.quick;
        const nowD = new Date();
        if (q === 'today') {
          filter.filterType = 'daily';
          filter.date = nowD.toISOString().slice(0, 10);
        } else if (q === 'this-month') {
          filter.filterType = 'monthly';
          filter.month = nowD.toISOString().slice(0, 7);
        } else if (q === 'last-month') {
          filter.filterType = 'monthly';
          const lastM = new Date(Date.UTC(nowD.getFullYear(), nowD.getMonth() - 1, 1)).toISOString().slice(0, 7);
          filter.month = lastM;
        }
        loadData();
      });
    });

    // Calendar day click -> Show day punch details
    $$('[data-cal-date]', overlay).forEach((dayEl) => {
      dayEl.addEventListener('click', () => {
        const dStr = dayEl.dataset.calDate;
        const rec = data.calendar[dStr];
        if (rec) showDayDetailModal(data.employee, rec);
      });
    });

    // Table Audit Punches button -> Show day punch details
    $$('.eap-btn-punches', overlay).forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const dStr = btn.dataset.date;
        const rec = data.calendar[dStr];
        if (rec) showDayDetailModal(data.employee, rec);
      });
    });

    // Search and filter inside history table
    const searchInput = $('#eap-search-history', overlay);
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        historySearch = e.target.value.trim();
        historyPage = 1;
        renderUI(cachedData);
        const refocused = $('#eap-search-history', overlay);
        if (refocused) {
          refocused.focus();
          refocused.selectionStart = refocused.selectionEnd = refocused.value.length;
        }
      });
    }

    $('#eap-filter-status', overlay)?.addEventListener('change', (e) => {
      historyStatusFilter = e.target.value;
      historyPage = 1;
      renderUI(cachedData);
    });

    // Pagination buttons
    $('#eap-page-prev', overlay)?.addEventListener('click', () => {
      if (historyPage > 1) {
        historyPage--;
        renderUI(cachedData);
      }
    });
    $('#eap-page-next', overlay)?.addEventListener('click', () => {
      historyPage++;
      renderUI(cachedData);
    });
  };

  const showDayDetailModal = (employee, rec) => {
    const pop = document.createElement('div');
    pop.className = 'eap-day-modal-overlay';
    pop.innerHTML = `
      <div class="eap-day-modal-box">
        <header class="eap-day-modal-head">
          <div>
            <h3 style="margin:0; font-size:16px;">Biometric Punch Audit — ${rec.date}</h3>
            <span class="small muted">${rec.dayName} · ${employee.name} (${employee.employeeCode})</span>
          </div>
          <button type="button" class="x" id="eap-day-close" style="font-size:20px; background:none; border:none; cursor:pointer;">×</button>
        </header>
        <div class="eap-day-modal-body">
          <div class="eap-day-stat-strip">
            <div><b>Status:</b> <span class="status-pill ${rec.status}">${rec.status}</span></div>
            <div><b>Working Hours:</b> ${rec.workedHours} hrs</div>
            <div><b>Late:</b> ${rec.lateMinutes} mins</div>
            <div><b>Overtime:</b> ${rec.overtimeHours} hrs</div>
          </div>
          <div style="margin-top:14px;">
            <div style="font-size:12.5px; font-weight:700; color:var(--text); margin-bottom:8px;">
              Raw ZK-uFace 800 Attendance Punches (${rec.punches ? rec.punches.length : 0}):
            </div>
            ${rec.punches && rec.punches.length ? `
              <table class="roster-table" style="font-size:12px;">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Punch Type</th>
                    <th>Verification</th>
                    <th>Terminal Device</th>
                  </tr>
                </thead>
                <tbody>
                  ${rec.punches.map((p) => `
                    <tr>
                      <td style="font-family:monospace; font-weight:700; color:#1d4ed8;">${p.time}</td>
                      <td>
                        <span class="stream-badge ${p.state === 'OUT' ? 'bad' : 'ok'}">${p.state === 'OUT' ? '− OUT' : '+ IN'}</span>
                      </td>
                      <td class="muted">${p.verify || 'Face Biometric'}</td>
                      <td>
                        <span class="device-tag uface-tag"><span class="device-dot blue"></span> ZK-uFace 800</span>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            ` : `
              <p class="empty" style="padding:16px; font-size:12.5px;">No raw biometric punches recorded on ZK-uFace 800 for this date.</p>
            `}
          </div>
        </div>
      </div>`;

    document.body.appendChild(pop);
    const closePop = () => pop.remove();
    pop.addEventListener('mousedown', (e) => { if (e.target === pop) closePop(); });
    $('#eap-day-close', pop)?.addEventListener('click', closePop);
  };

  const exportCSV = (data) => {
    const emp = data.employee;
    const s = data.summary;
    const rows = [
      ['JMCL STAFF FLOW PRO PLUS - EMPLOYEE ATTENDANCE REPORT'],
      ['Authoritative Terminal', 'ZK-UFACE800-01 (ZKTeco uFace 800)'],
      ['Generated On', new Date().toLocaleString()],
      ['Employee Name', emp.name],
      ['Employee Code', emp.employeeCode],
      ['Department', emp.department],
      ['Designation', emp.designation],
      ['Shift Schedule', `${emp.shiftName} (${emp.shiftStart} - ${emp.shiftEnd})`],
      ['Reporting Period', `${data.period.from} to ${data.period.to} (${data.period.filterType})`],
      [],
      ['SUMMARY METRICS'],
      ['Total Working Days', s.totalWorkingDays],
      ['Present Days', s.presentDays],
      ['Absent Days', s.absentDays],
      ['On-Time Days', s.onTimeDays],
      ['Late Arrivals', s.lateDays],
      ['Leave Days', s.leaveDays],
      ['Total Working Hours', `${s.totalWorkingHours} hrs`],
      ['Average Daily Working Hours', `${s.avgDailyWorkingHours} hrs/day`],
      ['Total Late Minutes', `${s.totalLateMinutes} mins`],
      ['Total Early Leave Minutes', `${s.totalEarlyLeaveMinutes} mins`],
      ['Total Overtime Hours', `${s.totalOvertimeHours} hrs`],
      ['Attendance Percentage', `${s.attendancePercentage}%`],
      [],
      ['DAILY ATTENDANCE HISTORY'],
      ['Date', 'Day', 'Shift', 'Scheduled Start', 'Scheduled End', 'Actual Check-In', 'Actual Check-Out', 'Working Hours', 'Late Minutes', 'Early Leave', 'Overtime Hours', 'Status', 'Machine Device'],
    ];

    for (const r of data.dailyHistory) {
      rows.push([
        r.date,
        r.dayName,
        r.shiftName,
        r.scheduledStart,
        r.scheduledEnd,
        r.checkIn,
        r.checkOut,
        r.workedHours,
        r.lateMinutes,
        r.earlyOutMinutes,
        r.overtimeHours,
        r.status,
        'ZK-uFace 800',
      ]);
    }

    const csvContent = '\uFEFF' + rows.map((e) => e.map((cell) => `"${String(cell || '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Attendance_${emp.name.replace(/\s+/g, '_')}_${data.period.from}_to_${data.period.to}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Attendance report exported to CSV successfully', 'ok');
  };

  // Start by loading data
  loadData();
}
