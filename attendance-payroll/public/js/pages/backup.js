// Automated Google Drive Backup & Safe Restore Management Dashboard
import { get, post, del, download } from '../api.js';
import { html, setHTML, $, $$, fmtDateLong, fmtDate, badge, toast, modal, formValues, confirmDialog, icon } from '../ui.js';

export async function render(view, state) {
  let activeTab = 'backups'; // 'backups' | 'logs' | 'settings'
  let backupData = { backups: [], logs: [] };
  let statsData = { stats: {}, config: {} };

  const loadData = async () => {
    try {
      const [statusRes, listRes] = await Promise.all([
        get('/backup/status'),
        get('/backup/list'),
      ]);
      statsData = statusRes;
      backupData = listRes;
    } catch (err) {
      toast(err.message || 'Error loading backup data', 'bad');
    }
  };

  await loadData();

  const frame = async () => {
    const s = statsData.stats || {};
    const c = statsData.config || {};
    const isDriveConnected = s.gdriveStatus === 'connected';

    setHTML(view, html`
      <div class="stack" style="gap:16px;">
        <!-- Top Header Banner -->
        <div class="panel" style="background:linear-gradient(135deg, #0F2942 0%, #1E3A8A 100%); color:#ffffff; padding:20px 24px; border-radius:12px; box-shadow:0 4px 12px rgba(15,41,66,0.15);">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:14px;">
            <div>
              <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-size:24px;">💾</span>
                <h1 style="font-size:20px; font-weight:700; margin:0; letter-spacing:0.3px; color:#ffffff;">Automated Cloud Backup &amp; Restore System</h1>
              </div>
              <p style="margin:4px 0 0 34px; font-size:13px; color:#93C5FD;">
                Enterprise AES-256-GCM Encrypted PostgreSQL Database &amp; Documents Archive with Google Drive Sync
              </p>
            </div>
            <div class="row" style="gap:10px; flex-wrap:wrap;">
              <a href="/api/backup/download-sql" id="btnQuickSql" class="btn" download="JMCL_Database_Dump.sql" style="background:rgba(255,255,255,0.15); color:#ffffff; font-weight:700; border:1px solid rgba(255,255,255,0.35); padding:8px 16px; border-radius:8px; display:inline-flex; align-items:center; gap:6px; text-decoration:none;" title="Instantly stream raw PostgreSQL SQL database dump">
                <span>📥</span> <span>Quick Download SQL</span>
              </a>
              <button id="btnRunBackupNow" class="btn primary" style="background:#10B981; color:#ffffff; font-weight:700; border:none; padding:8px 18px; border-radius:8px; display:inline-flex; align-items:center; gap:6px; box-shadow:0 2px 6px rgba(16,185,129,0.3);">
                <span>▶</span> <span>Run Backup Now</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Metrics KPI Cards -->
        <div class="stats-grid" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px;">
          <div class="stat-card primary" style="background:#fff; border-left:4px solid #0F2942; padding:14px 18px; border-radius:10px; box-shadow:0 1px 4px rgba(0,0,0,0.05);">
            <span class="lbl" style="font-size:12px; font-weight:600; color:#64748b; text-transform:uppercase;">Total Backups</span>
            <div class="val" style="font-size:24px; font-weight:800; color:#0F2942; margin-top:4px;">${s.total || 0}</div>
            <div class="small muted" style="font-size:11px; margin-top:4px;">${s.successful || 0} Successful • ${s.failed || 0} Failed</div>
          </div>

          <div class="stat-card ok" style="background:#fff; border-left:4px solid #10B981; padding:14px 18px; border-radius:10px; box-shadow:0 1px 4px rgba(0,0,0,0.05);">
            <span class="lbl" style="font-size:12px; font-weight:600; color:#64748b; text-transform:uppercase;">Last Backup</span>
            <div class="val" style="font-size:16px; font-weight:700; color:#10B981; margin-top:6px;">
              ${s.lastBackup ? fmtDateLong(s.lastBackup.created_at) : 'No backups yet'}
            </div>
            <div class="small muted" style="font-size:11px; margin-top:4px;">
              ${s.lastBackup ? `${(s.lastBackup.file_size / (1024 * 1024)).toFixed(2)} MB • ${s.lastBackup.records_count} records` : 'Ready to run'}
            </div>
          </div>

          <div class="stat-card" style="background:#fff; border-left:4px solid ${isDriveConnected ? '#2563EB' : '#F59E0B'}; padding:14px 18px; border-radius:10px; box-shadow:0 1px 4px rgba(0,0,0,0.05);">
            <span class="lbl" style="font-size:12px; font-weight:600; color:#64748b; text-transform:uppercase;">Google Drive Sync</span>
            <div style="display:flex; align-items:center; gap:8px; margin-top:6px;">
              <span class="badge" style="background:${isDriveConnected ? '#DCFCE7' : '#FEF3C7'}; color:${isDriveConnected ? '#15803D' : '#92400E'}; font-weight:700; padding:4px 10px; font-size:12px;">
                ${isDriveConnected ? '✓ Connected' : '⚠️ Setup Required'}
              </span>
            </div>
            <div class="small muted" style="font-size:11px; margin-top:4px;">Folder: <b>${c.root_folder_name || 'JMCL_Backup'}</b></div>
          </div>

          <div class="stat-card" style="background:#fff; border-left:4px solid #6366F1; padding:14px 18px; border-radius:10px; box-shadow:0 1px 4px rgba(0,0,0,0.05);">
            <span class="lbl" style="font-size:12px; font-weight:600; color:#64748b; text-transform:uppercase;">Automated Schedule</span>
            <div class="val" style="font-size:14px; font-weight:700; color:#4338CA; margin-top:6px;">Daily at 02:00 AM</div>
            <div class="small muted" style="font-size:11px; margin-top:4px;">Friday Full at 03:00 AM (BD Time)</div>
          </div>
        </div>

        <!-- Navigation Tabs & Action Bar -->
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
          <div class="tabs" role="tablist" style="margin-bottom:0;">
            <button role="tab" data-tab="backups" aria-selected="${activeTab === 'backups'}">
              📦 Backup Archives (${backupData.backups?.length || 0})
            </button>
            <button role="tab" data-tab="logs" aria-selected="${activeTab === 'logs'}">
              📜 Activity &amp; Audit Logs
            </button>
            <button role="tab" data-tab="settings" aria-selected="${activeTab === 'settings'}">
              ⚙️ Google Drive &amp; Retention Config
            </button>
          </div>

          <div class="row" style="gap:8px;">
            <button id="btnRestoreModal" class="btn sm" style="background:#fff; border:1px solid #CBD5E1; color:#0F2942; font-weight:700; display:inline-flex; align-items:center; gap:6px;">
              <span>🔄</span> <span>Restore System</span>
            </button>
          </div>
        </div>

        <div id="backupMainContainer"></div>
      </div>
    `);

    // Tab button bindings
    $$('[data-tab]', view).forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        frame();
      });
    });

    // Run Backup Now button
    $('#btnRunBackupNow').addEventListener('click', async () => {
      try {
        toast('Starting manual database backup & encryption...', 'info');
        const res = await post('/backup/run', { type: 'manual', scope: 'full' });
        toast(`Backup created successfully: ${res.fileName} (${(res.fileSize / (1024 * 1024)).toFixed(2)} MB)`);
        await loadData();
        frame();
      } catch (err) {
        toast(`Backup failed: ${err.message}`, 'bad');
      }
    });

    // Quick Download SQL link feedback
    $('#btnQuickSql')?.addEventListener('click', () => {
      toast('Streaming PostgreSQL SQL database dump download...');
    });

    // Restore Modal button
    $('#btnRestoreModal').addEventListener('click', () => openRestoreModal());

    // Render active tab view
    if (activeTab === 'backups') renderBackupsTable();
    else if (activeTab === 'logs') renderLogsTable();
    else if (activeTab === 'settings') renderSettingsTab();
  };

  /* =========================================================================
   * 1. BACKUP ARCHIVES TABLE
   * ========================================================================= */
  const renderBackupsTable = () => {
    const container = $('#backupMainContainer');
    const backups = backupData.backups || [];

    setHTML(container, html`
      <section class="panel">
        <div class="body flush table-wrap">
          ${backups.length ? html`
            <table>
              <thead>
                <tr>
                  <th>Backup File</th>
                  <th>Type &amp; Scope</th>
                  <th>Created Date &amp; Time</th>
                  <th>Size</th>
                  <th>Tables / Records</th>
                  <th>Security &amp; Storage</th>
                  <th class="r">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${backups.map((b) => html`
                  <tr>
                    <td>
                      <div style="font-weight:700; color:#0F2942; display:flex; align-items:center; gap:6px;">
                        <span>📦</span> <span>${b.file_name}</span>
                      </div>
                      <div class="small muted" style="font-family:monospace; font-size:10.5px; margin-top:2px;">
                        SHA-256: ${b.checksum_sha256 ? `${b.checksum_sha256.slice(0, 16)}...` : 'N/A'}
                      </div>
                    </td>
                    <td>
                      <span class="badge" style="background:#e0f2fe; color:#0369a1; font-weight:700; text-transform:uppercase;">${b.backup_type}</span>
                      <div class="small muted" style="margin-top:2px;">${b.scope}</div>
                    </td>
                    <td>
                      <div style="font-weight:600;">${fmtDateLong(b.created_at)}</div>
                      <div class="small muted">${fmtDate(b.created_at)}</div>
                    </td>
                    <td>
                      <b>${(b.file_size / (1024 * 1024)).toFixed(2)} MB</b>
                    </td>
                    <td>
                      <div style="font-weight:600; color:#15803d;">${b.records_count || 0} Records</div>
                      <div class="small muted">${b.tables_count || 0} Tables</div>
                    </td>
                    <td>
                      <div style="display:flex; gap:6px; flex-wrap:wrap;">
                        ${b.encrypted ? html`<span class="badge" style="background:#dcfce7; color:#15803d;">🔒 AES-256</span>` : html`<span class="badge">Unencrypted</span>`}
                        ${b.storage_location === 'cloud' || b.gdrive_file_id ? html`<span class="badge" style="background:#eff6ff; color:#1e40af;">☁️ Google Drive</span>` : html`<span class="badge">💾 Local/Memory</span>`}
                      </div>
                    </td>
                    <td class="r">
                      <span class="row" style="justify-content:flex-end; gap:6px; flex-wrap:nowrap;">
                        <a href="/api/backup/download/${b.id}" class="btn sm" download="${b.file_name}" style="background:#0F2942; color:#fff; font-weight:700; display:inline-flex; align-items:center; gap:4px; padding:5px 12px; border-radius:6px; text-decoration:none;" title="Download this backup file">
                          <span>📥</span> <span>Download</span>
                        </a>
                        <button class="btn sm" data-del-backup="${b.id}" style="color:#dc2626; border-color:#fca5a5;" title="Delete backup record">
                          🗑️
                        </button>
                      </span>
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          ` : html`
            <div style="padding:30px; text-align:center;">
              <p class="muted" style="font-size:14px; margin-bottom:12px;">No backup archives generated yet.</p>
              <button class="btn primary" id="btnFirstBackup" style="font-weight:700;">Run First Backup Now</button>
            </div>
          `}
        </div>
      </section>
    `);

    $('#btnFirstBackup')?.addEventListener('click', () => $('#btnRunBackupNow').click());

    $$('[data-del-backup]', container).forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.delBackup;
        confirmDialog({
          title: 'Delete Backup Record',
          message: 'Are you sure you want to delete this backup entry from the database? This action cannot be undone.',
          confirmLabel: 'Delete Record',
          danger: true,
          onConfirm: async () => {
            try {
              await del(`/backup/${id}`);
              toast('Backup record removed');
              await loadData();
              frame();
            } catch (e) {
              toast(e.message, 'bad');
            }
          },
        });
      });
    });
  };

  /* =========================================================================
   * 2. ACTIVITY & AUDIT LOGS TABLE
   * ========================================================================= */
  const renderLogsTable = () => {
    const container = $('#backupMainContainer');
    const logs = backupData.logs || [];

    setHTML(container, html`
      <section class="panel">
        <header style="padding:14px 20px; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <h2 style="margin:0; font-size:16px; color:#0F2942;">Backup &amp; Restore Audit Trail</h2>
            <p class="small muted" style="margin:2px 0 0;">Chronological history of all automated cron executions, uploads, and restore events.</p>
          </div>
          <span class="badge" style="background:#f1f5f9; color:#475569;">${logs.length} Log Records</span>
        </header>
        <div class="body flush table-wrap">
          ${logs.length ? html`
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Action</th>
                  <th>Status</th>
                  <th>Message &amp; Output Details</th>
                </tr>
              </thead>
              <tbody>
                ${logs.map((l) => html`
                  <tr>
                    <td style="white-space:nowrap;">
                      <div style="font-weight:600;">${fmtDateLong(l.created_at)}</div>
                      <div class="small muted">${fmtDate(l.created_at)}</div>
                    </td>
                    <td>
                      <b style="font-family:monospace; color:#1E3A8A;">${l.action}</b>
                    </td>
                    <td>
                      <span class="badge" style="background:${l.status === 'success' ? '#dcfce7' : l.status === 'error' ? '#fee2e2' : '#e0f2fe'}; color:${l.status === 'success' ? '#15803d' : l.status === 'error' ? '#dc2626' : '#0369a1'}; font-weight:700;">
                        ${(l.status || 'info').toUpperCase()}
                      </span>
                    </td>
                    <td>
                      <div style="font-weight:600; color:#334155;">${l.message}</div>
                      ${l.details && Object.keys(l.details).length ? html`
                        <div class="small muted" style="font-family:monospace; font-size:11px; margin-top:3px; background:#f8fafc; padding:4px 8px; border-radius:4px; max-width:500px; overflow-x:auto;">
                          ${JSON.stringify(l.details)}
                        </div>
                      ` : ''}
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          ` : html`<p class="muted" style="padding:20px;">No activity logs recorded yet.</p>`}
        </div>
      </section>
    `);
  };

  /* =========================================================================
   * 3. GOOGLE DRIVE & RETENTION SETTINGS TAB
   * ========================================================================= */
  const renderSettingsTab = () => {
    const container = $('#backupMainContainer');
    const c = statsData.config || {};

    setHTML(container, html`
      <div class="panel" style="max-width:850px; margin:0 auto; box-shadow:0 4px 16px rgba(0,0,0,0.06); border-radius:12px;">
        <header style="background:#f8fafc; border-bottom:1px solid #e2e8f0; padding:16px 24px; border-radius:12px 12px 0 0;">
          <h2 style="margin:0; font-size:17px; color:#0F2942; font-weight:700;">Google Drive Cloud Backup Configuration</h2>
          <p class="muted small" style="margin:3px 0 0;">Set up automated synchronization to your organization's Google Drive via Service Account.</p>
        </header>

        <div class="body" style="padding:24px;">
          <form id="gdriveConfigForm" class="stack" style="gap:20px;">
            
            <div style="background:#f0f9ff; border:1px solid #bae6fd; border-radius:8px; padding:14px; font-size:13px; color:#0369a1; line-height:1.5;">
              <b>ℹ️ Google Drive Service Account Setup Guide:</b>
              <ol style="margin:6px 0 0 20px; padding:0;">
                <li>Go to Google Cloud Console (<a href="https://console.cloud.google.com/" target="_blank" style="color:#0284c7; font-weight:700;">console.cloud.google.com</a>) and enable <b>Google Drive API</b>.</li>
                <li>Create a <b>Service Account</b> and download the <b>JSON Key</b> file.</li>
                <li>Share your target Google Drive folder (e.g. <code>JMCL_Backup</code>) with the Service Account email as <b>Editor</b>.</li>
                <li>Paste the complete JSON contents below.</li>
              </ol>
            </div>

            <label class="check" style="display:flex; align-items:center; gap:8px; font-weight:700; cursor:pointer;">
              <input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}>
              <span>Enable Automatic Google Drive Cloud Upload</span>
            </label>

            <label style="display:block;">Google Drive Root Folder Name
              <input type="text" name="root_folder_name" value="${c.root_folder_name || 'JMCL_Backup'}" style="width:100%; padding:8px 12px; border-radius:6px; border:1px solid #cbd5e1; margin-top:4px;">
              <span class="small muted">Subfolders (Daily_Backup, Weekly_Backup, Database_Backup) will be created automatically.</span>
            </label>

            <label style="display:block;">Google Cloud Service Account JSON Key <span style="color:#ef4444">*</span>
              <textarea name="service_account_json" rows="6" placeholder='Paste full {"type": "service_account", "project_id": "...", "private_key": "..."} content here' style="width:100%; font-family:monospace; font-size:12px; padding:10px; border-radius:6px; border:1px solid #cbd5e1; margin-top:4px;">${c.hasCredentials ? '•••••••••••••••• (Credentials Configured) ••••••••••••••••' : ''}</textarea>
            </label>

            <div style="display:flex; justify-content:flex-end;">
              <button type="button" id="btnTestDrive" class="btn" style="background:#eff6ff; color:#1e40af; border:1px solid #bfdbfe; font-weight:700; display:inline-flex; align-items:center; gap:6px;">
                <span>🔌</span> <span>Test Google Drive Connection</span>
              </button>
            </div>

            <hr style="border:none; border-top:1px solid #e2e8f0; margin:6px 0;">

            <div style="font-size:14px; font-weight:700; color:#0F2942;">Security &amp; Retention Policies</div>

            <label class="check" style="display:flex; align-items:center; gap:8px; font-weight:600; cursor:pointer;">
              <input type="checkbox" name="encryption_enabled" ${c.encryption_enabled !== false ? 'checked' : ''}>
              <span>Enable Military-Grade AES-256-GCM Backup Encryption</span>
            </label>

            <div class="form-grid" style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px;">
              <label>Daily Retention (Days)
                <input type="number" name="daily_retention_days" min="1" max="365" value="${c.daily_retention_days || 30}" style="width:100%; padding:8px 12px; border-radius:6px; border:1px solid #cbd5e1;">
              </label>
              <label>Weekly Retention (Weeks)
                <input type="number" name="weekly_retention_weeks" min="1" max="100" value="${c.weekly_retention_weeks || 12}" style="width:100%; padding:8px 12px; border-radius:6px; border:1px solid #cbd5e1;">
              </label>
              <label>Monthly Retention (Months)
                <input type="number" name="monthly_retention_months" min="1" max="60" value="${c.monthly_retention_months || 12}" style="width:100%; padding:8px 12px; border-radius:6px; border:1px solid #cbd5e1;">
              </label>
            </div>

            <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:10px;">
              <button type="submit" class="btn primary" style="padding:10px 24px; font-weight:700;">
                Save Configuration
              </button>
            </div>
          </form>
        </div>
      </div>
    `);

    // Test Connection Button
    $('#btnTestDrive')?.addEventListener('click', async () => {
      const textarea = $('textarea[name="service_account_json"]');
      let saJson = textarea ? textarea.value.trim() : '';
      if (saJson.includes('••••')) saJson = '';

      try {
        toast('Testing Google Drive API connectivity...', 'info');
        const res = await post('/backup/test-drive', { service_account_json: saJson });
        if (res.ok) {
          toast(`✓ Connected successfully! Service Account: ${res.email}`, 'ok');
        } else {
          toast(`❌ Connection failed: ${res.error}`, 'bad');
        }
      } catch (err) {
        toast(`Connection error: ${err.message}`, 'bad');
      }
    });

    // Save Configuration Form
    $('#gdriveConfigForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const v = formValues(form);

      const payload = {
        enabled: !!v.enabled,
        root_folder_name: v.root_folder_name || 'JMCL_Backup',
        encryption_enabled: !!v.encryption_enabled,
        daily_retention_days: parseInt(v.daily_retention_days || 30, 10),
        weekly_retention_weeks: parseInt(v.weekly_retention_weeks || 12, 10),
        monthly_retention_months: parseInt(v.monthly_retention_months || 12, 10),
      };

      if (v.service_account_json && !v.service_account_json.includes('••••')) {
        payload.service_account_json = v.service_account_json.trim();
      }

      try {
        await post('/backup/config', payload);
        toast('Backup configuration saved successfully!');
        await loadData();
        frame();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
  };

  /* =========================================================================
   * 4. SYSTEM RESTORE MODAL (WITH TRANSACTION SAFETY PRE-CHECK)
   * ========================================================================= */
  const openRestoreModal = () => {
    modal({
      title: '🔄 Restore Database System',
      submitLabel: 'Proceed with Restoration',
      body: html`
        <div class="stack" style="gap:16px;">
          <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:14px; color:#991b1b; font-size:13px; line-height:1.5;">
            <b>⚠️ CRITICAL WARNING:</b>
            <p style="margin:4px 0 0;">
              Restoring a backup will overwrite current database records with the contents of the backup file.
              The system will automatically create a <b>pre-restore safety backup</b> before applying any changes.
            </p>
          </div>

          <label style="display:block;">Select Backup File (.jmcl.enc / .sql / .json.gz)
            <input type="file" id="restoreFileInput" accept=".enc,.sql,.gz,.json" style="width:100%; padding:10px; border:2px dashed #cbd5e1; border-radius:8px; margin-top:6px; cursor:pointer;">
          </label>

          <label style="display:block;">Decryption Key (if file is encrypted)
            <input type="password" id="restoreEncKey" placeholder="Leave empty to use configured system key" style="width:100%; padding:8px 12px; border-radius:6px; border:1px solid #cbd5e1; margin-top:4px;">
          </label>

          <label class="check" style="display:flex; align-items:center; gap:8px; font-weight:700; color:#dc2626; cursor:pointer;">
            <input type="checkbox" id="restoreConfirmCheck" required>
            <span>I understand that existing records will be replaced and wish to proceed.</span>
          </label>
        </div>
      `,
      onSubmit: async (form, close) => {
        const fileInput = $('#restoreFileInput');
        const confirmCheck = $('#restoreConfirmCheck');
        const encKeyInput = $('#restoreEncKey');

        if (!confirmCheck?.checked) {
          toast('Please check the confirmation box to proceed', 'bad');
          return;
        }

        const file = fileInput?.files?.[0];
        if (!file) {
          toast('Please select a backup file to restore', 'bad');
          return;
        }

        const reader = new FileReader();
        reader.onload = async () => {
          try {
            toast('Uploading & verifying backup file for restoration...', 'info');
            const res = await post('/backup/restore', {
              backupData: reader.result,
              encryptionKey: encKeyInput?.value || null,
            });

            toast('✓ Database restoration completed successfully! Reloading...');
            close();
            setTimeout(() => window.location.reload(), 1500);
          } catch (err) {
            toast(`Restoration failed: ${err.message}`, 'bad');
          }
        };
        reader.readAsDataURL(file);
      },
    });
  };

  await frame();
}

