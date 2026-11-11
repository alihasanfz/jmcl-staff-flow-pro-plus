'use strict';
const router = require('express').Router();
const { wrap, toInt, forbidden } = require('../utils/http');
const { requireRole, canView } = require('../middleware/auth');
const dash = require('../services/dashboard');

// Personal summary for any signed-in user.
router.get('/mine', wrap(async (req, res) => res.json(await dash.mine(req.user.id))));

// Company-wide views are accessible if user has overview permission or management role
router.use((req, res, next) => {
  if (canView(req.user, 'overview') || ['super_admin', 'company_admin', 'admin', 'hr_manager', 'hr_executive', 'hr', 'dept_manager'].includes(req.user.role)) {
    return next();
  }
  return next(forbidden('Your role cannot access this'));
});

router.get(['/', '/overview'], wrap(async (req, res) => {
  const [today, trend, departments, punches, devices, hourly, terminals] = await Promise.all([
    dash.today(),
    dash.trend(Math.min(Math.max(toInt(req.query.days, 14), 7), 60)),
    dash.departments(),
    dash.recentPunches(15),
    dash.deviceStatus(),
    dash.hourlyFlow(),
    dash.terminalMetrics(),
  ]);
  res.json({ today, trend, departments, punches, devices, hourly, terminals });
}));

module.exports = router;
