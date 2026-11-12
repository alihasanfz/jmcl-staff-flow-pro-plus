'use strict';
/**
 * JMCL STAFF FLOW PRO PLUS — Automated Backup & Restore Coordinator Service
 */
const zlib = require('zlib');
const { query } = require('../db');
const { dumpDatabase, restoreDatabase } = require('./backupDump');
const { encryptBuffer, decryptBuffer, sha256 } = require('./backupCrypto');
const googleDrive = require('./googleDrive');
const { notifyManagers } = require('./notifications');

const DEFAULT_KEY = process.env.BACKUP_ENCRYPTION_KEY || 'JMCL-StaffFlowPro-2026-BackupKey';

/**
 * Retrieve current backup & Google Drive configuration.
 */
async function getBackupConfig() {
  try {
    const { rows: [row] } = await query("SELECT value FROM settings WHERE key = 'gdrive_backup_config'");
    const saved = row?.value || {};
    return {
      enabled: saved.enabled !== undefined ? saved.enabled : !!process.env.GDRIVE_SERVICE_ACCOUNT_JSON,
      service_account_json: saved.service_account_json || process.env.GDRIVE_SERVICE_ACCOUNT_JSON || '',
      root_folder_name: saved.root_folder_name || 'JMCL_Backup',
      root_folder_id: saved.root_folder_id || '',
      encryption_enabled: saved.encryption_enabled !== undefined ? saved.encryption_enabled : true,
      encryption_key: saved.encryption_key || process.env.BACKUP_ENCRYPTION_KEY || DEFAULT_KEY,
      daily_retention_days: parseInt(saved.daily_retention_days || 30, 10),
      weekly_retention_weeks: parseInt(saved.weekly_retention_weeks || 12, 10),
      monthly_retention_months: parseInt(saved.monthly_retention_months || 12, 10),
      last_backup_at: saved.last_backup_at || null,
      last_status: saved.last_status || 'idle',
      last_error: saved.last_error || null,
    };
  } catch (err) {
    return {
      enabled: false,
      service_account_json: '',
      root_folder_name: 'JMCL_Backup',
      encryption_enabled: true,
      encryption_key: DEFAULT_KEY,
      daily_retention_days: 30,
      weekly_retention_weeks: 12,
      monthly_retention_months: 12,
    };
  }
}

/**
 * Update backup configuration.
 */
async function saveBackupConfig(cfg) {
  const current = await getBackupConfig();
  const merged = { ...current, ...cfg };
  await query(`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('gdrive_backup_config', $1::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `, [JSON.stringify(merged)]);
  return merged;
}

/**
 * Log an entry to backup_logs.
 */
async function logActivity(backupId, action, status, message, details = {}) {
  try {
    await query(`
      INSERT INTO backup_logs (backup_id, action, status, message, details, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, now())
    `, [backupId, action, status, message, JSON.stringify(details)]);
  } catch (e) {
    console.warn('[backup-log] Error saving log:', e.message);
  }
}

/**
 * Run a backup:
 * 1. Dumps PostgreSQL database
 * 2. Compresses with Gzip
 * 3. Encrypts with AES-256-GCM (if enabled)
 * 4. Uploads to Google Drive (if enabled)
 * 5. Applies Retention Pruning
 * 6. Records in DB and notifies admins
 */
