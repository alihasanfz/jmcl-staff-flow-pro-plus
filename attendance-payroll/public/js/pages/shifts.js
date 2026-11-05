// Shift Management: Full CRUD with Overnight & Night Shift support
import { get, post, put, del } from '../api.js';
import { html, setHTML, $, $$, esc, icon, badge, toast, modal, confirmDialog } from '../ui.js';
import { t } from '../i18n.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function render(view) {
  setHTML(view, html`
    <div class="stack">
      <div class="row between">
        <div>
          <h2>${t('shifts')}</h2>
          <p class="muted">Configure work schedules, start/end hours, overnight shifts, grace periods, and weekly holidays.</p>
        </div>
        <button class="btn primary" id="add-shift">${icon('plus')} ${t('add')} ${t('shift')}</button>
      </div>

      <div class="panel">
        <header>
          <div class="search-input-wrap">
            ${icon('search')}
            <input type="text" id="shift-search" placeholder="${t('search')} ${t('shifts')}...">
          </div>
          <span class="small muted" id="shift-count"></span>
        </header>
        <div class="body flush">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Shift Name</th>
                  <th>Hours (Start – End)</th>
                  <th>Type</th>
                  <th>Break</th>
                  <th>Grace Period</th>
                  <th>Weekly Off</th>
                  <th>Employees</th>
                  <th class="r">${t('actions')}</th>
                </tr>
              </thead>
              <tbody id="shift-tbody">
                <tr><td colspan="8" class="empty">${t('loading')}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `);

  let shifts = [];

  async function load() {
    try {
      const res = await get('/org/shifts');
      shifts = res.shifts || [];
      renderTable();
    } catch (e) {
      setHTML($('#shift-tbody'), html`<tr><td colspan="8" class="empty notice bad">${e.message}</td></tr>`);
    }
  }

  function renderTable() {
    const q = ($('#shift-search')?.value || '').toLowerCase().trim();
    const filtered = shifts.filter((s) => !q || s.name.toLowerCase().includes(q));

    $('#shift-count').textContent = `${filtered.length} shift(s)`;

    const tbody = $('#shift-tbody');
    if (!filtered.length) {
      setHTML(tbody, html`<tr><td colspan="8" class="empty">${t('noData')}</td></tr>`);
      return;
    }

    setHTML(tbody, html`
      ${filtered.map((s) => {
        const offStr = (s.weekly_off || []).map((d) => DAYS[d]).join(', ') || 'None';
        const isNight = Boolean(s.is_night_shift);
        return html`
          <tr>
            <td><b>${s.name}</b></td>
            <td><b class="time">${s.start_time}</b> – <b class="time">${s.end_time}</b></td>
            <td>
              <span class="badge ${isNight ? 'leave' : 'waiting'}">
                ${isNight ? 'Night / Cross-Midnight' : 'Day Regular'}
              </span>
            </td>
            <td>${s.break_minutes} min</td>
            <td><span class="small">Late: ${s.grace_minutes}m · Early: ${s.early_out_grace_minutes}m</span></td>
            <td><span class="badge weekend">${offStr}</span></td>
            <td><span class="small">${s.employees || 0} employees</span></td>
            <td class="r">
              <div class="action-btns">
                <button class="action-btn" data-edit="${s.id}">${icon('edit')} ${t('edit')}</button>
                <button class="action-btn danger" data-del="${s.id}" data-name="${s.name}">${icon('trash')} ${t('delete')}</button>
              </div>
            </td>
          </tr>
        `;
      })}
    `);

    $$('[data-edit]', tbody).forEach((b) => {
      b.addEventListener('click', () => {
        const s = shifts.find((item) => String(item.id) === b.dataset.edit);
        if (s) openShiftModal(s);
      });
    });

    $$('[data-del]', tbody).forEach((b) => {
      b.addEventListener('click', async () => {
        const ok = await confirmDialog(
          `${t('delete')} ${b.dataset.name}?`,
          `Are you sure you want to delete this shift? Employees assigned to it must be reassigned first.`,
          { danger: true, confirmLabel: t('delete') }
        );
        if (!ok) return;
        try {
          await del(`/org/shifts/${b.dataset.del}`);
          toast(`Shift "${b.dataset.name}" deleted`);
          load();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      });
    });
  }

  function openShiftModal(shift = null) {
    const isEdit = Boolean(shift);
    const weeklyOff = shift?.weekly_off || [5]; // default Friday off in Bangladesh

    modal({
      title: isEdit ? `${t('edit')} ${t('shift')}` : `${t('add')} ${t('shift')}`,
      submitLabel: t('save'),
      body: html`
        <div class="form-grid">
          <label class="wide">Shift Name
            <input type="text" name="name" required value="${shift?.name || ''}" placeholder="e.g. Regular Day (09:00 - 18:00)">
          </label>
          <label>Start Time
            <input type="time" name="startTime" required value="${shift?.start_time || '09:00'}">
          </label>
          <label>End Time
            <input type="time" name="endTime" required value="${shift?.end_time || '18:00'}">
          </label>
          <label class="wide check" style="margin-top: 4px;">
            <input type="checkbox" name="isNightShift" ${shift?.is_night_shift ? 'checked' : ''}>
            <span>Night / Cross-Midnight Shift (shift ends the following day)</span>
          </label>
          <label>Break Duration (min)
            <input type="number" name="breakMinutes" min="0" max="240" value="${shift?.break_minutes ?? 60}">
          </label>
          <label>Late Grace Period (min)
            <input type="number" name="graceMinutes" min="0" max="120" value="${shift?.grace_minutes ?? 15}">
          </label>
          <label>Early Departure Grace (min)
            <input type="number" name="earlyOutGraceMinutes" min="0" max="120" value="${shift?.early_out_grace_minutes ?? 15}">
          </label>
          <label>Overtime After (min)
            <input type="number" name="overtimeAfterMinutes" min="0" max="240" value="${shift?.overtime_after_minutes ?? 30}">
          </label>
          <div class="wide">
            <span class="small muted" style="display:block; margin-bottom: 6px;">Weekly Holidays / Off Days</span>
            <div class="checks">
              ${DAYS.map((dayName, idx) => html`
                <label class="check">
                  <input type="checkbox" name="weeklyOff" value="${idx}" ${weeklyOff.includes(idx) ? 'checked' : ''}>
                  ${dayName}
                </label>
              `)}
            </div>
          </div>
        </div>
      `,
      onSubmit: async (form, close) => {
        const offDays = $$('input[name=weeklyOff]:checked', form).map((cb) => parseInt(cb.value, 10));
        const payload = {
          name: form.name.value.trim(),
          startTime: form.startTime.value,
          endTime: form.endTime.value,
          breakMinutes: parseInt(form.breakMinutes.value, 10) || 0,
          graceMinutes: parseInt(form.graceMinutes.value, 10) || 0,
          earlyOutGraceMinutes: parseInt(form.earlyOutGraceMinutes.value, 10) || 0,
          overtimeAfterMinutes: parseInt(form.overtimeAfterMinutes.value, 10) || 0,
          weeklyOff: offDays,
          isNightShift: form.isNightShift.checked,
        };

        if (isEdit) {
          await put(`/org/shifts/${shift.id}`, payload);
          toast('Shift updated');
        } else {
          await post('/org/shifts', payload);
          toast('Shift created');
        }
        close();
        load();
      },
    });
  }

  $('#add-shift').addEventListener('click', () => openShiftModal());
  $('#shift-search').addEventListener('input', renderTable);

  load();
}

