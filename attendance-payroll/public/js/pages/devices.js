// ZKTeco Biometric Device Management & Multi-Method Connectivity Hub
import { get, post, put, del } from '../api.js';
import { html, setHTML, $, $$, badge, ago, toast, modal, formValues, confirmDialog, icon, fmtDate } from '../ui.js';

export async function render(view, state) {
  let timer;
  let activeTab = 'devices';
  let serverInfo = null;

  try {
    serverInfo = await get('/devices/server-info');
  } catch {
    serverInfo = {
      serverHost: location.hostname !== 'localhost' ? location.hostname : '192.168.3.9',
      serverPort: location.port || (location.protocol === 'https:' ? 443 : 3000),
      currentHost: location.host,
      currentHostname: location.hostname,
      protocol: location.protocol.replace(':', ''),
      defaultPort: location.protocol === 'https:' ? 443 : 3000,
      localIps: ['192.168.3.9'],
      lanIp: '192.168.3.9',
      lanPort: '3000',
      admsPath: '/iclock/cdata',
    };
  }

  const serverHost = serverInfo.serverHost || (location.hostname !== 'localhost' ? location.hostname : (serverInfo.lanIp || '192.168.3.9'));
  const serverPort = String(serverInfo.serverPort || location.port || '3000');
  const localIp = serverInfo.lanIp || (serverInfo.localIps && serverInfo.localIps[0]) || '192.168.3.9';
  const localPort = String(serverInfo.lanPort || location.port || '3000');

  const copyText = (text, label) => {
    navigator.clipboard.writeText(text).then(() => {
      toast(`Copied ${label || text} to clipboard!`);
    }).catch(() => {
      toast(`Copy failed: please select and copy manually`, 'bad');
    });
  };

  const shell = () => {
    setHTML(view, html`
      <div class="stack" style="gap:16px;">
        <!-- Header & Action Row -->
        <div class="row between" style="align-items:center; flex-wrap:wrap; gap:12px;">
          <div>
            <div class="tabs" role="tablist" style="margin-bottom:0; overflow:visible;">
              <button role="tab" data-tab="devices" aria-selected="${activeTab === 'devices'}">
                ${icon('device')} Registered Readers
              </button>
              <button role="tab" data-tab="stream" aria-selected="${activeTab === 'stream'}">
                ${icon('live')} Live Punch Stream
              </button>
              <button role="tab" data-tab="guide" aria-selected="${activeTab === 'guide'}">
                ${icon('globe')} Connection Guide
              </button>
            </div>
          </div>
          <div class="row" style="gap:8px; flex-wrap:wrap;">
            <button class="btn" id="sync-time-global-btn" title="Synchronize Terminal Time with Server Clock" style="background:#f0fdf4; color:#15803d; border-color:#bbf7d0; font-weight:600;">
              ${icon('clock')} Sync Device Time
            </button>
            <button class="btn" id="upload-usb-btn" title="Import punches from USB Flash Drive (.dat / .csv)">
              ${icon('upload')} Upload USB Log
            </button>
            <button class="btn" id="gateway-info-btn" title="Run Local Windows Gateway Agent for LAN Devices">
              ${icon('gear')} Windows Gateway
            </button>
            <button class="btn" id="test-punch-global-btn" title="Simulate Biometric Punch">
              ${icon('clock')} Test Punch
            </button>
            <button class="btn primary" id="add-device-btn">
              ${icon('plus')} Add Device
            </button>
          </div>
        </div>

        <div id="tab-content">
          <p class="empty">Loading...</p>
        </div>
      </div>
    `);

    $$('[data-tab]', view).forEach((b) => {
      b.addEventListener('click', () => {
        activeTab = b.dataset.tab;
        shell();
        load();
      });
    });

    $('#sync-time-global-btn')?.addEventListener('click', () => openSyncTimeModal(null));
    $('#upload-usb-btn')?.addEventListener('click', openUploadModal);
    $('#gateway-info-btn')?.addEventListener('click', openGatewayModal);
    $('#test-punch-global-btn')?.addEventListener('click', () => openTestPunchModal(null));
    $('#add-device-btn')?.addEventListener('click', () => openEditModal(null));
  };

  const load = async () => {
    const container = $('#tab-content');
    if (!container) return;

    if (activeTab === 'stream') {
      await loadLiveStream(container);
      return;
    }

    if (activeTab === 'guide') {
      loadGuideTab(container);
      return;
    }

    await loadDevicesTab(container);
  };

  /** Tab 1: Registered Devices Table & Quick Cloud Config Strip */
  const loadDevicesTab = async (container) => {
    try {
      const { devices } = await get('/devices');
      const unapprovedCount = devices.filter((d) => !d.approved).length;

      setHTML(container, html`
        <div class="stack" style="gap:16px;">
          <!-- Compact Server Connection Parameters Strip -->
          <div style="background:var(--paper); border:1px solid var(--line); border-radius:var(--radius); padding:14px 18px; box-shadow:0 1px 3px rgba(0,0,0,0.03);">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
              <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap; font-size:0.88rem;">
                <div>
                  <span class="muted" style="font-size:0.75rem; text-transform:uppercase; font-weight:600; display:block;">ADMS Server Host / IP</span>
                  <code style="font-weight:700; color:var(--primary);">${serverHost}</code>
                  <button class="config-copy-btn" data-copy="${serverHost}" data-label="Server Host" style="margin-left:4px;">Copy</button>
                  <button class="btn sm" id="edit-server-host-btn" style="margin-left:6px; padding:2px 8px; font-size:11px;" title="Set your custom domain or IP">Change</button>
                </div>
                <div style="border-left:1px solid var(--line); padding-left:16px;">
                  <span class="muted" style="font-size:0.75rem; text-transform:uppercase; font-weight:600; display:block;">Port</span>
                  <code style="font-weight:700;">${serverPort}</code>
                  <button class="config-copy-btn" data-copy="${serverPort}" data-label="Port" style="margin-left:4px;">Copy</button>
                </div>
                <div style="border-left:1px solid var(--line); padding-left:16px;">
                  <span class="muted" style="font-size:0.75rem; text-transform:uppercase; font-weight:600; display:block;">ADMS Endpoint</span>
                  <code>/iclock/cdata</code>
                </div>
                <div style="border-left:1px solid var(--line); padding-left:16px;">
                  <span class="muted" style="font-size:0.75rem; text-transform:uppercase; font-weight:600; display:block;">PC LAN IP</span>
                  <code>${localIp}:${localPort}</code>
                </div>
              </div>

              <div>
                <button class="btn sm" id="quick-guide-btn">
                  ${icon('globe')} View Setup Instructions
                </button>
              </div>
            </div>
          </div>

          <!-- Pending Approval Alert -->
          ${unapprovedCount > 0 ? html`
            <div class="notice" style="display:flex; justify-content:space-between; align-items:center;">
              <div>
                <b>🔔 New Biometric Terminal Detected!</b>
                <span>${unapprovedCount} device(s) connected to the server and are pending approval. Click "Approve" in the table below to activate.</span>
              </div>
            </div>
          ` : ''}

          <!-- Registered Devices Panel -->
          <section class="panel">
            <header class="row between">
              <div>
                <h3>Registered Terminals (${devices.length})</h3>
                <p class="muted small" style="margin:2px 0 0">ZKTeco biometric terminals pushing logs to this system.</p>
              </div>
              <div class="muted small">Auto-refresh active (every 15s)</div>
            </header>
            <div class="body flush table-wrap">
              ${devices.length ? html`
                <table>
                  <thead>
                    <tr>
                      <th style="min-width:170px; width:22%;">Device / Terminal</th>
                      <th style="width:12%;">Serial Number</th>
                      <th style="width:17%;">Terminal Clock &amp; Date</th>
                      <th style="width:15%;">Activity &amp; Health</th>
                      <th style="width:10%;">Status</th>
                      <th class="r" style="width:7%;">Punches</th>
                      <th class="r" style="min-width:160px; width:17%;">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${devices.map((d) => {
                      const commTime = d.last_communication_time || d.last_seen;
                      const punchTime = d.last_punch_time || d.last_punch_at;
                      const state = d.connection_state || (d.online ? 'online' : d.last_seen ? 'standby' : 'offline');

                      return html`
                        <tr>
                          <td class="nameCell" style="white-space:normal; max-width:240px;">
                            <b>${d.name}</b>
                            <span class="muted small">${d.model || 'SenseFace 7A'}${d.location ? ' · ' + d.location : ''}</span>
                          </td>
                          <td><code style="font-weight:700; font-size:0.88rem;">${d.serial_number}</code></td>
                          <td class="small" style="line-height:1.35; white-space:nowrap;">
                            <div style="font-weight:700; color:var(--primary); font-family:monospace; font-size:13px; display:inline-flex; align-items:center; gap:4px;">
                              ${icon('clock')} ${d.device_clock || '—'}
                            </div>
                            <div class="muted small" style="margin-top:2px;">
                              Date: <b>${d.device_date || '—'}</b> · <span style="color:#15803d; font-weight:600;">✓ Synced (Dhaka UTC+6)</span>
                            </div>
                          </td>
                          <td class="small" style="line-height:1.35; white-space:nowrap;">
                            <div><span class="muted">Ping:</span> ${commTime ? html`<b>${ago(commTime)}</b>` : html`<span class="muted">Never</span>`}</div>
                            <div><span class="muted">Punch:</span> ${punchTime ? html`<b>${ago(punchTime)}</b>` : html`<span class="muted">None</span>`}</div>
                          </td>
                          <td>
                            ${state === 'pending' || !d.approved ? html`
                              <span class="badge pending">Needs Approval</span>
                            ` : state === 'disabled' || !d.active ? html`
                              <span class="badge inactive">Disabled</span>
                            ` : state === 'online' ? html`
                              <span class="badge online"><span class="pulse-dot online"></span> Online</span>
                            ` : state === 'standby' ? html`
                              <span class="badge waiting" title="Connected today, standby for activity"><span class="pulse-dot waiting"></span> Standby</span>
                            ` : html`
                              <span class="badge offline"><span class="pulse-dot offline"></span> Offline</span>
                            `}
                          </td>
                          <td class="r num" style="font-weight:700;">${d.punches_24h || 0}</td>
                          <td class="r">
                            <div class="action-btns" style="justify-content:flex-end; gap:4px;">
                              ${!d.approved ? html`
                                <button class="btn sm primary" data-approve="${d.id}" style="padding:4px 8px; font-size:11px;">Approve</button>
                              ` : ''}
                              <button class="btn sm" data-diag="${d.id}" title="Diagnose Connection" style="padding:4px 8px; font-size:11.5px; display:inline-flex; align-items:center; gap:3px;">
                                ${icon('globe')} Diag
                              </button>
                              <button class="btn sm" data-test-punch="${d.id}" title="Send Biometric Test Punch" style="padding:4px 8px; font-size:11.5px; display:inline-flex; align-items:center; gap:3px;">
                                ${icon('clock')} Test
                              </button>
                              <button class="btn sm" data-sync-time="${d.id}" data-name="${d.name}" title="Sync Machine Clock with Exact Bangladesh Time" style="padding:4px 8px; font-size:11.5px; display:inline-flex; align-items:center; gap:3px; background:#f0fdf4; color:#15803d; border-color:#bbf7d0;">
                                ${icon('refresh')} Sync Time
                              </button>
                              <button class="action-btn" data-edit="${d.id}" title="Edit Device Details" style="padding:4px 6px;">
                                ${icon('edit')}
                              </button>
                              <button class="action-btn danger" data-del="${d.id}" data-name="${d.name}" title="Remove Device" style="padding:4px 6px;">
                                ${icon('trash')}
                              </button>
                            </div>
                          </td>
                        </tr>
                      `;
                    })}
                  </tbody>
                </table>
              ` : html`
                <p class="empty">No biometric devices registered yet. Click "+ Add Device" above, or configure your ZKTeco reader with Cloud Server settings to connect automatically.</p>
              `}
            </div>
          </section>
        </div>
      `);

      // Event Listeners on Devices View
      $$('[data-copy]', container).forEach((b) => {
        b.addEventListener('click', () => copyText(b.dataset.copy, b.dataset.label));
      });

      $('#quick-guide-btn')?.addEventListener('click', () => {
        activeTab = 'guide';
        shell();
        load();
      });

      $('#edit-server-host-btn')?.addEventListener('click', () => {
        modal({
          title: 'Configure ADMS Server Host / Domain',
          submitLabel: 'Save Server Address',
          body: html`
            <div class="stack" style="gap:12px;">
              <p class="small muted">
                Set the IP address or custom domain where your ZKTeco terminals will push biometric punch events.
              </p>
              <div class="form-grid">
                <label class="wide">Server Host or IP Address
                  <input type="text" name="serverHost" id="cfg-host-input" required value="${serverHost}" placeholder="e.g. 192.168.3.9 or your-domain.com">
                  <span class="hint">For local office network, use your PC's LAN IP (${localIp}). For public cloud, enter your domain or public IP.</span>
                </label>
                <label>Port
                  <input type="number" name="serverPort" id="cfg-port-input" required value="${serverPort}" placeholder="3000">
                  <span class="hint">Standard port: 3000 (Localhost), 80 (HTTP), or 443 (HTTPS)</span>
                </label>
              </div>
              <div style="margin-top:4px; display:flex; gap:8px;">
                <button type="button" class="btn sm" id="btn-use-lan-ip">Use My PC LAN IP (${localIp}:3000)</button>
              </div>
            </div>
          `,
          onOpen: (form) => {
            $('#btn-use-lan-ip', form)?.addEventListener('click', () => {
              const h = $('#cfg-host-input', form);
              const p = $('#cfg-port-input', form);
              if (h) h.value = localIp;
              if (p) p.value = '3000';
            });
          },
          onSubmit: async (form, close) => {
            const vals = formValues(form);
            await post('/devices/server-info', { serverHost: vals.serverHost, serverPort: vals.serverPort });
            toast('ADMS Server configuration updated!');
            close();
            try { serverInfo = await get('/devices/server-info'); } catch { /* ignore */ }
            shell();
            load();
          },
        });
      });

      $$('[data-approve]', container).forEach((b) => {
        b.addEventListener('click', async () => {
          try {
            await post(`/devices/${b.dataset.approve}/approve`);
            toast('Device approved! Biometric punches are now active.');
            load();
          } catch (e) {
            toast(e.message, 'bad');
          }
        });
      });

      $$('[data-diag]', container).forEach((b) => {
        b.addEventListener('click', () => {
          const dev = devices.find((d) => String(d.id) === b.dataset.diag);
          if (dev) openDiagnoseModal(dev);
        });
      });

      $$('[data-test-punch]', container).forEach((b) => {
        b.addEventListener('click', () => {
          const dev = devices.find((d) => String(d.id) === b.dataset.testPunch);
          openTestPunchModal(dev);
        });
      });

      $$('[data-sync-time]', container).forEach((b) => {
        b.addEventListener('click', () => {
          const dev = devices.find((d) => String(d.id) === b.dataset.syncTime);
          openSyncTimeModal(dev);
        });
      });

      $$('[data-edit]', container).forEach((b) => {
        b.addEventListener('click', () => {
          const dev = devices.find((d) => String(d.id) === b.dataset.edit);
          if (dev) openEditModal(dev);
        });
      });

      $$('[data-del]', container).forEach((b) => {
        b.addEventListener('click', async () => {
          const ok = await confirmDialog(
            `Remove ${b.dataset.name}?`,
            `Are you sure you want to remove this device? Historical attendance punches will be preserved.`,
            { confirmLabel: 'Remove Device', danger: true }
          );
          if (!ok) return;
          try {
            await del(`/devices/${b.dataset.del}`);
            toast('Device removed');
            load();
          } catch (e) {
            toast(e.message, 'bad');
          }
        });
      });

    } catch (e) {
      setHTML(container, html`<div class="notice bad" style="margin:16px">${e.message}</div>`);
    }
  };

  /** Tab 2: Live Biometric Punch Stream */
  const loadLiveStream = async (container) => {
    try {
      const { logs } = await get('/devices/activity');
      setHTML(container, html`
        <section class="panel">
          <header class="row between">
            <div>
              <h3>Live Biometric Punch Stream (Latest 50 punches)</h3>
              <p class="muted small" style="margin:2px 0 0">Real-time attendance punches received from biometric readers, USB file imports, and gateway agents.</p>
            </div>
            <div class="row" style="gap:8px;">
              <button class="btn sm" id="refresh-stream-btn">${icon('clock')} Refresh</button>
              <button class="btn sm primary" id="stream-upload-btn">${icon('upload')} Upload USB Log</button>
            </div>
          </header>
          <div class="body flush table-wrap">
            ${logs && logs.length ? html`
              <table>
                <thead>
                  <tr>
                    <th>Punch Time</th>
                    <th>Employee</th>
                    <th>Device PIN</th>
                    <th>Verification Mode</th>
                    <th>Punch State</th>
                    <th>Terminal</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  ${logs.map((l) => {
                    const verifyLabel = l.verify === 15 ? '👤 Face Recognition'
                      : l.verify === 1 ? '👆 Fingerprint'
                      : l.verify === 3 ? '💳 RFID Card'
                      : l.verify === 0 ? '🔑 Password'
                      : 'Biometric';
                    const stateLabel = l.state === 0 ? 'Check-In' : l.state === 1 ? 'Check-Out' : 'Punch';
                    return html`
                      <tr>
                        <td class="time"><b>${new Date(l.punched_at).toLocaleTimeString('en-US', { hour12: false })}</b> <span class="muted small">${new Date(l.punched_at).toLocaleDateString('en-GB')}</span></td>
                        <td class="nameCell">
                          <b>${l.user_name || html`<span class="badge absent">Unregistered PIN</span>`}</b>
                          <span>${l.department || l.employee_code || '—'}</span>
                        </td>
                        <td><span class="num" style="font-weight:bold;">${l.pin}</span></td>
                        <td><span class="badge ${l.verify === 15 ? 'online' : ''}">${verifyLabel}</span></td>
                        <td><span class="badge ${l.state === 0 ? 'present' : 'late'}">${stateLabel}</span></td>
                        <td class="small">${l.device_name || l.device_sn || 'Cloud ADMS'}</td>
                        <td><span class="badge ${l.source === 'device' ? 'online' : l.source === 'manual' ? 'present' : 'waiting'}">${l.source}</span></td>
                      </tr>
                    `;
                  })}
                </tbody>
              </table>
            ` : html`
              <p class="empty">No attendance punch activity recorded yet. Scan a face/fingerprint on your device or upload a USB attendance file.</p>
            `}
          </div>
        </section>
      `);

      $('#refresh-stream-btn')?.addEventListener('click', () => loadLiveStream(container));
      $('#stream-upload-btn')?.addEventListener('click', openUploadModal);
    } catch (e) {
      setHTML(container, html`<div class="notice bad" style="margin:16px">${e.message}</div>`);
    }
  };

  /** Tab 3: Setup & Connection Guide */
  const loadGuideTab = (container) => {
    setHTML(container, html`
      <div class="stack" style="gap:20px;">
        <div class="row between" style="align-items:center;">
          <div>
            <h3 style="margin:0 0 4px;">ZKTeco Terminal Connectivity Guide</h3>
            <p class="muted small" style="margin:0;">Choose any of the 4 supported methods to connect your ZKTeco attendance devices to the cloud.</p>
          </div>
          <span class="badge online">4 Methods Available</span>
        </div>

        <div class="cloud-config-grid" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));">
          <!-- Method 1: ADMS Cloud Push -->
          <div class="config-box" style="border-top:3px solid #1a73e8; padding:16px;">
            <div class="config-box-label" style="color:#1a73e8; font-weight:700; font-size:0.85rem;">Method 1: ADMS Cloud Push (Direct Internet)</div>
            <div style="font-size:0.88rem; color:var(--text); margin-top:8px; line-height:1.5;">
              Recommended for modern ZKTeco terminals (uFace 800, SilkBio, MB series). The device pushes punch events directly to the cloud over HTTPS. No office computer required.
            </div>
            <div style="margin-top:14px; background:var(--surface); border:1px solid var(--line); border-radius:6px; padding:10px; font-size:0.82rem;">
              <div><b>Server Host / IP:</b> <code>${serverHost}</code></div>
              <div style="margin-top:4px;"><b>Server Port:</b> <code>${serverPort}</code></div>
              <div style="margin-top:4px;"><b>Endpoint:</b> <code>/iclock/cdata</code></div>
            </div>
            <div style="margin-top:12px;">
              <button class="config-copy-btn" data-copy="${serverHost}" data-label="Server Host">Copy Server Host</button>
              <button class="config-copy-btn" data-copy="${serverPort}" data-label="Port ${serverPort}">Copy Port: ${serverPort}</button>
            </div>
          </div>

          <!-- Method 2: Local Windows Sync Gateway -->
          <div class="config-box" style="border-top:3px solid #f9ab00; padding:16px;">
            <div class="config-box-label" style="color:#b06000; font-weight:700; font-size:0.85rem;">Method 2: Local Windows Sync Gateway (Office PC Bridge)</div>
            <div style="font-size:0.88rem; color:var(--text); margin-top:8px; line-height:1.5;">
              If your device does not have internet access, run the lightweight gateway agent on any office Windows PC on the same Wi-Fi/router. It reads punches from the local IP (192.168.0.201:4370) and relays them to the cloud.
            </div>
            <div style="margin-top:14px; background:var(--surface); border:1px solid var(--line); border-radius:6px; padding:10px; font-size:0.82rem;">
              <div><b>1-Click Batch File:</b> <code>start-sync-gateway.bat</code></div>
              <div style="margin-top:4px;"><b>Default Local IP:</b> <code>192.168.0.201:4370</code></div>
            </div>
            <div style="margin-top:12px;">
              <button class="config-copy-btn" id="guide-gateway-btn">Open Gateway Agent Guide</button>
            </div>
          </div>

          <!-- Method 3: USB Pendrive Import -->
          <div class="config-box" style="border-top:3px solid #188038; padding:16px;">
            <div class="config-box-label" style="color:#188038; font-weight:700; font-size:0.85rem;">Method 3: USB Flash Drive Import (100% Offline)</div>
            <div style="font-size:0.88rem; color:var(--text); margin-top:8px; line-height:1.5;">
              Completely air-gapped locations without internet or LAN cables. Plug a USB flash drive into the terminal, download attendance records, and upload the file directly here.
            </div>
            <div style="margin-top:14px; background:var(--surface); border:1px solid var(--line); border-radius:6px; padding:10px; font-size:0.82rem;">
              <div><b>Menu path:</b> USB Manager &rarr; Download &rarr; Att. Data</div>
              <div style="margin-top:4px;"><b>Files supported:</b> <code>1_attlog.dat</code>, CSV, TXT</div>
            </div>
            <div style="margin-top:12px;">
              <button class="config-copy-btn" id="guide-upload-btn">Upload .dat File</button>
            </div>
          </div>

          <!-- Method 4: Real Static IP & Port Forwarding -->
          <div class="config-box" style="border-top:3px solid #9c27b0; padding:16px;">
            <div class="config-box-label" style="color:#9c27b0; font-weight:700; font-size:0.85rem;">Method 4: Real Static IP &amp; Port Forwarding</div>
            <div style="font-size:0.88rem; color:var(--text); margin-top:8px; line-height:1.5;">
              If your office internet connection has a public static IP, forward TCP port 4370 on your router to the device IP. The cloud server connects directly to the terminal.
            </div>
            <div style="margin-top:14px; background:var(--surface); border:1px solid var(--line); border-radius:6px; padding:10px; font-size:0.82rem;">
              <div><b>Protocol:</b> Direct TCP Socket</div>
              <div style="margin-top:4px;"><b>Port:</b> <code>4370</code></div>
            </div>
            <div style="margin-top:12px;">
              <span class="small muted">Standard ZKTeco Protocol</span>
            </div>
          </div>
        </div>

        <!-- Step-by-Step Terminal Menu Configuration -->
        <div class="panel">
          <header>
            <h3>Step-by-Step ZKTeco uFace 800 Cloud Server Setup</h3>
          </header>
          <div class="body">
            <ol class="setup-steps-list">
              <li class="setup-step-item">
                <span class="step-badge">1</span>
                <div><b>Open Menu:</b> Press <b>M/OK</b> on the physical terminal keypad to enter the Main Menu.</div>
              </li>
              <li class="setup-step-item">
                <span class="step-badge">2</span>
                <div><b>Communication Settings:</b> Navigate to <b>Comm.</b> &rarr; <b>Cloud Server Setting</b> (or <b>ADMS</b> / <b>Web Server Setting</b> on some firmware versions).</div>
              </li>
              <li class="setup-step-item">
                <span class="step-badge">3</span>
                <div><b>Enable Domain Name:</b> Turn to <b>OFF</b> if using an IP address (like <code>${serverHost}</code>), or <b>ON</b> if using a domain name.</div>
              </li>
              <li class="setup-step-item">
                <span class="step-badge">4</span>
                <div><b>Server Address:</b> Enter <code>${serverHost}</code>.</div>
              </li>
              <li class="setup-step-item">
                <span class="step-badge">5</span>
                <div><b>Server Port:</b> Enter <code>${serverPort}</code>.</div>
              </li>
              <li class="setup-step-item">
                <span class="step-badge">6</span>
                <div><b>Save &amp; Reboot:</b> Leave Proxy Server <b>OFF</b>, press <b>ESC</b> or <b>OK</b> to save. Within 30 to 60 seconds, the terminal will register in the table!</div>
              </li>
            </ol>
          </div>
        </div>
      </div>
    `);

    $$('[data-copy]', container).forEach((b) => {
      b.addEventListener('click', () => copyText(b.dataset.copy, b.dataset.label));
    });

    $('#guide-gateway-btn')?.addEventListener('click', openGatewayModal);
    $('#guide-upload-btn')?.addEventListener('click', openUploadModal);
  };

  /** Modal: Upload USB / Offline Attendance File (.dat / .csv) */
  const openUploadModal = () => {
    modal({
      title: 'Upload USB Attendance File (Offline Import)',
      submitLabel: 'Import Attendance Data',
      body: html`
        <div class="stack" style="gap:14px;">
          <p style="margin:0; font-size:0.92rem; color:var(--text); line-height:1.45;">
            Select the attendance log file downloaded onto a USB flash drive from your ZKTeco reader (Menu &rarr; USB Manager &rarr; Download &rarr; Att. Data):
          </p>

          <div style="border:2px dashed var(--line); border-radius:8px; padding:24px; text-align:center; background:var(--bg); cursor:pointer;" id="drop-zone">
            <input type="file" id="usb-file-input" accept=".dat,.txt,.csv,.log" style="display:none;">
            <div style="margin-bottom:8px;">${icon('upload')}</div>
            <div style="font-weight:700; margin-bottom:4px;" id="drop-filename">Click to select file or drag &amp; drop here</div>
            <div class="small muted">Supported formats: 1_attlog.dat, attlog.dat, CSV, TXT (up to 10 MB)</div>
          </div>

          <div id="file-preview-wrap" style="display:none;">
            <div style="font-weight:600; font-size:0.85rem; margin-bottom:4px; color:var(--muted);">File Preview (First 5 lines):</div>
            <pre id="file-preview" style="background:var(--paper); border:1px solid var(--line); border-radius:6px; padding:8px; font-size:0.8rem; max-height:110px; overflow-y:auto; margin:0;"></pre>
          </div>

          <div class="notice" style="font-size:0.86rem; line-height:1.45;">
            💡 <b>Offline Reliability:</b> This method requires zero internet, router ports, or Wi-Fi. 100% of face and fingerprint punches recorded on the device are parsed and recalculated instantly.
          </div>
        </div>
      `,
      onOpen: (form) => {
        const dropZone = $('#drop-zone', form);
        const fileInput = $('#usb-file-input', form);
        const nameLabel = $('#drop-filename', form);
        const previewWrap = $('#file-preview-wrap', form);
        const previewPre = $('#file-preview', form);
        let selectedContent = '';

        dropZone.addEventListener('click', () => fileInput.click());

        const handleFile = (file) => {
          if (!file) return;
          nameLabel.innerHTML = `Selected: <b>${file.name}</b> (${Math.round(file.size / 1024)} KB)`;
          const reader = new FileReader();
          reader.onload = (e) => {
            selectedContent = e.target.result;
            form.dataset.fileContent = selectedContent;
            const lines = selectedContent.split('\n').slice(0, 5).join('\n');
            previewPre.textContent = lines;
            previewWrap.style.display = 'block';
          };
          reader.readAsText(file);
        };

        fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--brand)'; });
        dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'var(--line)'; });
        dropZone.addEventListener('drop', (e) => {
          e.preventDefault();
          dropZone.style.borderColor = 'var(--line)';
          if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
        });
      },
      onSubmit: async (form, close) => {
        const content = form.dataset.fileContent;
        if (!content) throw new Error('Please select an attendance file first.');
        const res = await post('/devices/upload-attlog', { content });
        toast(res.message);
        close();
        load();
      },
    });
  };

  /** Modal: Local Windows Sync Gateway Agent Guide */
  const openGatewayModal = () => {
    modal({
      title: 'Local Windows Sync Gateway Agent',
      narrow: false,
      submitLabel: 'Done',
      cancelLabel: 'Close',
      body: html`
        <div class="stack" style="gap:14px;">
          <p style="margin:0; font-size:0.92rem; line-height:1.5;">
            If your ZKTeco reader is on an office local area network (LAN) without direct internet access, run the lightweight <b>Gateway Agent</b> on any office Windows computer connected to the same Wi-Fi/switch.
          </p>

          <div style="background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:14px;">
            <div style="font-weight:700; margin-bottom:8px; font-size:0.95rem;">Command Line Execution:</div>
            <div class="config-box" style="margin-bottom:8px;">
              <div class="config-box-label">Run in Terminal / Command Prompt:</div>
              <div class="config-box-val" style="font-size:0.85rem; word-break:break-all;">
                <span>node scripts/zkteco-gateway.js --device-ip 192.168.0.201 --server-url http://${serverHost}:${serverPort}</span>
                <button class="config-copy-btn" data-copy="node scripts/zkteco-gateway.js --device-ip 192.168.0.201 --server-url http://${serverHost}:${serverPort}">Copy</button>
              </div>
            </div>
            <div class="small muted">
              * Change <code>--device-ip</code> if your device uses a different local IP (e.g. 192.168.0.201).
            </div>
          </div>

          <div style="background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px; font-size:0.88rem; line-height:1.45;">
            <b>1-Click Windows Batch Runner:</b><br>
            A pre-configured <code>start-sync-gateway.bat</code> is available in your project directory. Simply double-click it to start real-time background sync.
          </div>
        </div>
      `,
      onOpen: (form) => {
        $$('[data-copy]', form).forEach((b) => {
          b.addEventListener('click', () => copyText(b.dataset.copy, 'Command'));
        });
      },
      onSubmit: async (form, close) => {
        close();
      },
    });
  };

  /** Modal: Cloud Diagnostics & Audit Report */
  const openDiagnoseModal = async (dev) => {
    toast('Running deep connection diagnostics...');
    try {
      const diag = await post(`/devices/${dev.id}/test`);
      const st = diag.device?.status || 'offline';
      const tel = diag.telemetry || {};
      const checks = diag.checks || [];

      modal({
        title: `Biometric Connection Audit: ${dev.name}`,
        narrow: false,
        submitLabel: 'Simulate Test Punch',
        cancelLabel: 'Close',
        body: html`
          <div class="stack" style="gap:14px;">
            <!-- Status Card -->
            <div style="background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:14px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <span style="font-weight:700; font-size:1.05rem;">ZKTeco Terminal Connectivity</span>
                <span class="badge ${st === 'online' ? 'online' : st === 'standby' ? 'waiting' : st === 'pending' ? 'pending' : 'offline'}">
                  ${st === 'online' ? '● Online & Active' : st === 'standby' ? '● Standby (Connected Today)' : st === 'pending' ? 'Needs Approval' : 'Offline'}
                </span>
              </div>
              <p style="margin:0; font-size:0.9rem; line-height:1.45; color:var(--text);">
                ${st === 'online'
                  ? 'Terminal is actively communicating with JMCL Staff Flow Pro.'
                  : st === 'standby'
                    ? 'Terminal connected earlier today and is on standby for punch events or next heartbeat.'
                    : 'Terminal has not sent requests to the cloud server recently. See diagnostic checks below.'}
              </p>
            </div>

            <!-- Telemetry Grid -->
            <div class="cloud-config-grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom:0;">
              <div class="config-box">
                <div class="config-box-label">Device Serial Number</div>
                <div class="config-box-val" style="font-size:0.88rem;">${dev.serial_number}</div>
              </div>
              <div class="config-box">
                <div class="config-box-label">Last Communication Time</div>
                <div class="config-box-val" style="font-size:0.88rem;">
                  ${tel.lastCommunicationTime ? ago(tel.lastCommunicationTime) : 'Never'}
                </div>
                ${tel.lastCommunicationTime ? html`<div class="small muted" style="margin-top:2px;">${new Date(tel.lastCommunicationTime).toLocaleTimeString('en-US', { hour12: false })}</div>` : ''}
              </div>
              <div class="config-box">
                <div class="config-box-label">Last Punch Time</div>
                <div class="config-box-val" style="font-size:0.88rem;">
                  ${tel.lastPunchTime ? ago(tel.lastPunchTime) : 'No punches'}
                </div>
                ${tel.lastPunchTime ? html`<div class="small muted" style="margin-top:2px;">${new Date(tel.lastPunchTime).toLocaleTimeString('en-US', { hour12: false })}</div>` : ''}
              </div>
              <div class="config-box">
                <div class="config-box-label">Last Known IP / Source</div>
                <div class="config-box-val" style="font-size:0.88rem;">${tel.lastIp || dev.last_ip || 'None'}</div>
              </div>
            </div>

            <!-- Diagnostics Checklist -->
            <div style="background:var(--paper); border:1px solid var(--line); border-radius:8px; padding:12px;">
              <div style="font-weight:700; font-size:0.9rem; margin-bottom:10px;">Diagnostic Health Verification:</div>
              <div style="display:grid; gap:8px;">
                ${checks.map((c) => html`
                  <div style="display:flex; gap:10px; align-items:flex-start; padding:8px; background:var(--bg); border-radius:6px; font-size:0.86rem;">
                    <span class="badge ${c.status === 'pass' ? 'online' : c.status === 'warn' ? 'waiting' : 'absent'}" style="flex-shrink:0; font-size:0.75rem;">
                      ${c.status.toUpperCase()}
                    </span>
                    <div style="flex:1;">
                      <div style="font-weight:600; color:var(--text);">${c.name}</div>
                      <div style="color:var(--muted); margin-top:2px; line-height:1.4;">${c.detail}</div>
                      ${c.recommendation ? html`<div style="color:var(--brand); font-weight:550; margin-top:4px;">&rarr; Action: ${c.recommendation}</div>` : ''}
                    </div>
                  </div>
                `)}
              </div>
            </div>

            <!-- Architecture Advisory -->
            <div class="notice" style="font-size:0.86rem; line-height:1.45;">
              <b>💡 Cloud Deployment Compatibility Notice:</b><br>
              Render Cloud enforces HTTPS on port 443 and issues HTTP 301 redirects on port 80. Most physical ZKTeco firmwares (including uFace 800) use plain HTTP and cannot follow redirects or complete modern TLS handshakes.
              To ensure 100% reliable real-time syncing, run <b>start-sync-gateway.bat</b> on any office PC, or import logs with the <b>Upload USB Log</b> button.
            </div>
          </div>
        `,
        onSubmit: async (form, close) => {
          close();
          openTestPunchModal(dev);
        },
      });
    } catch (e) {
      toast(e.message, 'bad');
    }
  };

  /** Modal: Test Punch Console */
  const openTestPunchModal = async (dev) => {
    let users = [];
    try {
      const uRes = await get('/users?active=true');
      users = uRes.users || [];
    } catch { /* ignore */ }

    modal({
      title: 'Biometric Test Punch Console',
      submitLabel: 'Simulate Punch',
      body: html`
        <div class="form-grid">
          <label class="wide">Employee (Select to test live attendance calculation)
            <select name="userSelect" id="modal-user-select">
              <option value="">-- Choose Employee --</option>
              ${users.map((u) => html`<option value="${u.device_pin}">${u.name} (PIN: ${u.device_pin || 'No PIN'} · ${u.department || 'Staff'})</option>`)}
            </select>
          </label>
          <label>Device PIN
            <input type="text" name="pin" id="modal-pin-input" required placeholder="e.g. 1004" value="${users[0]?.device_pin || '1004'}">
          </label>
          <label>Punch Type
            <select name="state">
              <option value="0">Check-In</option>
              <option value="1">Check-Out</option>
            </select>
          </label>
          <label>Verification Method
            <select name="verify">
              <option value="15">👤 Face Recognition (uFace 800)</option>
              <option value="1">👆 Fingerprint</option>
              <option value="3">💳 RFID Card</option>
              <option value="0">🔑 Password</option>
            </select>
          </label>
          <label>Time (HH:MM:SS)
            <input type="text" name="time" placeholder="Leave blank for current time">
          </label>
          <div class="notice wide" style="margin-top:6px; font-size:0.86rem;">
            This console simulates an authentic ADMS biometric punch from a ZKTeco uFace 800 terminal to test instant attendance calculation and dashboard updates.
          </div>
        </div>
      `,
      onOpen: (form) => {
        const sel = $('#modal-user-select', form);
        const pinIn = $('#modal-pin-input', form);
        sel?.addEventListener('change', () => {
          if (sel.value) pinIn.value = sel.value;
        });
      },
      onSubmit: async (form, close) => {
        const v = formValues(form);
        const res = await post('/devices/test-punch', {
          pin: v.pin,
          deviceId: dev ? dev.id : undefined,
          state: v.state,
          verify: v.verify,
          time: v.time || undefined,
        });
        toast(res.message || 'Test punch successfully processed!');
        close();
        load();
      },
    });
  };

  /** Modal: Synchronize Terminal Clock */
  const openSyncTimeModal = async (dev = null) => {
    let devList = [];
    try {
      const res = await get('/devices');
      devList = res.devices || [];
    } catch { /* ignore */ }

    const now = new Date();
    const currentDhaka = now.toLocaleString('sv-SE', { timeZone: 'Asia/Dhaka' }).replace('T', ' ');

    modal({
      title: 'Synchronize Terminal Clock (Fix Machine Time)',
      submitLabel: '⚡ Apply & Sync Now',
      body: html`
        <div class="stack" style="gap:14px;">
          <div style="background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:12px 14px;">
            <div class="row between" style="align-items:center;">
              <span style="font-weight:600; font-size:13px; color:var(--text-muted);">Current Bangladesh / Server Time:</span>
              <span style="font-weight:700; font-size:14px; color:var(--primary); font-family:monospace;">${currentDhaka}</span>
            </div>
          </div>

          <div class="form-grid">
            <label class="wide">Target Biometric Terminal
              <select name="targetDevice" id="sync-target-device">
                <option value="all" ${!dev ? 'selected' : ''}>⚡ All Connected Terminals (${devList.length} devices)</option>
                ${devList.map((d) => html`
                  <option value="${d.id}" ${dev && String(dev.id) === String(d.id) ? 'selected' : ''}>
                    ${d.name} (${d.serial_number}) · ${d.model || 'Terminal'}
                  </option>
                `)}
              </select>
            </label>

            <label class="wide">Time Synchronization Mode
              <select name="timeMode" id="sync-time-mode">
                <option value="current">Current Bangladesh Time (${currentDhaka}) — Recommended</option>
                <option value="custom">Custom Date &amp; Time (Manual override)</option>
              </select>
            </label>

            <div class="wide" id="wrap-custom-datetime" style="display:none;">
              <label>Custom Date &amp; Time
                <input type="datetime-local" name="customDateTime" id="sync-custom-datetime" value="${currentDhaka.replace(' ', 'T').slice(0, 16)}">
                <span class="hint">The machine will be explicitly updated to this exact date and time.</span>
              </label>
            </div>
          </div>

          <div class="notice ok" style="font-size:12px; line-height:1.45;">
            <b>How it works:</b><br>
            When you click <b>Apply &amp; Sync Now</b>, our server queues a real-time ADMS command (<code>SET OPTIONS DateTime=...</code>) for the selected terminal.
            The device picks up the command on its next poll (within 5–10 seconds) and automatically adjusts its internal clock.
          </div>
        </div>
      `,
      onOpen: (form) => {
        const modeSel = $('#sync-time-mode', form);
        const wrapCustom = $('#wrap-custom-datetime', form);
        modeSel?.addEventListener('change', () => {
          if (wrapCustom) wrapCustom.style.display = modeSel.value === 'custom' ? 'block' : 'none';
        });
      },
      onSubmit: async (form, close) => {
        const target = form.targetDevice.value;
        const mode = form.timeMode.value;
        let dt = null;
        if (mode === 'custom') {
          const val = form.customDateTime.value;
          if (val) dt = val.replace('T', ' ') + ':00';
        }

        try {
          if (target === 'all') {
            const res = await post('/devices/sync-all-time', { datetime: dt });
            toast(res.message || 'Time sync commands sent to all devices!');
          } else {
            const res = await post(`/devices/${target}/sync-time`, { datetime: dt });
            toast(res.message || 'Time sync command sent to device!');
          }
          close();
          load();
        } catch (err) {
          toast(err.message || 'Failed to sync time', 'bad');
        }
      },
    });
  };

  /** Modal: Add / Edit Device */
  const openEditModal = (d) => {
    const isNew = !d;
    modal({
      title: isNew ? 'Add Biometric Terminal' : `Edit Terminal: ${d.name}`,
      submitLabel: isNew ? 'Register Terminal' : 'Save Changes',
      body: html`
        <div class="form-grid">
          <label class="wide">Terminal Name
            <input type="text" name="name" required maxlength="80" value="${d?.name || ''}" placeholder="e.g. Main Entrance (Ground Floor)">
          </label>
          <label>Serial Number (S/N)
            <input type="text" name="serialNumber" required value="${d?.serial_number || ''}" placeholder="e.g. VDE2251500160">
            <span class="hint">Found on device sticker or Menu &rarr; System Info &rarr; Device Info.</span>
          </label>
          <label>Model
            <input type="text" name="model" value="${d?.model || 'SenseFace 7A'}">
          </label>
          <label>Location / Branch
            <input type="text" name="location" value="${d?.location || ''}" placeholder="e.g. Head Office — Main Entrance">
          </label>

          <label class="wide">Connection Mode
            <select name="connectionMode" id="modal-conn-mode">
              <option value="adms" selected>1. ADMS Cloud Push — Direct Cloud push from terminal (Recommended, No PC needed)</option>
              <option value="gateway">2. Local Windows Gateway — Office PC bridge to local IP (192.168.0.201:4370)</option>
              <option value="usb">3. USB Flash Drive Import — Offline DAT/CSV upload</option>
              <option value="direct-ip">4. Direct TCP Pull — Connect to Public Static IP / Port Forwarded 4370</option>
              <option value="http-pull">5. HTTP API Pull — Server polls external HTTP API</option>
            </select>
          </label>

          <!-- ADMS Cloud Server Destination Parameters Box -->
          <div class="wide" id="wrap-adms-server-box" style="background:var(--surface); border:1.5px solid var(--primary); border-radius:8px; padding:14px; margin:4px 0 8px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <span style="font-weight:700; color:var(--primary); font-size:0.9rem;">📡 ZKTeco Cloud Server Settings (Enter on Terminal)</span>
              <span class="badge online" style="font-size:11px;">ADMS Push Destination</span>
            </div>
            <p style="margin:0 0 10px; font-size:0.84rem; color:var(--muted); line-height:1.4;">
              On your ZKTeco Terminal, go to: <b>Menu &rarr; Comm. &rarr; Cloud Server Setting</b> and enter this exact Server Address and Port:
            </p>
            <div style="display:grid; grid-template-columns: minmax(0, 1fr) 120px; gap:10px;">
              <label style="margin:0; font-size:0.8rem; font-weight:600;">Server Address (Cloud Host / IP)
                <input type="text" name="admsHost" id="modal-adms-host" value="${serverHost}" placeholder="e.g. 192.168.3.9 or domain.com" style="margin-top:4px; font-weight:700; color:var(--primary);">
              </label>
              <label style="margin:0; font-size:0.8rem; font-weight:600;">Server Port
                <input type="number" name="admsPort" id="modal-adms-port" value="${serverPort}" placeholder="3000" style="margin-top:4px; font-weight:700;">
              </label>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-top:10px; font-size:0.82rem;">
              <span class="muted">• <b>Enable Domain Name:</b> Keep <b>OFF</b> if using IP address (Turn <b>ON</b> if using domain).</span>
              <button type="button" class="btn sm" id="modal-btn-use-lan" style="font-size:11px; padding:3px 9px;">Set to My PC IP (${localIp}:3000)</button>
            </div>
          </div>

          <label id="wrap-ip">Terminal LAN IP (Optional)
            <input type="text" name="ipAddress" id="modal-ip-input" value="${d?.ip_address || '192.168.0.201'}" placeholder="192.168.0.201">
            <span class="hint">Physical IP of device (e.g. 192.168.0.201)</span>
          </label>
          <label id="wrap-port" style="display:none;">Device TCP Port
            <input type="number" name="port" id="modal-port-input" min="1" max="65535" value="${d?.port || 4370}">
            <span class="hint">Standard ZKTeco hardware port is 4370</span>
          </label>

          <label class="wide" id="wrap-api" style="display:none;">API URL (For HTTP Pull only)
            <input type="text" name="apiUrl" id="modal-api-input" value="${d?.api_url || ''}" placeholder="http://192.168.0.201/api/punches">
          </label>

          <div class="checks" style="align-self:end;">
            <label class="check">
              <input type="checkbox" name="active" ${d?.active !== false ? 'checked' : ''}> Enabled &amp; Active
            </label>
          </div>
        </div>
      `,
      onOpen: (form) => {
        const modeSel = $('#modal-conn-mode', form);
        const admsBox = $('#wrap-adms-server-box', form);
        const wrapApi = $('#wrap-api', form);
        const wrapIp = $('#wrap-ip', form);
        const wrapPort = $('#wrap-port', form);
        const ipInput = $('#modal-ip-input', form);
        const portInput = $('#modal-port-input', form);
        const admsHostIn = $('#modal-adms-host', form);
        const admsPortIn = $('#modal-adms-port', form);

        $('#modal-btn-use-lan', form)?.addEventListener('click', () => {
          if (admsHostIn) admsHostIn.value = localIp;
          if (admsPortIn) admsPortIn.value = '3000';
        });

        const updateHints = () => {
          const m = modeSel.value;
          if (m === 'adms') {
            admsBox.style.display = 'block';
            wrapIp.style.display = 'block';
            wrapPort.style.display = 'none';
            wrapApi.style.display = 'none';
          } else if (m === 'gateway' || m === 'direct-ip') {
            admsBox.style.display = 'none';
            wrapIp.style.display = 'block';
            wrapPort.style.display = 'block';
            wrapApi.style.display = 'none';
            portInput.value = '4370';
          } else if (m === 'usb') {
            admsBox.style.display = 'none';
            wrapIp.style.display = 'none';
            wrapPort.style.display = 'none';
            wrapApi.style.display = 'none';
          } else if (m === 'http-pull') {
            admsBox.style.display = 'none';
            wrapIp.style.display = 'none';
            wrapPort.style.display = 'none';
            wrapApi.style.display = 'block';
          }
        };

        modeSel.addEventListener('change', updateHints);
      },
      onSubmit: async (form, close) => {
        const v = formValues(form);
        const protocol = v.connectionMode === 'http-pull' ? 'http-pull' : 'adms';

        // If user changed the Cloud Server Host/Port in this modal, update global server-info
        if (v.admsHost) {
          try {
            await post('/devices/server-info', {
              serverHost: String(v.admsHost).trim(),
              serverPort: v.admsPort ? Number(v.admsPort) : 3000,
            });
          } catch { /* ignore */ }
        }

        const body = {
          name: v.name,
          serialNumber: v.serialNumber,
          model: v.model || 'SenseFace 7A',
          location: v.location || '',
          protocol,
          ipAddress: v.ipAddress || null,
          port: v.port ? Number(v.port) : 4370,
          apiUrl: v.apiUrl || null,
          enforceIp: false,
          pollIntervalSec: 60,
          active: !!v.active,
        };
        if (isNew) {
          await post('/devices', body);
          toast('Terminal registered successfully!');
        } else {
          await put(`/devices/${d.id}`, { ...body, approved: d.approved });
          toast('Terminal settings updated');
        }
        close();
        try { serverInfo = await get('/devices/server-info'); } catch { /* ignore */ }
        shell();
        load();
      },
    });
  };

  shell();
  await load();
  timer = setInterval(load, 15000);
  return () => clearInterval(timer);
}
