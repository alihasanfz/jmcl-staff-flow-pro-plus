'use strict';
/**
 * JMCL STAFF FLOW PRO PLUS — Automated Backup Scheduler
 * Runs background cron check in Bangladesh Time (Asia/Dhaka):
 *   - Daily: Every day at 02:00 AM
 *   - Weekly: Every Friday at 03:00 AM
 *   - Monthly: 1st of every month at 04:00 AM
 */
const { runBackup } = require('./backup');
const { getSettings } = require('./settings');
const { todayIn } = require('../utils/time');

let timer = null;
const executedRuns = new Set();

async function checkAndRunScheduledBackups() {
  try {
    const { timezone = 'Asia/Dhaka' } = await getSettings();
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    });

    const parts = formatter.formatToParts(now);
    const getPart = (type) => parts.find((p) => p.type === type)?.value || '';

    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    const hour = parseInt(getPart('hour'), 10);
    const minute = parseInt(getPart('minute'), 10);
    const weekday = getPart('weekday'); // 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'

    const todayStr = `${year}-${month}-${day}`;

    // 1. Monthly Backup: 1st of month at 04:00 AM (between 04:00 and 04:05)
    if (day === '01' && hour === 4 && minute >= 0 && minute <= 5) {
      const key = `monthly-${year}-${month}`;
      if (!executedRuns.has(key)) {
        executedRuns.add(key);
        console.log(`[backup-scheduler] Triggering Monthly Full Backup for ${todayStr}...`);
        await runBackup({ type: 'monthly', scope: 'full' });
      }
    }

    // 2. Weekly Backup: Friday at 03:00 AM (between 03:00 and 03:05)
    if (weekday === 'Fri' && hour === 3 && minute >= 0 && minute <= 5) {
      const key = `weekly-${todayStr}`;
      if (!executedRuns.has(key)) {
        executedRuns.add(key);
        console.log(`[backup-scheduler] Triggering Weekly Full Backup for ${todayStr}...`);
        await runBackup({ type: 'weekly', scope: 'full' });
      }
    }

    // 3. Daily Backup: Every day at 02:00 AM (between 02:00 and 02:05)
    if (hour === 2 && minute >= 0 && minute <= 5) {
      const key = `daily-${todayStr}`;
      if (!executedRuns.has(key)) {
        executedRuns.add(key);
        console.log(`[backup-scheduler] Triggering Daily Backup for ${todayStr}...`);
        await runBackup({ type: 'daily', scope: 'full' });
      }
    }

    // Prune executedRuns set older than 7 days to avoid memory leak
    if (executedRuns.size > 50) {
      executedRuns.clear();
    }
  } catch (err) {
    console.error('[backup-scheduler] Cron error:', err.message);
  }
}

function startBackupScheduler() {
  if (timer) return;
  console.log('[backup-scheduler] Automated Backup Scheduler registered (Daily 02:00 AM BD Time)');
  // Check every 60 seconds
  timer = setInterval(checkAndRunScheduledBackups, 60 * 1000);
}

function stopBackupScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startBackupScheduler,
  stopBackupScheduler,
  checkAndRunScheduledBackups,
};
