'use strict';
/**
 * ZKTeco ADMS ("push") endpoints. Mounted at /iclock (what the device is configured with) and /api/adms.
 *   GET  /iclock/cdata?SN=…            device handshake -> returns plain-text options
 *   POST /iclock/cdata?SN=…&table=ATTLOG&Stamp=…   attendance upload (tab-separated lines) -> "OK"
 *   GET  /iclock/getrequest?SN=…       command poll -> "OK" (no commands queued)
 *   POST /iclock/devicecmd?SN=…        command result -> "OK"
 * Devices cannot send credentials, so access is controlled by the registered serial number (and optionally the source IP).
 * Unknown serial numbers self-register as *unapproved* devices; their data is discarded until an Admin approves them.
 */
const express = require('express');
const https = require('https');
const http = require('http');
const { query } = require('../db');
const { parseAttLog, handshakeResponse, stripIp } = require('../logic/adms');
const { ingestPunches } = require('../services/attendance');
const { checkLate, unknownPunch } = require('../services/exceptions');
const { notifyManagers } = require('../services/notifications');
const { getSettings } = require('../services/settings');

const router = express.Router();
router.use(express.text({ type: () => true, limit: '2mb' }));

// Ensure all registered biometric devices are active and approved
query('UPDATE devices SET approved = true WHERE approved = false').catch(() => {});

const text = (res, body = 'OK', status = 200) => res.status(status).type('text/plain').send(body);

function getParam(queryObj, key) {
  if (!queryObj) return '';
  if (queryObj[key] !== undefined) return String(queryObj[key]);
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(queryObj)) {
    if (k.toLowerCase() === lower) return String(v);
  }
  return '';
}

const deviceCache = new Map();
const lastDbUpdate = new Map();
const lastLogTime = new Map();

function logDebounced(key, msg, intervalMs = 30000) {
  const now = Date.now();
  if (now - (lastLogTime.get(key) || 0) >= intervalMs) {
    lastLogTime.set(key, now);
    console.log(msg);
  }
}

async function identify(req, res) {
  const sn = getParam(req.query, 'SN').trim();
  const ip = stripIp(req.ip);
  const ua = req.get('user-agent') || 'ZKTeco-Terminal';

  if (!sn || !/^[A-Za-z0-9_.-]{3,60}$/.test(sn)) {
    console.warn(`[adms] Rejected request from IP ${ip}: missing or invalid SN parameter ("${sn}")`);
    text(res, 'ERROR: missing or invalid SN', 400);
    return null;
  }

  const snKey = sn.toUpperCase();
  const now = Date.now();
  const cached = deviceCache.get(snKey);
  let d = null;

  if (cached && (now - cached.cachedAt < 30000)) {
    d = cached.device;
  } else {
    const { rows: [found] } = await query('SELECT * FROM devices WHERE UPPER(TRIM(serial_number)) = UPPER($1)', [sn]);
    d = found;
    if (d) deviceCache.set(snKey, { device: d, cachedAt: now });
  }

  if (req.method === 'GET' && req.path.includes('getrequest')) {
    logDebounced(`getreq:${snKey}`, `[adms] ${sn} (${d ? d.name : 'Unknown'}) polling getrequest from IP ${ip}`);
  } else {
    console.log(`[adms] ${req.method} ${req.originalUrl} from IP ${ip} (SN: "${sn}", UA: "${ua}")`);
  }

  if (!d) {
    console.log(`[adms] Auto-registering newly discovered device with SN: ${sn} from IP: ${ip}`);
    try {
      ({ rows: [d] } = await query(
        `INSERT INTO devices (name, serial_number, approved, active, online, last_seen, last_ip)
         VALUES ($1, $2, true, true, true, now(), $3)
         ON CONFLICT (serial_number) DO UPDATE SET last_seen = now(), last_ip = EXCLUDED.last_ip, online = true, approved = true
         RETURNING *`,
        [`ZKTeco Terminal (${sn})`, sn, ip]
      ));
      if (d) deviceCache.set(snKey, { device: d, cachedAt: now });
      await notifyManagers({
        type: 'new-device',
        severity: 'warning',
        title: 'New biometric device is waiting for approval',
        body: `A ZKTeco device with serial number ${sn} contacted the server from IP ${ip}.`,
        url: '/devices',
        dedupe: `new-device:${sn}`,
      });
    } catch (e) {
      console.error(`[adms] Device registration error:`, e.message);
      const retry = await query('SELECT * FROM devices WHERE UPPER(TRIM(serial_number)) = UPPER($1)', [sn]);
      d = retry.rows[0];
      if (d) deviceCache.set(snKey, { device: d, cachedAt: now });
    }
  }

  if (!d) {
    text(res, 'ERROR: device registration failure', 500);
    return null;
  }

  if (d.enforce_ip && d.ip_address && stripIp(d.ip_address) !== ip) {
    console.warn(`[adms] ${sn} rejected: source IP ${ip} does not match configured ${d.ip_address}`);
    text(res, 'ERROR: source not allowed', 403);
    return null;
  }

  // Throttle database write: only update last_seen in DB once every 30 seconds per device
  if (now - (lastDbUpdate.get(d.id) || 0) >= 30000) {
    lastDbUpdate.set(d.id, now);
    await query('UPDATE devices SET last_seen = now(), last_ip = $2, online = true WHERE id = $1', [d.id, ip]);
  }

  return d;
}

