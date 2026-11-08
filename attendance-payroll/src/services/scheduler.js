'use strict';
const config = require('../config');
const { tx } = require('../db');
const { scan } = require('./exceptions');
const { pollDue } = require('./devicePoller');

const LOCK_SCAN = 7101;
const LOCK_POLL = 7102;
let timers = [];

/** Run fn only if no other instance holds the advisory lock (safe when several app replicas run). */
async function exclusive(lockId, fn) {
  if (config.usePglite) {
    return fn();
  }
  await tx(async (db) => {
    const { rows } = await db.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [lockId]);
    if (rows[0].ok) await fn();
  });
}

function every(ms, name, lockId, fn) {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try { await exclusive(lockId, fn); } catch (e) { console.error(`[scheduler] ${name} failed:`, e.message); } finally { running = false; }
  }, ms);
  t.unref();
  timers.push(t);
}

function start() {
  every(60_000, 'exception scan', LOCK_SCAN, scan);
  every(15_000, 'device poll', LOCK_POLL, pollDue);
  setTimeout(() => exclusive(LOCK_SCAN, scan).catch((e) => console.error('[scheduler] initial scan failed:', e.message)), 5_000).unref();

  // Cloud sync relay and continuous device heartbeat to keep terminals online in cloud
  const LOCK_SYNC = 7103;
  const { backfillRecentPunchesToCloud, sendCloudHeartbeat } = require('../routes/adms');
  every(60_000, 'cloud sync relay', LOCK_SYNC, backfillRecentPunchesToCloud);
  every(45_000, 'cloud heartbeat', LOCK_SYNC + 1, sendCloudHeartbeat);
  setTimeout(() => {
    exclusive(LOCK_SYNC, backfillRecentPunchesToCloud).catch(() => {});
    sendCloudHeartbeat().catch(() => {});
  }, 5_000).unref();

  console.log('[scheduler] started (exception scan every 60s, device poll check every 15s, cloud sync relay every 60s, cloud heartbeat every 45s)');
}
function stop() { timers.forEach(clearInterval); timers = []; }

module.exports = { start, stop };
