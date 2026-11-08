// App shell: session, 17-module navigation, dark/light theme, EN/BN localization, notifications bell.
import { api, get, post, setAuthHandlers } from './api.js';
import { html, setHTML, $, $$, esc, icon, toast, modal, ago } from './ui.js';
import { pushState, enablePush, disablePush } from './push.js';
import { t, getLang, setLang } from './i18n.js';

const app = $('#app');
export const state = { user: null, meta: null };

const ALL_ROLES = ['admin', 'company_admin', 'super_admin', 'hr_manager', 'hr_executive', 'hr', 'accounts_manager', 'dept_manager', 'employee', 'staff'];
const ADMIN_HR = ['admin', 'company_admin', 'super_admin', 'hr_manager', 'hr_executive', 'hr'];
const ADMIN_ONLY = ['admin', 'company_admin', 'super_admin'];

const NAV = [
  { path: '/', key: 'overview', label: 'Overview', icon: 'home', roles: ALL_ROLES },
  { path: '/attendance', key: 'attendance', label: 'Attendance', icon: 'clock', roles: ALL_ROLES },
  { path: '/live-attendance', key: 'liveAttendance', label: 'Live Attendance', icon: 'live', roles: ['admin', 'company_admin', 'super_admin', 'hr_manager', 'hr_executive', 'hr', 'dept_manager'] },
  { path: '/employees', key: 'employees', label: 'Employees', icon: 'people', roles: ADMIN_HR },
  { path: '/departments', key: 'departments', label: 'Departments', icon: 'department', roles: ADMIN_HR },
  { path: '/designations', key: 'designations', label: 'Designations', icon: 'designation', roles: ADMIN_HR },
  { path: '/shifts', key: 'shifts', label: 'Shift Management', icon: 'shift', roles: ADMIN_HR },
  { path: '/leave', key: 'leave', label: 'Leave Management', icon: 'leave', roles: ALL_ROLES },
  { path: '/holidays', key: 'holidays', label: 'Holiday Calendar', icon: 'holiday', roles: ALL_ROLES },
  { path: '/payroll', key: 'payroll', label: 'Payroll Management', icon: 'pay', roles: ['admin', 'company_admin', 'super_admin', 'hr_manager', 'accounts_manager', 'employee', 'staff'] },
  { path: '/overtime', key: 'overtime', label: 'Overtime', icon: 'overtime', roles: ['admin', 'company_admin', 'super_admin', 'hr_manager', 'hr_executive', 'hr', 'accounts_manager', 'dept_manager'] },
  { path: '/reports', key: 'reports', label: 'Reports & Analytics', icon: 'report', roles: ['admin', 'company_admin', 'super_admin', 'hr_manager', 'hr_executive', 'hr', 'accounts_manager'] },
  { path: '/devices', key: 'devices', label: 'Biometric Devices', icon: 'device', roles: ADMIN_ONLY },
  { path: '/roles', key: 'roles', label: 'Users & Roles', icon: 'role', roles: ADMIN_ONLY },
  { path: '/notifications', key: 'notifications', label: 'Notifications', icon: 'bell', roles: ALL_ROLES },
  { path: '/audit-logs', key: 'auditLogs', label: 'Audit Logs', icon: 'audit', roles: ['admin', 'company_admin', 'super_admin', 'hr_manager'] },
  { path: '/settings', key: 'settings', label: 'Settings', icon: 'gear', roles: ADMIN_HR },
];

