'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');
const { HttpError, forbidden } = require('../utils/http');

let secret = null;
const setSecret = (s) => { secret = s; };

const COOKIE = 'ap_session';

function issueSession(res, req, user) {
  const token = jwt.sign({ sub: user.id }, secret, { expiresIn: `${config.sessionHours}h` });
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: config.sessionHours * 3600 * 1000, path: '/',
  });
  return token;
}
const clearSession = (res) => res.clearCookie(COOKIE, { path: '/' });

/** Authenticates via the httpOnly session cookie, or a Bearer token (scripts/integrations). */
async function authenticate(req, res, next) {
  try {
    const bearer = (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const token = bearer || req.cookies?.[COOKIE];
    if (!token) throw new HttpError(401, 'Please sign in');

    // CSRF defence in depth for cookie sessions: SameSite=Strict plus a required custom header on writes.
    if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'fetch') {
      throw forbidden('Missing request header');
    }
    let payload;
    try { payload = jwt.verify(token, secret); } catch { throw new HttpError(401, 'Your session has expired. Please sign in again'); }

    const { rows: [user] } = await query(
      `SELECT id, employee_code, name, email, role, department, designation, shift_id, active, must_change_password
         FROM users WHERE id = $1`, [payload.sub]);
    if (!user || !user.active) throw new HttpError(401, 'Account not found or deactivated');
    req.user = user;
    next();
  } catch (err) { next(err); }
}

/** Password change gate: disabled so users are not blocked from using the dashboard */
function passwordGate(req, res, next) {
  next();
}

const ROLE_GROUPS = {
  admin: ['super_admin', 'company_admin', 'admin'],
  hr: ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr_executive', 'hr'],
  accounts: ['super_admin', 'company_admin', 'admin', 'accounts_manager'],
  manager: ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr_executive', 'hr', 'accounts_manager', 'dept_manager'],
  staff: ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr_executive', 'hr', 'accounts_manager', 'dept_manager', 'employee', 'staff'],
};

const requireRole = (...roles) => (req, res, next) => {
  const userRole = req.user.role;
  const matches = roles.some((r) => {
    if (r === userRole) return true;
    if (ROLE_GROUPS[r] && ROLE_GROUPS[r].includes(userRole)) return true;
    return false;
  });
  return matches ? next() : next(forbidden('Your role cannot access this'));
};

const isManager = (user) => ROLE_GROUPS.manager.includes(user.role);

module.exports = { setSecret, issueSession, clearSession, authenticate, passwordGate, requireRole, isManager, COOKIE };
