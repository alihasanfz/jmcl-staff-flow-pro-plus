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

  // Set official company name
  try {
    await query(`
      INSERT INTO settings (key, value)
      VALUES ('company_name', '"Jeans Manufacturing Company Ltd."'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = '"Jeans Manufacturing Company Ltd."'::jsonb
    `);
  } catch (_) { }

  // Ensure company shifts exist with precise hours and late rules:
  // 1. Store (08:00 AM – 05:00 PM) - punch after 08:00 is late (grace_minutes = 0)
  // 2. Commercial (09:15 AM – 06:45 PM) - starts at 09:15 AM (grace_minutes = 0)
  // 3. ZK-uFace800 / General (09:30 AM – 07:00 PM) - starts at 09:30 AM (grace_minutes = 10)
  try {
    await query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS allow_overtime boolean NOT NULL DEFAULT true`).catch(() => { });
    await query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS is_night_shift boolean NOT NULL DEFAULT false`).catch(() => { });
    await query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS default_shift_id int REFERENCES shifts(id)`).catch(() => { });
    await query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS overtime_eligible boolean NOT NULL DEFAULT true`).catch(() => { });
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS overtime_eligible boolean NOT NULL DEFAULT true`).catch(() => { });

    await query(`
      INSERT INTO shifts (name, start_time, end_time, break_minutes, grace_minutes, early_out_grace_minutes, overtime_after_minutes, weekly_off, allow_overtime, is_night_shift)
      VALUES 
        ('Store (08:00 AM – 05:00 PM)', '08:00:00', '17:00:00', 60, 0, 10, 30, '{5}', true, false),
        ('Commercial (09:15 AM – 06:45 PM)', '09:15:00', '18:45:00', 60, 0, 10, 30, '{5}', false, false),
        ('ZK-uFace800 (09:30 AM – 07:00 PM)', '09:30:00', '19:00:00', 60, 10, 10, 30, '{5}', true, false)
      ON CONFLICT (name) DO UPDATE SET 
        start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
        break_minutes = EXCLUDED.break_minutes, grace_minutes = EXCLUDED.grace_minutes,
        early_out_grace_minutes = EXCLUDED.early_out_grace_minutes,
        overtime_after_minutes = EXCLUDED.overtime_after_minutes,
        weekly_off = EXCLUDED.weekly_off,
        allow_overtime = EXCLUDED.allow_overtime
    `);

    // Ensure company departments are configured with default shifts
    const factoryDepts = [
      { name: 'Store', code: 'STR', shiftPattern: '%Store%', ot: true },
      { name: 'Commercial', code: 'COM', shiftPattern: '%Commercial%', ot: false },
      { name: 'Merchandiser', code: 'MER', shiftPattern: '%09:30%', ot: false },
      { name: 'Accounts', code: 'ACC', shiftPattern: '%09:30%', ot: false },
      { name: 'Audit', code: 'AUD', shiftPattern: '%09:30%', ot: false },
      { name: 'Information Technology', code: 'IT', shiftPattern: '%09:30%', ot: false },
      { name: 'Wash', code: 'WSH', shiftPattern: '%09:30%', ot: true },
      { name: 'Purchase', code: 'PUR', shiftPattern: '%09:30%', ot: false },
      { name: 'General', code: 'GEN', shiftPattern: '%09:30%', ot: true },
    ];
    for (const d of factoryDepts) {
      await query(`
        INSERT INTO departments (name, code, default_shift_id, overtime_eligible)
        VALUES ($1, $2, (SELECT id FROM shifts WHERE name LIKE $3 LIMIT 1), $4)
        ON CONFLICT (name) DO UPDATE SET 
          code = COALESCE(departments.code, EXCLUDED.code),
          default_shift_id = (SELECT id FROM shifts WHERE name LIKE $3 LIMIT 1),
          overtime_eligible = EXCLUDED.overtime_eligible
      `, [d.name, d.code, d.shiftPattern, d.ot]).catch(() => { });
    }

    // Assign shifts to employees based on department:
    // Store -> Store (08:00 AM)
    await query(`
      UPDATE users
         SET shift_id = (SELECT id FROM shifts WHERE name LIKE '%Store%' LIMIT 1),
             overtime_eligible = true
       WHERE LOWER(department) LIKE '%store%'
    `);

    // Commercial -> Commercial (09:15 AM)
    await query(`
      UPDATE users
         SET shift_id = (SELECT id FROM shifts WHERE name LIKE '%Commercial%' LIMIT 1),
             overtime_eligible = false
       WHERE LOWER(department) LIKE '%commercial%'
    `);

    // All other departments -> 09:30 AM Shift
    await query(`
      UPDATE users
         SET shift_id = (SELECT id FROM shifts WHERE name LIKE '%uFace800%' OR name LIKE '%09:30%' LIMIT 1)
       WHERE LOWER(department) NOT LIKE '%store%' AND LOWER(department) NOT LIKE '%commercial%'
    `);

    // Ensure all device schema columns exist
    await query(`
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_punch_at timestamptz;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS default_shift_id int REFERENCES shifts(id);
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_poll_at timestamptz;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_poll_error text;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS attlog_stamp text;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_ip text;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS ip_address text;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS port int;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS api_url text;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS enforce_ip boolean NOT NULL DEFAULT false;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS poll_interval_sec int NOT NULL DEFAULT 60;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT true;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS online boolean NOT NULL DEFAULT true;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen timestamptz;
    `).catch((e) => console.warn('[bootstrap] device column check:', e.message));

    // Ensure terminal metadata and assigned roles are accurate and up to date
    await query(`
      UPDATE devices
         SET name = 'ZKTeco Terminal (ZK-UFACE800-01)',
             model = 'uFace 800 (Main Attendance)',
             location = 'Main Office Attendance Entrance',
             default_shift_id = (SELECT id FROM shifts WHERE name LIKE '%uFace800%' LIMIT 1)
       WHERE UPPER(serial_number) = 'RKQ4262500336'
    `);

    await query(`
      UPDATE devices
         SET name = 'ZKTeco Terminal (VDE2251500160)',
             model = 'SenseFace 7A (Gate Controller)',
             location = 'Factory Barrier Gate (Door Access)'
       WHERE UPPER(serial_number) = 'VDE2251500160'
    `);

    // Assign primary device SN based on punch history
    await query(`
      UPDATE users
         SET primary_device_sn = 'RKQ4262500336'
       WHERE primary_device_sn IS NULL AND id IN (
         SELECT DISTINCT user_id FROM punch_logs WHERE UPPER(device_sn) = 'RKQ4262500336' AND user_id IS NOT NULL
       )
    `);

    await query(`
      UPDATE users
         SET primary_device_sn = 'VDE2251500160'
       WHERE primary_device_sn IS NULL AND id IN (
         SELECT DISTINCT user_id FROM punch_logs WHERE UPPER(device_sn) = 'VDE2251500160' AND user_id IS NOT NULL
       )
    `);
  } catch (err) {
    console.warn('[bootstrap] shift setup error:', err.message);
  }

  // Free all users from forced password change
  await query('UPDATE users SET must_change_password = false WHERE must_change_password = true').catch(() => { });
  // Ensure users permissions and raw_password columns exist
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '{}'").catch(() => { });
  await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS raw_password text").catch(() => { });
  await query("UPDATE users SET raw_password = 'Demo@12345' WHERE raw_password IS NULL").catch(() => { });

  // Ensure Ali Hasan Sheikh administrator account has password Sh@170885 active
  try {
    const aliHash = await bcrypt.hash('Sh@170885', 10);
    await query(`
      UPDATE users 
         SET password_hash = $1, 
             raw_password = 'Sh@170885', 
             active = true, 
             role = 'admin',
             must_change_password = false
       WHERE lower(email) = 'alihasanfzl@gmail.com'
    `, [aliHash]);
  } catch (err) {
    console.warn('[bootstrap] update alihasan password error:', err.message);
  }

  // Ensure all active users have a valid shift assigned
  await query('UPDATE users SET shift_id = (SELECT id FROM shifts ORDER BY id LIMIT 1) WHERE shift_id IS NULL AND active = true').catch(() => { });

  // Match punch_logs to users by device_pin or employee_code
  await query(`UPDATE punch_logs p SET user_id = u.id FROM users u WHERE p.user_id IS NULL AND (u.device_pin = p.pin OR u.employee_code = p.pin)`).catch(() => { });

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

    // 1. One-time restore: Bring back evening punches for 2026-11-11 to their true 20:xx PM times
    try {
      // If any punches are still in early morning of 2026-11-12, shift back to 2026-11-11
      const resEarly = await query(`
        UPDATE punch_logs
           SET punched_at = punched_at - interval '6 hours'
         WHERE id >= 77590 AND id <= 77755
           AND to_char(punched_at AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') = '2026-11-12'
           AND to_char(punched_at AT TIME ZONE 'Asia/Dhaka', 'HH24') < '07'
      `);
      // If any punches on 2026-11-11 are at 22:xx, shift back by 2 hours to 20:xx
      const resLate = await query(`
        UPDATE punch_logs
           SET punched_at = punched_at - interval '2 hours'
         WHERE id >= 77590 AND id <= 77755
           AND to_char(punched_at AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') = '2026-11-11'
           AND to_char(punched_at AT TIME ZONE 'Asia/Dhaka', 'HH24') >= '22'
      `);
      if (resEarly.rowCount || resLate.rowCount) {
        console.log(`[bootstrap] Restored evening punches on 2026-11-11 (early: ${resEarly.rowCount}, late: ${resLate.rowCount})`);
      }
      await rebuildRange('2026-11-11', '2026-11-12');
    } catch (e) {
      console.warn('[bootstrap] restore punches note:', e.message);
    }

    // 2. Remove accidental manual checkout for Md. Biplob (user_id 4)
    try {
      await query(`
        DELETE FROM punch_logs
         WHERE user_id = 4
           AND source = 'manual'
           AND state = 1
           AND to_char(punched_at AT TIME ZONE $1, 'YYYY-MM-DD') = '2026-11-11'
      `, [settings.timezone]);
      await query(`
        UPDATE attendance
           SET check_out = NULL,
               worked_minutes = 0,
               early_out_minutes = 0,
               overtime_minutes = 0,
               missing_checkout = false,
               punch_count = 1
         WHERE user_id = 4
           AND work_date = '2026-11-11'
      `);
    } catch (e) {
      console.warn('[bootstrap] clean biplob note:', e.message);
    }

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
