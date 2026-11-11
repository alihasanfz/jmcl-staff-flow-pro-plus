// Department Management: Full CRUD
import { get, post, put, del } from '../api.js';
import { html, setHTML, $, $$, esc, icon, badge, toast, modal, confirmDialog } from '../ui.js';
import { t } from '../i18n.js';

export async function render(view) {
  setHTML(view, html`
    <div class="stack">
      <div class="row between">
        <div>
          <h2>${t('departments')}</h2>
          <p class="muted">Manage organizational divisions, branch departments, and team heads.</p>
        </div>
        <button class="btn primary" id="add-dept">${icon('plus')} ${t('add')} ${t('department')}</button>
      </div>

      <div class="panel">
        <header>
          <div class="search-input-wrap">
            ${icon('search')}
            <input type="text" id="dept-search" placeholder="${t('search')} ${t('departments')}...">
          </div>
          <span class="small muted" id="dept-count"></span>
        </header>
        <div class="body flush">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Department Name</th>
                  <th>Code</th>
                  <th>Department Head</th>
                  <th>Employees</th>
                  <th>Status</th>
                  <th class="r">${t('actions')}</th>
                </tr>
              </thead>
              <tbody id="dept-tbody">
                <tr><td colspan="6" class="empty">${t('loading')}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `);

  let departments = [];

  async function load() {
    try {
      const res = await get('/departments');
      departments = res.departments || [];
      renderTable();
    } catch (e) {
      setHTML($('#dept-tbody'), html`<tr><td colspan="6" class="empty notice bad">${e.message}</td></tr>`);
    }
  }

  function renderTable() {
    const q = ($('#dept-search')?.value || '').toLowerCase().trim();
    const filtered = departments.filter((d) =>
      !q || d.name.toLowerCase().includes(q) || (d.code && d.code.toLowerCase().includes(q))
    );

    $('#dept-count').textContent = `${filtered.length} department(s)`;

    const tbody = $('#dept-tbody');
    if (!filtered.length) {
      setHTML(tbody, html`<tr><td colspan="6" class="empty">${t('noData')}</td></tr>`);
      return;
    }

    setHTML(tbody, html`
      ${filtered.map((d) => html`
        <tr>
          <td><b>${d.name}</b></td>
          <td><code>${d.code || '—'}</code></td>
          <td>${d.head_name || '—'}</td>
          <td><span class="badge waiting">${d.employee_count || 0} employees</span></td>
          <td><span class="badge ${d.active ? 'active' : 'inactive'}">${d.active ? t('active') : t('inactive')}</span></td>
          <td class="r">
            <div class="action-btns">
              <button class="action-btn" data-edit="${d.id}">${icon('edit')} ${t('edit')}</button>
              <button class="action-btn danger" data-del="${d.id}" data-name="${d.name}">${icon('trash')} ${t('delete')}</button>
            </div>
          </td>
        </tr>
      `)}
    `);

    $$('[data-edit]', tbody).forEach((b) => {
      b.addEventListener('click', () => {
        const d = departments.find((item) => String(item.id) === b.dataset.edit);
        if (d) openDeptModal(d);
      });
    });

    $$('[data-del]', tbody).forEach((b) => {
      b.addEventListener('click', async () => {
        const ok = await confirmDialog(
          `${t('delete')} ${b.dataset.name}?`,
          `Are you sure you want to delete this department? Employees assigned to it must be reassigned first.`,
          { danger: true, confirmLabel: t('delete') }
        );
        if (!ok) return;
        try {
          await del(`/departments/${b.dataset.del}`);
          toast(`Department "${b.dataset.name}" deleted`);
          load();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      });
    });
  }

  function openDeptModal(dept = null) {
    const isEdit = Boolean(dept);
    modal({
      title: isEdit ? `${t('edit')} ${t('department')}` : `${t('add')} ${t('department')}`,
      submitLabel: t('save'),
      body: html`
        <div class="form-grid">
          <label class="wide">Department Name
            <input type="text" name="name" required value="${dept?.name || ''}" placeholder="e.g. Accounts & Finance">
          </label>
          <label>Department Code
            <input type="text" name="code" value="${dept?.code || ''}" placeholder="e.g. ACC">
          </label>
          <label>Active Status
            <select name="active">
              <option value="true" ${dept?.active !== false ? 'selected' : ''}>${t('active')}</option>
              <option value="false" ${dept?.active === false ? 'selected' : ''}>${t('inactive')}</option>
            </select>
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        const payload = {
          name: form.name.value.trim(),
          code: form.code.value.trim() || null,
          active: form.active.value === 'true',
        };
        if (isEdit) {
          await put(`/departments/${dept.id}`, payload);
          toast('Department updated');
        } else {
          await post('/departments', payload);
          toast('Department added');
        }
        close();
        load();
      },
    });
  }

  $('#add-dept')?.addEventListener('click', () => openDeptModal());
  $('#dept-search')?.addEventListener('input', renderTable);

  load();
}

