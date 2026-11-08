'use strict';

const config = require('./config');

let pool;
let query;
let tx;

if (config.usePglite) {
  const { PGlite } = require('@electric-sql/pglite');
  const path = require('path');
  const fs = require('fs');

  const dataDir = path.join(__dirname, '../data/pglite');

  const initDb = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    const pidFile = path.join(dataDir, 'postmaster.pid');
    if (fs.existsSync(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch (_) { }
    }
    return new PGlite(dataDir, {
      parsers: {
        1700: (v) => (v === null ? null : parseFloat(v)),
        1082: (v) => v,
        20: (v) => (v === null ? null : parseInt(v, 10))
      }
    });
  };

  let db = initDb();

  let currentTx = null;

  const runQuery = async (target, text, params) => {
    const executor = (target === db && currentTx) ? currentTx : target;
    try {
      if (params && params.length > 0) return await executor.query(text, params);
      const statements = text.split(';').map((s) => s.trim()).filter(Boolean);
      if (statements.length > 1) {
        const results = await (executor.exec ? executor.exec(text) : db.exec(text));
        return results[results.length - 1] || { rows: [], rowCount: 0 };
      }
      return await executor.query(text);
    } catch (err) {
      if (String(err.message).includes('Aborted')) {
        console.warn('[db] PGlite aborted due to dirty state, resetting data/pglite directory...');
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) { }
        db = initDb();
      }
      throw err;
    }
  };

  query = async (text, params) => runQuery(db, text, params);

  tx = async (fn) => {
    if (currentTx) {
      return fn(currentTx);
    }
    return db.transaction(async (txDb) => {
      const client = {
        query: (text, params) => runQuery(txDb, text, params),
      };
      currentTx = client;
      try {
        return await fn(client);
      } finally {
        currentTx = null;
      }
    });
  };

  pool = {
    query,
    connect: async () => ({
      query: (text, params) => query(text, params),
      release: () => { },
    }),
    on: () => { },
    end: async () => {
      await db.close();
    }
  };

  const cleanup = async () => {
    try { await db.close(); } catch (_) { }
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
} else {
  const { Pool, types } = require('pg');

  // numeric -> JS number, date -> 'YYYY-MM-DD' string (no timezone shifting), int8 -> number
  types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
  types.setTypeParser(1082, (v) => v);
  types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

  pool = new Pool({ connectionString: config.databaseUrl || 'postgres://payroll:payroll@localhost:5432/payroll', max: 10 });
  pool.on('error', (err) => console.error('[db] idle client error', err.message));

  query = (text, params) => pool.query(text, params);

  /** Run fn(client) inside a transaction. */
  tx = async function (fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  };
}

module.exports = { pool, query, tx };
