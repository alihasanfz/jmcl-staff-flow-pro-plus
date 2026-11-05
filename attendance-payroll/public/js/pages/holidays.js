// Holiday Calendar: Full CRUD & Yearly View
import { get, post, del } from '../api.js';
import { html, setHTML, $, $$, esc, icon, badge, toast, modal, confirmDialog, fmtDateLong } from '../ui.js';
import { t } from '../i18n.js';

export async function render(view) {
  const currentYear = new Date().getFullYear();

  setHTML(view, html`
    <div class="stack">
      <div class="row between">
        <div>
          <h2>${t('holidays')}</h2>
          <p class="muted">Manage official company holidays and recognized public holidays.</p>
        </div>
        <div class="row">
          <button class="btn" id="load-bd-preset">${icon('plus')} Add BD Holidays Preset</button>
          <button class="btn primary" id="add-holiday">${icon('plus')} ${t('add')} ${t('holiday')}</button>
        </div>
      </div>

      <div class="panel">
        <header>
          <div class="row">
            <label style="min-width: 120px;">
              Year
              <select id="holiday-year" style="width: auto">
                ${[currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map((y) => html`
                  <option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}</option>
                `)}
              </select>
            </label>
            <div class="search-input-wrap">
              ${icon('search')}
              <input type="text" id="holiday-search" placeholder="${t('search')} ${t('holidays')}...">
            </div>
          </div>
          <span class="small muted" id="holiday-count"></span>
        </header>
        <div class="body flush">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Holiday Date</th>
                  <th>Day</th>
                  <th>Holiday Occasion / Name</th>
                  <th>Timeline</th>
                  <th class="r">${t('actions')}</th>
                </tr>
              </thead>
              <tbody id="holiday-tbody">
                <tr><td colspan="5" class="empty">${t('loading')}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `);

  let holidays = [];

  async function load() {
    const yr = $('#holiday-year').value;
    try {
      const res = await get(`/org/holidays?year=${yr}`);
      holidays = res.holidays || [];
      renderTable();
    } catch (e) {
      setHTML($('#holiday-tbody'), html`<tr><td colspan="5" class="empty notice bad">${e.message}</td></tr>`);
    }
  }

  function renderTable() {
    const q = ($('#holiday-search')?.value || '').toLowerCase().trim();
    const filtered = holidays.filter((h) => !q || h.name.toLowerCase().includes(q) || h.date.includes(q));

    $('#holiday-count').textContent = `${filtered.length} holiday(s)`;

    const tbody = $('#holiday-tbody');
    if (!filtered.length) {
      setHTML(tbody, html`<tr><td colspan="5" class="empty">${t('noData')}</td></tr>`);
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);

    setHTML(tbody, html`
      ${filtered.map((h) => {
        const d = new Date(`${h.date}T00:00:00Z`);
        const dayName = d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
        const isPast = h.date < todayStr;
        const isToday = h.date === todayStr;

        return html`
          <tr>
            <td><b class="date">${fmtDateLong(h.date)}</b></td>
            <td><span class="small muted">${dayName}</span></td>
            <td><b>${h.name}</b></td>
            <td>
              <span class="badge ${isToday ? 'present' : isPast ? 'waiting' : 'online'}">
                ${isToday ? 'Today' : isPast ? 'Past' : 'Upcoming'}
              </span>
            </td>
            <td class="r">
              <button class="action-btn danger" data-del="${h.date}" data-name="${h.name}">${icon('trash')} ${t('delete')}</button>
            </td>
          </tr>
        `;
      })}
    `);

    $$('[data-del]', tbody).forEach((b) => {
      b.addEventListener('click', async () => {
        const ok = await confirmDialog(
          `${t('delete')} Holiday?`,
          `Are you sure you want to remove "${b.dataset.name}" on ${b.dataset.del}?`,
          { danger: true, confirmLabel: t('delete') }
        );
        if (!ok) return;
        try {
          await del(`/org/holidays/${b.dataset.del}`);
          toast('Holiday removed');
          load();
        } catch (ex) {
          toast(ex.message, 'bad');
        }
      });
    });
  }

  function openHolidayModal() {
    modal({
      title: `${t('add')} ${t('holiday')}`,
      submitLabel: t('save'),
      body: html`
        <div class="form-grid">
          <label class="wide">Holiday Name / Occasion
            <input type="text" name="name" required placeholder="e.g. Eid-ul-Fitr, Independence Day">
          </label>
          <label class="wide">Date
            <input type="date" name="date" required value="${new Date().toISOString().slice(0, 10)}">
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        await post('/org/holidays', {
          name: form.name.value.trim(),
          date: form.date.value,
        });
        toast('Holiday added');
        close();
        load();
      },
    });
  }

  $('#add-holiday').addEventListener('click', openHolidayModal);
  $('#holiday-year').addEventListener('change', load);
  $('#holiday-search').addEventListener('input', renderTable);

  $('#load-bd-preset').addEventListener('click', async () => {
    const yr = $('#holiday-year').value;
    const ok = await confirmDialog(
      'Load Bangladesh Public Holidays?',
      `Add standard Bangladesh national holidays for year ${yr}? Existing holidays won't be deleted.`
    );
    if (!ok) return;

    const presets = [
      { date: `${yr}-02-21`, name: 'Shaheed Day & International Mother Language Day' },
      { date: `${yr}-03-17`, name: 'Father of the Nation Birthday & Children Day' },
      { date: `${yr}-03-26`, name: 'Independence & National Day' },
      { date: `${yr}-04-14`, name: 'Bengali New Year (Pohela Boishakh)' },
      { date: `${yr}-05-01`, name: 'May Day (International Workers Day)' },
      { date: `${yr}-08-15`, name: 'National Mourning Day' },
      { date: `${yr}-12-16`, name: 'Victory Day (Bijoy Dibosh)' },
      { date: `${yr}-12-25`, name: 'Christmas Day (Bara Din)' },
    ];

    try {
      for (const h of presets) {
        await post('/org/holidays', h);
      }
      toast(`Added Bangladesh public holidays for ${yr}`);
      load();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });

  load();
}

