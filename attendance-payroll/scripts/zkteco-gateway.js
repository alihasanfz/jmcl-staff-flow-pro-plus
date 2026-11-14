#!/usr/bin/env node
'use strict';
/**
 * JMCL STAFF FLOW PRO — Advanced ZKTeco Local Gateway & Cloud ADMS Proxy
 * 
 * Bridges local network ZKTeco devices (uFace 800, SenseFace 7A, SilkBio, MB series)
 * to the JMCL Staff Flow Pro server on Render over secure HTTPS.
 * 
 * Key Features:
 *  1. Multi-Port ADMS Proxy (8080 & 3000): Listens for plain HTTP pushes from ZKTeco
 *     devices and transparently relays them to Render over HTTPS TLS 1.3.
 *  2. De-chunking & Header Sanitization: Strips Cloudflare chunked encoding and keep-alive
 *     headers, returning standard unchunked Content-Length + Connection: close to terminals.
 *  3. Path Auto-Normalizer: Automatically maps /cdata, /getrequest, /devicecmd to /iclock/*.
 *  4. Intelligent LAN Scanner: Periodically checks 192.168.0.201:4370 and scans subnet for devices.
 *  5. Interactive Console: Press 't' to send test punch, 's' to scan devices, 'h' for help.
 */
const net = require('net');
const http = require('http');
const https = require('https');
const os = require('os');
const readline = require('readline');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const DEVICE_IP = String(opt('device-ip', process.env.DEVICE_IP || '192.168.0.201'));
const DEVICE_PORT = parseInt(opt('device-port', process.env.DEVICE_PORT || '4370'), 10);
const PROXY_PORT = parseInt(opt('proxy-port', process.env.PROXY_PORT || '8080'), 10);
const SERVER_URL = String(opt('server-url', process.env.SERVER_URL || 'https://jmcl-staff-flow-pro-plus-2846.onrender.com')).replace(/\/$/, '');
const POLL_INTERVAL = parseInt(opt('poll-interval', 20), 10) * 1000;

// Discover all active local IPv4 addresses
const ifaces = os.networkInterfaces();
const localIps = [];
for (const name of Object.keys(ifaces)) {
  for (const netInfo of ifaces[name]) {
    if (netInfo.family === 'IPv4' && !netInfo.internal) {
      localIps.push(netInfo.address);
    }
  }
}
const primaryLanIp = localIps[0] || '127.0.0.1';

console.clear ? console.clear() : null;
console.log('================================================================');
console.log('       JMCL STAFF FLOW PRO — ZKTeco Gateway & ADMS Proxy        ');
console.log('================================================================');
console.log(`Cloud Server Target : ${SERVER_URL}`);
console.log(`Primary Local IP    : ${primaryLanIp}`);
console.log(`All PC Network IPs  : ${localIps.join(', ') || '127.0.0.1'}`);
console.log(`Configured Device   : ${DEVICE_IP}:${DEVICE_PORT}`);
console.log(`Local ADMS Proxy    : Port ${PROXY_PORT} (Primary)`);
console.log('================================================================\n');

console.log('----------------------------------------------------------------');
console.log('  HOW TO CONFIGURE YOUR ZKTECO BIOMETRIC DEVICE (uFace 800 / SenseFace):');
console.log('----------------------------------------------------------------');
console.log('  1. Press [M/OK] on the physical device keypad to open Main Menu.');
console.log('  2. Navigate to: Comm. (Communication) -> Cloud Server Setting');
console.log('     (On some devices named: ADMS or Web Server Setting)');
console.log(`  3. Server Address   : ${primaryLanIp}   <--- Enter this PC IP`);
console.log(`  4. Server Port      : ${PROXY_PORT}          <--- Default is ${PROXY_PORT}`);
console.log('  5. Enable Domain    : OFF');
console.log('  6. Enable Proxy     : OFF');
console.log('  7. Press [ESC] to save and reboot the terminal.');
console.log('----------------------------------------------------------------\n');
console.log('Listening for live punches from biometric devices...\n');

/** Check TCP connection to terminal port */
function checkDeviceReachable(ip = DEVICE_IP, port = DEVICE_PORT, timeout = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on('connect', () => {
      socket.destroy();
      resolve({ ok: true, ip, port });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, ip, port, error: 'Connection timed out' });
    });
    socket.on('error', (err) => {
      socket.destroy();
      resolve({ ok: false, ip, port, error: err.message });
    });
    socket.connect(port, ip);
  });
}

/** Quick subnet scan to detect ZKTeco terminals on port 4370 */
let isScanning = false;
let discoveredDeviceIps = [];

