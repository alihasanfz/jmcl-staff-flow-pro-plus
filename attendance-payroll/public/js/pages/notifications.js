// Notifications Center: In-app alerts, device status & push controls
import { get, post } from '../api.js';
import { html, setHTML, $, $$, esc, icon, badge, toast, ago } from '../ui.js';
import { t } from '../i18n.js';
import { pushState, enablePush, disablePush } from '../push.js';

export async function render(view) {
  setHTML(view, html`
    <div class="stack">
      <div class="row between">
        <div>
          <h2>${t('notifications')}</h2>
          <p class="muted">System notifications, biometric punch alerts, leave updates, and device alerts.</p>
        </div>
        <div class="row">
          <button class="btn sm" id="mark-all-read">${icon('check')} Mark all read</button>
        </div>
      </div>

      <div class="panel" id="push-panel" style="display:none">
        <div class="body row between">
          <div>
            <b>Web Push Notifications</b>
            <p class="muted small" id="push-status-text">Receive real-time alerts on your phone or desktop even when the browser is closed.</p>
          </div>
          <div class="row" id="push-actions"></div>
        </div>
      </div>

      <div class="panel">
        <header>
          <div class="row">
            <select id="notif-filter" style="width:auto">
              <option value="">${t('all')} Notifications</option>
              <option value="unread">Unread Only</option>
              <option value="critical">Critical Exceptions</option>
              <option value="warning">Warnings</option>
            </select>
          </div>
          <span class="small muted" id="notif-count"></span>
        </header>
        <div class="body flush">
          <div id="notif-list" class="stack" style="gap:0">
            <div class="empty">${t('loading')}</div>
          </div>
        </div>
      </div>
    </div>
  `);

  let notifications = [];

  async function loadPush() {
    try {
      const ps = await pushState();
      const panel = $('#push-panel');
      const actions = $('#push-actions');
      panel.style.display = '';

      if (ps.enabled) {
        $('#push-status-text').textContent = 'Phone and desktop push alerts are active for this device.';
        setHTML(actions, html`
          <button class="btn sm" id="btn-push-test">Send Test Alert</button>
          <button class="btn sm" id="btn-push-off">Turn Off</button>
        `);
        $('#btn-push-test')?.addEventListener('click', async () => {
          await post('/notifications/push/test');
          toast('Test push sent');
        });
        $('#btn-push-off')?.addEventListener('click', async () => {
          await disablePush();
          toast('Push alerts disabled');
          loadPush();
        });
      } else if (ps.ok) {
        $('#push-status-text').textContent = 'Receive instant alerts when staff are late, absent, or devices disconnect.';
        setHTML(actions, html`<button class="btn sm primary" id="btn-push-on">Enable Push Alerts</button>`);
        $('#btn-push-on')?.addEventListener('click', async () => {
          await enablePush();
          toast('Push alerts enabled');
          loadPush();
        });
      }
    } catch { /* push not supported */ }
  }

  async function load() {
    try {
      const res = await get('/notifications');
      notifications = res.notifications || [];
      renderList();
    } catch (e) {
      setHTML($('#notif-list'), html`<div class="empty notice bad">${e.message}</div>`);
    }
  }

  function renderList() {
    const f = $('#notif-filter').value;
    const filtered = notifications.filter((n) => {
      if (f === 'unread') return !n.read_at;
      if (f === 'critical') return n.severity === 'critical';
      if (f === 'warning') return n.severity === 'warning';
      return true;
    });

    $('#notif-count').textContent = `${filtered.length} notification(s)`;
    const container = $('#notif-list');

    if (!filtered.length) {
      setHTML(container, html`<div class="empty">${t('noData')}</div>`);
      return;
    }

    setHTML(container, html`
      ${filtered.map((n) => html`
        <div class="notif ${n.severity} ${n.read_at ? 'read' : ''}" data-id="${n.id}" data-url="${n.url || ''}">
          <span class="dot"></span>
          <div class="grow">
            <div class="row between">
              <b>${n.title}</b>
              <span class="small muted">${ago(n.created_at)}</span>
            </div>
            <div class="small" style="margin-top:2px;">${n.body}</div>
          </div>
        </div>
      `)}
    `);

    $$('.notif[data-id]', container).forEach((el) => {
      el.addEventListener('click', async () => {
        try {
          await post(`/notifications/${el.dataset.id}/read`);
          el.classList.add('read');
        } catch { /* ignore */ }
        if (el.dataset.url) {
          window.location.pathname = el.dataset.url;
        }
      });
    });
  }

  $('#mark-all-read').addEventListener('click', async () => {
    try {
      await post('/notifications/read-all');
      toast('All notifications marked as read');
      load();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });

  $('#notif-filter').addEventListener('change', renderList);

  loadPush();
  load();
}

