// Designation Management: Full CRUD
import { get, post, put, del } from '../api.js';
import { html, setHTML, $, $$, esc, icon, badge, toast, modal, confirmDialog } from '../ui.js';
import { t } from '../i18n.js';

export async function render(view) {
  let departments = [];
  try {
    const res = await get('/departments');
    departments = res.departments || [];
  } catch { /* ignore */ }

  setHTML(view, html`
    <div class="stack">
      <div class="row between">
        <div>
          <h2>${t('designations')}</h2>
          <p class="muted">Manage employee job titles, ranks, and departmental roles.</p>
        </div>
        <button class="btn primary" id="add-desig">${icon('plus')} ${t('add')} ${t('designation')}</button>
      </div>

      <div class="panel">
        <header>
          <div class="row">
            <div class="search-input-wrap">
              ${icon('search')}
              <input type="text" id="desig-search" placeholder="${t('search')} ${t('designations')}...">
            </div>
            <select id="desig-dept-filter" style="width:auto">
              <option value="">${t('all')} ${t('departments')}</option>
              ${departments.map((d) => html`<option value="${d.id}">${d.name}</option>`)}
            </select>
          </div>
          <span class="small muted" id="desig-count"></span>
        </header>
        <div class="body flush">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Designation Title</th>
                  <th>Code</th>
                  <th>Department</th>
                  <th>Employees</th>
                  <th>Status</th>
                  <th class="r">${t('actions')}</th>
                </tr>
              </thead>
              <tbody id="desig-tbody">
                <tr><td colspan="6" class="empty">${t('loading')}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `);

  let designations = [];

  async function load() {
    try {
      const res = await get('/designations');
      designations = res.designations || [];
      renderTable();
    } catch (e) {
      setHTML($('#desig-tbody'), html`<tr><td colspan="6" class="empty notice bad">${e.message}</td></tr>`);
    }
  }

  function renderTable() {
    const q = ($('#desig-search')?.value || '').toLowerCase().trim();
    const deptId = $('#desig-dept-filter')?.value || '';
    const filtered = designations.filter((d) => {
      const matchesSearch = !q || d.title.toLowerCase().includes(q) || (d.code && d.code.toLowerCase().includes(q));
      const matchesDept = !deptId || String(d.department_id) === deptId;
      return matchesSearch && matchesDept;
    });

    $('#desig-count').textContent = `${filtered.length} designation(s)`;

    const tbody = $('#desig-tbody');
    if (!filtered.length) {
      setHTML(tbody, html`<tr><td colspan="6" class="empty">${t('noData')}</td></tr>`);
      return;
    }

    setHTML(tbody, html`
      ${filtered.map((d) => html`
        <tr>
          <td><b>${d.title}</b></td>
          <td><code>${d.code || '—'}</code></td>
          <td><span class="badge waiting">${d.department_name || 'General'}</span></td>
          <td><span class="small">${d.employee_count || 0} employees</span></td>
          <td><span class="badge ${d.active ? 'active' : 'inactive'}">${d.active ? t('active') : t('inactive')}</span></td>
          <td class="r">
            <div class="action-btns">
              <button class="action-btn" data-edit="${d.id}">${icon('edit')} ${t('edit')}</button>
              <button class="action-btn danger" data-del="${d.id}" data-title="${d.title}">${icon('trash')} ${t('delete')}</button>
            </div>
          </td>
        </tr>
      `)}
    `);

    $$('[data-edit]', tbody).forEach((b) => {
      b.addEventListener('click', () => {
        const d = designations.find((item) => String(item.id) === b.dataset.edit);
        if (d) openDesigModal(d);
      });
    });

    $$('[data-del]', tbody).forEach((b) => {
      b.addEventListener('click', async () => {
        const ok = await confirmDialog(
          `${t('delete')} ${b.dataset.title}?`,
          `Are you sure you want to delete this designation? Employees assigned to it must be updated first.`,
          { danger: true, confirmLabel: t('delete') }
        );
        if (!ok) return;
        try {
          await del(`/designations/${b.dataset.del}`);
          toast(`Designation "${b.dataset.title}" deleted`);
          load();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      });
    });
  }

  function openDesigModal(desig = null) {
    const isEdit = Boolean(desig);
    modal({
      title: isEdit ? `${t('edit')} ${t('designation')}` : `${t('add')} ${t('designation')}`,
      submitLabel: t('save'),
      body: html`
        <div class="form-grid">
          <label class="wide">Designation Title
            <input type="text" name="title" required value="${desig?.title || ''}" placeholder="e.g. Senior Software Engineer">
          </label>
          <label>Designation Code
            <input type="text" name="code" value="${desig?.code || ''}" placeholder="e.g. SSE">
          </label>
          <label>Department
            <select name="department_id">
              <option value="">General (No Department)</option>
              ${departments.map((d) => html`
                <option value="${d.id}" ${desig && desig.department_id === d.id ? 'selected' : ''}>${d.name}</option>
              `)}
            </select>
          </label>
          <label class="wide">Active Status
            <select name="active">
              <option value="true" ${desig?.active !== false ? 'selected' : ''}>${t('active')}</option>
              <option value="false" ${desig?.active === false ? 'selected' : ''}>${t('inactive')}</option>
            </select>
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        const payload = {
          title: form.title.value.trim(),
          code: form.code.value.trim() || null,
          department_id: form.department_id.value ? parseInt(form.department_id.value, 10) : null,
          active: form.active.value === 'true',
        };
        if (isEdit) {
          await put(`/designations/${desig.id}`, payload);
          toast('Designation updated');
        } else {
          await post('/designations', payload);
          toast('Designation added');
        }
        close();
        load();
      },
    });
  }

  $('#add-desig').addEventListener('click', () => openDesigModal());
  $('#desig-search').addEventListener('input', renderTable);
  $('#desig-dept-filter').addEventListener('change', renderTable);

  load();
}

