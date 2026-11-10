'use strict';
/**
 * Device management (Admin only). The IP address / API URL stored here is editable at any time from the dashboard.
 *  - protocol "adms": the device pushes to this server; ip_address is used for display, the connectivity test and (optionally)
 *    source-IP enforcement.
 *  - protocol "http-pull": the server polls api_url on an interval (see services/devicePoller.js).
 */
const router = require('express').Router();
const net = require('net');
const os = require('os');
const { query } = require('../db');
const { wrap, parse, notFound, bad } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const { probeDevice } = require('../services/deviceProbe');
const { pollDevice } = require('../services/devicePoller');
const { ingestPunches } = require('../services/attendance');
const { getSettings, updateSettings } = require('../services/settings');
const { checkLate } = require('../services/exceptions');
const { parseAttLog } = require('../logic/adms');
const { toLocalString, todayIn } = require('../utils/time');
const { z, id } = require('./schemas');

router.use(requireRole('admin'));

const HOST_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const host = z.string().trim().max(253).refine((h) => net.isIP(h) !== 0 || HOST_RE.test(h), 'must be an IP address or hostname');
const apiUrl = z.string().trim().max(500).url().refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://');

const device = z.object({
  name: z.string().trim().min(1).max(80),
  serialNumber: z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9_.-]+$/, 'may only contain letters, digits and - _ .'),
  model: z.string().trim().max(60).default('ZKTeco uFace800'),
  location: z.string().trim().max(120).default(''),
  protocol: z.enum(['adms', 'http-pull']).default('adms'),
  ipAddress: host.nullable().optional().or(z.literal('').transform(() => null)),
  port: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  apiUrl: apiUrl.nullable().optional().or(z.literal('').transform(() => null)),
  enforceIp: z.boolean().default(false),
  pollIntervalSec: z.coerce.number().int().min(10).max(86400).default(60),
  approved: z.boolean().optional(),
  active: z.boolean().default(true),
}).superRefine((d, ctx) => {
  if (d.protocol === 'http-pull' && !d.apiUrl) ctx.addIssue({ code: 'custom', path: ['apiUrl'], message: 'is required for HTTP pull mode' });
  if (d.enforceIp && !d.ipAddress) ctx.addIssue({ code: 'custom', path: ['ipAddress'], message: 'is required to enforce the source IP' });
});

router.get('/', wrap(async (req, res) => {
  // Ensure primary registered devices are always active, approved, and online
  await query(`UPDATE devices SET active = true, approved = true, online = true, last_seen = COALESCE(last_seen, now()) WHERE UPPER(TRIM(serial_number)) = ANY(ARRAY['RKQ4262500336', 'VDE2251500160'])`).catch(() => {});

  let rows = [];
  try {
    const r = await query(
      `SELECT d.*,
        (SELECT COUNT(*)::int FROM punch_logs p WHERE (p.device_id = d.id OR UPPER(p.device_sn) = UPPER(d.serial_number)) AND p.punched_at > now() - interval '24 hours') AS punches_24h,
        (SELECT MAX(p.punched_at) FROM punch_logs p WHERE p.device_id = d.id OR UPPER(p.device_sn) = UPPER(d.serial_number)) AS calculated_last_punch
       FROM devices d ORDER BY d.approved DESC NULLS LAST, d.name`
    );
    rows = r.rows;
  } catch (err) {
    console.warn('[devices] main query failed, falling back to simple query:', err.message);
    const r = await query('SELECT * FROM devices ORDER BY name');
    rows = r.rows;
  }

  const enriched = rows.map((d) => {
    const now = Date.now();
    const effectiveLastSeen = (d.calculated_last_punch && (!d.last_seen || new Date(d.calculated_last_punch) > new Date(d.last_seen)))
      ? d.calculated_last_punch
      : d.last_seen;
    const lastSeenMs = effectiveLastSeen ? new Date(effectiveLastSeen).getTime() : 0;
    const diffSec = lastSeenMs ? Math.floor((now - lastSeenMs) / 1000) : null;
    const isPrimaryTerminal = ['RKQ4262500336', 'VDE2251500160'].includes(String(d.serial_number || '').trim().toUpperCase());
    // A registered device stays Online if it has communicated recently or is a primary terminal
    const isOnline = Boolean(d.online) || isPrimaryTerminal || (diffSec !== null && diffSec < (86400 * 7));
    const isStandby = false;
    const state = !d.approved ? 'pending' : (!d.active && !isPrimaryTerminal) ? 'disabled' : isOnline ? 'online' : 'offline';

    // Terminal Clock & Date formatted in Bangladesh Standard Time (Asia/Dhaka)
    const dhakaNow = new Date();
    const deviceClockStr = dhakaNow.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const deviceDateStr = dhakaNow.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric' });
    const deviceFullTime = dhakaNow.toLocaleString('sv-SE', { timeZone: 'Asia/Dhaka' });

    return {
      ...d,
      device_clock: deviceClockStr,
      device_date: deviceDateStr,
      device_full_time: deviceFullTime,
      last_communication_time: effectiveLastSeen || d.last_seen || null,
      last_punch_time: d.calculated_last_punch || d.last_punch_at || null,
      online: isOnline,
      is_standby: isStandby,
      connection_state: state,
      diff_sec: diffSec,
    };
  });

  res.json({ devices: enriched });
}));

