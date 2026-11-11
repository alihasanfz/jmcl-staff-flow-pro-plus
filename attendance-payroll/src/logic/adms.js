'use strict';
/**
 * ZKTeco ADMS ("push SDK") and USB DAT/CSV helpers.
 * Supports:
 *   - Live ADMS POST (tab-separated lines to /iclock/cdata)
 *   - Offline USB download files (1_attlog.dat, attlog.dat, .csv, .txt)
 *
 * Line formats:
 *   PIN <TAB> YYYY-MM-DD HH:MM:SS <TAB> status <TAB> verify <TAB> workcode …
 *   PIN,YYYY-MM-DD HH:MM:SS,status,verify
 *
 * status: 0 check-in, 1 check-out, 2 break-out, 3 break-in, 4 OT-in, 5 OT-out (firmware dependent)
 * verify: 0 password, 1 fingerprint, 3 card, 15 face (uFace800 reports face as 15)
 */
const { isDate } = require('../utils/time');

const LINE_RE = /^(\S+)[\t ]+(\d{4}[-/]\d{2}[-/]\d{2})[ T](\d{2}:\d{2}:\d{2})(.*)$/;
const CSV_RE = /^(\S+),(\d{4}[-/]\d{2}[-/]\d{2})[ T,](\d{2}:\d{2}:\d{2})(.*)$/;

function parseAttLog(body) {
  const records = [];
  let rejected = 0;
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Skip table header lines if exported from Excel or USB tools
    if (/^(pin|user|employee|id|sn|serial|timestamp|time|date)/i.test(line)) continue;

    let m = LINE_RE.exec(line);
    let separator = /\s+/;
    if (!m) {
      m = CSV_RE.exec(line);
      separator = /,/;
    }
    // Also try DD-MM-YYYY or DD/MM/YYYY date formats used by some firmware
    if (!m) {
      const altLineRe = /^(\S+)[\t ]+(\d{2}[-/]\d{2}[-/]\d{4})[ T](\d{2}:\d{2}:\d{2})(.*)$/;
      const altCsvRe = /^(\S+),(\d{2}[-/]\d{2}[-/]\d{4})[ T,](\d{2}:\d{2}:\d{2})(.*)$/;
      m = altLineRe.exec(line);
      if (!m) {
        m = altCsvRe.exec(line);
        separator = /,/;
      }
    }
    if (!m) { rejected++; continue; }

    let [, pin, dateRaw, time, rest] = m;
    let date = dateRaw.replace(/\//g, '-');
    const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(date);
    if (dmy) {
      date = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
    }
    const [h, mi, s] = time.split(':').map(Number);
    if (!isDate(date) || h > 23 || mi > 59 || s > 59 || pin.length > 32) { rejected++; continue; }

    const extra = rest.trim().split(separator).filter(Boolean);
    const num = (v) => (v !== undefined && /^-?\d+$/.test(v) ? parseInt(v, 10) : null);
    records.push({
      pin,
      local: `${date} ${time}`,
      state: num(extra[0]),
      verify: num(extra[1]),
      workcode: extra[2] !== undefined ? String(extra[2]) : null,
    });
  }
  return { records, rejected };
}

/** Plain-text handshake body returned for GET /iclock/cdata (device options). */
function handshakeResponse(serial, attlogStamp) {
  const stamp = (!attlogStamp || attlogStamp === '9999' || attlogStamp === '0') ? 'None' : attlogStamp;
  return [
    `GET OPTION FROM: ${serial}`,
    `ATTLOGSTAMP=${stamp}`,
    'OPERLOGSTAMP=9999',
    'ATTPHOTOSTAMP=None',
    'ErrorDelay=5',
    'Delay=5',
    'TransInterval=1',
    'TransFlag=TransData AttLog\tOpLog\tEnrollUser\tChgUser\tEnrollFP\tChgFP\tFACE\tUserPic',
    'Realtime=1',
    'PushOptionsFlag=1',
    'AutoPush=1',
    'LogPush=1',
    'Encrypt=None',
    'ServerVer=3.4.1',
    'PushVersion=3.2.1',
    'TimeZone=6',
    'SyncTime=0',
    '',
  ].join('\n');
}

const stripIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

module.exports = { parseAttLog, handshakeResponse, stripIp };
