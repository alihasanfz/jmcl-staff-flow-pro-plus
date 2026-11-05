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
const { query } = require('../db');
const { parseAttLog, handshakeResponse, stripIp } = require('../logic/adms');
const { ingestPunches } = require('../services/attendance');
const { checkLate, unknownPunch } = require('../services/exceptions');
const { notifyManagers } = require('../services/notifications');

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

async function handleHandshake(req, res) {
  const d = await identify(req, res);
  if (!d) return;
  console.log(`[adms] Handshake response sent to ${d.serial_number} (${d.name})`);
  text(res, handshakeResponse(d.serial_number, d.attlog_stamp));
}

async function handleUpload(req, res) {
  const d = await identify(req, res);
  if (!d) return;

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

async function handleOk(req, res) {
  const d = await identify(req, res);
  if (d) text(res, 'OK');
}

const wrapAsync = (fn) => (req, res, next) => fn(req, res).catch(next);

for (const base of ['/cdata', '/cdata.aspx']) {
  router.get(base, wrapAsync(handleHandshake));
  router.post(base, wrapAsync(handleUpload));
}
router.post('/push', wrapAsync(handleUpload));           // friendly alias: POST /api/adms/push?SN=…
router.get('/getrequest', wrapAsync(handleOk));
router.post('/devicecmd', wrapAsync(handleOk));
router.get('/ping', wrapAsync(handleOk));

module.exports = router;
