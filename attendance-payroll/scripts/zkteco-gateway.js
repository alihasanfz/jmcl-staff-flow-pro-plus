#!/usr/bin/env node
'use strict';
/**
 * JMCL STAFF FLOW PRO — ZKTeco Local Gateway & Cloud ADMS Proxy
 * 
 * Bridges local network ZKTeco devices (e.g. uFace 800 at 192.168.0.201)
 * to the JMCL Staff Flow Pro server on Render over secure HTTPS.
 * 
 * Functions:
 *  1. Local ADMS HTTP Proxy: Listens on a local port (default 8080) for plain HTTP pushes
 *     from ZKTeco terminals and transparently relays them to Render over HTTPS TLS 1.3.
 *  2. Direct TCP Reachability: Periodically probes 192.168.0.201:4370 to check terminal status.
 * 
 * Usage:
 *   node scripts/zkteco-gateway.js --device-ip 192.168.0.201 --proxy-port 8080 --server-url http://localhost:3000
 */
const net = require('net');
const http = require('http');
const https = require('https');
const os = require('os');

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
const SERVER_URL = String(opt('server-url', process.env.SERVER_URL || 'http://localhost:3000')).replace(/\/$/, '');
const POLL_INTERVAL = parseInt(opt('poll-interval', 15), 10) * 1000;

// Discover local IPv4 addresses to show user
const ifaces = os.networkInterfaces();
const localIps = [];
for (const name of Object.keys(ifaces)) {
  for (const netInfo of ifaces[name]) {
    if (netInfo.family === 'IPv4' && !netInfo.internal) {
      localIps.push(netInfo.address);
    }
  }
}

console.log('====================================================');
console.log('JMCL STAFF FLOW PRO — ZKTeco Gateway & ADMS Proxy');
console.log('====================================================');
console.log(`Cloud Server Target : ${SERVER_URL}`);
console.log(`Local Terminal IP   : ${DEVICE_IP}:${DEVICE_PORT}`);
console.log(`Local ADMS Proxy    : Port ${PROXY_PORT}`);
console.log(`Your PC Network IPs : ${localIps.join(', ') || '127.0.0.1'}`);
console.log('====================================================\n');
console.log('SETUP INSTRUCTIONS FOR ZKTECO TERMINAL:');
console.log(`  1. Open Menu -> Comm. -> Cloud Server Setting on your device.`);
console.log(`  2. Set Server Address: ${localIps[0] || 'YOUR_PC_IP'}`);
console.log(`  3. Set Server Port   : ${PROXY_PORT}`);
console.log(`  4. Set Enable Domain : OFF`);
console.log(`  5. Save. All punches will proxy seamlessly to Cloud Render!\n`);

/** Check TCP connection to terminal port */
function checkDeviceReachable() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(3500);
    socket.on('connect', () => {
      socket.destroy();
      resolve({ ok: true });
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, error: 'Connection timed out' });
    });
    socket.on('error', (err) => {
      socket.destroy();
      resolve({ ok: false, error: err.message });
    });
    socket.connect(DEVICE_PORT, DEVICE_IP);
  });
}

/** Relay raw request from local terminal to Cloud Server over HTTPS */
function proxyRequestToCloud(req, res, bodyBuffer) {
  const isHttps = SERVER_URL.startsWith('https');
  const client = isHttps ? https : http;
  const targetUrl = new URL(SERVER_URL + req.url);

  const options = {
    method: req.method,
    headers: {
      ...req.headers,
      host: targetUrl.host,
      'x-forwarded-for': req.socket.remoteAddress,
      'x-forwarded-proto': 'http',
    },
  };

  const cloudReq = client.request(targetUrl, options, (cloudRes) => {
    console.log(`[${new Date().toLocaleTimeString()}] Cloud response: HTTP ${cloudRes.statusCode}`);
    res.writeHead(cloudRes.statusCode, cloudRes.headers);
    cloudRes.pipe(res);
  });

  cloudReq.on('error', (err) => {
    console.error(`[${new Date().toLocaleTimeString()}] Proxy error connecting to cloud:`, err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Gateway error connecting to cloud server');
  });

  if (bodyBuffer && bodyBuffer.length) {
    cloudReq.write(bodyBuffer);
  }
  cloudReq.end();
}

/** Start local HTTP proxy server */
const proxyServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const bodyBuffer = Buffer.concat(chunks);
    console.log(`[${new Date().toLocaleTimeString()}] Terminal Request: ${req.method} ${req.url} (Body: ${bodyBuffer.length} bytes)`);
    proxyRequestToCloud(req, res, bodyBuffer);
  });
});

proxyServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Error] Port ${PROXY_PORT} is already in use by another app.`);
  } else {
    console.error('[Error] Proxy server error:', err.message);
  }
});

proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`[Ready] Local ADMS Proxy listening on 0.0.0.0:${PROXY_PORT}`);
  console.log('Listening for incoming ZKTeco punches...\n');
});

/** Heartbeat probe */
async function cycle() {
  const probe = await checkDeviceReachable();
  if (probe.ok) {
    console.log(`[${new Date().toLocaleTimeString()}] Local Terminal (${DEVICE_IP}:${DEVICE_PORT}) is REACHABLE on LAN.`);
  } else {
    console.log(`[${new Date().toLocaleTimeString()}] Local Terminal probe (${DEVICE_IP}:${DEVICE_PORT}): ${probe.error}`);
  }
}

cycle();
setInterval(cycle, POLL_INTERVAL);
