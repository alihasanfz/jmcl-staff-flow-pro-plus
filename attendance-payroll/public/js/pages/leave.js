// Leave Management: Full Admin Control (Add, Edit, Delete Requests, Balances, & Types)
import { get, post, put, del, qs } from '../api.js';
import { html, setHTML, $, $$, fmtDateLong, fmtDate, badge, toast, modal, formValues, confirmDialog, icon } from '../ui.js';
import { canEdit, canView } from '../permissions.js';

export async function render(view, state) {
  const isMgr = ['admin', 'company_admin', 'super_admin', 'hr_manager', 'hr_executive', 'hr', 'dept_manager'].includes(state.user.role) || canView(state.user, 'leave');
  const canManageLeave = canEdit(state.user, 'leave') || ['admin', 'company_admin', 'super_admin', 'hr_manager', 'hr'].includes(state.user.role);

  let tab = isMgr ? 'requests' : 'mine';
  let users = [];
  let leaveTypes = [];

  const loadBaseData = async () => {
    try {
      const [uRes, tRes] = await Promise.all([
        isMgr ? get('/users?active=true').catch(() => ({ users: [] })) : Promise.resolve({ users: [] }),
        get('/leave/types').catch(() => get('/org/leave-types').then((r) => ({ types: r.leaveTypes }))),
      ]);
      users = uRes.users || [];
      leaveTypes = tRes.types || [];
    } catch { /* ignore */ }
  };

  await loadBaseData();

  const frame = async () => {
    const pendingCount = isMgr ? (await get('/leave/requests?scope=pending').catch(() => ({ requests: [] }))).requests.length : 0;
    const personalBal = await get('/leave/balances').catch(() => ({ year: new Date().getFullYear(), balances: [] }));

    setHTML(view, html`
      <div class="stack">
        <div class="tabs" role="tablist">
          ${isMgr ? html`
            <button role="tab" data-tab="requests" aria-selected="${tab === 'requests'}">
              Leave Requests ${pendingCount > 0 ? html`<span class="badge" style="background:#ef4444;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;margin-left:4px">${pendingCount}</span>` : ''}
            </button>
            <button role="tab" data-tab="balances" aria-selected="${tab === 'balances'}">Employee Balances (CL / SL)</button>
            <button role="tab" data-tab="types" aria-selected="${tab === 'types'}">Leave Types (10d CL / 14d SL)</button>
          ` : ''}
          <button role="tab" data-tab="mine" aria-selected="${tab === 'mine'}">My Leave</button>
        </div>
        <div id="leaveContent"></div>
      </div>
    `);

    $$('[data-tab]', view).forEach((b) => b.addEventListener('click', () => {
      tab = b.dataset.tab;
      frame();
    }));

    if (tab === 'requests') await renderRequests();
    else if (tab === 'balances') await renderBalances();
    else if (tab === 'types') await renderTypes();
    else await renderMine(personalBal);
  };

  /* =========================================================================
   * TAB 1: ALL LEAVE REQUESTS / APPROVALS
   * ========================================================================= */
  const renderRequests = async () => {
    const filter = { status: '', userId: '', department: '' };
    const content = $('#leaveContent');

    const loadTable = async () => {
      let q = '/leave/requests?scope=all';
      if (filter.status) q += `&status=${encodeURIComponent(filter.status)}`;
      if (filter.userId) q += `&userId=${encodeURIComponent(filter.userId)}`;
      const { requests = [] } = await get(q);

      let displayed = requests;
      if (filter.department) {
        displayed = displayed.filter((r) => r.department === filter.department);
      }

      setHTML($('#requestListBody'), html`
        ${displayed.length ? html`
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Leave Type</th>
                <th>Dates</th>
                <th class="r">Days</th>
                <th>Status</th>
                <th>Reason / Notes</th>
                <th class="r" style="min-width:180px">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${displayed.map((r) => html`
                <tr data-row-id="${r.id}">
                  <td class="nameCell">
                    <b>${r.name}</b>
                    <span class="small muted">${r.employee_code || ''} • ${r.department || 'General'}</span>
                  </td>
                  <td>
                    <b>${r.type}</b>
                    ${r.paid ? '' : html`<span class="small muted" style="margin-left:4px">(Unpaid)</span>`}
                  </td>
                  <td>
                    <span>${fmtDateLong(r.start_date)}</span>
                    ${r.start_date !== r.end_date ? html` → <span>${fmtDateLong(r.end_date)}</span>` : ''}
                    ${r.half_day ? html` <span class="badge" style="background:#e0f2fe;color:#0369a1;font-size:11px">Half Day</span>` : ''}
                  </td>
                  <td class="r"><b>${r.days}</b></td>
                  <td>${badge(r.status)}</td>
                  <td class="wrap small muted" style="max-width:240px">
                    ${r.reason ? html`<div>${r.reason}</div>` : ''}
                    ${r.review_note ? html`<div style="font-style:italic;color:#64748b">Note: ${r.review_note}</div>` : ''}
                    ${r.reviewer ? html`<div class="small muted">Reviewed by ${r.reviewer}</div>` : ''}
                  </td>
                  <td class="r">
                    <span class="row" style="justify-content:flex-end;gap:6px;flex-wrap:nowrap">
                      ${r.status === 'pending' ? html`
                        <button class="btn sm primary" data-act="approve" data-id="${r.id}" title="Approve">Approve</button>
                        <button class="btn sm danger" data-act="reject" data-id="${r.id}" title="Reject">Reject</button>
                      ` : ''}
                      ${canManageLeave ? html`
                        <button class="btn sm" data-act="edit" data-id="${r.id}" title="Edit Leave Record">${icon('edit') || 'Edit'}</button>
                        <button class="btn sm danger" data-act="delete" data-id="${r.id}" title="Delete Leave Record">${icon('trash') || 'Delete'}</button>
                      ` : ''}
                    </span>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        ` : html`<p class="empty">No leave requests found matching filter.</p>`}
      `);

      // Bind Action Buttons
      $$('[data-act="approve"]', content).forEach((b) => b.addEventListener('click', () => decide('approve', b.dataset.id)));
      $$('[data-act="reject"]', content).forEach((b) => b.addEventListener('click', () => decide('reject', b.dataset.id)));
      $$('[data-act="edit"]', content).forEach((b) => b.addEventListener('click', () => openEditRequestModal(b.dataset.id, displayed.find((x) => String(x.id) === b.dataset.id))));
      $$('[data-act="delete"]', content).forEach((b) => b.addEventListener('click', () => deleteRequest(b.dataset.id, displayed.find((x) => String(x.id) === b.dataset.id))));
    };

    const depts = [...new Set(users.map((u) => u.department).filter(Boolean))].sort();

    setHTML(content, html`
      <div class="stack" style="gap:16px">
        <div class="panel">
          <div class="body" style="padding:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
              <div class="row" style="gap:12px;align-items:center;flex-wrap:wrap">
                <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600">
                  Status:
                  <select id="reqFilterStatus" style="width:130px;padding:6px 10px;border-radius:6px;border:1px solid #cbd5e1">
                    <option value="">All Statuses</option>
                    <option value="pending">Pending</option>
                    <option value="approved">Approved</option>
                    <option value="rejected">Rejected</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600">
                  Department:
                  <select id="reqFilterDept" style="width:150px;padding:6px 10px;border-radius:6px;border:1px solid #cbd5e1">
                    <option value="">All Departments</option>
                    ${depts.map((d) => html`<option value="${d}">${d}</option>`)}
                  </select>
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600">
                  Employee:
                  <select id="reqFilterUser" style="width:180px;padding:6px 10px;border-radius:6px;border:1px solid #cbd5e1">
                    <option value="">All Employees</option>
                    ${users.map((u) => html`<option value="${u.id}">${u.name} (${u.employee_code || u.id})</option>`)}
                  </select>
                </label>
              </div>
              <div>
                ${canManageLeave ? html`
                  <button id="btnAdminApply" class="btn primary" style="display:flex;align-items:center;gap:6px">
                    <span>+</span> <span>Apply Leave</span>
                  </button>
                ` : ''}
              </div>
            </div>
          </div>
        </div>

        <section class="panel">
          <div class="body flush table-wrap" id="requestListBody">
            <p class="muted" style="padding:16px">Loading requests...</p>
          </div>
        </section>
      </div>
    `);

    $('#reqFilterStatus').addEventListener('change', (e) => { filter.status = e.target.value; loadTable(); });
    $('#reqFilterDept').addEventListener('change', (e) => { filter.department = e.target.value; loadTable(); });
    $('#reqFilterUser').addEventListener('change', (e) => { filter.userId = e.target.value; loadTable(); });

    if ($('#btnAdminApply')) {
      $('#btnAdminApply').addEventListener('click', openAdminApplyModal);
    }

    await loadTable();
  };

  /* Modal: Admin Add Leave for an Employee */
  const openAdminApplyModal = () => {
    modal({
      title: 'Apply Leave (Admin / HR)',
      submitLabel: 'Save & Approve Leave',
      body: html`
        <div class="stack" style="gap:14px">
          <label>Employee <span style="color:#ef4444">*</span>
            <select name="userId" required style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid #cbd5e1">
              <option value="">-- Select Employee --</option>
              ${users.map((u) => html`<option value="${u.id}">${u.name} — ${u.department || 'General'} (${u.employee_code || u.id})</option>`)}
            </select>
          </label>
          <label>Leave Type <span style="color:#ef4444">*</span>
            <select name="leaveTypeId" required style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid #cbd5e1">
              ${leaveTypes.filter((t) => t.active).map((t) => html`
                <option value="${t.id}">${t.name} ${t.annual_quota !== null ? `(${t.annual_quota} days quota)` : '(Unpaid)'}</option>
              `)}
            </select>
          </label>
          <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label>Start Date <span style="color:#ef4444">*</span>
              <input type="date" name="startDate" required value="${state.meta.today}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1">
            </label>
            <label>End Date <span style="color:#ef4444">*</span>
              <input type="date" name="endDate" required value="${state.meta.today}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1">
            </label>
          </div>
          <label class="check" style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" name="halfDay"> <span>Half Day (0.5 day)</span>
          </label>
          <label>Initial Status
            <select name="status" style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1">
              <option value="approved" selected>Approved (Immediate)</option>
              <option value="pending">Pending Approval</option>
            </select>
          </label>
          <label>Reason / Note
            <textarea name="reason" maxlength="500" placeholder="e.g. Medical emergency, Family matter" style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1"></textarea>
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        if (!v.userId) {
          toast('Please select an employee', 'bad');
          return;
        }
        try {
          await post('/leave/admin-create', {
            userId: Number(v.userId),
            leaveTypeId: Number(v.leaveTypeId),
            startDate: v.startDate,
            endDate: v.endDate,
            halfDay: !!v.halfDay,
            status: v.status || 'approved',
            reason: v.reason || '',
          });
          close();
          toast('Leave applied successfully');
          frame();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      },
    });
  };

  /* Modal: Edit Existing Leave Request */
  const openEditRequestModal = (id, rec) => {
    if (!rec) return;
    modal({
      title: `Edit Leave: ${rec.name}`,
      submitLabel: 'Save Changes',
      body: html`
        <div class="stack" style="gap:14px">
          <label>Leave Type <span style="color:#ef4444">*</span>
            <select name="leaveTypeId" required style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1">
              ${leaveTypes.map((t) => html`
                <option value="${t.id}" ${t.id === rec.leave_type_id || t.name === rec.type ? 'selected' : ''}>
                  ${t.name} ${t.annual_quota !== null ? `(${t.annual_quota} days)` : '(Unpaid)'}
                </option>
              `)}
            </select>
          </label>
          <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label>Start Date <span style="color:#ef4444">*</span>
              <input type="date" name="startDate" required value="${rec.start_date}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1">
            </label>
            <label>End Date <span style="color:#ef4444">*</span>
              <input type="date" name="endDate" required value="${rec.end_date}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1">
            </label>
          </div>
          <label class="check" style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" name="halfDay" ${rec.half_day ? 'checked' : ''}> <span>Half Day (0.5 day)</span>
          </label>
          <label>Status
            <select name="status" style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1">
              <option value="approved" ${rec.status === 'approved' ? 'selected' : ''}>Approved</option>
              <option value="pending" ${rec.status === 'pending' ? 'selected' : ''}>Pending</option>
              <option value="rejected" ${rec.status === 'rejected' ? 'selected' : ''}>Rejected</option>
              <option value="cancelled" ${rec.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
            </select>
          </label>
          <label>Reason / Note
            <textarea name="reason" maxlength="500" style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1">${rec.reason || ''}</textarea>
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        const v = formValues(form);
        try {
          await put(`/leave/requests/${id}`, {
            leaveTypeId: Number(v.leaveTypeId),
            startDate: v.startDate,
            endDate: v.endDate,
            halfDay: !!v.halfDay,
            status: v.status,
            reason: v.reason || '',
          });
          close();
          toast('Leave request updated');
          frame();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      },
    });
  };

  /* Action: Delete Leave Request */
  const deleteRequest = async (id, rec) => {
    const ok = await confirmDialog(
      'Delete this leave record?',
      `Are you sure you want to delete leave for ${rec?.name || 'this employee'}? Days will be restored to balance and daily attendance will be recalculated.`,
      { confirmLabel: 'Delete Record', danger: true }
    );
    if (!ok) return;

    try {
      await del(`/leave/requests/${id}`);
      toast('Leave record deleted');
      frame();
    } catch (ex) {
      toast(ex.message, 'bad');
    }
  };

  /* Action: Approve / Reject Leave */
  const decide = (act, id) => {
    modal({
      title: act === 'approve' ? 'Approve Leave' : 'Reject Leave',
      submitLabel: act === 'approve' ? 'Approve' : 'Reject',
      danger: act === 'reject',
      narrow: true,
      body: html`<label>Review Note <span class="hint">(optional)</span><input type="text" name="note" maxlength="300" placeholder="e.g. Approved by HR"></label>`,
      onSubmit: async (form, close) => {
        await post(`/leave/requests/${id}/${act}`, { note: formValues(form).note });
        close();
        toast(act === 'approve' ? 'Leave approved' : 'Leave rejected');
        frame();
      },
    });
  };

  /* =========================================================================
   * TAB 2: EMPLOYEE LEAVE BALANCES (CL / SL)
   * ========================================================================= */
  const renderBalances = async () => {
    const curYear = new Date().getFullYear();
    const content = $('#leaveContent');

    setHTML(content, html`
      <div class="stack" style="gap:16px">
        <section class="panel">
          <header style="display:flex;justify-content:space-between;align-items:center;padding:14px">
            <div>
              <h2 style="margin:0;font-size:16px">Employee Leave Balances (${curYear})</h2>
              <p class="muted small" style="margin:4px 0 0">
                Casual Leave (CL): 10 Days | Sick Leave (SL): 14 Days. Track used and remaining days for all active employees.
              </p>
            </div>
            <div class="row" style="gap:10px">
              <input type="text" id="balanceSearch" placeholder="Search employee..." style="padding:6px 12px;border-radius:6px;border:1px solid #cbd5e1;font-size:13px;width:220px">
            </div>
          </header>
          <div class="body flush table-wrap" id="balanceTableContainer">
            <p class="muted" style="padding:16px">Loading employee balances...</p>
          </div>
        </section>
      </div>
    `);

    try {
      const { rows = [] } = await get(`/leave/all-balances?year=${curYear}`);

      const renderRows = (search = '') => {
        const s = search.toLowerCase();
        const filtered = rows.filter((r) => !s || r.name.toLowerCase().includes(s) || (r.employee_code && r.employee_code.toLowerCase().includes(s)) || (r.department && r.department.toLowerCase().includes(s)));

        setHTML($('#balanceTableContainer'), html`
          ${filtered.length ? html`
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  ${leaveTypes.filter((t) => t.annual_quota !== null && t.active).map((t) => html`<th style="min-width:160px">${t.name} (Quota ${t.annual_quota}d)</th>`)}
                  <th class="r" style="min-width:110px">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${filtered.map((emp) => html`
                  <tr>
                    <td class="nameCell">
                      <b>${emp.name}</b>
                      <span class="small muted">${emp.employee_code || ''}</span>
                    </td>
                    <td>${emp.department || 'General'}</td>
                    ${leaveTypes.filter((t) => t.annual_quota !== null && t.active).map((lt) => {
                      const b = (emp.balances || []).find((x) => x.leave_type_id === lt.id) || { allocated: lt.annual_quota, used: 0, remaining: lt.annual_quota };
                      const remaining = b.remaining;
                      return html`
                        <td>
                          <div style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px">
                            <span style="color:${remaining > 0 ? '#16a34a' : '#dc2626'}">${remaining}</span>
                            <span class="muted small" style="font-weight:normal">of ${b.allocated} remaining</span>
                          </div>
                          <div style="font-size:11px;color:#64748b;margin-top:2px">
                            Used: <b>${b.used}</b> day${b.used === 1 ? '' : 's'}
                          </div>
                        </td>
                      `;
                    })}
                    <td class="r">
                      <button class="btn sm" data-edit-bal="${emp.user_id}" title="Adjust Balance">Adjust</button>
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          ` : html`<p class="empty">No employees found.</p>`}
        `);

        $$('[data-edit-bal]', content).forEach((btn) => {
          btn.addEventListener('click', () => {
            const emp = rows.find((x) => String(x.user_id) === btn.dataset.editBal);
            if (emp) openAdjustBalanceModal(emp, curYear);
          });
        });
      };

      $('#balanceSearch').addEventListener('input', (e) => renderRows(e.target.value));
      renderRows();
    } catch (e) {
      setHTML($('#balanceTableContainer'), html`<p class="empty" style="color:#ef4444">Failed to load balances: ${e.message}</p>`);
    }
  };

  /* Modal: Adjust Employee Balance */
  const openAdjustBalanceModal = (emp, year) => {
    const quotaTypes = leaveTypes.filter((t) => t.annual_quota !== null && t.active);
    modal({
      title: `Adjust Leave Balance: ${emp.name}`,
      submitLabel: 'Save Balances',
      body: html`
        <div class="stack" style="gap:14px">
          <p class="small muted">Update allocated or used leave days for year ${year}.</p>
          ${quotaTypes.map((t) => {
            const b = (emp.balances || []).find((x) => x.leave_type_id === t.id) || { allocated: t.annual_quota, used: 0 };
            return html`
              <div style="background:#f8fafc;padding:12px;border-radius:8px;border:1px solid #e2e8f0" class="stack" style="gap:8px">
                <b style="font-size:14px;color:#0f172a">${t.name}</b>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                  <label>Allocated Days
                    <input type="number" step="0.5" min="0" name="allocated_${t.id}" value="${b.allocated}" required style="padding:6px;border-radius:6px;border:1px solid #cbd5e1">
                  </label>
                  <label>Used Days
                    <input type="number" step="0.5" min="0" name="used_${t.id}" value="${b.used}" required style="padding:6px;border-radius:6px;border:1px solid #cbd5e1">
                  </label>
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

  /* =========================================================================
   * TAB 3: LEAVE TYPES MANAGEMENT (CL / SL / OTHERS)
   * ========================================================================= */
  const renderTypes = async () => {
    const content = $('#leaveContent');

    setHTML(content, html`
      <div class="stack" style="gap:16px">
        <section class="panel">
          <header style="display:flex;justify-content:space-between;align-items:center;padding:14px">
            <div>
              <h2 style="margin:0;font-size:16px">Leave Types Configuration</h2>
              <p class="muted small" style="margin:4px 0 0">
                Manage leave policies: Casual Leave (CL) 10 days, Sick Leave (SL) 14 days, and custom types.
              </p>
            </div>
            ${canManageLeave ? html`
              <button id="btnAddLeaveType" class="btn primary" style="display:flex;align-items:center;gap:6px">
                <span>+</span> <span>Add Leave Type</span>
              </button>
            ` : ''}
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
                    <td>
                      <b>${t.name}</b>
                    </td>
                    <td>
                      ${t.annual_quota !== null ? html`<b>${t.annual_quota} days</b> / year` : html`<span class="muted">No quota</span>`}
                    </td>
                    <td>
                      ${t.paid ? html`<span class="badge" style="background:#dcfce7;color:#15803d">Paid</span>` : html`<span class="badge" style="background:#f1f5f9;color:#64748b">Unpaid</span>`}
                    </td>
                    <td>
                      ${t.active ? html`<span class="badge" style="background:#dcfce7;color:#15803d">Active</span>` : html`<span class="badge" style="background:#fee2e2;color:#991b1b">Inactive</span>`}
                    </td>
                    <td class="r">
                      ${canManageLeave ? html`
                        <span class="row" style="justify-content:flex-end;gap:6px">
                          <button class="btn sm" data-edit-type="${t.id}">Edit</button>
                          <button class="btn sm danger" data-del-type="${t.id}">Delete</button>
                        </span>
                      ` : ''}
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    `);

    if ($('#btnAddLeaveType')) {
      $('#btnAddLeaveType').addEventListener('click', openAddLeaveTypeModal);
    }

    $$('[data-edit-type]', content).forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = leaveTypes.find((x) => String(x.id) === btn.dataset.editType);
        if (t) openEditLeaveTypeModal(t);
      });
    });

    $$('[data-del-type]', content).forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = leaveTypes.find((x) => String(x.id) === btn.dataset.delType);
        if (t) deleteLeaveType(t);
      });
    });
  };

  /* Modal: Add Leave Type */
  const openAddLeaveTypeModal = () => {
    modal({
      title: 'Add Leave Type',
      submitLabel: 'Create Leave Type',
      body: html`
        <div class="stack" style="gap:14px">
          <label>Type Name <span style="color:#ef4444">*</span>
            <input type="text" name="name" required placeholder="e.g. Casual Leave (CL)" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1">
          </label>
          <label>Annual Quota (Days) <span class="hint">(Leave blank for unpaid)</span>
            <input type="number" name="annualQuota" min="0" placeholder="e.g. 10 or 14" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1">
          </label>
          <label class="check" style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" name="paid" checked> <span>Paid Leave</span>
          </label>
          <label class="check" style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" name="active" checked> <span>Active</span>
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
            active: !!v.active,
          });
          close();
          toast('Leave type created');
          await loadBaseData();
          frame();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      },
    });
  };

  /* Modal: Edit Leave Type */
  const openEditLeaveTypeModal = (t) => {
    modal({
      title: `Edit Leave Type: ${t.name}`,
      submitLabel: 'Save Changes',
      body: html`
        <div class="stack" style="gap:14px">
          <label>Type Name <span style="color:#ef4444">*</span>
            <input type="text" name="name" required value="${t.name}" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1">
          </label>
          <label>Annual Quota (Days)
            <input type="number" name="annualQuota" min="0" value="${t.annual_quota !== null ? t.annual_quota : ''}" placeholder="Leave blank for unpaid" style="padding:8px;border-radius:6px;border:1px solid #cbd5e1">
          </label>
          <label class="check" style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" name="paid" ${t.paid ? 'checked' : ''}> <span>Paid Leave</span>
          </label>
          <label class="check" style="display:flex;align-items:center;gap:8px">
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
          toast('Leave type updated');
          await loadBaseData();
          frame();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      },
    });
  };

  /* Action: Delete Leave Type */
  const deleteLeaveType = async (t) => {
    const ok = await confirmDialog(
      `Delete ${t.name}?`,
      'If requests already exist under this leave type, it will be safely deactivated instead of deleted.',
      { confirmLabel: 'Delete Type', danger: true }
    );
    if (!ok) return;

    try {
      await del(`/leave/types/${t.id}`);
      toast('Leave type removed');
      await loadBaseData();
      frame();
    } catch (ex) {
      toast(ex.message, 'bad');
    }
  };

  /* =========================================================================
   * TAB 4: MY LEAVE (Self-Service)
   * ========================================================================= */
  const renderMine = async (bal) => {
    const { requests = [] } = await get('/leave/requests?scope=mine');
    setHTML($('#leaveContent'), html`
      <div class="cols-2">
        <section class="panel">
          <header><h2>My Leave History</h2></header>
          <div class="body flush table-wrap">
            ${requests.length ? html`
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Dates</th>
                    <th class="r">Days</th>
                    <th>Status</th>
                    <th>Note</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${requests.map((r) => html`
                    <tr>
                      <td>${r.type}</td>
                      <td>
                        ${fmtDateLong(r.start_date)}
                        ${r.start_date !== r.end_date ? ' → ' + fmtDateLong(r.end_date) : ''}
                        ${r.half_day ? ' (half day)' : ''}
                      </td>
                      <td class="r">${r.days}</td>
                      <td>${badge(r.status)}</td>
                      <td class="wrap small muted">
                        ${r.review_note || r.reason || ''}
                        ${r.reviewer ? html`<br>by ${r.reviewer}` : ''}
                      </td>
                      <td>
                        ${r.status === 'pending' ? html`<button class="btn sm" data-cancel="${r.id}">Cancel</button>` : ''}
                      </td>
                    </tr>
                  `)}
                </tbody>
              </table>
            ` : html`<p class="empty">You have not requested any leave yet.</p>`}
          </div>
        </section>

        <div class="stack">
          <section class="panel">
            <header><h2>My Balance (${bal.year || new Date().getFullYear()})</h2></header>
            <div class="body flush list-lines">
              ${(bal.balances || []).map((b) => html`
                <div style="display:grid;grid-template-columns:1fr 90px auto;gap:12px;align-items:center;padding:10px 14px">
                  <span><b>${b.name}</b></span>
                  <div class="bar ${b.available <= 1 ? 'warn' : ''}">
                    <i style="width:${b.allocated ? Math.min(100, ((b.used + b.pending) / b.allocated) * 100) : 0}%"></i>
                  </div>
                  <span class="num small">
                    <b>${b.available}</b> of ${b.allocated}
                    ${b.pending ? html` <span class="muted">(${b.pending} pend)</span>` : ''}
                  </span>
                </div>
              `)}
              <div class="small muted" style="padding:10px 14px;border-top:1px solid #f1f5f9">
                Casual Leave (CL) quota is 10 days, Sick Leave (SL) quota is 14 days per calendar year. Unpaid leave is deducted from salary.
              </div>
            </div>
          </section>

          <section class="panel">
            <header><h2>Request Leave</h2></header>
            <div class="body">
              <form id="myReqForm" class="stack" style="gap:12px">
                <label>Leave Type
                  <select name="leaveTypeId" required style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1">
                    ${leaveTypes.filter((t) => t.active).map((t) => html`
                      <option value="${t.id}">${t.name} ${t.annual_quota === null ? '(unpaid)' : `(${t.annual_quota}d quota)`}</option>
                    `)}
                  </select>
                </label>
                <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                  <label>From
                    <input type="date" name="startDate" required value="${state.meta.today}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1">
                  </label>
                  <label>To
                    <input type="date" name="endDate" required value="${state.meta.today}" style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1">
                  </label>
                </div>
                <label class="check" style="display:flex;align-items:center;gap:8px">
                  <input type="checkbox" name="halfDay"> <span>Half day (0.5 day)</span>
                </label>
                <label>Reason
                  <textarea name="reason" maxlength="500" placeholder="Reason for leave (optional)" style="width:100%;padding:8px;border-radius:6px;border:1px solid #cbd5e1"></textarea>
                </label>
                <button class="btn primary" type="submit">Submit Request</button>
              </form>
            </div>
          </section>
        </div>
      </div>
    `);

    const form = $('#myReqForm');
    if (form) {
      form.startDate.addEventListener('change', () => {
        if (form.endDate.value < form.startDate.value) form.endDate.value = form.startDate.value;
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = formValues(form);
        try {
          const r = await post('/leave/requests', {
            leaveTypeId: Number(v.leaveTypeId),
            startDate: v.startDate,
            endDate: v.endDate,
            halfDay: !!v.halfDay,
            reason: v.reason || '',
          });
          toast(`Request submitted for ${r.days} day${r.days === 1 ? '' : 's'}`);
          frame();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      });
    }

    $$('[data-cancel]', $('#leaveContent')).forEach((b) => {
      b.addEventListener('click', async () => {
        const ok = await confirmDialog('Cancel this request?', 'The request will be withdrawn.', { confirmLabel: 'Cancel Request', danger: true });
        if (!ok) return;
        try {
          await post(`/leave/requests/${b.dataset.cancel}/cancel`);
          toast('Request cancelled');
          frame();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      });
    });
  };

  await frame();
}
