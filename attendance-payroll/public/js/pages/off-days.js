// Off Day Management: Advanced Date-Based, Department-Based, & Employee-Based Off Day System
import { get, post, del } from '../api.js';
import { html, setHTML, $, $$, esc, icon, badge, toast, modal, confirmDialog, fmtDateLong } from '../ui.js';
import { t } from '../i18n.js';

export async function render(view, state) {
  let isMounted = true;
  let activeTab = 'calendar'; // 'calendar' or 'list'
  let currentMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  let currentDept = 'all';
  let searchTerm = '';
  let selectedIds = new Set();
  let calendarData = null;
  let listData = null;
  let statsData = null;
  let departments = [];
  let allEmployees = [];

  const cleanup = () => {
    isMounted = false;
  };

  // Initial Shell HTML
  setHTML(view, html`
    <div class="stack" style="gap:20px;">
      <!-- Page Header -->
      <div class="row between items-center wrap" style="gap:12px;">
        <div>
          <h2>${t('off_days')}</h2>
          <p class="muted">Manage and assign corporate off days by specific dates, departments, individual employees, or bulk spreadsheet roster.</p>
        </div>
        <div class="row items-center wrap" style="gap:8px;">
          <button class="btn" id="btn-export-excel">${icon('download')} Export Excel</button>
          <button class="btn" id="btn-export-pdf">${icon('download')} Export PDF</button>
          <button class="btn" id="btn-bulk-import">${icon('upload')} Bulk Import</button>
          <button class="btn primary" id="btn-assign-offday">${icon('plus')} Assign Off Days</button>
        </div>
      </div>

      <!-- Top Summary Cards -->
      <section class="modern-kpi-grid" id="offday-stats-grid">
        <div class="kpi-stat-card">
          <div class="kpi-card-header">
            <div class="kpi-icon-box" style="background:#e0f2fe; color:#0284c7;">
              ${icon('coffee')}
            </div>
          </div>
          <div class="kpi-card-title">Total Off Day Assignments</div>
          <div class="kpi-card-val-row">
            <span class="kpi-card-val" id="stat-total-assignments">—</span>
            <span class="kpi-card-badge" style="background:#e0f2fe; color:#0284c7;">Active</span>
          </div>
          <div class="kpi-card-foot">Total recorded off days</div>
        </div>

        <div class="kpi-stat-card">
          <div class="kpi-card-header">
            <div class="kpi-icon-box" style="background:#fef3c7; color:#d97706;">
              ${icon('department')}
            </div>
          </div>
          <div class="kpi-card-title">Departments Covered</div>
          <div class="kpi-card-val-row">
            <span class="kpi-card-val" id="stat-depts-covered">—</span>
            <span class="kpi-card-badge" style="background:#fef3c7; color:#d97706;">Schedules</span>
          </div>
          <div class="kpi-card-foot">Distinct departments assigned</div>
        </div>

        <div class="kpi-stat-card">
          <div class="kpi-card-header">
            <div class="kpi-icon-box" style="background:#dcfce7; color:#16a34a;">
              ${icon('people')}
            </div>
          </div>
          <div class="kpi-card-title">Employees Covered</div>
          <div class="kpi-card-val-row">
            <span class="kpi-card-val" id="stat-employees-covered">—</span>
            <span class="kpi-card-badge" style="background:#dcfce7; color:#16a34a;">Staff</span>
          </div>
          <div class="kpi-card-foot">Distinct staff with custom off days</div>
        </div>

        <div class="kpi-stat-card">
          <div class="kpi-card-header">
            <div class="kpi-icon-box" style="background:#ede9fe; color:#7c3aed;">
              ${icon('calendar')}
            </div>
          </div>
          <div class="kpi-card-title">Upcoming Off Days</div>
          <div class="kpi-card-val-row">
            <span class="kpi-card-val" id="stat-upcoming-offdays">—</span>
            <span class="kpi-card-badge" style="background:#ede9fe; color:#7c3aed;">From Today</span>
          </div>
          <div class="kpi-card-foot">Scheduled future off days</div>
        </div>
      </section>

      <!-- Panel with Tabs & Content -->
      <div class="panel">
        <header class="row between items-center wrap" style="gap:12px; padding:12px 16px;">
          <!-- Left: Tab Switcher -->
          <div class="tab-pill-group" style="display:inline-flex; background:var(--line); padding:3px; border-radius:8px;">
            <button class="btn small ${activeTab === 'calendar' ? 'primary' : ''}" id="tab-btn-calendar" style="border:none; border-radius:6px; font-weight:600;">
              ${icon('calendar')} Interactive Calendar
            </button>
            <button class="btn small ${activeTab === 'list' ? 'primary' : ''}" id="tab-btn-list" style="border:none; border-radius:6px; font-weight:600;">
              ${icon('audit')} Assignment History / List
            </button>
          </div>

          <!-- Right: Filters -->
          <div class="row items-center wrap" style="gap:8px;">
            <select id="filter-dept" style="width:auto; min-width:160px;">
              <option value="all">All Departments</option>
            </select>

            <div class="search-input-wrap" style="width:220px;">
              ${icon('search')}
              <input type="text" id="filter-search" placeholder="Search employee, ID...">
            </div>
          </div>
        </header>

        <div class="body" id="offday-content-area" style="padding:16px;">
          <p class="muted">${t('loading')}</p>
        </div>
      </div>
    </div>
  `);

  // Event Listeners for Page
  $('#tab-btn-calendar')?.addEventListener('click', () => switchTab('calendar'));
  $('#tab-btn-list')?.addEventListener('click', () => switchTab('list'));
  $('#filter-dept')?.addEventListener('change', (e) => {
    currentDept = e.target.value;
    refreshView();
  });
  $('#filter-search')?.addEventListener('input', (e) => {
    searchTerm = e.target.value.toLowerCase().trim();
    if (activeTab === 'list') renderListTable();
  });

  $('#btn-assign-offday')?.addEventListener('click', () => openAssignModal());
  $('#btn-bulk-import')?.addEventListener('click', () => openImportModal());
  $('#btn-export-excel')?.addEventListener('click', () => {
    window.location.href = `/api/off-days/export?format=xlsx&department=${encodeURIComponent(currentDept)}`;
  });
  $('#btn-export-pdf')?.addEventListener('click', () => {
    window.open(`/api/off-days/export?format=pdf&department=${encodeURIComponent(currentDept)}`, '_blank');
  });

  // Load Initial Metadata
  await loadMetadata();
  await loadStats();
  await refreshView();

  async function loadMetadata() {
    try {
      const [deptRes, userRes] = await Promise.all([
        get('/departments'),
        get('/users?brief=true'),
      ]);
      departments = (deptRes.departments || []).filter((d) => Boolean(d.name));
      allEmployees = (userRes.users || []).filter((u) => u.active !== false);

      const deptSelect = $('#filter-dept');
      if (deptSelect) {
        deptSelect.innerHTML = `<option value="all">All Departments</option>` +
          departments.map((d) => `<option value="${esc(d.name)}">${esc(d.name)} (${d.employees || 0})</option>`).join('');
      }
    } catch (err) {
      console.error('[offDays] Failed to load metadata:', err);
    }
  }

  async function loadStats() {
    try {
      const res = await get('/off-days/stats');
      statsData = res.stats || {};
      $('#stat-total-assignments').textContent = statsData.totalAssignments ?? 0;
      $('#stat-depts-covered').textContent = statsData.departmentsCovered ?? 0;
      $('#stat-employees-covered').textContent = statsData.employeesCovered ?? 0;
      $('#stat-upcoming-offdays').textContent = statsData.upcomingOffDays ?? 0;
    } catch (err) {
      console.error('[offDays] Failed to load stats:', err);
    }
  }

  function switchTab(tab) {
    activeTab = tab;
    $('#tab-btn-calendar').className = `btn small ${activeTab === 'calendar' ? 'primary' : ''}`;
    $('#tab-btn-list').className = `btn small ${activeTab === 'list' ? 'primary' : ''}`;
    refreshView();
  }

  async function refreshView() {
    if (!isMounted) return;
    const area = $('#offday-content-area');
    setHTML(area, html`<p class="muted">${t('loading')}</p>`);

    if (activeTab === 'calendar') {
      await loadCalendarView();
    } else {
      await loadListView();
    }
  }

  /* =========================================================================
   * 1. INTERACTIVE MONTHLY CALENDAR VIEW
   * ========================================================================= */
  async function loadCalendarView() {
    const area = $('#offday-content-area');
    try {
      const data = await get(`/off-days/calendar?month=${currentMonth}&department=${encodeURIComponent(currentDept)}`);
      calendarData = data;
      renderCalendar();
    } catch (err) {
      setHTML(area, html`<div class="notice bad">${err.message}</div>`);
    }
  }

  function renderCalendar() {
    const area = $('#offday-content-area');
    if (!calendarData) return;

    const [yearStr, monthStr] = currentMonth.split('-');
    const currentYear = Number(yearStr);
    const currentMonthNum = Number(monthStr);

    const monthDate = new Date(currentYear, currentMonthNum - 1, 1);
    const monthTitle = monthDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    // Calendar grid calculations
    const firstDayOfWeek = monthDate.getDay(); // 0 = Sunday
    const daysInMonth = new Date(currentYear, currentMonthNum, 0).getDate();

    const dayCardsMap = new Map();
    for (const d of calendarData.days) {
      dayCardsMap.set(d.date, d);
    }

    const todayStr = new Date().toISOString().slice(0, 10);

    // Build days array with leading blank padding
    const gridCells = [];
    for (let i = 0; i < firstDayOfWeek; i++) {
      gridCells.push(null);
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${currentMonth}-${String(day).padStart(2, '0')}`;
      gridCells.push(dayCardsMap.get(dateStr) || { date: dateStr, count: 0, assignments: [] });
    }

    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    setHTML(area, html`
      <div class="calendar-container">
        <!-- Month Navigation Bar -->
        <div class="row between items-center" style="margin-bottom:16px;">
          <div class="row items-center" style="gap:10px;">
            <button class="btn small" id="cal-prev-month" title="Previous Month">‹ Previous</button>
            <h3 style="margin:0; font-size:18px; font-weight:700;">${monthTitle}</h3>
            <button class="btn small" id="cal-next-month" title="Next Month">Next ›</button>
            <button class="btn small" id="cal-today-btn" style="margin-left:6px;">Current Month</button>
          </div>
          <div class="row items-center" style="gap:12px; font-size:12px;">
            <span class="row items-center" style="gap:4px;"><span style="width:12px; height:12px; border-radius:3px; background:#e0f2fe; border:1px solid #38bdf8;"></span> Assigned Off Day</span>
            <span class="row items-center" style="gap:4px;"><span style="width:12px; height:12px; border-radius:3px; background:#fee2e2; border:1px solid #f87171;"></span> Holiday</span>
            <span class="row items-center" style="gap:4px;"><span style="width:12px; height:12px; border-radius:3px; background:var(--line);"></span> Friday Weekly Off</span>
          </div>
        </div>

        <!-- Calendar Day Headers -->
        <div class="calendar-grid" style="display:grid; grid-template-columns:repeat(7, 1fr); gap:8px;">
          ${weekdays.map((w, idx) => html`
            <div style="text-align:center; padding:8px; font-size:12px; font-weight:700; text-transform:uppercase; color:${idx === 5 ? 'var(--brand)' : 'var(--muted)'};">
              ${w} ${idx === 5 ? '★' : ''}
            </div>
          `)}

          <!-- Calendar Date Cells -->
          ${gridCells.map((cell) => {
            if (!cell) {
              return html`<div style="min-height:95px; background:transparent; border-radius:8px;"></div>`;
            }

            const dayNum = cell.date.split('-')[2];
            const isToday = cell.date === todayStr;
            const isFriday = cell.isFriday;
            const hasHoliday = Boolean(cell.holiday);
            const hasOffDays = cell.count > 0;

            let bgColor = 'var(--surface)';
            let borderColor = 'var(--line)';

            if (hasOffDays) {
              bgColor = '#f0f9ff';
              borderColor = '#0284c7';
            } else if (hasHoliday) {
              bgColor = '#fef2f2';
              borderColor = '#fca5a5';
            } else if (isFriday) {
              bgColor = 'rgba(255, 255, 255, 0.02)';
            }

            return html`
              <div class="cal-cell" data-date="${cell.date}"
                   style="min-height:100px; padding:8px; border-radius:10px; border:1px solid ${borderColor};
                          background:${bgColor}; display:flex; flex-direction:column; justify-content:space-between;
                          cursor:pointer; transition:all 0.15s ease; position:relative; box-shadow:${isToday ? '0 0 0 2px var(--brand)' : 'none'};">
                <div>
                  <div class="row between items-center" style="margin-bottom:6px;">
                    <span style="font-size:13px; font-weight:${isToday ? '800' : '600'}; color:${isToday ? 'var(--brand)' : 'var(--text)'};">
                      ${Number(dayNum)} ${isToday ? '· Today' : ''}
                    </span>
                    ${isFriday ? html`<span class="badge weekend" style="font-size:9.5px; padding:1px 5px;">Fri</span>` : ''}
                  </div>

                  ${hasHoliday ? html`
                    <div style="font-size:10.5px; font-weight:600; color:#dc2626; margin-bottom:4px; line-height:1.2;">
                      🎉 ${cell.holiday}
                    </div>
                  ` : ''}

                  ${hasOffDays ? html`
                    <div style="background:#0284c7; color:#fff; border-radius:6px; padding:3px 6px; font-size:11px; font-weight:700; display:inline-flex; align-items:center; gap:4px; margin-bottom:4px;">
                      ${icon('people')} ${cell.count} Staff Off
                    </div>
                    <div style="display:flex; flex-wrap:wrap; gap:3px;">
                      ${(cell.departments || []).slice(0, 2).map((dept) => html`
                        <span style="font-size:9.5px; background:#e0f2fe; color:#0369a1; padding:1px 5px; border-radius:4px; font-weight:600;">
                          ${dept}
                        </span>
                      `)}
                      ${(cell.departments || []).length > 2 ? html`
                        <span style="font-size:9.5px; background:#e0f2fe; color:#0369a1; padding:1px 4px; border-radius:4px;">
                          +${cell.departments.length - 2}
                        </span>
                      ` : ''}
                    </div>
                  ` : ''}
                </div>

                <div style="text-align:right; margin-top:4px;">
                  <span class="small muted" style="font-size:10px;">${hasOffDays ? 'Click to inspect ›' : '+ Assign'}</span>
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    `);

    // Month Navigation triggers
    $('#cal-prev-month')?.addEventListener('click', () => {
      const prev = new Date(currentYear, currentMonthNum - 2, 1);
      currentMonth = prev.toISOString().slice(0, 7);
      loadCalendarView();
    });
    $('#cal-next-month')?.addEventListener('click', () => {
      const next = new Date(currentYear, currentMonthNum, 1);
      currentMonth = next.toISOString().slice(0, 7);
      loadCalendarView();
    });
    $('#cal-today-btn')?.addEventListener('click', () => {
      currentMonth = new Date().toISOString().slice(0, 7);
      loadCalendarView();
    });

    // Date Cell click -> opens Inspector & Management Drawer/Modal
    $$('.cal-cell', area).forEach((el) => {
      el.addEventListener('click', () => {
        const d = el.getAttribute('data-date');
        const cellData = dayCardsMap.get(d) || { date: d, count: 0, assignments: [] };
        openDateDetailsModal(cellData);
      });
    });
  }

  /* =========================================================================
   * 2. DATE DETAILS & ROSTER INSPECTOR MODAL
   * ========================================================================= */
  function openDateDetailsModal(dayData) {
    const d = new Date(`${dayData.date}T00:00:00Z`);
    const dayName = d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
    const formattedDate = fmtDateLong(dayData.date);

    modal({
      title: `Off Day Details: ${formattedDate} (${dayName})`,
      wide: true,
      body: html`
        <div class="stack" style="gap:16px;">
          <div class="row between items-center wrap" style="padding:10px 14px; background:var(--line); border-radius:8px;">
            <div>
              <b style="font-size:14px;">Total Scheduled Off: ${dayData.count} Employee(s)</b>
              <p class="small muted" style="margin:2px 0 0 0;">These employees are excused from attendance and will not be marked Absent.</p>
            </div>
            <div class="row" style="gap:8px;">
              <button class="btn small primary" id="modal-add-more-btn">${icon('plus')} Add Staff</button>
              ${dayData.count > 0 ? html`
                <button class="btn small danger" id="modal-clear-day-btn">${icon('trash')} Clear All for Date</button>
              ` : ''}
            </div>
          </div>

          ${dayData.count === 0 ? html`
            <div class="notice muted" style="text-align:center; padding:30px;">
              <p style="margin:0 0 8px 0;">No custom off days assigned for this date.</p>
              <button class="btn small primary" id="empty-add-btn">${icon('plus')} Assign Off Day to this Date</button>
            </div>
          ` : html`
            <div class="table-wrap" style="max-height:400px; overflow-y:auto;">
              <table>
                <thead>
                  <tr>
                    <th>Employee ID</th>
                    <th>Name</th>
                    <th>Department</th>
                    <th>Designation</th>
                    <th>Type</th>
                    <th>Reason / Note</th>
                    <th class="r">Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${dayData.assignments.map((a) => html`
                    <tr>
                      <td><b class="code">${esc(a.code || '—')}</b></td>
                      <td><b>${esc(a.name)}</b></td>
                      <td>${esc(a.department || '—')}</td>
                      <td><span class="small muted">${esc(a.designation || '—')}</span></td>
                      <td><span class="badge ${a.assignmentType === 'department' ? 'weekend' : 'leave'}">${esc(a.assignmentType)}</span></td>
                      <td><span class="small">${esc(a.reason || 'Off Day')}</span></td>
                      <td class="r">
                        <button class="btn small icon danger btn-delete-single" data-id="${a.id}" data-name="${esc(a.name)}" title="Remove Off Day">
                          ${icon('trash')}
                        </button>
                      </td>
                    </tr>
                  `)}
                </tbody>
              </table>
            </div>
          `}
        </div>
      `,
      onOpen: (f, close) => {
        $('#modal-add-more-btn', f)?.addEventListener('click', () => {
          close();
          openAssignModal({ defaultDate: dayData.date });
        });
        $('#empty-add-btn', f)?.addEventListener('click', () => {
          close();
          openAssignModal({ defaultDate: dayData.date });
        });

        $('#modal-clear-day-btn', f)?.addEventListener('click', async () => {
          const ok = await confirmDialog('Clear Off Days', `Remove all ${dayData.count} off day assignments for ${formattedDate}?`);
          if (!ok) return;
          try {
            await post('/off-days/bulk-delete', { from: dayData.date, to: dayData.date });
            toast(`Cleared all off days for ${dayData.date}`, 'good');
            close();
            loadStats();
            refreshView();
          } catch (e) {
            toast(e.message, 'bad');
          }
        });

        $$('.btn-delete-single', f).forEach((btn) => {
          btn.addEventListener('click', async () => {
            const targetId = btn.getAttribute('data-id');
            const empName = btn.getAttribute('data-name');
            const ok = await confirmDialog('Remove Off Day', `Remove custom off day for ${empName} on ${formattedDate}?`);
            if (!ok) return;
            try {
              await del(`/off-days/${targetId}`);
              toast(`Removed off day for ${empName}`, 'good');
              close();
              loadStats();
              refreshView();
            } catch (e) {
              toast(e.message, 'bad');
            }
          });
        });
      },
    });
  }

  /* =========================================================================
   * 3. ASSIGNMENT HISTORY / LIST VIEW
   * ========================================================================= */
  async function loadListView() {
    const area = $('#offday-content-area');
    try {
      listData = await get(`/off-days?department=${encodeURIComponent(currentDept)}&limit=1000`);
      renderListTable();
    } catch (err) {
      setHTML(area, html`<div class="notice bad">${err.message}</div>`);
    }
  }

  function renderListTable() {
    const area = $('#offday-content-area');
    if (!listData) return;

    const rows = (listData.rows || []).filter((r) => {
      if (!searchTerm) return true;
      return (
        r.employee_name.toLowerCase().includes(searchTerm) ||
        (r.employee_code && r.employee_code.toLowerCase().includes(searchTerm)) ||
        (r.department && r.department.toLowerCase().includes(searchTerm)) ||
        (r.reason && r.reason.toLowerCase().includes(searchTerm)) ||
        r.date.includes(searchTerm)
      );
    });

    setHTML(area, html`
      <div class="stack" style="gap:12px;">
        <div class="row between items-center wrap" style="gap:8px;">
          <span class="small muted">Showing ${rows.length} of ${listData.total || rows.length} assignment record(s)</span>
          ${selectedIds.size > 0 ? html`
            <div class="row items-center" style="gap:8px;">
              <span class="badge waiting">${selectedIds.size} selected</span>
              <button class="btn small danger" id="btn-delete-selected">${icon('trash')} Delete Selected</button>
            </div>
          ` : ''}
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width:36px;"><input type="checkbox" id="th-check-all"></th>
                <th>Date</th>
                <th>Day</th>
                <th>Employee Code</th>
                <th>Employee Name</th>
                <th>Department</th>
                <th>Designation</th>
                <th>Type</th>
                <th>Reason</th>
                <th>Assigned By</th>
                <th class="r">Action</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length === 0 ? html`
                <tr><td colspan="11" class="empty">${t('noData')}</td></tr>
              ` : rows.map((r) => {
                const d = new Date(`${r.date}T00:00:00Z`);
                const dayName = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
                const isChecked = selectedIds.has(r.id);

                return html`
                  <tr>
                    <td><input type="checkbox" class="row-check" data-id="${r.id}" ${isChecked ? 'checked' : ''}></td>
                    <td><b class="date">${fmtDateLong(r.date)}</b></td>
                    <td><span class="small muted">${dayName}</span></td>
                    <td><b class="code">${esc(r.employee_code || '—')}</b></td>
                    <td><b>${esc(r.employee_name)}</b></td>
                    <td>${esc(r.user_department || r.department || '—')}</td>
                    <td><span class="small muted">${esc(r.designation || '—')}</span></td>
                    <td><span class="badge ${r.assignment_type === 'department' ? 'weekend' : 'leave'}">${esc(r.assignment_type)}</span></td>
                    <td><span class="small">${esc(r.reason || 'Off Day')}</span></td>
                    <td><span class="small muted">${esc(r.assigned_by_name || 'System / Admin')}</span></td>
                    <td class="r">
                      <button class="btn small icon danger btn-del-row" data-id="${r.id}" data-name="${esc(r.employee_name)}" data-date="${r.date}" title="Delete">
                        ${icon('trash')}
                      </button>
                    </td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        </div>
      </div>
    `);

    // Check all event
    $('#th-check-all')?.addEventListener('change', (e) => {
      const checked = e.target.checked;
      selectedIds.clear();
      if (checked) {
        rows.forEach((r) => selectedIds.add(r.id));
      }
      renderListTable();
    });

    // Row check event
    $$('.row-check', area).forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = Number(cb.getAttribute('data-id'));
        if (cb.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        renderListTable();
      });
    });

    // Delete single row
    $$('.btn-del-row', area).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name');
        const dt = btn.getAttribute('data-date');
        const ok = await confirmDialog('Delete Off Day Assignment', `Remove off day for ${name} on ${dt}?`);
        if (!ok) return;
        try {
          await del(`/off-days/${id}`);
          toast(`Removed off day for ${name}`, 'good');
          loadStats();
          loadListView();
        } catch (e) {
          toast(e.message, 'bad');
        }
      });
    });

    // Delete selected
    $('#btn-delete-selected')?.addEventListener('click', async () => {
      const ok = await confirmDialog('Delete Selected Off Days', `Permanently remove ${selectedIds.size} off day assignment(s)?`);
      if (!ok) return;
      try {
        await post('/off-days/bulk-delete', { ids: Array.from(selectedIds) });
        toast(`Removed ${selectedIds.size} assignments`, 'good');
        selectedIds.clear();
        loadStats();
        loadListView();
      } catch (e) {
        toast(e.message, 'bad');
      }
    });
  }

  /* =========================================================================
   * 4. ASSIGN OFF DAYS MODAL (Department, Employee ID, Date & Range)
   * ========================================================================= */
  async function openAssignModal({ defaultDate = null } = {}) {
    if (!departments.length || !allEmployees.length) {
      await loadMetadata();
    }

    const today = new Date().toISOString().slice(0, 10);
    const initialDate = defaultDate || today;

    let targetMode = 'department'; // 'department', 'employee', 'bulk_ids'
    let dateMode = 'single'; // 'single', 'range'
    let selectedDepartment = departments[0]?.name || '';
    let selectedEmployees = new Set();
    let excludedEmployees = new Set();

    modal({
      title: 'Assign Off Days',
      wide: true,
      submitLabel: 'Confirm & Assign Off Days',
      body: html`
        <div class="stack" style="gap:16px;">
          <!-- 1. DATE SELECTION SECTION -->
          <div class="panel" style="background:var(--line); padding:12px; border-radius:8px;">
            <b style="font-size:13px; display:block; margin-bottom:8px;">1. Select Date(s)</b>
            <div class="row items-center wrap" style="gap:16px; margin-bottom:10px;">
              <label class="row items-center" style="gap:6px; cursor:pointer;">
                <input type="radio" name="dateMode" value="single" checked id="radio-date-single"> Specific Date(s)
              </label>
              <label class="row items-center" style="gap:6px; cursor:pointer;">
                <input type="radio" name="dateMode" value="range" id="radio-date-range"> Date Range (Bulk)
              </label>
            </div>

            <!-- Single or Multi Date Input -->
            <div id="date-single-wrap" class="row items-center wrap" style="gap:10px;">
              <label style="flex:1; min-width:200px;">
                Off Day Date
                <input type="date" id="input-single-date" value="${initialDate}" required>
              </label>
              <label style="flex:1; min-width:200px;">
                Additional Dates (Optional, comma-separated)
                <input type="text" id="input-extra-dates" placeholder="e.g. 2026-11-25, 2026-11-26">
              </label>
            </div>

            <!-- Date Range Input (Hidden initially) -->
            <div id="date-range-wrap" class="row items-center wrap" style="gap:10px; display:none;">
              <label style="flex:1; min-width:180px;">
                Start Date (From)
                <input type="date" id="input-range-from" value="${initialDate}">
              </label>
              <label style="flex:1; min-width:180px;">
                End Date (To)
                <input type="date" id="input-range-to" value="${initialDate}">
              </label>
            </div>
          </div>

          <!-- 2. TARGET SELECTION SECTION -->
          <div class="panel" style="background:var(--line); padding:12px; border-radius:8px;">
            <b style="font-size:13px; display:block; margin-bottom:8px;">2. Assign By</b>
            <div class="row items-center wrap" style="gap:16px; margin-bottom:12px;">
              <label class="row items-center" style="gap:6px; cursor:pointer;">
                <input type="radio" name="targetMode" value="department" checked id="radio-target-dept"> Department
              </label>
              <label class="row items-center" style="gap:6px; cursor:pointer;">
                <input type="radio" name="targetMode" value="employee" id="radio-target-emp"> Individual Employee(s)
              </label>
              <label class="row items-center" style="gap:6px; cursor:pointer;">
                <input type="radio" name="targetMode" value="bulk_ids" id="radio-target-ids"> Multiple Employee IDs
              </label>
            </div>

            <!-- Mode A: Department Selection with Exclusion Checkboxes -->
            <div id="target-dept-wrap">
              <label style="margin-bottom:10px; display:block;">
                <span style="font-weight:600; font-size:13px; margin-bottom:4px; display:block;">Select Department</span>
                <select id="modal-select-dept" style="width:100%; padding:10px 14px; background:var(--surface); color:var(--text); border:1px solid var(--line); border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; outline:none;">
                  <option value="">Loading departments...</option>
                </select>
              </label>

              <!-- Dynamic Department Active Employee Roster Box -->
              <div style="border:1px solid var(--line); border-radius:8px; background:var(--surface); padding:12px;">
                <div class="row between items-center" style="margin-bottom:10px; border-bottom:1px solid var(--line); padding-bottom:8px;">
                  <label class="row items-center" style="gap:8px; cursor:pointer; font-weight:700;">
                    <input type="checkbox" id="dept-select-all" checked style="width:16px; height:16px; accent-color:var(--brand);"> Include All Active Employees of this Department
                  </label>
                  <span class="small font-bold" id="dept-emp-count-badge" style="color:var(--brand);">Loading employees...</span>
                </div>
                <div id="dept-employee-checklist" style="max-height:180px; overflow-y:auto; display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:8px;">
                  <!-- Dynamically populated -->
                </div>
              </div>
            </div>

            <!-- Mode B: Individual Searchable Employee Multi-Select -->
            <div id="target-emp-wrap" style="display:none;">
              <label>
                Search & Add Employees (by Name, ID, Department, or Designation)
                <div class="search-input-wrap">
                  ${icon('search')}
                  <input type="text" id="modal-emp-search" placeholder="Type employee name or ID (e.g. EMP001)...">
                </div>
              </label>

              <!-- Search suggestions -->
              <div id="emp-search-dropdown" style="max-height:140px; overflow-y:auto; border:1px solid var(--line); border-radius:6px; background:var(--surface); margin-top:4px; display:none;">
              </div>

              <!-- Selected Employee Chips -->
              <div style="margin-top:10px;">
                <span class="small muted" style="display:block; margin-bottom:4px;">Selected Employees:</span>
                <div id="selected-emp-chips" class="row wrap" style="gap:6px; min-height:36px; padding:6px; background:var(--surface); border-radius:6px; border:1px solid var(--line);">
                  <span class="small muted" id="chips-placeholder">No employees selected yet. Search above to add.</span>
                </div>
              </div>
            </div>

            <!-- Mode C: Bulk Multiple IDs -->
            <div id="target-ids-wrap" style="display:none;">
              <label>
                Enter Employee Codes / Device PINs (Comma, Space, or Newline separated)
                <textarea id="modal-bulk-ids-text" rows="3" placeholder="EMP001, EMP002, EMP005, EMP012"></textarea>
              </label>
            </div>
          </div>

          <!-- 3. REASON / NOTE -->
          <div>
            <label>
              Reason / Purpose
              <input type="text" id="modal-assign-reason" placeholder="e.g. Weekly off adjustment, Maintenance, Shift swap..." value="Corporate Off Day">
            </label>
          </div>

          <!-- 4. LIVE CONFLICT DETECTION & SUMMARY CARD -->
          <div id="modal-preview-box" style="padding:10px 14px; border-radius:8px; background:var(--line); font-size:12.5px;">
            <div class="row between items-center">
              <span><b>Target:</b> <span id="preview-emp-count">0</span> employee(s) across <span id="preview-date-count">1</span> date(s)</span>
              <button type="button" class="btn small" id="btn-recheck-conflicts">${icon('check')} Check Conflicts</button>
            </div>
            <div id="preview-conflicts-area" style="margin-top:6px; display:none;"></div>
          </div>
        </div>
      `,
      onOpen: (f, close) => {
        // Date Mode Toggle
        $('#radio-date-single', f)?.addEventListener('change', () => {
          dateMode = 'single';
          $('#date-single-wrap', f).style.display = 'flex';
          $('#date-range-wrap', f).style.display = 'none';
          triggerConflictCheck();
        });
        $('#radio-date-range', f)?.addEventListener('change', () => {
          dateMode = 'range';
          $('#date-single-wrap', f).style.display = 'none';
          $('#date-range-wrap', f).style.display = 'flex';
          triggerConflictCheck();
        });

        // Target Mode Toggle
        $('#radio-target-dept', f)?.addEventListener('change', () => {
          targetMode = 'department';
          $('#target-dept-wrap', f).style.display = 'block';
          $('#target-emp-wrap', f).style.display = 'none';
          $('#target-ids-wrap', f).style.display = 'none';
          loadDeptChecklist();
        });
        $('#radio-target-emp', f)?.addEventListener('change', () => {
          targetMode = 'employee';
          $('#target-dept-wrap', f).style.display = 'none';
          $('#target-emp-wrap', f).style.display = 'block';
          $('#target-ids-wrap', f).style.display = 'none';
          triggerConflictCheck();
        });
        $('#radio-target-ids', f)?.addEventListener('change', () => {
          targetMode = 'bulk_ids';
          $('#target-dept-wrap', f).style.display = 'none';
          $('#target-emp-wrap', f).style.display = 'none';
          $('#target-ids-wrap', f).style.display = 'block';
          triggerConflictCheck();
        });

        // Populate Department Select element directly via DOM
        const deptSel = $('#modal-select-dept', f);
        if (deptSel) {
          if (!selectedDepartment && departments[0]) {
            selectedDepartment = departments[0].name;
          }
          deptSel.innerHTML = departments.map((d) => `
            <option value="${esc(d.name)}" ${(d.name || '').toLowerCase() === (selectedDepartment || '').toLowerCase() ? 'selected' : ''}>
              ${esc(d.name)} (${d.employees ?? d.active_emps ?? 0} active employees)
            </option>
          `).join('');
          if (selectedDepartment) {
            deptSel.value = selectedDepartment;
          }

          deptSel.addEventListener('change', (e) => {
            selectedDepartment = e.target.value;
            loadDeptChecklist();
          });
        }

        // Load employees checklist for initial department
        loadDeptChecklist();

        function loadDeptChecklist() {
          const listArea = $('#dept-employee-checklist', f);
          const currentDeptName = (selectedDepartment || deptSel?.value || departments[0]?.name || '').trim();
          selectedDepartment = currentDeptName;

          const deptEmps = allEmployees.filter((u) => 
            (u.department || '').trim().toLowerCase() === currentDeptName.toLowerCase()
          );
          excludedEmployees.clear();

          $('#dept-emp-count-badge', f).textContent = `${deptEmps.length} active employee(s)`;

          if (!deptEmps.length) {
            setHTML(listArea, html`<p class="muted small" style="grid-column: 1 / -1; padding:12px; text-align:center;">No active employees found in ${esc(currentDeptName || 'selected department')}.</p>`);
            triggerConflictCheck();
            return;
          }

          setHTML(listArea, html`
            ${deptEmps.map((u) => html`
              <label class="row items-center" style="gap:8px; font-size:12px; padding:8px 10px; border-radius:6px; background:var(--paper); border:1px solid var(--line); color:var(--text); cursor:pointer;">
                <input type="checkbox" class="dept-emp-cb" data-uid="${u.id}" checked style="width:16px; height:16px; accent-color:var(--brand); cursor:pointer;">
                <span><b style="color:var(--brand);">${esc(u.employee_code || '')}</b> - <b>${esc(u.name)}</b> <span class="small muted">(${esc(u.designation || 'Staff')})</span></span>
              </label>
            `)}
          `);

          // Select all toggle
          const selectAllCb = $('#dept-select-all', f);
          if (selectAllCb) {
            selectAllCb.checked = true;
            selectAllCb.onchange = () => {
              const checked = selectAllCb.checked;
              $$('.dept-emp-cb', listArea).forEach((cb) => {
                cb.checked = checked;
                const uid = Number(cb.getAttribute('data-uid'));
                if (checked) excludedEmployees.delete(uid);
                else excludedEmployees.add(uid);
              });
              triggerConflictCheck();
            };
          }

          // Individual checkbox change
          $$('.dept-emp-cb', listArea).forEach((cb) => {
            cb.onchange = () => {
              const uid = Number(cb.getAttribute('data-uid'));
              if (cb.checked) excludedEmployees.delete(uid);
              else excludedEmployees.add(uid);
              if (selectAllCb) {
                selectAllCb.checked = ($$('.dept-emp-cb:checked', listArea).length === deptEmps.length);
              }
              triggerConflictCheck();
            };
          });

          triggerConflictCheck();
        }

        // Employee Search & Multi-Select Logic
        const empSearchInput = $('#modal-emp-search', f);
        const searchDropdown = $('#emp-search-dropdown', f);

        empSearchInput?.addEventListener('input', () => {
          const q = empSearchInput.value.toLowerCase().trim();
          if (!q) {
            searchDropdown.style.display = 'none';
            return;
          }

          const matches = allEmployees.filter((u) => (
            u.name.toLowerCase().includes(q) ||
            (u.employee_code && u.employee_code.toLowerCase().includes(q)) ||
            (u.department && u.department.toLowerCase().includes(q)) ||
            (u.designation && u.designation.toLowerCase().includes(q))
          )).slice(0, 8);

          if (!matches.length) {
            setHTML(searchDropdown, html`<p class="small muted" style="padding:8px;">No matching employees</p>`);
            searchDropdown.style.display = 'block';
            return;
          }

          setHTML(searchDropdown, html`
            ${matches.map((u) => html`
              <div class="row between items-center search-match-item" data-uid="${u.id}"
                   style="padding:8px 10px; cursor:pointer; border-bottom:1px solid var(--line); font-size:12px;">
                <div>
                  <b>${esc(u.name)}</b> <span class="small muted">(${esc(u.employee_code || '')})</span>
                  <div class="small muted">${esc(u.department || '')} · ${esc(u.designation || '')}</div>
                </div>
                <button type="button" class="btn small">+ Add</button>
              </div>
            `)}
          `);
          searchDropdown.style.display = 'block';

          $$('.search-match-item', searchDropdown).forEach((item) => {
            item.onclick = () => {
              const uid = Number(item.getAttribute('data-uid'));
              selectedEmployees.add(uid);
              empSearchInput.value = '';
              searchDropdown.style.display = 'none';
              renderSelectedChips();
              triggerConflictCheck();
            };
          });
        });

        function renderSelectedChips() {
          const chipsWrap = $('#selected-emp-chips', f);
          if (selectedEmployees.size === 0) {
            chipsWrap.innerHTML = '<span class="small muted" id="chips-placeholder">No employees selected yet. Search above to add.</span>';
            return;
          }

          const chips = Array.from(selectedEmployees).map((uid) => {
            const u = allEmployees.find((e) => e.id === uid);
            return u ? html`
              <span class="badge" style="background:#e0f2fe; color:#0369a1; padding:4px 8px; font-size:11.5px; display:inline-flex; align-items:center; gap:6px;">
                <b>${esc(u.employee_code || '')}</b> ${esc(u.name)}
                <button type="button" class="btn-remove-chip" data-uid="${u.id}" style="border:none; background:none; cursor:pointer; color:#ef4444; font-weight:800; padding:0 2px;">×</button>
              </span>
            ` : '';
          });

          setHTML(chipsWrap, html`${chips}`);

          $$('.btn-remove-chip', chipsWrap).forEach((btn) => {
            btn.onclick = () => {
              const uid = Number(btn.getAttribute('data-uid'));
              selectedEmployees.delete(uid);
              renderSelectedChips();
              triggerConflictCheck();
            };
          });
        }

        // Live conflict detection and preview
        $('#btn-recheck-conflicts', f)?.addEventListener('click', () => triggerConflictCheck());
        $('#input-single-date', f)?.addEventListener('change', () => triggerConflictCheck());
        $('#input-extra-dates', f)?.addEventListener('input', () => triggerConflictCheck());
        $('#input-range-from', f)?.addEventListener('change', () => triggerConflictCheck());
        $('#input-range-to', f)?.addEventListener('change', () => triggerConflictCheck());
        $('#modal-bulk-ids-text', f)?.addEventListener('input', () => triggerConflictCheck());

        async function triggerConflictCheck() {
          const dates = resolveSelectedDates();
          $('#preview-date-count', f).textContent = dates.length;

          const payload = { dates, excludeUserIds: Array.from(excludedEmployees) };

          if (targetMode === 'department') {
            const activeDept = selectedDepartment || deptSel?.value || departments[0]?.name;
            payload.departments = [activeDept].filter(Boolean);
            payload.department = activeDept || null;
          } else if (targetMode === 'employee') {
            payload.userIds = Array.from(selectedEmployees);
          } else if (targetMode === 'bulk_ids') {
            const raw = $('#modal-bulk-ids-text', f).value;
            const codes = raw.split(/[\s,;\n]+/).filter(Boolean).map((s) => s.toLowerCase());
            const matched = allEmployees.filter((u) => codes.includes((u.employee_code || '').toLowerCase()) || codes.includes(String(u.id)));
            payload.userIds = matched.map((u) => u.id);
          }

          if (!dates.length || (!payload.departments?.length && !payload.userIds?.length)) {
            $('#preview-emp-count', f).textContent = '0';
            $('#preview-conflicts-area', f).style.display = 'none';
            return;
          }

          try {
            const preview = await post('/off-days/preview', payload);
            $('#preview-emp-count', f).textContent = preview.affectedEmployeeCount;

            const conflictsArea = $('#preview-conflicts-area', f);
            if (preview.conflicts && preview.conflicts.length > 0) {
              const conflictList = preview.conflicts.slice(0, 5);
              setHTML(conflictsArea, html`
                <div style="background:#fffbeb; border:1px solid #fef08a; padding:8px 10px; border-radius:6px; color:#b45309;">
                  <b>⚠️ Notice: ${preview.conflicts.length} conflict(s) or warnings detected:</b>
                  <ul style="margin:4px 0 0 16px; padding:0; font-size:11.5px;">
                    ${conflictList.map((c) => html`
                      <li>${esc(c.name)} (${esc(c.employeeCode)}): ${esc(c.message)} on ${c.date}</li>
                    `)}
                    ${preview.conflicts.length > 5 ? html`<li>... and ${preview.conflicts.length - 5} more</li>` : ''}
                  </ul>
                  <span class="small" style="display:block; margin-top:4px;">Assigning will safely update/confirm their Off Day for the selected date(s).</span>
                </div>
              `);
              conflictsArea.style.display = 'block';
            } else {
              setHTML(conflictsArea, html`
                <span class="small text-green" style="font-weight:600;">✓ No conflicts detected. Ready to assign!</span>
              `);
              conflictsArea.style.display = 'block';
            }
          } catch (err) {
            console.error('[offDays] Preview check error:', err);
          }
        }

        function resolveSelectedDates() {
          if (dateMode === 'range') {
            const from = $('#input-range-from', f).value;
            const to = $('#input-range-to', f).value;
            if (!from || !to || from > to) return [];
            const result = [];
            let cur = new Date(from);
            const end = new Date(to);
            while (cur <= end) {
              result.push(cur.toISOString().slice(0, 10));
              cur.setDate(cur.getDate() + 1);
            }
            return result;
          }

          const single = $('#input-single-date', f).value;
          const extra = ($('#input-extra-dates', f).value || '').split(/[\s,;]+/).filter(Boolean);
          const allDates = [single, ...extra].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
          return [...new Set(allDates)].sort();
        }
      },
      onSubmit: async (f, close) => {
        const dates = resolveSelectedDates();
        if (!dates.length) throw new Error('Please select at least one valid date');

        const reason = $('#modal-assign-reason', f).value.trim() || 'Off Day';
        const payload = {
          dates,
          reason,
          assignmentType: targetMode === 'department' ? 'department' : (targetMode === 'bulk_ids' ? 'bulk' : 'individual'),
          excludeUserIds: Array.from(excludedEmployees),
        };

        if (targetMode === 'department') {
          const finalDept = selectedDepartment || $('#modal-select-dept', f)?.value || departments[0]?.name;
          if (!finalDept) throw new Error('Please select a department');
          payload.departments = [finalDept];
          payload.department = finalDept;
        } else if (targetMode === 'employee') {
          if (selectedEmployees.size === 0) throw new Error('Please select at least one employee');
          payload.userIds = Array.from(selectedEmployees);
        } else if (targetMode === 'bulk_ids') {
          const raw = $('#modal-bulk-ids-text', f).value;
          const codes = raw.split(/[\s,;\n]+/).filter(Boolean).map((s) => s.toLowerCase());
          const matched = allEmployees.filter((u) => codes.includes((u.employee_code || '').toLowerCase()) || codes.includes(String(u.id)));
          if (!matched.length) throw new Error('No valid employee codes matched');
          payload.userIds = matched.map((u) => u.id);
        }

        const res = await post('/off-days', payload);
        toast(`Successfully assigned ${res.assignedCount} off day(s) across ${res.affectedEmployees} staff!`, 'good');
        close();
        loadStats();
        refreshView();
      },
    });

    function resolveSelectedDates() {
      const mode = document.querySelector('input[name="dateMode"]:checked')?.value || 'single';
      if (mode === 'range') {
        const from = $('#input-range-from')?.value;
        const to = $('#input-range-to')?.value;
        if (!from || !to || from > to) return [];
        const result = [];
        let cur = new Date(from);
        const end = new Date(to);
        while (cur <= end) {
          result.push(cur.toISOString().slice(0, 10));
          cur.setDate(cur.getDate() + 1);
        }
        return result;
      }
      const single = $('#input-single-date')?.value;
      const extra = ($('#input-extra-dates')?.value || '').split(/[\s,;]+/).filter(Boolean);
      return [...new Set([single, ...extra].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
    }
  }

        // Employee Search & Multi-Select Logic
        const empSearchInput = $('#modal-emp-search', f);
        const searchDropdown = $('#emp-search-dropdown', f);

        empSearchInput?.addEventListener('input', () => {
          const q = empSearchInput.value.toLowerCase().trim();
          if (!q) {
            searchDropdown.style.display = 'none';
            return;
          }

          const matches = allEmployees.filter((u) => (
            u.name.toLowerCase().includes(q) ||
            (u.employee_code && u.employee_code.toLowerCase().includes(q)) ||
            (u.department && u.department.toLowerCase().includes(q)) ||
            (u.designation && u.designation.toLowerCase().includes(q))
          )).slice(0, 8);

          if (!matches.length) {
            setHTML(searchDropdown, html`<p class="small muted" style="padding:8px;">No matching employees</p>`);
            searchDropdown.style.display = 'block';
            return;
          }

          setHTML(searchDropdown, html`
            ${matches.map((u) => html`
              <div class="row between items-center search-match-item" data-uid="${u.id}"
                   style="padding:8px 10px; cursor:pointer; border-bottom:1px solid var(--line); font-size:12px;">
                <div>
                  <b>${esc(u.name)}</b> <span class="small muted">(${esc(u.employee_code || '')})</span>
                  <div class="small muted">${esc(u.department || '')} · ${esc(u.designation || '')}</div>
                </div>
                <button type="button" class="btn small">+ Add</button>
              </div>
            `)}
          `);
          searchDropdown.style.display = 'block';

          $$('.search-match-item', searchDropdown).forEach((item) => {
            item.onclick = () => {
              const uid = Number(item.getAttribute('data-uid'));
              selectedEmployees.add(uid);
              empSearchInput.value = '';
              searchDropdown.style.display = 'none';
              renderSelectedChips();
              triggerConflictCheck();
            };
          });
        });

        function renderSelectedChips() {
          const chipsWrap = $('#selected-emp-chips', f);
          if (selectedEmployees.size === 0) {
            chipsWrap.innerHTML = '<span class="small muted" id="chips-placeholder">No employees selected yet. Search above to add.</span>';
            return;
          }

          const chips = Array.from(selectedEmployees).map((uid) => {
            const u = allEmployees.find((e) => e.id === uid);
            return u ? html`
              <span class="badge" style="background:#e0f2fe; color:#0369a1; padding:4px 8px; font-size:11.5px; display:inline-flex; align-items:center; gap:6px;">
                <b>${esc(u.employee_code || '')}</b> ${esc(u.name)}
                <button type="button" class="btn-remove-chip" data-uid="${u.id}" style="border:none; background:none; cursor:pointer; color:#ef4444; font-weight:800; padding:0 2px;">×</button>
              </span>
            ` : '';
          });

          setHTML(chipsWrap, html`${chips}`);

          $$('.btn-remove-chip', chipsWrap).forEach((btn) => {
            btn.onclick = () => {
              const uid = Number(btn.getAttribute('data-uid'));
              selectedEmployees.delete(uid);
              renderSelectedChips();
              triggerConflictCheck();
            };
          });
        }

        // Live conflict detection and preview
        $('#btn-recheck-conflicts', f)?.addEventListener('click', () => triggerConflictCheck());
        $('#input-single-date', f)?.addEventListener('change', () => triggerConflictCheck());
        $('#input-extra-dates', f)?.addEventListener('input', () => triggerConflictCheck());
        $('#input-range-from', f)?.addEventListener('change', () => triggerConflictCheck());
        $('#input-range-to', f)?.addEventListener('change', () => triggerConflictCheck());
        $('#modal-bulk-ids-text', f)?.addEventListener('input', () => triggerConflictCheck());

        async function triggerConflictCheck() {
          const dates = resolveSelectedDates();
          $('#preview-date-count', f).textContent = dates.length;

          const payload = { dates, excludeUserIds: Array.from(excludedEmployees) };

          if (targetMode === 'department') {
            payload.departments = [selectedDepartment];
          } else if (targetMode === 'employee') {
            payload.userIds = Array.from(selectedEmployees);
          } else if (targetMode === 'bulk_ids') {
            const raw = $('#modal-bulk-ids-text', f).value;
            const codes = raw.split(/[\s,;\n]+/).filter(Boolean).map((s) => s.toLowerCase());
            const matched = allEmployees.filter((u) => codes.includes((u.employee_code || '').toLowerCase()) || codes.includes(String(u.id)));
            payload.userIds = matched.map((u) => u.id);
          }

          if (!dates.length || (!payload.departments?.length && !payload.userIds?.length)) {
            $('#preview-emp-count', f).textContent = '0';
            $('#preview-conflicts-area', f).style.display = 'none';
            return;
          }

          try {
            const preview = await post('/off-days/preview', payload);
            $('#preview-emp-count', f).textContent = preview.affectedEmployeeCount;

            const conflictsArea = $('#preview-conflicts-area', f);
            if (preview.conflicts && preview.conflicts.length > 0) {
              const conflictList = preview.conflicts.slice(0, 5);
              setHTML(conflictsArea, html`
                <div style="background:#fffbeb; border:1px solid #fef08a; padding:8px 10px; border-radius:6px; color:#b45309;">
                  <b>⚠️ Notice: ${preview.conflicts.length} conflict(s) or warnings detected:</b>
                  <ul style="margin:4px 0 0 16px; padding:0; font-size:11.5px;">
                    ${conflictList.map((c) => html`
                      <li>${esc(c.name)} (${esc(c.employeeCode)}): ${esc(c.message)} on ${c.date}</li>
                    `)}
                    ${preview.conflicts.length > 5 ? html`<li>... and ${preview.conflicts.length - 5} more</li>` : ''}
                  </ul>
                  <span class="small" style="display:block; margin-top:4px;">Assigning will safely update/confirm their Off Day for the selected date(s).</span>
                </div>
              `);
              conflictsArea.style.display = 'block';
            } else {
              setHTML(conflictsArea, html`
                <span class="small text-green" style="font-weight:600;">✓ No conflicts detected. Ready to assign!</span>
              `);
              conflictsArea.style.display = 'block';
            }
          } catch (err) {
            console.error('[offDays] Preview check error:', err);
          }
        }

        function resolveSelectedDates() {
          if (dateMode === 'range') {
            const from = $('#input-range-from', f).value;
            const to = $('#input-range-to', f).value;
            if (!from || !to || from > to) return [];
            const result = [];
            let cur = new Date(from);
            const end = new Date(to);
            while (cur <= end) {
              result.push(cur.toISOString().slice(0, 10));
              cur.setDate(cur.getDate() + 1);
            }
            return result;
          }

          const single = $('#input-single-date', f).value;
          const extra = ($('#input-extra-dates', f).value || '').split(/[\s,;]+/).filter(Boolean);
          const allDates = [single, ...extra].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
          return [...new Set(allDates)].sort();
        }
      },
      onSubmit: async (f, close) => {
        const dates = resolveSelectedDates();
        if (!dates.length) throw new Error('Please select at least one valid date');

        const reason = $('#modal-assign-reason', f).value.trim() || 'Off Day';
        const payload = {
          dates,
          reason,
          assignmentType: targetMode === 'department' ? 'department' : (targetMode === 'bulk_ids' ? 'bulk' : 'individual'),
          excludeUserIds: Array.from(excludedEmployees),
        };

        if (targetMode === 'department') {
          payload.departments = [selectedDepartment];
          payload.department = selectedDepartment;
        } else if (targetMode === 'employee') {
          if (selectedEmployees.size === 0) throw new Error('Please select at least one employee');
          payload.userIds = Array.from(selectedEmployees);
        } else if (targetMode === 'bulk_ids') {
          const raw = $('#modal-bulk-ids-text', f).value;
          const codes = raw.split(/[\s,;\n]+/).filter(Boolean).map((s) => s.toLowerCase());
          const matched = allEmployees.filter((u) => codes.includes((u.employee_code || '').toLowerCase()) || codes.includes(String(u.id)));
          if (!matched.length) throw new Error('No valid employee codes matched');
          payload.userIds = matched.map((u) => u.id);
        }

        const res = await post('/off-days', payload);
        toast(`Successfully assigned ${res.assignedCount} off day(s) across ${res.affectedEmployees} staff!`, 'good');
        close();
        loadStats();
        refreshView();
      },
    });

    function resolveSelectedDates() {
      const mode = document.querySelector('input[name="dateMode"]:checked')?.value || 'single';
      if (mode === 'range') {
        const from = $('#input-range-from')?.value;
        const to = $('#input-range-to')?.value;
        if (!from || !to || from > to) return [];
        const result = [];
        let cur = new Date(from);
        const end = new Date(to);
        while (cur <= end) {
          result.push(cur.toISOString().slice(0, 10));
          cur.setDate(cur.getDate() + 1);
        }
        return result;
      }
      const single = $('#input-single-date')?.value;
      const extra = ($('#input-extra-dates')?.value || '').split(/[\s,;]+/).filter(Boolean);
      return [...new Set([single, ...extra].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
    }
  }

  /* =========================================================================
   * 5. BULK IMPORT MODAL (Excel / CSV)
   * ========================================================================= */
  function openImportModal() {
    modal({
      title: 'Bulk Import Off Days (CSV / Spreadsheet)',
      wide: true,
      submitLabel: 'Upload & Import',
      body: html`
        <div class="stack" style="gap:14px;">
          <p class="muted small" style="margin:0;">
            Import off day assignments directly from CSV or copy-paste from Excel. Format: <code>EmployeeCode, Date (YYYY-MM-DD), Reason</code>.
          </p>

          <div class="row between items-center">
            <span class="small font-bold">Paste CSV Rows:</span>
            <button type="button" class="btn small" id="btn-load-sample-csv">Load Sample Data</button>
          </div>

          <textarea id="import-csv-textarea" rows="8" placeholder="EMP001, 2026-11-25, Alternative off day&#10;EMP002, 2026-11-25, Shift swap&#10;EMP003, 2026-11-26, Department off"></textarea>

          <div id="import-preview-box" style="display:none; padding:10px; background:var(--line); border-radius:6px;">
            <b class="small" id="import-parsed-count">0 valid rows parsed</b>
          </div>
        </div>
      `,
      onOpen: (f) => {
        $('#btn-load-sample-csv', f)?.addEventListener('click', () => {
          const sample = (allEmployees.slice(0, 4) || []).map((u, i) => `${u.employee_code}, 2026-11-${25 + i}, Roster off day`).join('\n');
          $('#import-csv-textarea', f).value = sample || 'EMP001, 2026-11-25, Weekly off adjustment\nEMP002, 2026-11-25, Shift swap';
        });
      },
      onSubmit: async (f, close) => {
        const text = $('#import-csv-textarea', f).value.trim();
        if (!text) throw new Error('Please enter CSV data');

        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const records = [];

        for (const line of lines) {
          const parts = line.split(',').map((p) => p.trim());
          if (parts.length >= 2) {
            const employeeCode = parts[0];
            const date = parts[1];
            const reason = parts[2] || 'Imported via CSV';
            if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
              records.push({ employeeCode, date, reason });
            }
          }
        }

        if (!records.length) throw new Error('No valid records recognized. Check format: EmployeeCode, YYYY-MM-DD, Reason');

        const res = await post('/off-days/import', { records });
        toast(`Imported ${res.importedCount} off day assignment(s)!${res.skippedCount ? ` (${res.skippedCount} skipped)` : ''}`, 'good');
        close();
        loadStats();
        refreshView();
      },
    });
  }

  return cleanup;
}
