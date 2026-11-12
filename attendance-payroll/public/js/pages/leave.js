// Digital Leave Application & Multi-Tier Approval System
import { get, post, put, del, qs } from '../api.js';
import { html, setHTML, $, $$, fmtDateLong, fmtDate, badge, toast, modal, formValues, confirmDialog, icon } from '../ui.js';
import { canEdit, canView } from '../permissions.js';

export async function render(view, state) {
  const isMgr = ['admin', 'company_admin', 'super_admin', 'hr_manager', 'hr_executive', 'hr', 'dept_manager'].includes(state.user.role) || canView(state.user, 'leave');
  const canManageLeave = canEdit(state.user, 'leave') || ['admin', 'company_admin', 'super_admin', 'hr_manager', 'hr'].includes(state.user.role);
  const isAdminHead = ['admin', 'company_admin', 'super_admin', 'hr_manager'].includes(state.user.role);
  const isDeptHead = ['dept_manager', 'hr_manager', 'admin', 'company_admin', 'super_admin'].includes(state.user.role);

  let activeTab = 'requests'; // 'requests' | 'apply' | 'dashboard' | 'balances' | 'types'
  let users = [];
  let leaveTypes = [];

  const loadBaseData = async () => {
    try {
      const [uRes, tRes] = await Promise.all([
        get('/users?active=true').catch(() => ({ users: [] })),
        get('/leave/types').catch(() => get('/org/leave-types').then((r) => ({ types: r.leaveTypes }))),
      ]);
      users = uRes.users || [];
      leaveTypes = (tRes.types || []).filter((t) => t.active);
    } catch { /* ignore */ }
  };

  await loadBaseData();

  const frame = async () => {
    let pendingCount = 0;
    let recommendedCount = 0;
    try {
      const { requests = [] } = await get('/leave/requests?scope=all');
      pendingCount = requests.filter((r) => r.status === 'pending').length;
      recommendedCount = requests.filter((r) => r.status === 'recommended').length;
    } catch { /* ignore */ }

    setHTML(view, html`
      <div class="stack" style="gap:16px;">
        <!-- Top Header Banner -->
        <div class="panel" style="background:linear-gradient(135deg, #0F2942 0%, #1E3A8A 100%); color:#ffffff; padding:18px 24px; border-radius:12px; box-shadow:0 4px 12px rgba(15,41,66,0.15);">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:14px;">
            <div>
              <div style="display:flex; align-items:center; gap:8px;">
                <span style="font-size:22px;">🏢</span>
                <h1 style="font-size:19px; font-weight:700; margin:0; letter-spacing:0.3px; color:#ffffff;">Jeans Manufacturing Company Ltd.</h1>
              </div>
              <p style="margin:4px 0 0 30px; font-size:13px; color:#93C5FD;">Digital Leave Application &amp; Multi-Tier Approval System</p>
            </div>
            <div class="row" style="gap:10px;">
              <button id="btnNewApplicationHeader" class="btn" style="background:#ffffff; color:#0F2942; font-weight:700; border:none; padding:8px 16px; border-radius:8px; display:inline-flex; align-items:center; gap:6px; box-shadow:0 2px 6px rgba(0,0,0,0.1);">
                <span>📝</span> <span>New Leave Application</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Navigation Tabs -->
        <div class="tabs" role="tablist" style="margin-bottom:0;">
          <button role="tab" data-tab="requests" aria-selected="${activeTab === 'requests'}">
            📋 Leave Applications
            ${pendingCount > 0 ? html`<span class="badge" style="background:#ef4444; color:#fff; border-radius:10px; padding:1px 7px; font-size:11px; margin-left:6px;" title="${pendingCount} Pending Recommendation">${pendingCount}</span>` : ''}
            ${recommendedCount > 0 ? html`<span class="badge" style="background:#3b82f6; color:#fff; border-radius:10px; padding:1px 7px; font-size:11px; margin-left:4px;" title="${recommendedCount} Recommended - Waiting Final Approval">${recommendedCount}</span>` : ''}
          </button>
          <button role="tab" data-tab="apply" aria-selected="${activeTab === 'apply'}">
            ✍️ Application Form
          </button>
          <button role="tab" data-tab="dashboard" aria-selected="${activeTab === 'dashboard'}">
            📊 Leave Dashboard
          </button>
          <button role="tab" data-tab="balances" aria-selected="${activeTab === 'balances'}">
            👥 Employee Balances (CL / SL / EL)
          </button>
          ${canManageLeave ? html`
            <button role="tab" data-tab="types" aria-selected="${activeTab === 'types'}">
              ⚙️ Leave Types Setup
            </button>
          ` : ''}
        </div>

        <div id="leaveMainContainer"></div>
      </div>
    `);

    // Tab bindings
    $$('[data-tab]', view).forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        frame();
      });
    });

    const headerBtn = $('#btnNewApplicationHeader');
    if (headerBtn) {
      headerBtn.addEventListener('click', () => {
        activeTab = 'apply';
        frame();
      });
    }

    if (activeTab === 'requests') await renderApplicationsList();
    else if (activeTab === 'apply') await renderApplicationForm();
    else if (activeTab === 'dashboard') await renderDashboard();
    else if (activeTab === 'balances') await renderBalances();
    else if (activeTab === 'types') await renderLeaveTypes();
  };

  /* =========================================================================
   * 1. LEAVE APPLICATIONS LIST & APPROVAL WORKFLOW TABLE
   * ========================================================================= */
  const renderApplicationsList = async () => {
    const container = $('#leaveMainContainer');
    const filter = { status: '', userId: '', department: '', search: '' };

    setHTML(container, html`
      <div class="stack" style="gap:14px;">
        <!-- Filters Bar -->
        <div class="panel">
          <div class="body" style="padding:14px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
              <div class="row" style="gap:12px; align-items:center; flex-wrap:wrap;">
                <input type="text" id="appSearchInput" placeholder="Search employee or ID..." style="width:200px; padding:7px 12px; border-radius:6px; border:1px solid #cbd5e1; font-size:13px;">
                <label style="display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600;">
                  Status:
                  <select id="appStatusFilter" style="padding:6px 10px; border-radius:6px; border:1px solid #cbd5e1;">
                    <option value="">All Statuses</option>
                    <option value="pending">Pending (Dept Head)</option>
                    <option value="recommended">Recommended (Admin Head)</option>
                    <option value="approved">Approved</option>
                    <option value="rejected">Rejected</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </label>
                <label style="display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600;">
                  Department:
                  <select id="appDeptFilter" style="padding:6px 10px; border-radius:6px; border:1px solid #cbd5e1;">
                    <option value="">All Departments</option>
                    ${[...new Set(users.map((u) => u.department).filter(Boolean))].sort().map((d) => html`<option value="${d}">${d}</option>`)}
                  </select>
                </label>
              </div>
              <button class="btn primary" id="btnApplyNewInList" style="display:inline-flex; align-items:center; gap:6px;">
                <span>+</span> <span>New Application</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Applications Table Section -->
        <section class="panel">
          <div class="body flush table-wrap" id="applicationsTableBody">
            <p class="muted" style="padding:20px;">Loading leave applications...</p>
          </div>
        </section>
      </div>
    `);

    $('#btnApplyNewInList').addEventListener('click', () => { activeTab = 'apply'; frame(); });
    $('#appSearchInput').addEventListener('input', (e) => { filter.search = e.target.value.toLowerCase().trim(); loadTable(); });
    $('#appStatusFilter').addEventListener('change', (e) => { filter.status = e.target.value; loadTable(); });
    $('#appDeptFilter').addEventListener('change', (e) => { filter.department = e.target.value; loadTable(); });

    const loadTable = async () => {
      let q = '/leave/requests?scope=all';
      if (filter.status) q += `&status=${encodeURIComponent(filter.status)}`;
      if (filter.department) q += `&department=${encodeURIComponent(filter.department)}`;

      const { requests = [] } = await get(q);
      const filtered = requests.filter((r) => {
        if (!filter.search) return true;
        const name = (r.name || '').toLowerCase();
        const code = (r.employee_code || '').toLowerCase();
        const reason = (r.reason || '').toLowerCase();
        return name.includes(filter.search) || code.includes(filter.search) || reason.includes(filter.search);
      });

      const tbody = $('#applicationsTableBody');
      if (!filtered.length) {
        setHTML(tbody, html`<p class="empty" style="padding:32px 16px;">No leave applications found matching your criteria.</p>`);
        return;
      }

      setHTML(tbody, html`
        <table>
          <thead>
            <tr>
              <th style="min-width:110px;">Ref / Date</th>
              <th style="min-width:180px;">Employee Information</th>
              <th style="min-width:140px;">Leave Particulars</th>
              <th style="min-width:150px;">Dates &amp; Duration</th>
              <th style="min-width:120px;">Reason &amp; Contact</th>
              <th style="min-width:170px;">Workflow Status</th>
              <th class="r" style="min-width:190px;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map((r) => {
              const statusBadge = r.status === 'approved'
                ? html`<span class="badge" style="background:#dcfce7; color:#15803d; border:1px solid #86efac; font-weight:700;">✓ Approved</span>`
                : r.status === 'recommended'
                ? html`<span class="badge" style="background:#e0f2fe; color:#0369a1; border:1px solid #7dd3fc; font-weight:700;">★ Recommended</span>`
                : r.status === 'rejected'
                ? html`<span class="badge" style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; font-weight:700;">✕ Rejected</span>`
                : r.status === 'cancelled'
                ? html`<span class="badge" style="background:#f1f5f9; color:#64748b; font-weight:600;">Cancelled</span>`
                : html`<span class="badge" style="background:#fef3c7; color:#b45309; border:1px solid #fde68a; font-weight:700;">⏳ Pending</span>`;

              return html`
                <tr data-row-id="${r.id}">
                  <td>
                    <b style="color:#0F2942; font-size:12.5px;">#LA-${String(r.id).padStart(5, '0')}</b>
                    <div class="small muted" style="margin-top:2px;">${fmtDate(r.applied_at || r.created_at)}</div>
                  </td>
                  <td class="nameCell">
                    <b>${r.name}</b>
                    <span class="small muted">${r.employee_code || `EMP-${r.user_id}`} • ${r.designation || 'Staff'}</span>
                    <span class="small" style="color:#0284c7; font-weight:600;">${r.department || 'General'}</span>
                  </td>
                  <td>
                    <b style="color:#1e3a8a;">${r.type}</b>
                    <div class="small muted">${r.paid ? 'Paid Leave' : 'Unpaid'} • ${r.half_day ? 'Half Day' : 'Full Day'}</div>
                  </td>
                  <td>
                    <div style="font-weight:600;">${fmtDateLong(r.start_date)}</div>
                    ${r.start_date !== r.end_date ? html`<div class="small muted">→ ${fmtDateLong(r.end_date)}</div>` : ''}
                    <div style="font-weight:700; color:#15803d; margin-top:2px;">${r.days} Working Day${r.days === 1 ? '' : 's'}</div>
                  </td>
                  <td class="wrap small" style="max-width:200px;">
                    <div style="font-weight:600; color:#334155;">${r.reason || 'Personal / Urgent'}</div>
                    ${r.contact_number ? html`<div class="muted" style="margin-top:2px;">📞 ${r.contact_number}</div>` : ''}
                  </td>
                  <td>
                    <div>${statusBadge}</div>
                    <div class="small muted" style="margin-top:4px; font-size:11px;">
                      ${r.status === 'pending' ? html`<span>Awaiting Dept Head</span>` : ''}
                      ${r.status === 'recommended' ? html`<span style="color:#0369a1; font-weight:600;">Rec. by ${r.dept_head_name || 'Dept Head'}</span>` : ''}
                      ${r.status === 'approved' ? html`<span style="color:#15803d; font-weight:600;">Appr. by ${r.admin_head_name || 'Admin Head'}</span>` : ''}
                      ${r.status === 'rejected' ? html`<span style="color:#b91c1c;">Rejected: ${r.admin_head_remarks || r.dept_head_remarks || r.review_note || 'Policy'}</span>` : ''}
                    </div>
                  </td>
                  <td class="r">
                    <span class="row" style="justify-content:flex-end; gap:6px; flex-wrap:nowrap;">
                      <!-- Print / Download PDF -->
                      <a href="/api/leave/requests/${r.id}/pdf" target="_blank" download="Leave_Application_${r.id}.pdf" class="btn sm" style="background:#f0f9ff; color:#0369a1; border:1px solid #bae6fd; font-weight:600;" title="Download Official A4 Printable PDF">
                        📄 PDF
                      </a>

                      <!-- View Details Modal -->
                      <button class="btn sm" data-action="view" data-id="${r.id}" title="View Application &amp; Signatures">
                        👁️
                      </button>

                      <!-- Stage 1: Dept Head Recommendation -->
                      ${(isDeptHead || canManageLeave) && r.status === 'pending' ? html`
                        <button class="btn sm" style="background:#e0f2fe; color:#0369a1; border-color:#7dd3fc; font-weight:700;" data-action="recommend" data-id="${r.id}" title="Recommend Application">
                          ★ Rec.
                        </button>
                      ` : ''}

                      <!-- Stage 2: Admin Head Final Approval -->
                      ${(isAdminHead || canManageLeave) && (r.status === 'recommended' || r.status === 'pending') ? html`
                        <button class="btn sm primary" data-action="approve" data-id="${r.id}" title="Grant Final Approval">
                          ✓ Approve
                        </button>
                        <button class="btn sm danger" data-action="reject" data-id="${r.id}" title="Reject Application">
                          ✕
                        </button>
                      ` : ''}

                      <!-- Admin Edit / Delete -->
                      ${canManageLeave ? html`
                        <button class="btn sm" data-action="edit" data-id="${r.id}" title="Edit Application">${icon('edit')}</button>
                        <button class="btn sm danger" data-action="delete" data-id="${r.id}" title="Delete Record">${icon('trash')}</button>
                      ` : ''}
                    </span>
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      `);

      // Bind Row Actions
      $$('[data-action="view"]', tbody).forEach((b) => {
        b.addEventListener('click', () => openApplicationDetailsModal(filtered.find((x) => String(x.id) === b.dataset.id)));
      });
      $$('[data-action="recommend"]', tbody).forEach((b) => {
        b.addEventListener('click', () => openRecommendModal(filtered.find((x) => String(x.id) === b.dataset.id)));
      });
      $$('[data-action="approve"]', tbody).forEach((b) => {
        b.addEventListener('click', () => openFinalApproveModal(filtered.find((x) => String(x.id) === b.dataset.id), 'approved'));
      });
      $$('[data-action="reject"]', tbody).forEach((b) => {
        b.addEventListener('click', () => openFinalApproveModal(filtered.find((x) => String(x.id) === b.dataset.id), 'rejected'));
      });
      $$('[data-action="edit"]', tbody).forEach((b) => {
        b.addEventListener('click', () => openEditModal(filtered.find((x) => String(x.id) === b.dataset.id)));
      });
      $$('[data-action="delete"]', tbody).forEach((b) => {
        b.addEventListener('click', () => deleteApplication(filtered.find((x) => String(x.id) === b.dataset.id)));
      });
    };

    await loadTable();
  };

  /* =========================================================================
   * 2. DIGITAL LEAVE APPLICATION FORM
   * ========================================================================= */
  const renderApplicationForm = async () => {
    const container = $('#leaveMainContainer');
    let selectedEmp = users.find((u) => u.id === state.user.id) || users[0] || null;
    let selectedType = leaveTypes[0] || null;
    let empBalances = [];

    const loadEmpBalances = async (uid) => {
      try {
        const res = await get(`/leave/balances?userId=${uid}&year=${new Date().getFullYear()}`);
        empBalances = res.balances || [];
      } catch {
        empBalances = [];
      }
    };

    if (selectedEmp) await loadEmpBalances(selectedEmp.id);

    setHTML(container, html`
      <div class="panel" style="max-width:960px; margin:0 auto; box-shadow:0 4px 16px rgba(0,0,0,0.06); border-radius:12px;">
        <header style="background:#f8fafc; border-bottom:1px solid #e2e8f0; padding:16px 24px; border-radius:12px 12px 0 0;">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
            <div>
              <h2 style="margin:0; font-size:17px; color:#0F2942; font-weight:700;">Employee Leave Application Form</h2>
              <p class="muted small" style="margin:2px 0 0;">Fill in the particulars to submit an official leave request for approval.</p>
            </div>
            <span class="badge" style="background:#e0f2fe; color:#0369a1; font-weight:600; padding:4px 10px;">Company Standard Form</span>
          </div>
        </header>

        <div class="body" style="padding:24px;">
          <form id="digitalLeaveForm" class="stack" style="gap:22px;">
            
            <!-- SECTION 1: EMPLOYEE SELECTION & DETAILS CARD -->
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:16px;">
              <div style="font-size:14px; font-weight:700; color:#0F2942; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
                <span>👤</span> <span>1. Employee Information</span>
              </div>

              <div class="form-grid" style="display:grid; grid-template-columns:1fr; gap:14px; margin-bottom:14px;">
                <label>Select Employee <span style="color:#ef4444">*</span>
                  <select id="formEmpSelect" style="width:100%; padding:9px 12px; border-radius:6px; border:1px solid #cbd5e1; font-size:13.5px; font-weight:600;">
                    ${users.map((u) => html`
                      <option value="${u.id}" ${selectedEmp && selectedEmp.id === u.id ? 'selected' : ''}>
                        ${u.name} — ${u.department || 'General'} (${u.employee_code || `EMP-${u.id}`})
                      </option>
                    `)}
                  </select>
                </label>
              </div>

              <!-- Dynamic Employee Details Preview Grid -->
              <div id="empCardDetails" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:14px;">
                <!-- Populated dynamically -->
              </div>
            </div>

            <!-- SECTION 2: LEAVE APPLICATION PARTICULARS -->
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:16px;">
              <div style="font-size:14px; font-weight:700; color:#0F2942; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
                <span>📅</span> <span>2. Leave Particulars &amp; Duration</span>
              </div>

              <!-- Leave Type Buttons -->
              <label style="margin-bottom:14px; display:block;">Select Leave Type <span style="color:#ef4444">*</span>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; margin-top:6px;" id="leaveTypeRadioGroup">
                  ${leaveTypes.map((t, idx) => html`
                    <label style="display:flex; align-items:center; gap:8px; padding:10px 14px; border:2px solid ${idx === 0 ? '#1E3A8A' : '#cbd5e1'}; background:${idx === 0 ? '#eff6ff' : '#fff'}; border-radius:8px; cursor:pointer; font-weight:600; font-size:13px;" class="leave-type-card" data-tid="${t.id}">
                      <input type="radio" name="leaveTypeId" value="${t.id}" ${idx === 0 ? 'checked' : ''} style="margin:0;">
                      <div>
                        <div>${t.name}</div>
                        <div class="small muted" style="font-weight:normal; font-size:11px;">
                          ${t.annual_quota !== null ? `Quota: ${t.annual_quota} days / yr` : 'Unpaid Leave'}
                        </div>
                      </div>
                    </label>
                  `)}
                </div>
              </label>

              <div class="form-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:14px;">
                <label>From Date (Start) <span style="color:#ef4444">*</span>
                  <input type="date" id="formStartDate" name="startDate" required value="${state.meta.today}" style="width:100%; padding:8px 12px; border-radius:6px; border:1px solid #cbd5e1;">
                </label>
                <label>To Date (End) <span style="color:#ef4444">*</span>
                  <input type="date" id="formEndDate" name="endDate" required value="${state.meta.today}" style="width:100%; padding:8px 12px; border-radius:6px; border:1px solid #cbd5e1;">
                </label>
              </div>

              <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:12px 16px; margin-bottom:14px;">
                <label class="check" style="display:flex; align-items:center; gap:8px; font-weight:600; cursor:pointer;">
                  <input type="checkbox" id="formHalfDay" name="halfDay"> <span>Half Day Leave (0.5 working day)</span>
                </label>
                <div id="liveDayCalculation" style="font-size:14px; font-weight:700; color:#15803D;">
                  Total Calculated: 1 Working Day
                </div>
              </div>

              <label style="margin-bottom:14px; display:block;">Detailed Reason for Leave <span style="color:#ef4444">*</span>
                <textarea name="reason" id="formReason" required maxlength="1000" rows="3" placeholder="Provide complete and clear explanation for the leave request..." style="width:100%; padding:10px; border-radius:6px; border:1px solid #cbd5e1; font-size:13px;"></textarea>
              </label>

              <div class="form-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
                <label>Address During Leave Period
                  <input type="text" name="addressDuringLeave" placeholder="e.g. Village home / Current address" style="width:100%; padding:8px 12px; border-radius:6px; border:1px solid #cbd5e1;">
                </label>
                <label>Emergency Contact Number
                  <input type="text" name="contactNumber" id="formContactNumber" placeholder="e.g. +8801700000000" style="width:100%; padding:8px 12px; border-radius:6px; border:1px solid #cbd5e1;">
                </label>
              </div>
            </div>

            <!-- SECTION 3: SIGNATURE & SUBMISSION -->
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:16px;">
              <div style="font-size:14px; font-weight:700; color:#0F2942; margin-bottom:12px; display:flex; align-items:center; gap:8px;">
                <span>✍️</span> <span>3. Applicant Digital Signature &amp; Acknowledgement</span>
              </div>

              <div style="background:#ffffff; border:1px solid #cbd5e1; border-radius:8px; padding:14px; margin-bottom:14px;">
                <label class="check" style="display:flex; align-items:flex-start; gap:8px; cursor:pointer;">
                  <input type="checkbox" id="formSignConfirm" required checked style="margin-top:3px;">
                  <span style="font-size:12.5px; color:#334155;">
                    I hereby declare that the particulars provided above are authentic and accurate. I understand that taking leave without prior authorization is considered misconduct under company regulations.
                  </span>
                </label>
                <div style="margin-top:10px; padding-top:10px; border-top:1px dashed #e2e8f0; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                  <div style="font-size:12px; color:#64748b;">
                    Digital Signature: <b id="signatureText" style="color:#0F2942;">${selectedEmp?.name || state.user.name}</b>
                  </div>
                  <div style="font-size:12px; color:#64748b;">
                    Submission Date: <b>${state.meta.today}</b>
                  </div>
                </div>
              </div>

              <div style="display:flex; justify-content:flex-end; gap:12px; align-items:center;">
                <button type="reset" class="btn">Clear Form</button>
                <button type="submit" class="btn primary" style="padding:10px 24px; font-size:14px; font-weight:700; display:inline-flex; align-items:center; gap:8px;">
                  <span>✓</span> <span>Submit Leave Application</span>
                </button>
              </div>
            </div>

          </form>
        </div>
      </div>
    `);

    const updateEmpPreview = () => {
      const u = selectedEmp;
      if (!u) return;

      const card = $('#empCardDetails');
      setHTML(card, html`
        <div>
          <div class="small muted">Employee ID</div>
          <b style="color:#0F2942; font-size:13.5px;">${u.employee_code || `EMP-${u.id}`}</b>
        </div>
        <div>
          <div class="small muted">Full Name</div>
          <b style="color:#0F2942; font-size:13.5px;">${u.name}</b>
        </div>
        <div>
          <div class="small muted">Department</div>
          <b style="color:#0284c7; font-size:13.5px;">${u.department || 'General'}</b>
        </div>
        <div>
          <div class="small muted">Designation</div>
          <b style="color:#0F2942; font-size:13.5px;">${u.designation || 'Staff'}</b>
        </div>
        <div>
          <div class="small muted">Joining Date</div>
          <b style="color:#0F2942; font-size:13.5px;">${fmtDateLong(u.join_date)}</b>
        </div>
        <div style="grid-column: 1 / -1; margin-top:4px; padding-top:8px; border-top:1px solid #f1f5f9; display:flex; gap:16px; flex-wrap:wrap;">
          <span style="font-size:12px; font-weight:600; color:#475569;">Available Balances:</span>
          ${empBalances.map((b) => html`
            <span class="badge" style="background:${b.available > 0 ? '#dcfce7' : '#fee2e2'}; color:${b.available > 0 ? '#15803d' : '#991b1b'}; font-weight:600;">
              ${b.name}: ${b.available}d remaining (${b.used}d used of ${b.allocated}d)
            </span>
          `)}
        </div>
      `);

      if ($('#signatureText')) $('#signatureText').textContent = u.name;
      if ($('#formContactNumber') && !$('#formContactNumber').value && u.phone) {
        $('#formContactNumber').value = u.phone;
      }
    };

    updateEmpPreview();

    // Employee Selection Change
    $('#formEmpSelect').addEventListener('change', async (e) => {
      selectedEmp = users.find((u) => String(u.id) === e.target.value);
      if (selectedEmp) {
        await loadEmpBalances(selectedEmp.id);
        updateEmpPreview();
        calculateDays();
      }
    });

    // Type selection visual highlight
    $$('.leave-type-card', container).forEach((card) => {
      card.addEventListener('click', () => {
        $$('.leave-type-card', container).forEach((c) => {
          c.style.borderColor = '#cbd5e1';
          c.style.background = '#ffffff';
        });
        card.style.borderColor = '#1E3A8A';
        card.style.background = '#eff6ff';
      });
    });

    // Date range change & auto calculation
    const sInput = $('#formStartDate');
    const eInput = $('#formEndDate');
    const halfInput = $('#formHalfDay');

    const calculateDays = () => {
      if (eInput.value < sInput.value) eInput.value = sInput.value;
      if (halfInput.checked) {
        eInput.value = sInput.value;
        $('#liveDayCalculation').textContent = 'Total Calculated: 0.5 Working Day (Half Day)';
        return;
      }

      // Simple local calculation excluding Fridays
      const start = new Date(sInput.value);
      const end = new Date(eInput.value);
      let count = 0;
      for (let cur = new Date(start); cur <= end; cur.setDate(cur.getDate() + 1)) {
        if (cur.getDay() !== 5) count++; // 5 is Friday
      }
      $('#liveDayCalculation').textContent = `Total Calculated: ${count} Working Day${count === 1 ? '' : 's'} (Excl. Friday)`;
    };

    sInput.addEventListener('change', calculateDays);
    eInput.addEventListener('change', calculateDays);
    halfInput.addEventListener('change', calculateDays);
    calculateDays();

    // Form Submit
    $('#digitalLeaveForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const v = formValues(form);

      if (!v.leaveTypeId) {
        toast('Please select a leave type', 'bad');
        return;
      }

      try {
        const res = await post('/leave/requests', {
          userId: selectedEmp ? selectedEmp.id : state.user.id,
          leaveTypeId: Number(v.leaveTypeId),
          startDate: v.startDate,
          endDate: v.endDate,
          halfDay: !!v.halfDay,
          reason: v.reason || '',
          addressDuringLeave: v.addressDuringLeave || '',
          contactNumber: v.contactNumber || '',
          applicantSignature: selectedEmp ? selectedEmp.name : state.user.name,
        });

        toast('Leave Application submitted successfully!');
        activeTab = 'requests';
        frame();
      } catch (ex) {
        toast(ex.message, 'bad');
      }
    });
  };

  /* =========================================================================
   * 3. LEAVE MANAGEMENT DASHBOARD & METRICS
   * ========================================================================= */
  const renderDashboard = async () => {
    const container = $('#leaveMainContainer');
    const year = new Date().getFullYear();

    setHTML(container, html`
      <div class="stack" style="gap:16px;">
        <div class="stats-grid" id="dashboardStatsGrid">
          <div class="stat-card primary"><span class="lbl">Total Applications</span><span class="val" id="kpiTotal">—</span></div>
          <div class="stat-card late"><span class="lbl">Pending Dept Head</span><span class="val" id="kpiPending">—</span></div>
          <div class="stat-card ok" style="border-left-color:#3b82f6;"><span class="lbl">Recommended</span><span class="val" id="kpiRecommended" style="color:#2563eb;">—</span></div>
          <div class="stat-card ok"><span class="lbl">Final Approved</span><span class="val" id="kpiApproved">—</span></div>
          <div class="stat-card bad"><span class="lbl">Rejected</span><span class="val" id="kpiRejected">—</span></div>
        </div>

        <div class="cols-2">
          <!-- Department-wise Leave Analysis -->
          <section class="panel">
            <header><h2>Department-wise Leave Distribution (${year})</h2></header>
            <div class="body flush table-wrap" id="deptStatsBody">
              <p class="muted" style="padding:16px;">Loading department metrics...</p>
            </div>
          </section>

          <!-- Type-wise Leave Analysis -->
          <section class="panel">
            <header><h2>Leave Types Breakdown &amp; Quotas</h2></header>
            <div class="body flush table-wrap" id="typeStatsBody">
              <p class="muted" style="padding:16px;">Loading types metrics...</p>
            </div>
          </section>
        </div>
      </div>
    `);

    try {
      const { summary = {}, byDepartment = [], byType = [] } = await get(`/leave/stats?year=${year}`);

      $('#kpiTotal').textContent = summary.total ?? 0;
      $('#kpiPending').textContent = summary.pending ?? 0;
      $('#kpiRecommended').textContent = summary.recommended ?? 0;
      $('#kpiApproved').textContent = summary.approved ?? 0;
      $('#kpiRejected').textContent = summary.rejected ?? 0;

      setHTML($('#deptStatsBody'), html`
        ${byDepartment.length ? html`
          <table>
            <thead><tr><th>Department</th><th class="r">Applications</th></tr></thead>
            <tbody>
              ${byDepartment.map((d) => html`
                <tr>
                  <td><b>${d.department || 'General'}</b></td>
                  <td class="r"><b>${d.count}</b></td>
                </tr>
              `)}
            </tbody>
          </table>
        ` : html`<p class="empty">No leave requests recorded this year.</p>`}
      `);

      setHTML($('#typeStatsBody'), html`
        ${byType.length ? html`
          <table>
            <thead><tr><th>Leave Type</th><th class="r">Count</th><th class="r">Total Days</th></tr></thead>
            <tbody>
              ${byType.map((t) => html`
                <tr>
                  <td><b>${t.type}</b></td>
                  <td class="r">${t.count}</td>
                  <td class="r" style="color:#15803d; font-weight:700;">${t.total_days}d</td>
                </tr>
              `)}
            </tbody>
          </table>
        ` : html`<p class="empty">No data available.</p>`}
      `);
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  /* =========================================================================
   * 4. EMPLOYEE BALANCES TAB
   * ========================================================================= */
  const renderBalances = async () => {
    const curYear = new Date().getFullYear();
    const container = $('#leaveMainContainer');

    setHTML(container, html`
      <div class="stack" style="gap:14px;">
        <section class="panel">
          <header style="display:flex; justify-content:space-between; align-items:center; padding:14px 20px;">
            <div>
              <h2 style="margin:0; font-size:16px;">Employee Leave Quotas &amp; Balances (${curYear})</h2>
              <p class="muted small" style="margin:3px 0 0;">Casual Leave (CL): 10d | Sick Leave (SL): 14d | Earned Leave (EL): 15d</p>
            </div>
            <input type="text" id="balSearchInput" placeholder="Search employee..." style="padding:6px 12px; border-radius:6px; border:1px solid #cbd5e1; font-size:13px; width:220px;">
          </header>
          <div class="body flush table-wrap" id="balTableContainer">
            <p class="muted" style="padding:16px;">Loading employee balances...</p>
          </div>
        </section>
      </div>
    `);

    try {
      const { rows = [] } = await get(`/leave/all-balances?year=${curYear}`);

      const renderRows = (search = '') => {
        const s = search.toLowerCase();
        const filtered = rows.filter((r) => !s || r.name.toLowerCase().includes(s) || (r.employee_code && r.employee_code.toLowerCase().includes(s)) || (r.department && r.department.toLowerCase().includes(s)));

        setHTML($('#balTableContainer'), html`
          ${filtered.length ? html`
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department / Section</th>
                  ${leaveTypes.filter((t) => t.annual_quota !== null).map((t) => html`<th style="min-width:150px;">${t.name} (Quota ${t.annual_quota}d)</th>`)}
                  ${canManageLeave ? html`<th class="r">Actions</th>` : ''}
                </tr>
              </thead>
              <tbody>
                ${filtered.map((emp) => html`
                  <tr>
                    <td class="nameCell">
                      <b>${emp.name}</b>
                      <span class="small muted">${emp.employee_code || ''} • ${emp.designation || 'Staff'}</span>
                    </td>
                    <td>
                      <div>${emp.department || 'General'}</div>
                      <span class="small muted">${emp.section || emp.department}</span>
                    </td>
                    ${leaveTypes.filter((t) => t.annual_quota !== null).map((lt) => {
                      const b = (emp.balances || []).find((x) => x.leave_type_id === lt.id) || { allocated: lt.annual_quota, used: 0, remaining: lt.annual_quota };
                      const rem = b.remaining;
                      return html`
                        <td>
                          <div style="font-weight:700; color:${rem > 0 ? '#15803d' : '#dc2626'}; font-size:13px;">
                            ${rem} <span class="muted small" style="font-weight:normal;">of ${b.allocated} left</span>
                          </div>
                          <div class="small muted" style="font-size:11px;">Used: <b>${b.used}</b> day${b.used === 1 ? '' : 's'}</div>
                        </td>
                      `;
                    })}
                    ${canManageLeave ? html`
                      <td class="r">
                        <button class="btn sm" data-edit-bal="${emp.user_id}">Adjust</button>
                      </td>
                    ` : ''}
                  </tr>
                `)}
              </tbody>
            </table>
          ` : html`<p class="empty">No employees found.</p>`}
        `);

        $$('[data-edit-bal]', container).forEach((btn) => {
          btn.addEventListener('click', () => {
            const emp = rows.find((x) => String(x.user_id) === btn.dataset.editBal);
            if (emp) openAdjustBalanceModal(emp, curYear);
          });
        });
      };

      $('#balSearchInput').addEventListener('input', (e) => renderRows(e.target.value));
      renderRows();
    } catch (e) {
      setHTML($('#balTableContainer'), html`<p class="empty" style="color:#ef4444;">Failed to load balances: ${e.message}</p>`);
    }
  };

  /* =========================================================================
   * 5. LEAVE TYPES CONFIGURATION TAB
   * ========================================================================= */
  const renderLeaveTypes = async () => {
    const container = $('#leaveMainContainer');

    setHTML(container, html`
      <div class="stack" style="gap:14px;">
        <section class="panel">
          <header style="display:flex; justify-content:space-between; align-items:center; padding:14px 20px;">
            <div>
              <h2 style="margin:0; font-size:16px;">Leave Policies &amp; Types Configuration</h2>
              <p class="muted small" style="margin:2px 0 0;">Manage corporate leave categories: Casual Leave (CL 10d), Sick Leave (SL 14d), Earned Leave (EL 15d).</p>
            </div>
            <button id="btnAddTypeBtn" class="btn primary" style="display:inline-flex; align-items:center; gap:6px;">
              <span>+</span> <span>Add Leave Type</span>
            </button>
          </header>
          <div class="body flush table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Leave Type Name</th>
                  <th>Annual Quota</th>
                  <th>Pay Type</th>
                  <th>Status</th>
                  <th class="r">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${leaveTypes.map((t) => html`
                  <tr>
                    <td><b>${t.name}</b></td>
                    <td>${t.annual_quota !== null ? html`<b>${t.annual_quota} days</b> / year` : html`<span class="muted">No quota</span>`}</td>
                    <td>${t.paid ? html`<span class="badge" style="background:#dcfce7; color:#15803d;">Paid</span>` : html`<span class="badge" style="background:#f1f5f9; color:#64748b;">Unpaid</span>`}</td>
                    <td>${t.active ? html`<span class="badge" style="background:#dcfce7; color:#15803d;">Active</span>` : html`<span class="badge" style="background:#fee2e2; color:#991b1b;">Inactive</span>`}</td>
                    <td class="r">
                      <span class="row" style="justify-content:flex-end; gap:6px;">
                        <button class="btn sm" data-edit-type="${t.id}">Edit</button>
                        <button class="btn sm danger" data-del-type="${t.id}">Delete</button>
                      </span>
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    `);

    $('#btnAddTypeBtn').addEventListener('click', openAddLeaveTypeModal);
    $$('[data-edit-type]', container).forEach((b) => {
      b.addEventListener('click', () => openEditLeaveTypeModal(leaveTypes.find((x) => String(x.id) === b.dataset.editType)));
    });
    $$('[data-del-type]', container).forEach((b) => {
      b.addEventListener('click', () => deleteLeaveType(leaveTypes.find((x) => String(x.id) === b.dataset.delType)));
    });
  };

  /* =========================================================================
   * MODALS & ACTIONS
   * ========================================================================= */

  // Modal: View Full Application Details & Signatures
  const openApplicationDetailsModal = (r) => {
    if (!r) return;
    modal({
      title: `Leave Application #LA-${String(r.id).padStart(5, '0')}`,
      submitLabel: 'Close',
      body: html`
        <div class="stack" style="gap:16px;">
          <!-- Top Overview Box -->
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:14px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
              <div>
                <b style="font-size:15px; color:#0F2942;">${r.name}</b>
                <div class="small muted">${r.employee_code || ''} • ${r.designation} • ${r.department}</div>
              </div>
              <div>
                <a href="/api/leave/requests/${r.id}/pdf" target="_blank" download="Leave_Application_${r.id}.pdf" class="btn sm" style="background:#0F2942; color:#fff; font-weight:700;">
                  📄 Download A4 PDF
                </a>
              </div>
            </div>
          </div>

          <!-- Particulars Grid -->
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; background:#fff; border:1px solid #e2e8f0; border-radius:8px; padding:14px;">
            <div><span class="small muted">Leave Type:</span> <div><b>${r.type}</b></div></div>
            <div><span class="small muted">Duration:</span> <div><b>${r.half_day ? 'Half Day' : 'Full Day'} (${r.days} working days)</b></div></div>
            <div><span class="small muted">From Date:</span> <div><b>${fmtDateLong(r.start_date)}</b></div></div>
            <div><span class="small muted">To Date:</span> <div><b>${fmtDateLong(r.end_date)}</b></div></div>
            <div style="grid-column: 1 / -1;"><span class="small muted">Reason:</span> <div style="color:#334155; font-weight:500;">${r.reason || 'N/A'}</div></div>
            <div><span class="small muted">Address during leave:</span> <div>${r.address_during_leave || '—'}</div></div>
            <div><span class="small muted">Emergency Contact:</span> <div>${r.contact_number || r.phone || '—'}</div></div>
          </div>

          <!-- 3-Tier Signature Records -->
          <div style="font-size:13px; font-weight:700; color:#0F2942;">3-Tier Signature &amp; Authorization Record:</div>
          <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px;">
            <div style="border:1px solid #cbd5e1; border-radius:8px; padding:10px; background:#f8fafc;">
              <b style="font-size:11.5px; color:#1E3A8A;">1. APPLICANT</b>
              <div style="font-size:12px; font-weight:700; margin-top:4px;">${r.applicant_signature || r.name}</div>
              <div class="small muted" style="font-size:10.5px;">${fmtDate(r.applied_at || r.created_at)}</div>
              <div style="color:#15803d; font-size:11px; font-weight:700; margin-top:6px;">✓ Submitted</div>
            </div>

            <div style="border:1px solid #cbd5e1; border-radius:8px; padding:10px; background:#f8fafc;">
              <b style="font-size:11.5px; color:#1E3A8A;">2. DEPT HEAD</b>
              <div style="font-size:12px; font-weight:700; margin-top:4px;">${r.dept_head_name || 'Department Manager'}</div>
              <div class="small muted" style="font-size:10.5px;">${fmtDate(r.dept_head_signed_at || r.created_at)}</div>
              <div style="font-size:11px; font-weight:700; margin-top:6px; color:${r.dept_head_recommendation === 'recommended' || r.status === 'recommended' || r.status === 'approved' ? '#0369a1' : '#b45309'};">
                ${r.dept_head_recommendation ? r.dept_head_recommendation.toUpperCase() : (r.status === 'approved' ? 'RECOMMENDED' : 'PENDING')}
              </div>
              ${r.dept_head_remarks ? html`<div class="small muted" style="font-style:italic;">"${r.dept_head_remarks}"</div>` : ''}
            </div>

            <div style="border:1px solid #cbd5e1; border-radius:8px; padding:10px; background:#f8fafc;">
              <b style="font-size:11.5px; color:#1E3A8A;">3. ADMIN HEAD</b>
              <div style="font-size:12px; font-weight:700; margin-top:4px;">${r.admin_head_name || 'Ali Hasan Sheikh'}</div>
              <div class="small muted" style="font-size:10.5px;">${fmtDate(r.admin_head_signed_at || r.reviewed_at || '—')}</div>
              <div style="font-size:11px; font-weight:700; margin-top:6px; color:${r.status === 'approved' ? '#15803d' : r.status === 'rejected' ? '#dc2626' : '#b45309'};">
                ${(r.status || 'pending').toUpperCase()}
              </div>
              ${r.admin_head_remarks ? html`<div class="small muted" style="font-style:italic;">"${r.admin_head_remarks}"</div>` : ''}
            </div>
          </div>
        </div>
      `,
      onSubmit: (form, close) => close(),
    });
  };

  // Modal: Department Head Recommendation
  const openRecommendModal = (r) => {
    if (!r) return;
    modal({
      title: `Recommend Leave: ${r.name}`,
      submitLabel: 'Submit Recommendation',
      body: html`
        <div class="stack" style="gap:14px;">
          <p class="small muted">Review application for <b>${r.name}</b> (${r.type}, ${r.days} working days).</p>
          <label>Recommendation Decision <span style="color:#ef4444">*</span>
            <select name="decision" required style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
              <option value="recommended" selected>Recommend for Approval (Forward to Admin Head)</option>
              <option value="rejected">Reject at Department Level</option>
            </select>
          </label>
          <label>Department Remarks / Notes
            <textarea name="remarks" maxlength="500" placeholder="e.g. Recommended, work covered by teammate" style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1;"></textarea>
          </label>
          <label>Department Head Digital Signature
            <input type="text" name="signature" value="${state.user.name}" required style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        try {
          await post(`/leave/requests/${r.id}/recommend`, {
            decision: v.decision,
            remarks: v.remarks || '',
            signature: v.signature || state.user.name,
          });
          close();
          toast(`Application ${v.decision === 'recommended' ? 'recommended successfully' : 'rejected'}`);
          frame();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      },
    });
  };

  // Modal: Admin Head Final Approval
  const openFinalApproveModal = (r, decision) => {
    if (!r) return;
    modal({
      title: decision === 'approved' ? `Final Approve Leave: ${r.name}` : `Reject Leave: ${r.name}`,
      submitLabel: decision === 'approved' ? 'Grant Final Approval' : 'Confirm Rejection',
      danger: decision === 'rejected',
      body: html`
        <div class="stack" style="gap:14px;">
          <p class="small muted">
            ${decision === 'approved'
              ? `Granting final approval will deduct ${r.days} day(s) from ${r.name}'s balance and record approved leave in daily attendance.`
              : `Rejecting application for ${r.name}. Balance will not be deducted.`}
          </p>
          <label>Approval / Rejection Remarks
            <textarea name="remarks" maxlength="500" placeholder="${decision === 'approved' ? 'e.g. Approved as per company policy' : 'e.g. Critical factory delivery deadline'}" style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1;"></textarea>
          </label>
          <label>Admin Head Digital Signature
            <input type="text" name="signature" value="${state.user.name}" required style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        try {
          await post(`/leave/requests/${r.id}/final-approve`, {
            decision,
            remarks: v.remarks || '',
            signature: v.signature || state.user.name,
          });
          close();
          toast(decision === 'approved' ? 'Leave finally approved & balance deducted' : 'Leave application rejected');
          frame();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      },
    });
  };

  // Modal: Edit Application
  const openEditModal = (r) => {
    if (!r) return;
    modal({
      title: `Edit Application: ${r.name}`,
      submitLabel: 'Save Changes',
      body: html`
        <div class="stack" style="gap:14px;">
          <label>Leave Type
            <select name="leaveTypeId" required style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
              ${leaveTypes.map((t) => html`
                <option value="${t.id}" ${t.name === r.type ? 'selected' : ''}>${t.name}</option>
              `)}
            </select>
          </label>
          <div class="form-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
            <label>Start Date<input type="date" name="startDate" required value="${r.start_date}" style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1;"></label>
            <label>End Date<input type="date" name="endDate" required value="${r.end_date}" style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1;"></label>
          </div>
          <label class="check" style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="halfDay" ${r.half_day ? 'checked' : ''}> <span>Half Day</span>
          </label>
          <label>Status
            <select name="status" style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
              <option value="pending" ${r.status === 'pending' ? 'selected' : ''}>Pending (Dept Head)</option>
              <option value="recommended" ${r.status === 'recommended' ? 'selected' : ''}>Recommended (Admin Head)</option>
              <option value="approved" ${r.status === 'approved' ? 'selected' : ''}>Approved</option>
              <option value="rejected" ${r.status === 'rejected' ? 'selected' : ''}>Rejected</option>
              <option value="cancelled" ${r.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
            </select>
          </label>
          <label>Reason
            <textarea name="reason" maxlength="500" style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1;">${r.reason || ''}</textarea>
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        try {
          await put(`/leave/requests/${r.id}`, {
            leaveTypeId: Number(v.leaveTypeId),
            startDate: v.startDate,
            endDate: v.endDate,
            halfDay: !!v.halfDay,
            status: v.status,
            reason: v.reason || '',
          });
          close();
          toast('Application updated');
          frame();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      },
    });
  };

  // Action: Delete Application
  const deleteApplication = async (r) => {
    const ok = await confirmDialog(
      'Delete leave application?',
      `Are you sure you want to permanently delete application #LA-${r.id} for ${r.name}? If approved, days will be restored.`,
      { confirmLabel: 'Delete Application', danger: true }
    );
    if (!ok) return;

    try {
      await del(`/leave/requests/${r.id}`);
      toast('Application deleted');
      frame();
    } catch (ex) {
      toast(ex.message, 'bad');
    }
  };

  // Modal: Adjust Employee Balance
  const openAdjustBalanceModal = (emp, year) => {
    const quotaTypes = leaveTypes.filter((t) => t.annual_quota !== null);
    modal({
      title: `Adjust Balances: ${emp.name}`,
      submitLabel: 'Save Balances',
      body: html`
        <div class="stack" style="gap:14px;">
          <p class="small muted">Update quota or used days for year ${year}.</p>
          ${quotaTypes.map((t) => {
            const b = (emp.balances || []).find((x) => x.leave_type_id === t.id) || { allocated: t.annual_quota, used: 0 };
            return html`
              <div style="background:#f8fafc; padding:12px; border-radius:8px; border:1px solid #e2e8f0;">
                <b style="font-size:13.5px; color:#0F2942;">${t.name}</b>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:8px;">
                  <label>Allocated Quota<input type="number" step="0.5" min="0" name="allocated_${t.id}" value="${b.allocated}" required style="padding:6px; border-radius:6px; border:1px solid #cbd5e1;"></label>
                  <label>Used Days<input type="number" step="0.5" min="0" name="used_${t.id}" value="${b.used}" required style="padding:6px; border-radius:6px; border:1px solid #cbd5e1;"></label>
                </div>
              </div>
            `;
          })}
        </div>
      `,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        try {
          for (const t of quotaTypes) {
            const alloc = parseFloat(v[`allocated_${t.id}`]);
            const used = parseFloat(v[`used_${t.id}`]);
            if (!isNaN(alloc) && !isNaN(used)) {
              await put(`/leave/balances/${emp.user_id}/${t.id}`, { allocated: alloc, used, year });
            }
          }
          close();
          toast('Balances updated successfully');
          frame();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      },
    });
  };

  // Modal: Add Leave Type
  const openAddLeaveTypeModal = () => {
    modal({
      title: 'Add Leave Type',
      submitLabel: 'Create Category',
      body: html`
        <div class="stack" style="gap:14px;">
          <label>Type Name <span style="color:#ef4444">*</span>
            <input type="text" name="name" required placeholder="e.g. Earned Leave (EL)" style="padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
          </label>
          <label>Annual Quota (Days) <span class="hint">(Leave blank for unpaid)</span>
            <input type="number" name="annualQuota" min="0" placeholder="e.g. 15" style="padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
          </label>
          <label class="check" style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="paid" checked> <span>Paid Leave</span>
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        const quota = v.annualQuota ? parseInt(v.annualQuota, 10) : null;
        try {
          await post('/leave/types', {
            name: v.name,
            annualQuota: quota,
            paid: !!v.paid,
            active: true,
          });
          close();
          toast('Leave category created');
          await loadBaseData();
          frame();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      },
    });
  };

  // Modal: Edit Leave Type
  const openEditLeaveTypeModal = (t) => {
    modal({
      title: `Edit Category: ${t.name}`,
      submitLabel: 'Save Changes',
      body: html`
        <div class="stack" style="gap:14px;">
          <label>Category Name <span style="color:#ef4444">*</span>
            <input type="text" name="name" required value="${t.name}" style="padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
          </label>
          <label>Annual Quota (Days)
            <input type="number" name="annualQuota" min="0" value="${t.annual_quota !== null ? t.annual_quota : ''}" style="padding:8px; border-radius:6px; border:1px solid #cbd5e1;">
          </label>
          <label class="check" style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="paid" ${t.paid ? 'checked' : ''}> <span>Paid Leave</span>
          </label>
          <label class="check" style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" name="active" ${t.active ? 'checked' : ''}> <span>Active</span>
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        const quota = v.annualQuota !== '' && v.annualQuota !== undefined ? parseInt(v.annualQuota, 10) : null;
        try {
          await put(`/leave/types/${t.id}`, {
            name: v.name,
            annualQuota: quota,
            paid: !!v.paid,
            active: !!v.active,
          });
          close();
          toast('Leave category updated');
          await loadBaseData();
          frame();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      },
    });
  };

  // Action: Delete Leave Type
  const deleteLeaveType = async (t) => {
    const ok = await confirmDialog(`Delete ${t.name}?`, 'If applications exist under this category, it will be safely deactivated.', { confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await del(`/leave/types/${t.id}`);
      toast('Category removed');
      await loadBaseData();
      frame();
    } catch (ex) {
      toast(ex.message, 'bad');
    }
  };

  await frame();
}
