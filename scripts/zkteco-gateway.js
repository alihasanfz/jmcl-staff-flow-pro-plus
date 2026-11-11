#!/usr/bin/env node
'use strict';
/**
 * Root wrapper: forwards to attendance-payroll/scripts/zkteco-gateway.js
 */
const path = require('path');
require(path.join(__dirname, '../attendance-payroll/scripts/zkteco-gateway.js'));