async function runBackup({ type = 'manual', scope = 'full' } = {}) {
  const config = await getBackupConfig();
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = config.encryption_enabled ? 'jmcl.enc' : 'json.gz';
  const fileName = `JMCL_Backup_${type.toUpperCase()}_${dateStr}.${ext}`;

  await logActivity(null, 'backup_start', 'info', `Started ${type} backup (${scope})`, { type, scope });

  let backupRecord = null;
  try {
    // Step 1: Dump database
    const dump = await dumpDatabase();

    // Step 2: Package into JSON and compress with Gzip
    const rawPayload = JSON.stringify({
      manifest: dump.manifest,
      sqlDump: dump.sqlDump,
      dataExport: dump.dataExport,
    });

    const compressed = zlib.gzipSync(Buffer.from(rawPayload, 'utf8'), { level: 9 });
    const originalChecksum = sha256(compressed);

    // Step 3: Encrypt if enabled
    let finalBuffer = compressed;
    if (config.encryption_enabled) {
      finalBuffer = encryptBuffer(compressed, config.encryption_key);
    }
    const finalChecksum = sha256(finalBuffer);
    const fileSize = finalBuffer.length;

    // Step 4: Record backup in DB
    const { rows: [b] } = await query(`
      INSERT INTO backups (
        file_name, backup_type, scope, file_size, checksum_sha256,
        encrypted, storage_location, status, tables_count, records_count, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, now())
      RETURNING *
    `, [
      fileName,
      type,
      scope,
      fileSize,
      finalChecksum,
      config.encryption_enabled,
      config.enabled ? 'cloud' : 'local',
      'in_progress',
      dump.tablesCount,
      dump.totalRecords,
      JSON.stringify({
        originalChecksum,
        uncompressedSize: rawPayload.length,
        compressedSize: compressed.length,
      }),
    ]);
    backupRecord = b;

    // Step 5: Upload to Google Drive if configured
    let gdriveFile = null;
    if (config.enabled && config.service_account_json) {
      try {
        let sa = null;
        try {
          sa = typeof config.service_account_json === 'string'
            ? JSON.parse(config.service_account_json)
            : config.service_account_json;
        } catch (jsonErr) {
          throw new Error('Service Account JSON is not valid JSON format');
        }

        const token = await googleDrive.getAccessToken(sa);
        let rootTarget = config.root_folder_id || config.root_folder_name || 'JMCL_Backup';
        const urlMatch = String(rootTarget).match(/folders\/([A-Za-z0-9_-]+)/);
        if (urlMatch) rootTarget = urlMatch[1];
        const folders = await googleDrive.ensureFolderHierarchy(token, rootTarget);

        // Determine destination folder based on backup type
        let targetFolderId = folders.root;
        if (type === 'daily') targetFolderId = folders.Daily_Backup;
        else if (type === 'weekly') targetFolderId = folders.Weekly_Backup;
        else if (type === 'monthly') targetFolderId = folders.Monthly_Backup;
        else if (type === 'manual') targetFolderId = folders.Database_Backup;

        gdriveFile = await googleDrive.uploadFile(token, {
          name: fileName,
          buffer: finalBuffer,
          mimeType: config.encryption_enabled ? 'application/octet-stream' : 'application/gzip',
          parentFolderId: targetFolderId,
          description: `JMCL Staff Flow Pro ${type.toUpperCase()} Backup (${dump.totalRecords} records across ${dump.tablesCount} tables)`,
        });

        // Apply retention pruning
        if (type === 'daily' && config.daily_retention_days > 0) {
          await googleDrive.applyRetention(token, folders.Daily_Backup, config.daily_retention_days);
        } else if (type === 'weekly' && config.weekly_retention_weeks > 0) {
          await googleDrive.applyRetention(token, folders.Weekly_Backup, config.weekly_retention_weeks * 7);
        } else if (type === 'monthly' && config.monthly_retention_months > 0) {
          await googleDrive.applyRetention(token, folders.Monthly_Backup, config.monthly_retention_months * 30);
        }

        await logActivity(backupRecord.id, 'upload_success', 'success', `Uploaded to Google Drive (${fileName})`, {
          gdriveId: gdriveFile.id,
          folderId: targetFolderId,
        });
      } catch (uploadErr) {
        console.error('[backup] Google Drive upload error:', uploadErr.message);
        await logActivity(backupRecord.id, 'upload_fail', 'warning', `Google Drive upload failed: ${uploadErr.message}`);
      }
    }

    // Step 6: Finalize backup record
    await query(`
      UPDATE backups
         SET status = 'completed',
             gdrive_file_id = $2,
             storage_location = $3
       WHERE id = $1
    `, [
      backupRecord.id,
      gdriveFile?.id || null,
      gdriveFile ? 'cloud' : 'local',
    ]);

    await saveBackupConfig({
      last_backup_at: new Date().toISOString(),
      last_status: 'success',
      last_error: null,
    });

    await logActivity(backupRecord.id, 'backup_success', 'success', `Backup completed successfully: ${fileName} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`, {
      fileSize,
      records: dump.totalRecords,
      tables: dump.tablesCount,
      gdriveSynced: !!gdriveFile,
    });

    return {
      ok: true,
      backupId: backupRecord.id,
      fileName,
      fileSize,
      records: dump.totalRecords,
      tables: dump.tablesCount,
      gdriveSynced: !!gdriveFile,
      encrypted: config.encryption_enabled,
      checksum: finalChecksum,
    };
  } catch (err) {
    if (backupRecord) {
      await query(`UPDATE backups SET status = 'failed', error_message = $2 WHERE id = $1`, [backupRecord.id, err.message]);
      await logActivity(backupRecord.id, 'backup_fail', 'error', `Backup failed: ${err.message}`, { error: err.stack });
    } else {
      await logActivity(null, 'backup_fail', 'error', `Backup failed before database record: ${err.message}`);
    }

    await saveBackupConfig({
      last_status: 'failed',
      last_error: err.message,
    });

    await notifyManagers({
      type: 'backup-failed',
      severity: 'critical',
      title: '🚨 Automated Backup Failed',
      body: `Backup attempt failed: ${err.message}`,
      url: '/backup',
      dedupe: `backup-fail-${dateStr.slice(0, 10)}`,
    }).catch(() => {});

    throw err;
  }
}