const V = '3.8';
const PAGES = {
  '/': () => import(`./pages/dashboard.js?v=${V}`),
  '/attendance': () => import(`./pages/attendance.js?v=${V}`),
  '/live-attendance': () => import(`./pages/live-attendance.js?v=${V}`),
  '/employees': () => import(`./pages/employees.js?v=${V}`),
  '/departments': () => import(`./pages/departments.js?v=${V}`),
  '/designations': () => import(`./pages/designations.js?v=${V}`),
  '/shifts': () => import(`./pages/shifts.js?v=${V}`),
  '/leave': () => import(`./pages/leave.js?v=${V}`),
  '/holidays': () => import(`./pages/holidays.js?v=${V}`),
  '/payroll': () => import(`./pages/payroll.js?v=${V}`),
  '/overtime': () => import(`./pages/overtime.js?v=${V}`),
  '/reports': () => import(`./pages/reports.js?v=${V}`),
  '/devices': () => import(`./pages/devices.js?v=${V}`),
  '/roles': () => import(`./pages/roles.js?v=${V}`),
  '/notifications': () => import(`./pages/notifications.js?v=${V}`),
  '/audit-logs': () => import(`./pages/audit.js?v=${V}`),
  '/settings': () => import(`./pages/settings.js?v=${V}`),
};

let cleanup = null;
let pollTimer = null;

// Theme Initialization
const savedTheme = localStorage.getItem('jmcl_theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);

export function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('jmcl_theme', next);
  updateThemeIcon();
}

function updateThemeIcon() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const btn = $('#theme-toggle');
  if (btn) {
    setHTML(btn, isDark ? icon('sun') : icon('moon'));
    btn.setAttribute('title', isDark ? t('lightMode') : t('darkMode'));
  }
}

/* ---------- routing ---------- */
export function navigate(path, replace = false) {
  if (location.pathname === path) return render();
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  render();
}
window.addEventListener('popstate', () => render());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

