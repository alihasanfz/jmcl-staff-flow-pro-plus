'use strict';
const config = require('../src/config');
const { waitForDb, migrate, firstRun } = require('../src/bootstrap');
const { getSecret, randomSecret, getSettings } = require('../src/services/settings');
const { setSecret } = require('../src/middleware/auth');
const { initPush } = require('../src/services/notifications');
const { createApp } = require('../src/app');

let initPromise = null;
async function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      await waitForDb();
      await migrate();
      await getSettings();
      setSecret(config.jwtSecret || await getSecret('jwt', randomSecret));
      await initPush();
      await firstRun();
    })().catch((err) => {
      console.error('[vercel-init-error]', err);
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

const app = createApp();

module.exports = async (req, res) => {
  await ensureInit();
  return app(req, res);
};
