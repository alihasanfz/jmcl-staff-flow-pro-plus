'use strict';
const config = require('../src/config');
const { setSecret } = require('../src/middleware/auth');
const { createApp } = require('../src/app');

// Instant initialization without blocking database locks
setSecret(config.jwtSecret || 'jmcl-staff-flow-pro-jwt-secret-2026');

const app = createApp();

module.exports = app;
