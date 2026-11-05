'use strict';

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

// Load .env if present
try {
  require('fs').readFileSync(require('path').join(__dirname, '../.env'), 'utf8')
    .split('\n')
    .forEach((line) => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match && !match[1].startsWith('#')) {
        const key = match[1];
        let val = (match[2] || '').trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
      }
    });
} catch (_) {}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || process.env.APP_PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL || '',
  usePglite: bool(process.env.USE_PGLITE, !process.env.DATABASE_URL),
  // Default company timezone; can be changed later in Settings. Device timestamps are interpreted in this zone.
  defaultTimezone: process.env.TZ_DEFAULT || process.env.TZ || 'Asia/Dhaka',
  // Optional. When unset, random secrets are generated on first boot and kept in the database.
  jwtSecret: process.env.JWT_SECRET || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  // Demo data (employees, 60 days of punches, leave, payroll history).
  seedDemo: bool(process.env.SEED_DEMO, true),
  // First-run admin account when SEED_DEMO is false.
  adminEmail: process.env.ADMIN_EMAIL || 'admin@company.test',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  // Background jobs (exception scan, device heartbeat, http-pull poller).
  schedulerEnabled: bool(process.env.SCHEDULER_ENABLED, true),
  sessionHours: parseInt(process.env.SESSION_HOURS || '12', 10),
  trustProxy: parseInt(process.env.TRUST_PROXY || '0', 10),
};