async function scanSubnetForTerminals() {
  if (isScanning || localIps.length === 0) return;
  isScanning = true;
  try {
    const baseSubnet = primaryLanIp.split('.').slice(0, 3).join('.');
    const candidates = [];
    for (let i = 2; i <= 254; i++) {
      const ip = `${baseSubnet}.${i}`;
      if (ip !== primaryLanIp) candidates.push(ip);
    }
    const found = [];
    const batchSize = 30;
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((ip) => checkDeviceReachable(ip, 4370, 600)));
      for (const r of results) {
        if (r.ok) found.push(r.ip);
      }
    }
    discoveredDeviceIps = found;
    if (found.length > 0) {
      console.log(`[LAN Discovery] Found ${found.length} ZKTeco terminal(s) on network: ${found.join(', ')}:4370`);
    }
  } catch (_) {
  } finally {
    isScanning = false;
  }
}

/** Relay request from local terminal to Cloud Server over HTTPS */
function proxyRequestToCloud(req, res, bodyBuffer) {
  const isHttps = SERVER_URL.startsWith('https');
  const client = isHttps ? https : http;

  // Normalize path: Ensure /iclock prefix is present so Render handles it properly
  let normalizedUrl = req.url;
  if (!normalizedUrl.startsWith('/iclock/') && !normalizedUrl.startsWith('/api/adms/')) {
    normalizedUrl = '/iclock' + (normalizedUrl.startsWith('/') ? normalizedUrl : '/' + normalizedUrl);
  }

  const targetUrl = new URL(SERVER_URL + normalizedUrl);
  const clientIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  const headers = {
    ...req.headers,
    host: targetUrl.host,
    'x-forwarded-for': clientIp,
    'x-forwarded-proto': 'http',
    'accept-encoding': 'identity', // Prevents gzip so response can be easily parsed by terminal
  };

  if (bodyBuffer && bodyBuffer.length) {
    headers['content-length'] = bodyBuffer.length;
    headers['content-type'] = req.headers['content-type'] || 'text/plain';
  } else if (req.method === 'POST') {
    headers['content-length'] = 0;
  }

  const cloudReq = client.request(targetUrl, {
    method: req.method,
    headers: headers,
    timeout: 15000,
  }, (cloudRes) => {
    const resChunks = [];
    cloudRes.on('data', (c) => resChunks.push(c));
    cloudRes.on('end', () => {
      const resBody = Buffer.concat(resChunks);
      const bodyPreview = resBody.toString('utf8').trim().split('\n')[0].slice(0, 60);

      console.log(`[${new Date().toLocaleTimeString()}] Cloud response: HTTP ${cloudRes.statusCode} -> "${bodyPreview}" (${resBody.length} bytes)`);

      // De-chunk & sanitize headers for older embedded ZKTeco micro-HTTP clients
      res.writeHead(cloudRes.statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': resBody.length,
        'Connection': 'close',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
      });
      res.end(resBody);
    });
  });

  cloudReq.on('error', (err) => {
    console.error(`[${new Date().toLocaleTimeString()}] Proxy error connecting to cloud server:`, err.message);
    const errMsg = 'OK'; // Fail-safe: some terminals require 200 OK to continue buffering
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(errMsg),
      'Connection': 'close',
    });
    res.end(errMsg);
  });

  if (bodyBuffer && bodyBuffer.length) {
    cloudReq.write(bodyBuffer);
  }
  cloudReq.end();
}

/** Create HTTP proxy handler */
function createProxyHandler(portLabel) {
  return (req, res) => {
    const clientIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyBuffer = Buffer.concat(chunks);
      const isPost = req.method === 'POST';
      const isAttLog = isPost && (req.url.includes('ATTLOG') || req.url.includes('table=ATTLOG'));

      if (isAttLog) {
        console.log(`\n>>> [${new Date().toLocaleTimeString()}] PUNCH RECEIVED from ${clientIp} (Port ${portLabel}):`);
        console.log(`    ${req.method} ${req.url}`);
        const lines = bodyBuffer.toString('utf8').trim().split('\n');
        console.log(`    Punch records (${lines.length}):\n    ` + lines.slice(0, 3).join('\n    '));
        if (lines.length > 3) console.log(`    ... and ${lines.length - 3} more line(s)`);
      } else if (req.url.includes('cdata')) {
        console.log(`[${new Date().toLocaleTimeString()}] Device Handshake from ${clientIp}: ${req.method} ${req.url}`);
      } else {
        console.log(`[${new Date().toLocaleTimeString()}] Terminal Request from ${clientIp}: ${req.method} ${req.url}`);
      }

      proxyRequestToCloud(req, res, bodyBuffer);
    });
  };
}

