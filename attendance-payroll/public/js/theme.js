// JMCL Attendance Dashboard — Modern Appearance & Theme Engine
import { html, raw, setHTML, $, $$, modal, toast } from './ui.js';
import { t } from './i18n.js';

export const MODES = [
  {
    id: 'light',
    name: 'Light Mode',
    desc: 'Clean, bright & crisp presentation for daytime work',
    badge: 'Default',
    iconSvg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
  },
  {
    id: 'dark',
    name: 'Dark Mode',
    desc: 'Deep midnight obsidian surfaces for low-light comfort',
    badge: 'Popular',
    iconSvg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
  },
  {
    id: 'system',
    name: 'System Default',
    desc: 'Synchronizes automatically with your OS light/dark theme',
    badge: 'Adaptive',
    iconSvg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`
  },
  {
    id: 'dim',
    name: 'Dim Mode',
    desc: 'Soft slate dark theme, gentle on eyes with reduced glare',
    badge: 'Relaxed',
    iconSvg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>`
  },
  {
    id: 'contrast',
    name: 'High Contrast',
    desc: 'Pure contrast black/white surfaces for maximum accessibility',
    badge: 'WCAG AAA',
    iconSvg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20z"/></svg>`
  },
  {
    id: 'auto',
    name: 'Auto Mode (Scheduled)',
    desc: 'Scheduled: Light mode 06:00–18:00, Dark mode 18:00–06:00',
    badge: 'Smart Time',
    iconSvg: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 6 12 12 16 14"/></svg>`
  }
];

export const ACCENTS = [
  { id: 'blue', name: 'Blue', hex: '#1a68ff', desc: 'Vibrant Azure (Default)' },
  { id: 'indigo', name: 'Indigo', hex: '#6366f1', desc: 'Modern Tech Indigo' },
  { id: 'purple', name: 'Purple', hex: '#9333ea', desc: 'Refined Royal Violet' },
  { id: 'green', name: 'Green', hex: '#16a34a', desc: 'Fresh Emerald Growth' },
  { id: 'teal', name: 'Teal', hex: '#0d9488', desc: 'Clean Cyan Teal' },
  { id: 'slate', name: 'Slate', hex: '#475569', desc: 'Understated Executive' }
];