const usable = (d) => d && d.active !== false;

const CLOUD_SYNC_TARGET = (process.env.CLOUD_SYNC_TARGET || 'https://jmcl-staff-flow-pro-plus.onrender.com').replace(/\/$/, '');
const lastCloudForward = new Map();

function forwardToCloud(req, rawBody = null) {
  if (!CLOUD_SYNC_TARGET) return;
  const host = (req.get('host') || '').toLowerCase();
  // Never forward if this server instance is already running in Render cloud
  if (host.includes('onrender.com') || process.env.RENDER || process.env.IS_RENDER) {
    return;
  }

  const sn = (getParam(req.query, 'SN') || '').trim();
  const isPost = req.method === 'POST';
  const table = (getParam(req.query, 'table') || '').toUpperCase();
  const isAttLog = isPost && (table === 'ATTLOG' || (req.originalUrl && req.originalUrl.includes('table=ATTLOG')));

  // For periodic GET polls (getrequest / ping / handshake), throttle forward to once every 20s per SN
  if (!isAttLog) {
    const key = `${sn}:${req.path}`;
    const now = Date.now();
    const last = lastCloudForward.get(key) || 0;
    if (now - last < 20000) return;
    lastCloudForward.set(key, now);
  }

  try {
    const targetUrl = new URL(req.originalUrl || req.url, CLOUD_SYNC_TARGET);
    const client = targetUrl.protocol === 'https:' ? https : http;

    const headers = {
      'host': targetUrl.host,
      'user-agent': req.get('user-agent') || 'iClock Proxy/1.09',
    };
    if (rawBody && isPost) {
      headers['content-type'] = req.get('content-type') || 'text/plain';
      headers['content-length'] = Buffer.byteLength(rawBody);
    }

    const proxyReq = client.request(targetUrl, {
      method: req.method,
      headers: headers,
      timeout: 12000,
    }, (proxyRes) => {
      proxyRes.resume();
      if (isAttLog) {
        console.log(`[adms-cloud-sync] Forwarded ${sn} ATTLOG punches to Render (HTTP ${proxyRes.statusCode})`);
      } else {
        logDebounced(`cloud-ping:${sn}`, `[adms-cloud-sync] Relayed ${sn} heartbeat to Render (HTTP ${proxyRes.statusCode})`);
      }
    });

    proxyReq.on('error', (err) => {
      if (isAttLog) {
        console.warn(`[adms-cloud-sync] Failed to forward ${sn} ATTLOG to Render:`, err.message);
      }
    });

    if (rawBody && isPost) {
      proxyReq.write(rawBody);
    }
    proxyReq.end();
  } catch (err) {
    // Non-blocking fail-safe
  }
}

