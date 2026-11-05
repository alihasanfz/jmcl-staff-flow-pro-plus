// Audit Logs: System Activity & Security Trails
import { get } from '../api.js';
import { html, setHTML, $, $$, esc, icon, badge, toast, modal, fmtDateLong, ago } from '../ui.js';
import { t } from '../i18n.js';

export async function render(view) {
  setHTML(view, html`
    <div class="stack">
      <div class="row between">
        <div>
          <h2>${t('auditLogs')}</h2>
          <p class="muted">Immutable forensic audit trail of all administrative actions, employee updates, and payroll edits.</p>
        </div>
        <button class="btn sm" id="refresh-audit">${icon('clock')} ${t('refresh')}</button>
      </div>

      <div class="panel">
        <header>
          <div class="row">
            <select id="audit-entity-filter" style="width:auto">
              <option value="">${t('all')} Entities</option>
              <option value="user">Users &amp; Employees</option>
              <option value="attendance">Attendance</option>
              <option value="department">Departments</option>
              <option value="designation">Designations</option>
              <option value="payroll_run">Payroll Runs</option>
              <option value="device">Biometric Devices</option>
              <option value="settings">System Settings</option>
            </select>
            <div class="search-input-wrap">
              ${icon('search')}
              <input type="text" id="audit-search" placeholder="${t('search')} actions, actors...">
            </div>
          </div>
          <span class="small muted" id="audit-count"></span>
        </header>
        <div class="body flush">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Actor (User)</th>
                  <th>Action</th>
                  <th>Target Entity</th>
                  <th>Details &amp; Audit Data</th>
                </tr>
              </thead>
              <tbody id="audit-tbody">
                <tr><td colspan="5" class="empty">${t('loading')}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `);

  let logs = [];

  async function load() {
    const entity = $('#audit-entity-filter')?.value || '';
    try {
      const url = entity ? `/audit-logs?entity=${entity}&limit=200` : '/audit-logs?limit=200';
      const res = await get(url).catch(() => get('/settings/audit').then((r) => ({ logs: r.entries })));
      logs = res.logs || [];
      renderTable();
    } catch (e) {
      setHTML($('#audit-tbody'), html`<tr><td colspan="5" class="empty notice bad">${e.message}</td></tr>`);
    }
  }

  function renderTable() {
    const q = ($('#audit-search')?.value || '').toLowerCase().trim();
    const filtered = logs.filter((l) => {
      if (!q) return true;
      return (l.actor || '').toLowerCase().includes(q) ||
        (l.action || '').toLowerCase().includes(q) ||
        (l.entity || '').toLowerCase().includes(q) ||
        JSON.stringify(l.detail || {}).toLowerCase().includes(q);
    });

    $('#audit-count').textContent = `${filtered.length} audit entry(ies)`;
    const tbody = $('#audit-tbody');

    if (!filtered.length) {
      setHTML(tbody, html`<tr><td colspan="5" class="empty">${t('noData')}</td></tr>`);
      return;
    }

    setHTML(tbody, html`
      ${filtered.map((l) => {
        const isCritical = ['delete', 'reset-password'].includes(l.action);
        const isCreate = ['create', 'finalize'].includes(l.action);

        return html`
          <tr>
            <td>
              <b class="time">${new Date(l.at).toLocaleTimeString('en-GB')}</b>
              <div class="small muted">${fmtDateLong(l.at)} (${ago(l.at)})</div>
            </td>
            <td>
              <b>${l.actor || 'System Automation'}</b>
              <div class="small muted">${l.actor_email || ''}</div>
            </td>
            <td>
              <span class="badge ${isCritical ? 'absent' : isCreate ? 'present' : 'waiting'}">
                ${l.action}
              </span>
            </td>
            <td>
              <code>${l.entity}${l.entity_id ? ` #${l.entity_id}` : ''}</code>
            </td>
            <td>
              <button class="action-btn" data-detail="${l.id}">View Payload Diff</button>
            </td>
          </tr>
        `;
      })}
    `);

    $$('[data-detail]', tbody).forEach((b) => {
      b.addEventListener('click', () => {
        const item = logs.find((l) => String(l.id) === b.dataset.detail);
        if (!item) return;
        modal({
          title: `Audit Record #${item.id}: ${item.action} on ${item.entity}`,
          narrow: false,
          body: html`
            <div class="stack">
              <div class="row between">
                <span><b>Actor:</b> ${item.actor || 'System'}</span>
                <span><b>Time:</b> ${new Date(item.at).toLocaleString('en-GB')}</span>
              </div>
              <pre class="secret" style="max-height: 360px; overflow: auto; white-space: pre-wrap;">${JSON.stringify(item.detail || {}, null, 2)}</pre>
            </div>
          `,
        });
      });
    });
  }

  $('#refresh-audit').addEventListener('click', load);
  $('#audit-entity-filter').addEventListener('change', load);
  $('#audit-search').addEventListener('input', renderTable);

  load();
}