export function resolveEffectiveTheme(mode) {
  if (mode === 'system') {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  if (mode === 'auto') {
    const h = new Date().getHours();
    return (h >= 6 && h < 18) ? 'light' : 'dark';
  }
  if (['light', 'dark', 'dim', 'contrast'].includes(mode)) {
    return mode;
  }
  return 'light';
}

export function getThemeSettings() {
  const mode = localStorage.getItem('jmcl_theme_mode') || localStorage.getItem('jmcl_theme') || 'light';
  const accent = localStorage.getItem('jmcl_accent') || 'blue';
  const effective = resolveEffectiveTheme(mode);
  return { mode, accent, effective };
}

export function applyTheme(mode, accent, persist = true) {
  const effective = resolveEffectiveTheme(mode);
  document.documentElement.setAttribute('data-theme', effective);
  document.documentElement.setAttribute('data-mode-pref', mode);
  document.documentElement.setAttribute('data-accent', accent);

  if (persist) {
    localStorage.setItem('jmcl_theme_mode', mode);
    localStorage.setItem('jmcl_accent', accent);
    localStorage.setItem('jmcl_theme', effective);
  }

  // Set mobile browser status bar tint
  const metaTheme = $('meta[name="theme-color"]');
  if (metaTheme) {
    if (effective === 'contrast') metaTheme.content = '#000000';
    else if (effective === 'dark') metaTheme.content = '#090e17';
    else if (effective === 'dim') metaTheme.content = '#161b22';
    else metaTheme.content = '#f0f4f9';
  }

  updateTopbarThemeBtn();

  window.dispatchEvent(new CustomEvent('themechange', {
    detail: { mode, accent, effective }
  }));
}

export function updateTopbarThemeBtn() {
  const btn = $('#theme-settings-btn');
  if (!btn) return;
  const { mode, accent, effective } = getThemeSettings();
  const currentModeObj = MODES.find((m) => m.id === mode) || MODES[0];
  const currentAccentObj = ACCENTS.find((a) => a.id === accent) || ACCENTS[0];

  const iconHolder = $('#theme-top-icon', btn);
  if (iconHolder) {
    iconHolder.innerHTML = currentModeObj.iconSvg;
  }
  const dot = $('#theme-swatch-dot', btn);
  if (dot) {
    dot.style.backgroundColor = currentAccentObj.hex;
  }
  const label = $('#theme-top-label', btn);
  if (label) {
    label.textContent = `${currentModeObj.name.split(' ')[0]} ⌵`;
  }
}

export function initThemeEngine() {
  const { mode, accent } = getThemeSettings();
  applyTheme(mode, accent, false);

  // Listen to OS system theme changes
  if (window.matchMedia) {
    try {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      mql.addEventListener('change', () => {
        const cur = getThemeSettings();
        if (cur.mode === 'system') {
          applyTheme('system', cur.accent, false);
        }
      });
    } catch { /* old safari fallback */ }
  }

  // Periodic check for auto scheduled theme (every 30 seconds)
  setInterval(() => {
    const cur = getThemeSettings();
    if (cur.mode === 'auto') {
      const expected = resolveEffectiveTheme('auto');
      if (document.documentElement.getAttribute('data-theme') !== expected) {
        applyTheme('auto', cur.accent, false);
      }
    }
  }, 30000);
}

export function showAppearanceModal() {
  let { mode: currentMode, accent: currentAccent } = getThemeSettings();

  const body = html`
    <div class="appearance-modal-container">
      <!-- Section 1: Display Mode (6 options) -->
      <div class="appearance-group">
        <div class="appearance-group-head">
          <label class="appearance-group-title">${t('displayMode') || 'Display Mode'}</label>
          <span class="appearance-group-hint">Select your preferred viewing mode across all dashboard screens</span>
        </div>
        <div class="appearance-mode-grid" id="mode-selector-grid">
          ${MODES.map((m) => {
            const isSelected = m.id === currentMode;
            return `
              <div class="mode-card ${isSelected ? 'active' : ''}" data-mode-id="${m.id}" role="button" tabindex="0">
                <div class="mode-card-header">
                  <span class="mode-card-icon">${m.iconSvg}</span>
                  <span class="mode-card-badge">${m.badge}</span>
                </div>
                <div class="mode-card-body">
                  <div class="mode-card-title">${m.name}</div>
                  <div class="mode-card-desc">${m.desc}</div>
                </div>
                <div class="mode-card-radio">
                  <div class="radio-indicator"></div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>

      <!-- Section 2: Primary Accent Color (6 options) -->
      <div class="appearance-group">
        <div class="appearance-group-head">
          <label class="appearance-group-title">${t('accentColor') || 'Primary Accent Color'}</label>
          <span class="appearance-group-hint">Choose brand color for buttons, tabs, active highlights & accents</span>
        </div>
        <div class="appearance-accent-grid" id="accent-selector-grid">
          ${ACCENTS.map((a) => {
            const isSelected = a.id === currentAccent;
            return `
              <button type="button" class="accent-card ${isSelected ? 'active' : ''}" data-accent-id="${a.id}">
                <span class="accent-swatch" style="background-color: ${a.hex};">
                  <svg class="accent-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
                <span class="accent-info">
                  <strong class="accent-name">${a.name}</strong>
                  <span class="accent-desc">${a.desc}</span>
                </span>
              </button>
            `;
          }).join('')}
        </div>
      </div>

      <!-- Section 3: Live Theme & Accent Preview -->
      <div class="appearance-group">
        <div class="appearance-group-head">
          <label class="appearance-group-title">${t('themePreview') || 'Theme Preview'}</label>
          <span class="appearance-group-hint">Live demonstration of cards, contrast, buttons and status indicators</span>
        </div>
        <div class="appearance-preview-panel" id="appearance-live-preview">
          <div class="preview-kpi-box">
            <div class="preview-kpi-top">
              <div class="preview-kpi-iconbox">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </div>
              <span class="preview-pct-pill">90% PRESENT</span>
            </div>
            <div class="preview-kpi-lbl">Active Attendance</div>
            <div class="preview-kpi-metric">61 <span class="preview-kpi-total">/ 68 Staff</span></div>
          </div>
          <div class="preview-elements-col">
            <div class="preview-btn-row">
              <button type="button" class="btn btn-primary sm preview-accent-demo-btn">
                <span>Primary Button</span>
              </button>
              <button type="button" class="btn sm preview-secondary-btn">
                <span>Secondary Button</span>
              </button>
            </div>
            <div class="preview-tag-row">
              <span class="status-pill present"><span class="pill-dot"></span> On Time</span>
              <span class="device-tag uface-tag"><span class="device-dot blue"></span> uFace 800</span>
              <span class="status-pill late"><span class="pill-dot"></span> Late (18m)</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer Quick Actions & Status -->
      <div class="appearance-modal-bottom">
        <button type="button" class="btn sm reset-theme-btn" id="reset-theme-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          <span>Reset to Default (Light / Blue)</span>
        </button>
        <div class="appearance-save-badge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          <span>Auto-saved to Local Storage</span>
        </div>
      </div>
    </div>
  `;

  modal({
    title: t('appearanceSettings') || 'Dashboard Appearance & Theme Settings',
    body,
    wide: true,
    cancelLabel: 'Close',
    submitLabel: 'Apply & Close',
    onOpen(form, close) {
      // Setup click handlers for mode cards
      $$('.mode-card', form).forEach((card) => {
        card.addEventListener('click', () => {
          const modeId = card.getAttribute('data-mode-id');
          currentMode = modeId;
          $$('.mode-card', form).forEach((c) => c.classList.remove('active'));
          card.classList.add('active');
          applyTheme(currentMode, currentAccent, true);
        });
      });

      // Setup click handlers for accent cards
      $$('.accent-card', form).forEach((card) => {
        card.addEventListener('click', () => {
          const accentId = card.getAttribute('data-accent-id');
          currentAccent = accentId;
          $$('.accent-card', form).forEach((c) => c.classList.remove('active'));
          card.classList.add('active');
          applyTheme(currentMode, currentAccent, true);
        });
      });

      // Reset to defaults
      const resetBtn = $('#reset-theme-btn', form);
      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          currentMode = 'light';
          currentAccent = 'blue';
          applyTheme('light', 'blue', true);
          $$('.mode-card', form).forEach((c) => c.classList.toggle('active', c.getAttribute('data-mode-id') === 'light'));
          $$('.accent-card', form).forEach((c) => c.classList.toggle('active', c.getAttribute('data-accent-id') === 'blue'));
          toast('Appearance reset to Light Mode & Blue Accent', 'ok');
        });
      }
    },
    onSubmit(form, close) {
      close();
    }
  });
}
