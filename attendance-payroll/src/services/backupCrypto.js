'use strict';
/**
 * JMCL STAFF FLOW PRO PLUS — Enterprise Backup Cryptography & Checksum Utility
 * Uses Node.js native crypto: AES-256-GCM encryption & SHA-256 verification.
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;

/**
 * Derives a 32-byte key from a secret string using PBKDF2.
 */
function deriveKey(secret, salt) {
  return crypto.pbkdf2Sync(String(secret), salt, 100000, 32, 'sha256');
}

/**
 * Encrypts a buffer with AES-256-GCM.
 * Output format: [MAGIC (4b)][SALT (32b)][IV (16b)][AUTH_TAG (16b)][CIPHERTEXT]
 */
function encryptBuffer(buffer, secret) {
  if (!secret) throw new Error('Encryption secret key is required');
  const magic = Buffer.from('JMCL');
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(secret, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([magic, salt, iv, tag, ciphertext]);
}

/**
 * Decrypts an AES-256-GCM encrypted buffer.
 */
function decryptBuffer(encryptedBuffer, secret) {
  if (!secret) throw new Error('Decryption secret key is required');
  if (encryptedBuffer.length < 4 + SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error('Encrypted data is too short or invalid');
  }

  const magic = encryptedBuffer.subarray(0, 4).toString('utf8');
  if (magic !== 'JMCL') {
    throw new Error('Invalid backup file header (not a JMCL encrypted backup)');
  }

  let offset = 4;
  const salt = encryptedBuffer.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = encryptedBuffer.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const tag = encryptedBuffer.subarray(offset, offset + TAG_LENGTH);
  offset += TAG_LENGTH;
  const ciphertext = encryptedBuffer.subarray(offset);

  const key = deriveKey(secret, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Computes SHA-256 checksum for verification.
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = {
  encryptBuffer,
  decryptBuffer,
  sha256,
};