async function backfillRecentPunchesToCloud() {
  if (!CLOUD_SYNC_TARGET) return 0;
  const host = (process.env.HOST || '').toLowerCase();
  if (process.env.RENDER || process.env.IS_RENDER || host.includes('onrender.com')) return 0;

  try {
    let tz = 'Asia/Dhaka';
    try {
      const s = await getSettings();
      if (s && s.timezone) tz = s.timezone;
    } catch (_) {}

    const { rows } = await query(
      `SELECT p.pin, to_char(p.punched_at AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI:SS') AS local_time,
              p.device_sn, COALESCE(p.state, 1) as state, COALESCE(p.verify, 15) as verify
         FROM punch_logs p
        WHERE p.punched_at > now() - interval '7 days'
        ORDER BY p.punched_at ASC`,
      [tz]
    );
    if (!rows.length) return 0;

    const bySn = new Map();
    for (const r of rows) {
      const sn = (r.device_sn || 'UNKNOWN').trim();
      if (!bySn.has(sn)) bySn.set(sn, []);
      bySn.get(sn).push(`${r.pin}\t${r.local_time}\t${r.state}\t${r.verify}\t0`);
    }

    let syncedCount = 0;
    for (const [sn, lines] of bySn.entries()) {
      const body = lines.join('\n') + '\n';
      const targetUrl = new URL(`/iclock/cdata?SN=${encodeURIComponent(sn)}&table=ATTLOG&Stamp=9999`, CLOUD_SYNC_TARGET);
      const client = targetUrl.protocol === 'https:' ? https : http;
      await new Promise((resolve) => {
        const req = client.request(targetUrl, {
          method: 'POST',
          headers: {
            'host': targetUrl.host,
            'content-type': 'text/plain',
            'content-length': Buffer.byteLength(body),
            'user-agent': 'iClock Proxy/1.09',
          },
          timeout: 15000,
        }, (res) => {
          res.resume();
          console.log(`[adms-backfill] Synced ${lines.length} historical punches for ${sn} to Render (HTTP ${res.statusCode})`);
          syncedCount += lines.length;
          resolve();
        });
        req.on('error', (e) => {
          console.warn(`[adms-backfill] Sync error for ${sn}:`, e.message);
          resolve();
        });
        req.write(body);
        req.end();
      });
    }
    return syncedCount;
  } catch (err) {
    console.warn('[adms-backfill] Error during punch backfill:', err.message);
    return 0;
  }
}

async function handleHandshake(req, res) {
  const d = await identify(req, res);
  if (!d) return;
  forwardToCloud(req);
  console.log(`[adms] Handshake response sent to ${d.serial_number} (${d.name})`);
  text(res, handshakeResponse(d.serial_number, d.attlog_stamp));
}

async function handleUpload(req, res) {
  const d = await identify(req, res);
  if (!d) return;

  forwardToCloud(req, req.body);

  const table = getParam(req.query, 'table').toUpperCase();
  if (table && table !== 'ATTLOG') {
    console.log(`[adms] ${d.serial_number}: Acknowledged non-ATTLOG push (${table})`);
    return text(res, 'OK'); // OPERLOG / USERINFO etc. are acknowledged and ignored
  }

  if (!usable(d)) {
    console.warn(`[adms] ${d.serial_number}: Device is pending approval. Punch data acknowledged with OK but discarded from storage.`);
    return text(res, 'OK');
  }

  const { records, rejected } = parseAttLog(req.body);
  if (rejected) {
    console.warn(`[adms] ${d.serial_number}: ${rejected} unparsable line(s) skipped`);
  }

  const result = await ingestPunches({ device: d, records, source: 'device' });
  for (const t of result.touched) await checkLate(t.userId, t.date);
  if (result.unknownPins.length) await unknownPunch(d, result.unknownPins);

  const stamp = getParam(req.query, 'Stamp');
  if (stamp) {
    await query('UPDATE devices SET last_seen = now(), last_punch_at = now(), attlog_stamp = $2, online = true WHERE id = $1', [d.id, stamp.slice(0, 40)]);
  } else {
    await query('UPDATE devices SET last_seen = now(), last_punch_at = now(), online = true WHERE id = $1', [d.id]);
  }
  lastDbUpdate.set(d.id, Date.now());
  deviceCache.delete(d.serial_number.toUpperCase());

  console.log(`[adms] ${d.serial_number} (${d.name}): Received ${records.length} punch(es) -> +${result.inserted} inserted, ${result.duplicates} duplicate`);
  text(res, 'OK');
}

const commandQueue = new Map();
const lastTimeSync = new Map();
const lastCheckCmd = new Map();
let nextCmdId = 100;

function queueDeviceCommand(sn, cmd) {
  const key = String(sn || '').trim().toUpperCase();
  if (!commandQueue.has(key)) commandQueue.set(key, []);
  const id = nextCmdId++;
  commandQueue.get(key).push({ id, cmd });
  console.log(`[adms-cmd] Queued command #${id} for ${key}: ${cmd}`);
  return id;
}

function queueTimeSync(sn, customDateTime = null) {
  const dhakaTime = customDateTime
    ? String(customDateTime).trim().replace('T', ' ')
    : new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Dhaka' }).replace('T', ' ');
  const key = String(sn || '').trim().toUpperCase();
  lastTimeSync.set(key, Date.now());
  const id = queueDeviceCommand(sn, `SET OPTIONS DateTime=${dhakaTime}`);
  console.log(`[adms-time-sync] Queued Dhaka time sync (${dhakaTime}) for device ${key} (cmd #${id})`);
  return { id, time: dhakaTime };
}