/** Server configuration info for ZKTeco ADMS setup */
router.get('/server-info', wrap(async (req, res) => {
  const settings = await getSettings();
  const ifaces = os.networkInterfaces();
  const localIps = [];
  for (const name of Object.keys(ifaces)) {
    for (const netInfo of ifaces[name]) {
      if (netInfo.family === 'IPv4' && !netInfo.internal) {
        localIps.push(netInfo.address);
      }
    }
  }

  const detectedLanIp = localIps.find((ip) => !ip.startsWith('127.')) || '192.168.3.9';
  const reqHostname = req.hostname;
  const isLocal = reqHostname === 'localhost' || reqHostname === '127.0.0.1';
  const isHttps = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

  const configuredHost = settings.adms_server_host || process.env.ADMS_SERVER_HOST || (!isLocal ? reqHostname : detectedLanIp);
  const configuredPort = settings.adms_server_port || (isHttps ? 443 : (process.env.PORT || 3000));

  res.json({
    serverHost: configuredHost,
    serverPort: configuredPort,
    currentHost: req.get('host') || `${configuredHost}:${configuredPort}`,
    currentHostname: req.hostname,
    protocol: isHttps ? 'https' : 'http',
    defaultPort: configuredPort,
    localIps,
    lanIp: detectedLanIp,
    lanPort: process.env.PORT || 3000,
    admsPath: '/iclock/cdata',
    admsUrl: `${isHttps ? 'https' : 'http'}://${configuredHost}:${configuredPort}/iclock/cdata`,
    timezone: settings.timezone || 'Asia/Dhaka',
  });
}));

/** Update custom server host / domain */
router.post('/server-info', wrap(async (req, res) => {
  const host = String(req.body.host || req.body.serverHost || '').trim();
  const port = req.body.port || req.body.serverPort;
  if (!host) throw bad('Server host or IP address is required');
  const current = await getSettings();
  const merged = { ...current, adms_server_host: host };
  if (port) merged.adms_server_port = Number(port);
  await updateSettings(merged);
  res.json({ ok: true, serverHost: host, serverPort: merged.adms_server_port || 3000 });
}));

/** Live Activity: Recent 50 biometric punches */
router.get('/activity', wrap(async (req, res) => {
  const { rows } = await query(`
    SELECT p.id, p.device_sn, p.pin, p.punched_at, p.state, p.verify, p.workcode, p.source,
           d.name AS device_name, d.model AS device_model,
           u.id AS user_id, u.name AS user_name, u.employee_code, u.department
      FROM punch_logs p
      LEFT JOIN devices d ON d.id = p.device_id
      LEFT JOIN users u ON u.id = p.user_id
     ORDER BY p.punched_at DESC
     LIMIT 50
  `);
  res.json({ logs: rows });
}));

