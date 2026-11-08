'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool, query } = require('./db');
const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for PostgreSQL (containers start in parallel). */
async function waitForDb(attempts = 40) {
  for (let i = 1; i <= attempts; i++) {
    try { await query('SELECT 1'); return; } catch (e) {
      if (i === attempts) throw e;
      console.log(`[db] waiting for PostgreSQL (${i}/${attempts}): ${e.code || e.message}`);
      await sleep(1500);
    }
  }
}

/** Apply db/schema.sql (idempotent). An advisory lock serialises concurrent replicas. */
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(7100)');
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock(7100)').catch(() => { });
    client.release();
  }
  console.log('[db] schema is up to date');
}

/** First-run data: reference data always, demo data or a lone admin account depending on configuration. */
async function firstRun() {
  const seed = require('./seed');
  await seed.seedReference();

  // Ensure uFace 800 (09:30 AM – 07:00 PM) shift exists
  try {
    await query(`
      INSERT INTO shifts (name, start_time, end_time, break_minutes, grace_minutes, early_out_grace_minutes, overtime_after_minutes, weekly_off)
      VALUES ('ZK-uFace800 (09:30 AM – 07:00 PM)', '09:30:00', '19:00:00', 60, 10, 10, 30, '{5}')
      ON CONFLICT (name) DO UPDATE SET start_time = '09:30:00', end_time = '19:00:00', break_minutes = 60, grace_minutes = 10, early_out_grace_minutes = 10, overtime_after_minutes = 30
    `);

    // Assign default shift to uFace 800 terminal
    await query(`
      UPDATE devices
         SET default_shift_id = (SELECT id FROM shifts WHERE name LIKE '%uFace800%' LIMIT 1)
       WHERE UPPER(serial_number) = 'RKQ4262500336'
    `);

    // Assign uFace 800 employees to this shift
    await query(`
      UPDATE users
         SET shift_id = (SELECT id FROM shifts WHERE name LIKE '%uFace800%' LIMIT 1),
             primary_device_sn = 'RKQ4262500336'
       WHERE id IN (
         SELECT DISTINCT user_id FROM punch_logs WHERE UPPER(device_sn) = 'RKQ4262500336' AND user_id IS NOT NULL
       )
    `);

    // Assign SenseFace 7A employees primary_device_sn
    await query(`
      UPDATE users
         SET primary_device_sn = 'VDE2251500160'
       WHERE primary_device_sn IS NULL AND id IN (
         SELECT DISTINCT user_id FROM punch_logs WHERE UPPER(device_sn) = 'VDE2251500160' AND user_id IS NOT NULL
       )
    `);
  } catch (err) {
    console.warn('[bootstrap] uFace800 shift setup error:', err.message);
  }

  // Free all users from forced password change
  await query('UPDATE users SET must_change_password = false WHERE must_change_password = true').catch(() => {});
  // Ensure all active users have a valid shift assigned
  await query('UPDATE users SET shift_id = (SELECT id FROM shifts ORDER BY id LIMIT 1) WHERE shift_id IS NULL AND active = true').catch(() => {});

  // Match punch_logs to users by device_pin or employee_code
  await query(`UPDATE punch_logs p SET user_id = u.id FROM users u WHERE p.user_id IS NULL AND (u.device_pin = p.pin OR u.employee_code = p.pin)`).catch(() => {});

  // Auto-provision employee records for any unassigned device PINs so their punches are tracked immediately
  try {
    const { rows: unmatchedPins } = await query(`SELECT DISTINCT pin FROM punch_logs WHERE user_id IS NULL AND pin IS NOT NULL AND pin != '' AND pin != '0'`);
    if (unmatchedPins.length) {
      const defaultShift = (await query('SELECT id FROM shifts ORDER BY id LIMIT 1')).rows[0]?.id || 1;
      const dummyHash = await bcrypt.hash('Employee@123', 10);
      for (const { pin } of unmatchedPins) {
        const code = `EMP${String(pin).padStart(4, '0')}`;
        const name = `Employee #${pin}`;
        const { rows: [newEmp] } = await query(
          `INSERT INTO users (employee_code, device_pin, name, email, password_hash, role, department, designation, shift_id, active, must_change_password, join_date)
           VALUES ($1, $2, $3, $4, $5, 'employee', 'General', 'Staff', $6, true, false, '2020-01-01')
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [code, String(pin), name, `emp${pin}@company.local`, dummyHash, defaultShift]
        );
        const empId = newEmp?.id || (await query('SELECT id FROM users WHERE device_pin = $1', [String(pin)])).rows[0]?.id;
        if (empId) {
          await query('UPDATE punch_logs SET user_id = $1 WHERE pin = $2 AND user_id IS NULL', [empId, String(pin)]);
        }
      }
    }
  } catch (err) {
    console.warn('[bootstrap] auto-provision PINs error:', err.message);
  }

  // Rebuild attendance for the last 30 days so dashboard charts and stats are immediately live
  try {
    const { getSettings } = require('./services/settings');
    const { todayIn, addDays } = require('./utils/time');
    const { rebuildRange } = require('./services/attendance');
    const settings = await getSettings();
    const today = todayIn(settings.timezone);
    const from = addDays(today, -30);
    const count = await rebuildRange(from, today);
    console.log(`[bootstrap] Rebuilt attendance for recent period (${count} days processed)`);
  } catch (err) {
    console.warn('[bootstrap] initial attendance rebuild error:', err.message);
  }

  const { rows: [c] } = await query('SELECT COUNT(*)::int AS n FROM users');
  if (c.n > 0) return;

  if (config.seedDemo) {
    await seed.seedDemo();
    return;
  }
  const generated = !config.adminPassword;
  const pw = config.adminPassword || crypto.randomBytes(9).toString('base64url');
  await query(
    `INSERT INTO users (employee_code, device_pin, name, email, password_hash, role, department, designation, shift_id, must_change_password)
     VALUES ('ADMIN', '0', 'Administrator', $1, $2, 'admin', 'Management', 'System administrator', (SELECT id FROM shifts ORDER BY id LIMIT 1), false)`,
    [config.adminEmail, await bcrypt.hash(pw, 10)]);
  console.log('──────────────────────────────────────────────────────────');
  console.log(` First-run admin account created`);
  console.log(`   email:    ${config.adminEmail}`);
  console.log(`   password: ${generated ? pw + '   (generated — you must change it at first sign-in)' : '(from ADMIN_PASSWORD — you must change it at first sign-in)'}`);
  console.log('──────────────────────────────────────────────────────────');
}

module.exports = { waitForDb, migrate, firstRun };