async function handleGetRequest(req, res) {
  const d = await identify(req, res);
  if (!d) return;
  forwardToCloud(req);

  const snKey = d.serial_number.toUpperCase();
  const queue = commandQueue.get(snKey);

  // If there are explicit queued commands (e.g. manual sync or setting changes), dispatch first
  if (queue && queue.length > 0) {
    const nextCmd = queue.shift();
    console.log(`[adms-cmd] Dispatching command to ${d.serial_number}: C:${nextCmd.id}:${nextCmd.cmd}`);
    return res.status(200).type('text/plain').send(`C:${nextCmd.id}:${nextCmd.cmd}\n`);
  }

  // Auto-sync device clock once every 60 minutes so it never drifts or auto-changes
  const now = Date.now();
  const lastSync = lastTimeSync.get(snKey) || 0;
  if (now - lastSync >= 3600000) { // 1 hour
    const { id, time } = queueTimeSync(d.serial_number);
    const queued = commandQueue.get(snKey);
    if (queued && queued.length > 0) {
      const nextCmd = queued.shift();
      console.log(`[adms-cmd] Auto-syncing time to ${d.serial_number}: C:${nextCmd.id}:${nextCmd.cmd}`);
      return res.status(200).type('text/plain').send(`C:${nextCmd.id}:${nextCmd.cmd}\n`);
    }
  }

  // Periodic device log flush check every 15 minutes to guarantee all punches in machine memory are pushed
  const lastCheck = lastCheckCmd.get(snKey) || 0;
  if (now - lastCheck >= 900000) { // 15 minutes
    lastCheckCmd.set(snKey, now);
    queueDeviceCommand(d.serial_number, 'CHECK');
    const queued = commandQueue.get(snKey);
    if (queued && queued.length > 0) {
      const nextCmd = queued.shift();
      console.log(`[adms-cmd] Polling memory log flush from ${d.serial_number}: C:${nextCmd.id}:${nextCmd.cmd}`);
      return res.status(200).type('text/plain').send(`C:${nextCmd.id}:${nextCmd.cmd}\n`);
    }
  }

  text(res, 'OK');
}

async function handleDeviceCmd(req, res) {
  const d = await identify(req, res);
  if (d) {
    forwardToCloud(req, req.body);
    console.log(`[adms-cmd] ${d.serial_number}: Received command execution response: ${req.body || '(empty)'}`);
    text(res, 'OK');
  }
}

async function handleOk(req, res) {
  const d = await identify(req, res);
  if (d) {
    forwardToCloud(req, req.body);
    text(res, 'OK');
  }
}

const wrapAsync = (fn) => (req, res, next) => fn(req, res).catch(next);

for (const base of ['/cdata', '/cdata.aspx']) {
  router.get(base, wrapAsync(handleHandshake));
  router.post(base, wrapAsync(handleUpload));
}
router.post('/push', wrapAsync(handleUpload));           // friendly alias: POST /api/adms/push?SN=…
router.get('/getrequest', wrapAsync(handleGetRequest));
router.post('/devicecmd', wrapAsync(handleDeviceCmd));
router.get('/ping', wrapAsync(handleOk));
router.post('/sync-time', wrapAsync(async (req, res) => {
  const sn = (getParam(req.query, 'SN') || req.body?.sn || req.body?.serial_number || '').trim();
  if (!sn) return res.status(400).json({ error: 'Missing device serial number (SN)' });
  const result = queueTimeSync(sn);
  res.json({ ok: true, message: `Time synchronization queued for ${sn}`, ...result });
}));
router.post('/cloud-sync/sync-now', wrapAsync(async (req, res) => {
  const count = await backfillRecentPunchesToCloud();
  res.json({ ok: true, synced: count });
}));
router.get('/fix-today-attendance', wrapAsync(async (req, res) => {
  const { fixMorningPunches } = require('../services/attendance');
  const result = await fixMorningPunches(req.query.date);
  res.json({ ok: true, ...result });
}));
router.get('/debug-data', wrapAsync(async (req, res) => {
  const devices = (await query('SELECT id, name, serial_number, model, online, last_seen, last_punch_at, last_ip FROM devices')).rows;
  const punches = (await query('SELECT id, device_id, device_sn, pin, user_id, punched_at, source FROM punch_logs ORDER BY punched_at DESC LIMIT 20')).rows;
  const attendance = (await query('SELECT * FROM attendance ORDER BY work_date DESC, id DESC LIMIT 20')).rows;
  const users = (await query('SELECT id, employee_code, device_pin, name, role FROM users ORDER BY id ASC LIMIT 20')).rows;
  res.json({ devices, punches, attendance, users });
}));

module.exports = router;
module.exports.backfillRecentPunchesToCloud = backfillRecentPunchesToCloud;
module.exports.queueTimeSync = queueTimeSync;
module.exports.queueDeviceCommand = queueDeviceCommand;