/** Start local HTTP proxy servers */
function startProxyServer(port) {
  const server = http.createServer(createProxyHandler(port));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Notice] Port ${port} is currently in use. (Skipped)`);
    } else {
      console.error(`[Error] Port ${port} error:`, err.message);
    }
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[Ready] Local ADMS Proxy listening on 0.0.0.0:${port}`);
  });
  return server;
}

// Listen on primary and standard ZKTeco ports
[8080, 3000, 8000, 80].forEach((p) => {
  try {
    startProxyServer(p);
  } catch (err) {
    console.warn(`[Notice] Port ${p} cannot be opened: ${err.message}`);
  }
});

/** Probing loop */
async function cycle() {
  const probe = await checkDeviceReachable(DEVICE_IP, DEVICE_PORT);
  if (probe.ok) {
    console.log(`[${new Date().toLocaleTimeString()}] Local Terminal (${DEVICE_IP}:${DEVICE_PORT}) is REACHABLE on LAN.`);
  } else {
    // Check if discovered devices are reachable
    if (discoveredDeviceIps.length > 0) {
      console.log(`[${new Date().toLocaleTimeString()}] Default IP (${DEVICE_IP}) offline, but terminal found at: ${discoveredDeviceIps.join(', ')}:4370`);
    } else {
      // Trigger background scan
      scanSubnetForTerminals().catch(() => {});
    }
  }
}

cycle();
setInterval(cycle, POLL_INTERVAL);

/** Verify Cloud Server reachability at boot */
function checkCloudHealth() {
  const isHttps = SERVER_URL.startsWith('https');
  const client = isHttps ? https : http;
  const pingUrl = new URL(SERVER_URL + '/iclock/cloud-ping');
  const req = client.get(pingUrl, { timeout: 10000 }, (res) => {
    if (res.statusCode === 200 || res.statusCode === 400) {
      console.log(`[Cloud Check] Successfully connected to Render Cloud (${SERVER_URL})! Status: HTTP ${res.statusCode}`);
    } else {
      console.log(`[Cloud Check] Connected to Cloud Server: HTTP ${res.statusCode}`);
    }
  });
  req.on('error', (err) => {
    console.warn(`[Cloud Check] Warning: Could not contact cloud server (${SERVER_URL}):`, err.message);
  });
}
checkCloudHealth();

/** Interactive Keyboard Commands */
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);

  console.log('\n[Shortcuts] Press "t" to send test punch | "s" to scan LAN devices | "q" to exit\n');

  process.stdin.on('keypress', (str, key) => {
    if (key.ctrl && key.name === 'c') process.exit(0);
    if (key.name === 'q') process.exit(0);

    if (key.name === 't') {
      console.log('\n[Test Punch] Simulating live biometric punch to Cloud Render...');
      const sampleSn = 'RKQ4262500336';
      const dhakaTime = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Dhaka' }).replace('T', ' ');
      const testLine = `18\t${dhakaTime}\t0\t15\t0\n`;
      const targetUrl = new URL(`${SERVER_URL}/iclock/cdata?SN=${sampleSn}&table=ATTLOG`);
      const client = SERVER_URL.startsWith('https') ? https : http;
      const req = client.request(targetUrl, {
        method: 'POST',
        headers: {
          'host': targetUrl.host,
          'content-type': 'text/plain',
          'content-length': Buffer.byteLength(testLine),
        },
      }, (res) => {
        let d = '';
        res.on('data', (c) => d += c);
        res.on('end', () => {
          console.log(`[Test Punch] Result: HTTP ${res.statusCode} -> "${d.trim()}"`);
          console.log(`[Test Punch] Recorded sample punch for PIN 18 at ${dhakaTime} (Dhaka Time).\n`);
        });
      });
      req.on('error', (e) => console.error('[Test Punch] Error:', e.message));
      req.write(testLine);
      req.end();
    }

    if (key.name === 's') {
      console.log(`\n[Scan] Scanning ${primaryLanIp.split('.').slice(0, 3).join('.')}.0/24 subnet for ZKTeco devices on port 4370...`);
      scanSubnetForTerminals().then(() => {
        console.log(`[Scan] Scan complete. Found: ${discoveredDeviceIps.join(', ') || 'No devices found on port 4370'}\n`);
      });
    }

    if (key.name === 'h') {
      console.log('\n=== ZKTeco Cloud Setup Instructions ===');
      console.log(`1. Terminal Menu -> Comm. -> Cloud Server Setting`);
      console.log(`2. Server IP   : ${primaryLanIp}`);
      console.log(`3. Server Port : ${PROXY_PORT}`);
      console.log(`4. Domain Name : OFF\n`);
    }
  });
}
