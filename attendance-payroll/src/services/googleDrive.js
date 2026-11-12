'use strict';
/**
 * JMCL STAFF FLOW PRO PLUS — Native Google Drive API v3 Service
 * Pure Node.js (https + crypto), zero third-party dependencies.
 * Compatible with Render Web Services and serverless containers.
 */
const https = require('https');
const crypto = require('crypto');

/**
 * Helper to perform HTTPS JSON or binary requests.
 */
function request(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const opts = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 60000,
    };

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const status = res.statusCode;
        const isJson = (res.headers['content-type'] || '').includes('application/json');

        if (status >= 200 && status < 300) {
          if (isJson) {
            try {
              resolve({ status, data: JSON.parse(buffer.toString('utf8')), headers: res.headers, buffer });
            } catch (err) {
              resolve({ status, data: buffer.toString('utf8'), headers: res.headers, buffer });
            }
          } else {
            resolve({ status, buffer, headers: res.headers });
          }
        } else {
          let errMsg = `HTTP ${status}: ${res.statusMessage}`;
          if (isJson) {
            try {
              const parsed = JSON.parse(buffer.toString('utf8'));
              errMsg = parsed.error?.message || parsed.error_description || errMsg;
            } catch (_) {}
          } else if (buffer.length) {
            errMsg += ` - ${buffer.toString('utf8').slice(0, 300)}`;
          }
          const err = new Error(errMsg);
          err.status = status;
          err.buffer = buffer;
          reject(err);
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Google API network error: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Google API request timed out (60s)'));
    });

    if (body) {
      if (Buffer.isBuffer(body)) {
        req.write(body);
      } else if (typeof body === 'string') {
        req.write(body);
      } else {
        req.write(JSON.stringify(body));
      }
    }
    req.end();
  });
}

/**
 * Base64 URL encode utility for JWTs
 */
function base64Url(strOrBuffer) {
  const buf = Buffer.isBuffer(strOrBuffer) ? strOrBuffer : Buffer.from(strOrBuffer, 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generates Google OAuth2 Access Token using Service Account Private Key.
 */
async function getAccessToken(serviceAccount) {
  if (!serviceAccount || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('Invalid Service Account configuration. client_email and private_key are required.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedClaims = base64Url(JSON.stringify(claims));
  const signatureInput = `${encodedHeader}.${encodedClaims}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signatureInput);
  const signature = base64Url(signer.sign(serviceAccount.private_key));

  const jwt = `${signatureInput}.${signature}`;

  const postBody = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  const res = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }, postBody);

  return res.data.access_token;
}

/**
 * Test & verify Google Drive Connection.
 */
async function verifyConnection(serviceAccount) {
  try {
    const token = await getAccessToken(serviceAccount);
    const res = await request('https://www.googleapis.com/drive/v3/about?fields=user,storageQuota', {
      headers: { Authorization: `Bearer ${token}` },
    });

    return {
      ok: true,
      email: serviceAccount.client_email,
      driveUser: res.data.user?.displayName || res.data.user?.emailAddress || serviceAccount.client_email,
      storageQuota: res.data.storageQuota || null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
    };
  }
}

/**
 * Search or create a folder in Google Drive.
 */
async function ensureFolder(token, folderName, parentFolderId = null) {
  let query = `name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  if (parentFolderId) {
    query += ` and '${parentFolderId}' in parents`;
  }

  const listUrl = `https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(query)}&fields=files(id,name)`;
  const listRes = await request(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (listRes.data.files && listRes.data.files.length > 0) {
    return listRes.data.files[0].id;
  }

  // Create folder
  const metadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentFolderId) {
    metadata.parents = [parentFolderId];
  }

  const createRes = await request('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }, metadata);

  return createRes.data.id;
}

/**
 * Ensures standard JMCL backup folder hierarchy:
 * JMCL_Backup/
 *   ├── Daily_Backup/
 *   ├── Weekly_Backup/
 *   ├── Monthly_Backup/
 *   ├── Database_Backup/
 *   └── Backup_Logs/
 */
async function ensureFolderHierarchy(token, rootFolderNameOrId = 'JMCL_Backup') {
  let rootId = null;
  // If input looks like an alphanumeric Google Drive ID (25+ characters, no spaces)
  if (rootFolderNameOrId && /^[A-Za-z0-9_-]{25,}$/.test(rootFolderNameOrId)) {
    rootId = rootFolderNameOrId;
  } else {
    rootId = await ensureFolder(token, rootFolderNameOrId || 'JMCL_Backup');
  }

  const subfolders = [
    'Daily_Backup',
    'Weekly_Backup',
    'Monthly_Backup',
    'Database_Backup',
    'Employee_Documents',
    'Application_Backup',
    'Configuration_Backup',
    'Backup_Logs',
  ];

  const map = { root: rootId };
  for (const sub of subfolders) {
    map[sub] = await ensureFolder(token, sub, rootId);
  }
  return map;
}

/**
 * Uploads a file buffer directly to Google Drive via v3 Multipart Upload.
 */
async function uploadFile(token, { name, buffer, mimeType = 'application/octet-stream', parentFolderId = null, description = '' }) {
  const boundary = `-------JMCL_BOUNDARY_${crypto.randomBytes(8).toString('hex')}`;
  const metadata = {
    name,
    description,
    mimeType,
  };
  if (parentFolderId) {
    metadata.parents = [parentFolderId];
  }

  const metaHeader = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const fileHeader = `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--`;

  const payload = Buffer.concat([
    Buffer.from(metaHeader, 'utf8'),
    Buffer.from(fileHeader, 'utf8'),
    buffer,
    Buffer.from(footer, 'utf8'),
  ]);

  const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,createdTime,webViewLink';
  const res = await request(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': payload.length,
    },
  }, payload);

  return res.data;
}

/**
 * Downloads a file buffer from Google Drive by fileId.
 */
async function downloadFile(token, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const res = await request(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.buffer;
}

/**
 * Prunes files older than retention policy.
 */
async function applyRetention(token, folderId, maxAgeDays = 30) {
  if (!folderId || maxAgeDays <= 0) return 0;
  const cutoff = new Date(Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000)).toISOString();
  const query = `'${folderId}' in parents and createdTime < '${cutoff}' and trashed = false`;

  const listUrl = `https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&includeItemsFromAllDrives=true&q=${encodeURIComponent(query)}&fields=files(id,name,createdTime)`;
  const listRes = await request(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const files = listRes.data.files || [];
  let deletedCount = 0;

  for (const f of files) {
    try {
      await request(`https://www.googleapis.com/drive/v3/files/${f.id}?supportsAllDrives=true`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      deletedCount++;
    } catch (_) {}
  }
  return deletedCount;
}

module.exports = {
  getAccessToken,
  verifyConnection,
  ensureFolder,
  ensureFolderHierarchy,
  uploadFile,
  downloadFile,
  applyRetention,
};

