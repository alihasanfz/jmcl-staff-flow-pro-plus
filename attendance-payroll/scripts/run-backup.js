#!/usr/bin/env node
'use strict';
/**
 * JMCL STAFF FLOW PRO PLUS — Standalone Backup CLI Runner
 * Ideal for manual execution or Render Cron Jobs.
 * Usage:
 *   node scripts/run-backup.js [--type=daily|weekly|monthly|manual] [--scope=full|database_only]
 */
const { runBackup, getBackupConfig } = require('../src/services/backup');
const { waitForDb } = require('../src/bootstrap');

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name, def) => {
    const prefix = `--${name}=`;
    const found = args.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : def;
  };

  const type = getArg('type', 'manual');
  const scope = getArg('scope', 'full');

  console.log('================================================================');
  console.log('       JMCL STAFF FLOW PRO PLUS — AUTOMATED BACKUP RUNNER       ');
  console.log('================================================================');
  console.log(`Backup Type : ${type.toUpperCase()}`);
  console.log(`Scope       : ${scope.toUpperCase()}`);
  console.log('Connecting to database...');

  await waitForDb();
  const config = await getBackupConfig();
  console.log(`Encryption  : ${config.encryption_enabled ? 'AES-256-GCM Enabled' : 'Disabled'}`);
  console.log(`Cloud Sync  : ${config.enabled && config.service_account_json ? 'Google Drive Active' : 'Local Only (Google Drive not configured)'}`);
  console.log('Starting backup dump...');

  const start = Date.now();
  const result = await runBackup({ type, scope });
  const duration = ((Date.now() - start) / 1000).toFixed(2);

  console.log('----------------------------------------------------------------');
  console.log('✓ BACKUP COMPLETED SUCCESSFULLY');
  console.log(`  File Name     : ${result.fileName}`);
  console.log(`  Size          : ${(result.fileSize / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`  Tables Dumped : ${result.tables}`);
  console.log(`  Total Records : ${result.records}`);
  console.log(`  SHA-256       : ${result.checksum}`);
  console.log(`  Google Drive  : ${result.gdriveSynced ? '✓ Synced' : '— Not Synced'}`);
  console.log(`  Time Elapsed  : ${duration}s`);
  console.log('================================================================\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ BACKUP FAILED:', err.message);
  process.exit(1);
});