async function render() {
  if (!state.user) return showLogin();

  const uRole = state.user.role;
  const nav = NAV.filter((n) => n.roles.includes(uRole));
  let path = location.pathname.replace(/\/$/, '') || '/';
  const item = nav.find((n) => n.path === path);
  if (!item) { path = '/'; history.replaceState({}, '', '/'); }

  if (!$('.shell')) buildShell(nav);
  $$('.nav a').forEach((a) => (a.getAttribute('href') === path ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const cur = nav.find((n) => n.path === path);
  const localizedLabel = t(cur.key) || cur.label;
  $('#page-title').textContent = localizedLabel;
  document.title = `${localizedLabel} · ${state.meta.company || 'Jeans Manufacturing Company Ltd.'}`;

  const view = $('#view');
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  setHTML(view, html`<p class="muted">${t('loading')}</p>`);
  try {
    const mod = await PAGES[path]();
    if ((location.pathname.replace(/\/$/, '') || '/') !== path) return; // navigated away
    cleanup = (await mod.render(view, state)) || null;
  } catch (err) {
    setHTML(view, html`<div class="notice bad">${err.message || 'This page could not be loaded.'}</div>`);
  }
  view.focus?.({ preventScroll: true });
  window.scrollTo(0, 0);
}

function buildShell(nav) {
  const u = state.user;
  const isCollapsed = localStorage.getItem('jmcl_sidebar_collapsed') === 'true';

  setHTML(app, html`
    <div class="shell ${isCollapsed ? 'collapsed' : ''}">
      <aside class="sidebar">
        <div class="brand">
          <img src="/icons/icon-192.png" alt="">
          <span>${state.meta.company || 'Jeans Manufacturing Company Ltd.'}</span>
        </div>
        <nav class="nav" aria-label="Main">
          ${nav.map((n) => html`
            <a href="${n.path}" data-link title="${t(n.key) || n.label}">
              ${icon(n.icon)}
              <span>${t(n.key) || n.label}</span>
            </a>
          `)}
        </nav>
        <div class="side-foot">
          <strong>${u.name}</strong>
          <span class="role-desc muted small">${u.role.replace('_', ' ').toUpperCase()}</span>
          <div class="row" style="margin-top:8px">
            <button id="pw">${t('changePassword')}</button>
            <button id="logout">${t('signOut')}</button>
          </div>
        </div>
      </aside>
      <div class="main">
        <div class="topbar">
          <button class="icon-btn" id="sidebar-toggle" title="${t('collapseSidebar')}">
            ${icon('menu')}
          </button>
          <h1 id="page-title"></h1>
          <span class="date" id="today"></span>

          <div class="topbar-actions">
            <button class="pill-btn" id="lang-toggle" title="${t('language')}">
              ${icon('globe')}
              <span>${getLang() === 'en' ? 'বাংলা' : 'English'}</span>
            </button>
            <button class="icon-btn" id="theme-toggle" title="${t('darkMode')}">
              ${icon('moon')}
            </button>
            <button class="bell" id="bell" aria-label="Notifications" aria-haspopup="dialog">
              ${icon('bell')}
              <span class="count" id="bell-count" hidden></span>
            </button>
          </div>
        </div>
        <main class="view" id="view" tabindex="-1"></main>
      </div>
    </div>`);

  $('#today').textContent = new Date().toLocaleDateString(getLang() === 'bn' ? 'bn-BD' : 'en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: state.meta.timezone || 'Asia/Dhaka'
  });

  $('#sidebar-toggle').addEventListener('click', () => {
    const s = $('.shell');
    s.classList.toggle('collapsed');
    localStorage.setItem('jmcl_sidebar_collapsed', s.classList.contains('collapsed'));
  });

  $('#theme-toggle').addEventListener('click', toggleTheme);
  updateThemeIcon();

  $('#lang-toggle').addEventListener('click', () => {
    const nextLang = getLang() === 'en' ? 'bn' : 'en';
    setLang(nextLang);
    location.reload();
  });

  $('#logout').addEventListener('click', logout);
  $('#pw').addEventListener('click', () => showChangePassword(false));
  $('#bell').addEventListener('click', toggleNotifications);

  startBellPolling();
}

/* ---------- auth screens ---------- */
function showLogin() {
  stopBellPolling();
  const m = state.meta;
  const demoAccounts = [['Admin', 'admin@company.test']];

  setHTML(app, html`
    <div class="login">
      <div class="login-art">
        <div class="brand">
          <img src="/icons/icon-192.png" alt="">
          <span>${m.company || 'JMCL Staff Flow Pro'}</span>
        </div>
        <div>
          <h2>Enterprise HRM, Biometric Attendance &amp; Payroll System</h2>
          <div class="mini-ribbon" aria-hidden="true">
            <div><i style="left:18%;width:56%"></i></div>
            <div><i class="l" style="left:30%;width:12%"></i><i style="left:42%;width:42%"></i></div>
            <div><i style="left:16%;width:52%"></i><i class="o" style="left:68%;width:14%"></i></div>
            <div><i style="left:20%;width:50%"></i></div>
          </div>
          <p>Real-time ZKTeco biometric sync, itemized Bangladeshi payroll engine, overnight shifts, and complete workforce intelligence.</p>
        </div>
        <span class="small" style="color:#7F91A3">Timezone: ${m.timezone || 'Asia/Dhaka'}</span>
      </div>
      <div class="login-form">
        <form id="login" novalidate>
          <div>
            <h1>Sign in</h1>
            <p class="muted">Enter your administrator or staff credentials to access JMCL Staff Flow Pro.</p>
          </div>
          <label>Email Address
            <input type="email" name="email" autocomplete="username" required autofocus placeholder="admin@company.test">
          </label>
          <label>Password
            <input type="password" name="password" autocomplete="current-password" required placeholder="••••••••">
          </label>
          <div class="notice bad" id="login-error" hidden></div>
          <button class="btn primary" type="submit" style="width:100%; margin-top:8px;">Sign in to Dashboard</button>
          
          <div style="margin-top: 14px; text-align: center;">
            <p class="small muted">System Administrator: <b>admin@company.test</b></p>
          </div>
        </form>
      </div>
    </div>`);

  const form = $('#login');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error'); err.hidden = true;
    const btn = $('button[type=submit]', form); btn.disabled = true;
    try {
      const { user } = await post('/auth/login', { email: form.email.value.trim(), password: form.password.value });
      state.user = user;
      history.replaceState({}, '', '/');
      render();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

function showChangePassword(forced) {
  const m = modal({
    title: forced ? 'Set a new password to continue' : 'Change password',
    submitLabel: 'Update password',
    narrow: true,
    body: html`
      ${forced ? html`<p class="muted">Your password was set by an administrator. Choose your own secure password before using the app.</p>` : ''}
      <label>Current password<input type="password" name="currentPassword" autocomplete="current-password" required></label>
      <label>New password<input type="password" name="newPassword" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters.</span></label>
      <label>Repeat new password<input type="password" name="again" autocomplete="new-password" required></label>`,
    onSubmit: async (f, close) => {
      if (f.newPassword.value !== f.again.value) throw new Error('The new passwords do not match');
      await post('/auth/change-password', { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value });
      state.user.mustChangePassword = false;
      close();
      toast('Password updated');
      render();
    },
  });
  if (forced) {
    $('[data-close]', m.form).hidden = true;
    $$('[data-close]', m.form).forEach((b) => (b.style.display = 'none'));
  }
}

async function logout() {
  await post('/auth/logout').catch(() => { });
  state.user = null;
  cleanupAll();
  showLogin();
}

function cleanupAll() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  stopBellPolling();
}

/* ---------- notifications ---------- */
async function refreshBell() {
  try {
    const { unread } = await get('/notifications');
    const c = $('#bell-count');
    if (!c) return;
    c.textContent = unread > 99 ? '99+' : unread;
    c.hidden = !unread;
  } catch { /* ignore transient errors */ }
}
function startBellPolling() { stopBellPolling(); refreshBell(); pollTimer = setInterval(refreshBell, 30_000); }
function stopBellPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

async function toggleNotifications() {
  const existing = $('#notif-pop');
  if (existing) { existing.remove(); return; }
  const pop = document.createElement('div');
  pop.id = 'notif-pop';
  pop.className = 'panel-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Notifications');
  document.body.appendChild(pop);
  const close = (e) => { if (!pop.contains(e.target) && !e.target.closest('#bell')) { pop.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
  await drawNotifications(pop);
}

async function drawNotifications(pop) {
  const { notifications } = await get('/notifications');
  setHTML(pop, html`
    <header>
      <h2>${t('notifications')}</h2>
      <button class="btn sm" id="read-all">Mark all read</button>
    </header>
    ${notifications.length ? notifications.map((n) => html`
      <div class="notif ${n.severity} ${n.read_at ? 'read' : ''}" data-id="${n.id}" data-url="${n.url}" tabindex="0" role="button">
        <span class="dot"></span>
        <div>
          <b>${n.title}</b>
          <span class="small">${n.body}</span>
          <div class="small muted">${ago(n.created_at)}</div>
        </div>
      </div>`) : html`<div class="empty">No notifications yet.</div>`}`);
  $('#read-all', pop)?.addEventListener('click', async () => {
    await post('/notifications/read-all');
    refreshBell();
    drawNotifications(pop);
  });
  $$('.notif[data-id]', pop).forEach((el) => {
    const go = async () => {
      await post(`/notifications/${el.dataset.id}/read`).catch(() => { });
      refreshBell();
      pop.remove();
      navigate(el.dataset.url || '/');
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

/* ---------- boot ---------- */
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
  setAuthHandlers(
    () => {
      if (state.user) {
        state.user = null;
        cleanupAll();
        toast('Your session has expired. Please sign in again.', 'bad');
        showLogin();
      }
    },
    () => {
      if (state.user) {
        state.user.mustChangePassword = true;
        render();
      }
    }
  );
  try {
    state.meta = await get('/meta');
  } catch (e) {
    setHTML(app, html`<div class="view"><div class="notice bad">${e.message}</div></div>`);
    return;
  }
  try {
    state.user = (await get('/auth/me')).user;
  } catch {
    state.user = null;
  }
  render();
}
boot();
