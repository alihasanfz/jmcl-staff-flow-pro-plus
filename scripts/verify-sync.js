'use strict';
const https = require('https');
const os = require('os');

const ifaces = os.networkInterfaces();
const ips = [];
for (const n of Object.keys(ifaces)) {
  for (const info of ifaces[n]) {
    if (info.family === 'IPv4' && !info.internal) ips.push(info.address);
  }
}
const localIp = ips[0] || '127.0.0.1';

console.log('1. Host Network Configuration:');
console.log('   Your PC Local IP : ' + localIp);
console.log('   All IPv4 Adapters: ' + (ips.join(', ') || 'None'));
console.log('');

console.log('2. Cloud Server Connection (Render):');
const req = https.get('https://jmcl-staff-flow-pro-plus-2846.onrender.com/iclock/debug-today-punches', { timeout: 8000 }, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const j = JSON.parse(d);
      console.log('   Cloud Status     : ONLINE (HTTP ' + res.statusCode + ')');
      console.log('   Today\'s Punches  : ' + j.count + ' punches recorded');
      if (j.punches && j.punches.length > 0) {
        const last = j.punches[j.punches.length - 1];
        console.log('   Latest Punch     : ' + last.name + ' (' + last.punch_time + ') on ' + last.device_sn);
      }
    } catch (_) {
      console.log('   Cloud Status     : Responded (HTTP ' + res.statusCode + ')');
    }
    console.log('');
    printInstructions(localIp);
  });
});

req.on('error', (e) => {
  console.log('   Cloud Status     : OFFLINE / Unreachable (' + e.message + ')');
  console.log('');
  printInstructions(localIp);
});

function printInstructions(ip) {
  console.log('====================================================================');
  console.log('  ZKTECO DEVICE SETUP INSTRUCTIONS:');
  console.log('====================================================================');
  console.log('  1. On your device keypad, press [M/OK]');
  console.log('  2. Go to: Comm. -> Cloud Server Setting (or ADMS / WebServer)');
  console.log('  3. Server Address   : ' + ip);
  console.log('  4. Server Port      : 8080');
  console.log('  5. Enable Domain    : OFF');
  console.log('  6. Press ESC to save.');
  console.log('');
  console.log('  To start sync, double-click: start-sync-gateway.bat');
  console.log('====================================================================');
}