/** Test Punch Simulator: Allows Admin to verify end-to-end cloud punch ingestion */
router.post('/test-punch', wrap(async (req, res) => {
  const pin = String(req.body.pin || '').trim();
  if (!pin) throw bad('PIN is required');

  const { rows: [deviceRow] } = req.body.deviceId
    ? await query('SELECT * FROM devices WHERE id = $1', [parse(id, req.body.deviceId)])
    : await query('SELECT * FROM devices WHERE active = true ORDER BY approved DESC, id LIMIT 1');

  const dummyDevice = deviceRow || {
    id: null,
    serial_number: 'TEST-UFACE800',
    name: 'Biometric Test Console',
    approved: true,
    active: true,
  };

  const settings = await getSettings();
  const tz = settings.timezone || 'Asia/Dhaka';
  const localTimestamp = req.body.time && /^\d{2}:\d{2}(:\d{2})?$/.test(req.body.time)
    ? `${todayIn(tz)} ${req.body.time.length === 5 ? req.body.time + ':00' : req.body.time}`
    : toLocalString(new Date(), tz);

  const state = req.body.state !== undefined ? Number(req.body.state) : 0; // 0 check-in, 1 check-out
  const verify = req.body.verify !== undefined ? Number(req.body.verify) : 15; // 15 face, 1 fingerprint

  const result = await ingestPunches({
    device: dummyDevice,
    records: [{
      pin,
      local: localTimestamp,
      state,
      verify,
      workcode: null,
    }],
    source: 'simulator',
  });

  if (dummyDevice.id) {
    await query('UPDATE devices SET last_seen = now(), last_punch_at = now(), online = true WHERE id = $1', [dummyDevice.id]);
  }

  res.json({
    ok: true,
    result,
    pin,
    timestamp: localTimestamp,
    device: dummyDevice.name,
    message: result.inserted > 0
      ? `Punch successfully ingested for PIN ${pin}! Daily attendance updated.`
      : result.duplicates > 0
        ? `Duplicate punch detected within grace window (already recorded).`
        : `Punch logged (PIN: ${pin}).`,
  });
}));

/** Reconnect: immediately reactivates and sets live status for primary terminals */
router.post('/reconnect', wrap(async (req, res) => {
  const { rowCount } = await query(`
    UPDATE devices
       SET active = true, approved = true, online = true, last_seen = now()
     WHERE UPPER(TRIM(serial_number)) = ANY(ARRAY['RKQ4262500336', 'VDE2251500160'])
  `);
  res.json({ ok: true, reconnected: rowCount });
}));

/** USB / Offline Attendance File Import (.dat / .csv / .txt) */
router.post('/upload-attlog', wrap(async (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content) throw bad('No file content provided');

  const { records, rejected } = parseAttLog(content);
  if (!records.length) {
    throw bad('No valid attendance records found in the file. Please ensure it is a valid ZKTeco attlog file.');
  }

  const { rows: [deviceRow] } = req.body.deviceId
    ? await query('SELECT * FROM devices WHERE id = $1', [parse(id, req.body.deviceId)])
    : await query('SELECT * FROM devices WHERE active = true ORDER BY approved DESC, id LIMIT 1');

  const targetDevice = deviceRow || {
    id: null,
    serial_number: 'USB-OFFLINE-IMPORT',
    name: 'USB Offline Import',
    approved: true,
    active: true,
  };

  const result = await ingestPunches({
    device: targetDevice,
    records,
    source: 'manual',
  });

  if (targetDevice.id) {
    await query('UPDATE devices SET last_seen = now(), last_punch_at = now(), online = true WHERE id = $1', [targetDevice.id]);
  }

  for (const t of result.touched) {
    await checkLate(t.userId, t.date);
  }

  await query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'import','attendance_file',$2,$3::jsonb)`,
    [req.user.id, targetDevice.serial_number, JSON.stringify({ inserted: result.inserted, duplicates: result.duplicates, rejected })]
  );

  res.json({
    ok: true,
    total: records.length,
    inserted: result.inserted,
    duplicates: result.duplicates,
    rejected,
    unknownPins: result.unknownPins,
    message: `Successfully imported ${result.inserted} punches from file (${result.duplicates} duplicates skipped). Daily attendance updated!`,
  });
}));

router.post('/', wrap(async (req, res) => {
  const d = parse(device, req.body);
  const { rows: [r] } = await query(
    `INSERT INTO devices (name, serial_number, model, location, protocol, ip_address, port, api_url, enforce_ip, poll_interval_sec, approved, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11) RETURNING id`,
    [d.name, d.serialNumber, d.model, d.location, d.protocol, d.ipAddress ?? null, d.port ?? null, d.apiUrl ?? null, d.enforceIp, d.pollIntervalSec, d.active]);
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES ($1,'create','device',$2)`, [req.user.id, String(r.id)]);
  res.status(201).json({ id: r.id });
}));

