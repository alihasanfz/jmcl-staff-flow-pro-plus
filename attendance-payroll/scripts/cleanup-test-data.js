'use strict';
const { query } = require('../src/db');

async function run() {
  await query("UPDATE users SET shift_id = NULL WHERE role = 'admin'");
  const a = await query("DELETE FROM attendance WHERE user_id IN (1, 2)");
  const p = await query("DELETE FROM punch_logs WHERE user_id IN (1, 2)");
  const u = await query("DELETE FROM users WHERE email = 'staff.one@company.test'");
  console.log(`Cleaned up: attendance rows ${a.rowCount}, punch logs ${p.rowCount}, test users ${u.rowCount}`);
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});