/**
 * Generates an unencrypted raw SQL dump for quick direct download.
 */
async function generateRawSqlDump() {
  const dump = await dumpDatabase();
  return {
    sqlDump: dump.sqlDump,
    fileName: `JMCL_Database_Dump_${new Date().toISOString().slice(0, 10)}.sql`,
    tablesCount: dump.tablesCount,
    recordsCount: dump.totalRecords,
  };
}

/**
 * Restores the system from an uploaded or downloaded backup buffer.
 */
async function restoreBackupBuffer(buffer, encryptionKey = null) {
  const config = await getBackupConfig();
  const keyToUse = encryptionKey || config.encryption_key || DEFAULT_KEY;

  let decrypted = buffer;
  // If buffer starts with 'JMCL' magic header, decrypt it
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('utf8') === 'JMCL') {
    decrypted = decryptBuffer(buffer, keyToUse);
  }

  // Decompress
  let uncompressed = decrypted;
  try {
    uncompressed = zlib.gunzipSync(decrypted);
  } catch (_) {
    // If not gzipped, proceed with decrypted buffer
  }

  const payloadStr = uncompressed.toString('utf8');
  let parsed = null;
  try {
    parsed = JSON.parse(payloadStr);
  } catch (e) {
    // Could be raw SQL
    if (payloadStr.includes('INSERT INTO') || payloadStr.includes('BEGIN;')) {
      parsed = payloadStr;
    } else {
      throw new Error('Invalid backup archive contents');
    }
  }

  await logActivity(null, 'restore_start', 'warning', 'Initiating database restoration...');
  const restoreRes = await restoreDatabase(parsed);
  await logActivity(null, 'restore_success', 'success', 'Database restored successfully!', restoreRes);

  return restoreRes;
}

/**
 * Retrieve statistics and KPI metrics for Admin Dashboard.
 */
async function getBackupStats() {
  const config = await getBackupConfig();

  const [countRes, sizeRes, lastSuccessRes] = await Promise.all([
    query(`
      SELECT 
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS successful,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM backups
    `),
    query(`SELECT COALESCE(SUM(file_size), 0)::bigint AS total_bytes FROM backups WHERE status = 'completed'`),
    query(`SELECT * FROM backups WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1`),
  ]);

  let gdriveStatus = 'not_configured';
  if (config.enabled && config.service_account_json) {
    gdriveStatus = 'connected';
  }

  return {
    stats: {
      total: countRes.rows[0].total,
      successful: countRes.rows[0].successful,
      failed: countRes.rows[0].failed,
      totalBytes: Number(sizeRes.rows[0].total_bytes),
      totalMB: (Number(sizeRes.rows[0].total_bytes) / (1024 * 1024)).toFixed(2),
      lastBackup: lastSuccessRes.rows[0] || null,
      gdriveStatus,
      encryptionEnabled: config.encryption_enabled,
      nextDailySchedule: '02:00 AM (Bangladesh Time)',
      nextWeeklySchedule: 'Friday 03:00 AM',
    },
    config: {
      enabled: config.enabled,
      root_folder_name: config.root_folder_name,
      daily_retention_days: config.daily_retention_days,
      weekly_retention_weeks: config.weekly_retention_weeks,
      monthly_retention_months: config.monthly_retention_months,
      encryption_enabled: config.encryption_enabled,
      last_backup_at: config.last_backup_at,
      last_status: config.last_status,
      hasCredentials: !!config.service_account_json,
    },
  };
}

/**
 * List recent backups and activity logs.
 */
async function listBackups(limit = 50) {
  const [bRes, lRes] = await Promise.all([
    query(`SELECT * FROM backups ORDER BY created_at DESC LIMIT $1`, [limit]),
    query(`SELECT * FROM backup_logs ORDER BY created_at DESC LIMIT 100`),
  ]);

  return {
    backups: bRes.rows,
    logs: lRes.rows,
  };
}

module.exports = {
  getBackupConfig,
  saveBackupConfig,
  runBackup,
  generateRawSqlDump,
  restoreBackupBuffer,
  getBackupStats,
  listBackups,
  logActivity,
};