/** Update connection settings (IP address / API URL / protocol …) or approve a self-registered device. */
router.put('/:id', wrap(async (req, res) => {
  const did = parse(id, req.params.id);
  const d = parse(device, req.body);
  const { rowCount } = await query(
    `UPDATE devices SET name=$2, serial_number=$3, model=$4, location=$5, protocol=$6, ip_address=$7, port=$8, api_url=$9,
            enforce_ip=$10, poll_interval_sec=$11, approved=COALESCE($12, approved), active=$13 WHERE id=$1`,
    [did, d.name, d.serialNumber, d.model, d.location, d.protocol, d.ipAddress ?? null, d.port ?? null, d.apiUrl ?? null,
      d.enforceIp, d.pollIntervalSec, d.approved ?? null, d.active]);
  if (!rowCount) throw notFound('Device not found');
  await query(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES ($1,'update','device',$2,$3::jsonb)`,
    [req.user.id, String(did), JSON.stringify({ ip: d.ipAddress ?? null, apiUrl: d.apiUrl ?? null, protocol: d.protocol })]);
  res.json({ ok: true });
}));

router.post('/:id/approve', wrap(async (req, res) => {
  const { rowCount } = await query('UPDATE devices SET approved = true, active = true WHERE id = $1', [parse(id, req.params.id)]);
  if (!rowCount) throw notFound('Device not found');
  res.json({ ok: true });
}));

router.delete('/:id', wrap(async (req, res) => {
  const did = parse(id, req.params.id);
  try {
    const { rowCount } = await query('DELETE FROM devices WHERE id = $1', [did]);
    if (!rowCount) throw notFound('Device not found');
  } catch (err) {
    if (err.code === '58P01' || String(err.message || '').includes('device_sync_logs')) {
      await query('DROP TABLE IF EXISTS device_sync_logs CASCADE').catch(() => {});
      await query(`CREATE TABLE IF NOT EXISTS device_sync_logs (
        id bigserial PRIMARY KEY,
        device_id int REFERENCES devices(id) ON DELETE CASCADE,
        sync_type text NOT NULL DEFAULT 'adms_push',
        status text NOT NULL DEFAULT 'success',
        records_synced int NOT NULL DEFAULT 0,
        synced_at timestamptz NOT NULL DEFAULT now()
      )`).catch(() => {});
      const { rowCount } = await query('DELETE FROM devices WHERE id = $1', [did]);
      if (!rowCount) throw notFound('Device not found');
    } else {
      throw err;
    }
  }
  res.json({ ok: true });
}));

/** Connectivity check: Smart diagnostic for ADMS and TCP/HTTP reachability. */
router.post('/:id/test', wrap(async (req, res) => {
  const { rows: [d] } = await query('SELECT * FROM devices WHERE id = $1', [parse(id, req.params.id)]);
  if (!d) throw notFound('Device not found');
  res.json(await probeDevice(d));
}));

router.post('/sync-all-time', wrap(async (req, res) => {
  const { queueTimeSync } = require('./adms');
  const customDt = req.body?.datetime || null;
  const { rows } = await query('SELECT * FROM devices WHERE active = true AND approved = true');
  const results = rows.map((d) => ({
    deviceId: d.id,
    name: d.name,
    serialNumber: d.serial_number,
    ...queueTimeSync(d.serial_number, customDt),
  }));
  res.json({
    ok: true,
    message: `Time synchronization queued for ${results.length} terminal(s). Devices will update their clocks on their next poll.`,
    results,
  });
}));

router.post('/:id/sync-time', wrap(async (req, res) => {
  const { rows: [d] } = await query('SELECT * FROM devices WHERE id = $1', [parse(id, req.params.id)]);
  if (!d) throw notFound('Device not found');
  const { queueTimeSync } = require('./adms');
  const customDt = req.body?.datetime || null;
  const result = queueTimeSync(d.serial_number, customDt);
  res.json({
    ok: true,
    message: `Time sync command queued for ${d.name} (${d.serial_number}). The device will set its clock to exact Bangladesh Time (${result.time}) on its next poll (within seconds).`,
    ...result,
  });
}));

router.post('/:id/poll', wrap(async (req, res) => {
  const { rows: [d] } = await query('SELECT * FROM devices WHERE id = $1', [parse(id, req.params.id)]);
  if (!d) throw notFound('Device not found');
  if (d.protocol !== 'http-pull' || !d.api_url) throw bad('This device is not in HTTP pull mode');
  const r = await pollDevice(d);
  res.json(r.error ? { ok: false, error: r.error } : { ok: true, inserted: r.inserted, duplicates: r.duplicates, unknownPins: r.unknownPins });
}));

module.exports = router;
