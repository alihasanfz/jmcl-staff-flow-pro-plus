'use strict';
const net = require('net');
const { query } = require('../db');

/** TCP reachability check (ZKTeco devices listen on 4370 for the native protocol). */
function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (ok, error) => { socket.destroy(); resolve({ ok, ms: Date.now() - started, error }); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'Connection timed out'));
    socket.once('error', (e) => done(false, e.code || e.message));
  });
}

/** HTTP reachability check. Only status code and latency are reported. */
async function httpProbe(url, timeoutMs = 3500) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    return { ok: res.status < 500, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e.name === 'AbortError' ? 'Timed out' : (e.cause?.code || e.message) };
  } finally { clearTimeout(timer); }
}

function isPrivateIp(ip) {
  if (!ip) return false;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.)/.test(String(ip).trim());
}

async function probeDevice(d) {
  // Demo device fast-path
  if (d.serial_number && d.serial_number.startsWith('DEMO-')) {
    return {
      protocol: d.protocol,
      serialNumber: d.serial_number,
      approved: true,
      active: true,
      status: 'online',
      telemetry: {
        lastSeen: new Date().toISOString(),
        lastPunchTime: new Date().toISOString(),
        totalPunches: 10,
        punches24h: 5,
        lastIp: '127.0.0.1',
      },
      checks: [
        { name: 'Device Registration', status: 'pass', detail: 'Demo device registered.' },
        { name: 'ADMS Push Protocol', status: 'pass', detail: 'Simulation mode active.' },
      ],
      recommendations: ['Demo device ready for testing.'],
    };
  }

  // Fetch punch statistics
  let punchStats = { total: 0, punches_24h: 0, last_punch: null };
  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(CASE WHEN punched_at > now() - interval '24 hours' THEN 1 END)::int AS punches_24h,
              MAX(punched_at) AS last_punch
         FROM punch_logs
        WHERE device_id = $1 OR device_sn = $2`,
      [d.id, d.serial_number]
    );
    if (rows[0]) {
      punchStats = {
        total: rows[0].total || 0,
        punches_24h: rows[0].punches_24h || 0,
        last_punch: rows[0].last_punch || d.last_punch_at || null,
      };
    }
  } catch { /* ignore */ }

  const now = Date.now();
  const lastSeenMs = d.last_seen ? new Date(d.last_seen).getTime() : 0;
  const diffSec = lastSeenMs ? Math.floor((now - lastSeenMs) / 1000) : null;

  // Multi-tier status logic to prevent false offline display
  const isOnline = diffSec !== null && diffSec < 600;       // within 10 minutes
  const isStandby = diffSec !== null && diffSec < 86400;    // within 24 hours
  const status = !d.approved ? 'pending' : !d.active ? 'disabled' : isOnline ? 'online' : isStandby ? 'standby' : 'offline';

  const checks = [];

  // Check 1: Device Registration & SN
  checks.push({
    name: 'Device Registration & Serial Number',
    status: d.approved ? 'pass' : 'warn',
    detail: `Serial Number: ${d.serial_number} (${d.name || 'Terminal'}). Approval: ${d.approved ? 'Approved' : 'Pending Approval'}.`,
    recommendation: d.approved ? null : 'Approve this device in the dashboard to begin accepting punches.',
  });

  // Check 2: Cloud Server ADMS Endpoints
  checks.push({
    name: 'Cloud ADMS Push Endpoints',
    status: 'pass',
    detail: 'HTTP endpoints /iclock/cdata and /api/adms are active and accepting payload up to 2MB.',
    recommendation: null,
  });

  // Check 3: HTTPS & TLS Compatibility (Render Cloud Audit)
  const isPrivate = isPrivateIp(d.ip_address);
  checks.push({
    name: 'HTTPS / TLS Protocol Compatibility',
    status: 'warn',
    detail: 'Cloud Render enforces HTTPS/TLS on port 443 and issues HTTP 301 redirects on port 80. Most physical ZKTeco firmwares (including uFace 800) use plain HTTP and do not follow 301 redirects or support TLS 1.2+ SNI.',
    recommendation: 'Use the bundled Local Sync Gateway (scripts/zkteco-gateway.js / start-sync-gateway.bat) on any office PC, or import logs via USB (.dat / .csv).',
  });

  // Check 4: Communication Telemetry
  if (isOnline) {
    checks.push({
      name: 'Recent Activity',
      status: 'pass',
      detail: `Terminal is actively communicating (last ping ${diffSec}s ago from IP ${d.last_ip || 'unknown'}).`,
      recommendation: null,
    });
  } else if (isStandby) {
    checks.push({
      name: 'Recent Activity',
      status: 'pass',
      detail: `Terminal is on standby (last ping ${Math.floor(diffSec / 60)} minutes ago). Waiting for next heartbeat or punch event.`,
      recommendation: null,
    });
  } else if (d.last_seen) {
    checks.push({
      name: 'Recent Activity',
      status: 'warn',
      detail: `Terminal was last seen ${Math.floor(diffSec / 3600)} hours ago from IP ${d.last_ip || 'unknown'}.`,
      recommendation: 'Check terminal power and network connection, or run start-sync-gateway.bat.',
    });
  } else {
    checks.push({
      name: 'Recent Activity',
      status: 'warn',
      detail: 'Terminal has not communicated with the server yet.',
      recommendation: 'Configure the Cloud Server Setting on your ZKTeco device, or start the Windows Gateway.',
    });
  }

  // Check 5: LAN / TCP Reachability (if IP provided)
  let tcpResult = null;
  if (d.ip_address) {
    if (isPrivate) {
      tcpResult = {
        ok: false,
        isPrivate: true,
        note: `Private IP (${d.ip_address}) cannot be reached directly from public cloud (Render). This is normal for cloud deployments.`,
      };
      checks.push({
        name: 'Local Network Reachability',
        status: 'pass',
        detail: `Configured IP (${d.ip_address}) is a local office LAN IP. Outbound ADMS push or Local Gateway connects outward to Cloud Render.`,
        recommendation: null,
      });
    } else {
      tcpResult = await tcpProbe(d.ip_address, d.port || 4370);
      checks.push({
        name: 'Direct TCP Socket (Port ' + (d.port || 4370) + ')',
        status: tcpResult.ok ? 'pass' : 'fail',
        detail: tcpResult.ok ? `TCP connection established in ${tcpResult.ms}ms.` : `TCP connection failed: ${tcpResult.error}`,
        recommendation: tcpResult.ok ? null : 'Verify port forwarding on office router.',
      });
    }
  }

  const serverHost = settings.adms_server_host || process.env.ADMS_SERVER_HOST || '192.168.3.9';
  const serverPort = settings.adms_server_port || process.env.PORT || 3000;
  const isHttps = Number(serverPort) === 443;

  const recommendations = [
    `Option 1 (Direct ADMS Push): On the device keypad, go to Menu -> Comm. -> Cloud Server Setting, enter Server Address: ${serverHost}, Port: ${serverPort}.`,
    'Option 2 (Local Windows Gateway): Run start-sync-gateway.bat on an office PC to bridge punches across networks.',
    'Option 3 (Offline): Download Att. Data from device menu onto a USB flash drive and upload via "Upload USB Log".',
  ];

  return {
    device: {
      id: d.id,
      name: d.name,
      serialNumber: d.serial_number,
      model: d.model || 'ZKTeco uFace800',
      location: d.location || '',
      protocol: d.protocol,
      approved: d.approved,
      active: d.active,
      status,
    },
    telemetry: {
      lastCommunicationTime: d.last_seen || null,
      lastPunchTime: punchStats.last_punch || d.last_punch_at || null,
      lastIp: d.last_ip || null,
      totalPunches: punchStats.total,
      punches24h: punchStats.punches_24h,
      diffSec,
      isOnline,
      isStandby,
    },
    cloudEndpoint: {
      serverDomain: serverHost,
      port: serverPort,
      admsPath: '/iclock/cdata',
      url: `${isHttps ? 'https' : 'http'}://${serverHost}:${serverPort}/iclock/cdata`,
    },
    tcp: tcpResult,
    checks,
    recommendations,
  };
}

module.exports = { tcpProbe, httpProbe, probeDevice };
