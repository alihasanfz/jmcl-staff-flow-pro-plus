'use strict';
/**
 * JMCL STAFF FLOW PRO PLUS — Automated Backup & Restore API Routes
 * Access restricted exclusively to Administrators.
 */
const express = require('express');
const { requireRole } = require('../middleware/auth');
const backupService = require('../services/backup');
const googleDrive = require('../services/googleDrive');
const { query } = require('../db');

const router = express.Router();

// Wrap async handlers
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Admin-only access guard
router.use(requireRole('admin'));

/**
 * GET /api/backup/status
 * KPI statistics, connection status, and configuration summary.
 */
router.get('/status', wrap(async (req, res) => {
  const data = await backupService.getBackupStats();
  res.json(data);
}));

/**
 * GET /api/backup/list
 * History of backups and audit activity logs.
 */
router.get('/list', wrap(async (req, res) => {
  const data = await backupService.listBackups(req.query.limit || 50);
  res.json(data);
}));

/**
 * POST /api/backup/run
 * Trigger immediate manual backup.
 */
router.post('/run', wrap(async (req, res) => {
  const type = req.body?.type || 'manual';
  const scope = req.body?.scope || 'full';
  const result = await backupService.runBackup({ type, scope });
  res.json(result);
}));

/**
 * GET /api/backup/download-sql
 * Direct streaming download of raw PostgreSQL SQL dump.
 */
router.get('/download-sql', wrap(async (req, res) => {
  const { sqlDump, fileName } = await backupService.generateRawSqlDump();
  res.setHeader('Content-Type', 'application/sql');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(sqlDump);
}));

/**
 * GET /api/backup/download/:id
 * Direct download of an archived backup package.
 */
router.get('/download/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows: [b] } = await query('SELECT * FROM backups WHERE id = $1', [id]);
  if (!b) return res.status(404).json({ error: 'Backup record not found' });

  // If stored in Google Drive, download from Google Drive
  const config = await backupService.getBackupConfig();
  if (b.gdrive_file_id && config.service_account_json) {
    try {
      const sa = typeof config.service_account_json === 'string'
        ? JSON.parse(config.service_account_json)
        : config.service_account_json;
      const token = await googleDrive.getAccessToken(sa);
      const buffer = await googleDrive.downloadFile(token, b.gdrive_file_id);

      res.setHeader('Content-Type', b.encrypted ? 'application/octet-stream' : 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${b.file_name}"`);
      return res.send(buffer);
    } catch (err) {
      console.warn('[backup-download] Could not download from Google Drive:', err.message);
    }
  }

  // Fallback: generate fresh on-demand dump with matching metadata
  const { sqlDump, fileName } = await backupService.generateRawSqlDump();
  res.setHeader('Content-Type', 'application/sql');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(sqlDump);
}));

/**
 * POST /api/backup/config
 * Save Google Drive settings & Retention policy.
 */
router.post('/config', wrap(async (req, res) => {
  const body = req.body || {};
  const updated = await backupService.saveBackupConfig(body);
  res.json({ ok: true, config: updated });
}));

/**
 * POST /api/backup/test-drive
 * Test Google Drive API connectivity with provided or saved credentials.
 */
router.post('/test-drive', wrap(async (req, res) => {
  let sa = req.body?.service_account_json;
  if (!sa) {
    const config = await backupService.getBackupConfig();
    sa = config.service_account_json;
  }
  if (!sa) {
    return res.status(400).json({ ok: false, error: 'Please provide Service Account JSON credentials' });
  }

  const parsed = typeof sa === 'string' ? JSON.parse(sa) : sa;
  const testRes = await googleDrive.verifyConnection(parsed);
  res.json(testRes);
}));

/**
 * POST /api/backup/restore
 * Safely restores database from uploaded backup payload or raw SQL.
 */
router.post('/restore', wrap(async (req, res) => {
  const { backupData, encryptionKey } = req.body;
  if (!backupData) {
    return res.status(400).json({ error: 'Missing backupData for restoration' });
  }

  let buffer;
  if (typeof backupData === 'string' && backupData.startsWith('data:')) {
    const base64Str = backupData.split(',')[1];
    buffer = Buffer.from(base64Str, 'base64');
  } else if (typeof backupData === 'string') {
    buffer = Buffer.from(backupData, 'utf8');
  } else {
    buffer = Buffer.from(backupData);
  }

  const result = await backupService.restoreBackupBuffer(buffer, encryptionKey);
  res.json({ ok: true, result });
}));

/**
 * DELETE /api/backup/:id
 * Delete a backup record.
 */
router.delete('/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await query('DELETE FROM backups WHERE id = $1', [id]);
  res.json({ ok: true, deletedId: id });
}));

module.exports = router;

