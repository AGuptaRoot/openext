'use strict';

/**
 * Encryption for data an extension keeps (sdk.crypto and sdk.files).
 *
 *   text     "xenc:v1:" + base64url(iv).base64url(tag).base64url(ciphertext)
 *   bytes    "XENC1" + iv(12) + tag(16) + ciphertext
 *   hash     HMAC-SHA256 hex, for finding a value without storing it in clear
 *
 * AES-256-GCM. The key comes from the CRM's master secret (the one that
 * protects Integrations API keys) with its own salt, and every value is bound
 * to its tenant and extension (GCM additional data / HMAC input), so a value
 * copied to another tenant or extension does not decrypt or match there.
 * Extension code never sees a key.
 */

const crypto = require('crypto');
const { readMasterSecret } = require('../utils/credential.util');
const { runtimeError } = require('./values');

const TEXT_PREFIX = 'xenc:v1:';
const BYTES_MAGIC = Buffer.from('XENC1', 'ascii');
const MAX_TEXT_CHARS = 4096;

let cached = null;
function keys() {
  const master = readMasterSecret();
  if (cached && cached.master === master) return cached;
  cached = {
    master,
    enc: crypto.scryptSync(master, 'opennext-crm-extension-data-v1', 32),
    mac: crypto.scryptSync(master, 'opennext-crm-extension-hash-v1', 32)
  };
  return cached;
}

const scopeOf = (tenantId, extensionId) => Buffer.from(`${String(tenantId)}|${String(extensionId)}`, 'utf8');

function encryptBytes(tenantId, extensionId, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys().enc, iv);
  cipher.setAAD(scopeOf(tenantId, extensionId));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([BYTES_MAGIC, iv, cipher.getAuthTag(), data]);
}

function decryptBytes(tenantId, extensionId, stored) {
  const buf = Buffer.isBuffer(stored) ? stored : Buffer.from(stored || []);
  if (buf.length < BYTES_MAGIC.length + 28 || !buf.subarray(0, BYTES_MAGIC.length).equals(BYTES_MAGIC)) {
    throw runtimeError(500, 'Stored file is not in the expected encrypted format', 'FILE_CORRUPT');
  }
  const at = BYTES_MAGIC.length;
  const decipher = crypto.createDecipheriv('aes-256-gcm', keys().enc, buf.subarray(at, at + 12));
  decipher.setAAD(scopeOf(tenantId, extensionId));
  decipher.setAuthTag(buf.subarray(at + 12, at + 28));
  try {
    return Buffer.concat([decipher.update(buf.subarray(at + 28)), decipher.final()]);
  } catch {
    throw runtimeError(500, 'Stored file could not be decrypted', 'FILE_CORRUPT');
  }
}

function encryptText(tenantId, extensionId, value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (!text) return '';
  if (text.length > MAX_TEXT_CHARS) throw runtimeError(400, `crypto.encrypt: value is longer than ${MAX_TEXT_CHARS} characters`, 'VALUE_TOO_LARGE');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys().enc, iv);
  cipher.setAAD(scopeOf(tenantId, extensionId));
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return TEXT_PREFIX + [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

function decryptText(tenantId, extensionId, stored) {
  const value = String(stored === undefined || stored === null ? '' : stored);
  if (!value) return '';
  if (!value.startsWith(TEXT_PREFIX)) throw runtimeError(400, 'crypto.decrypt: value was not made by crypto.encrypt', 'NOT_ENCRYPTED');
  const [iv, tag, data] = value.slice(TEXT_PREFIX.length).split('.');
  if (!iv || !tag || !data) throw runtimeError(400, 'crypto.decrypt: malformed value', 'NOT_ENCRYPTED');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keys().enc, Buffer.from(iv, 'base64url'));
    decipher.setAAD(scopeOf(tenantId, extensionId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw runtimeError(400, 'crypto.decrypt: value cannot be decrypted here', 'DECRYPT_FAILED');
  }
}

function hashText(tenantId, extensionId, value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (!text) return '';
  return crypto.createHmac('sha256', keys().mac).update(scopeOf(tenantId, extensionId)).update('\0').update(text, 'utf8').digest('hex');
}

/** The sdk.crypto object for one request. */
function createCryptoApi(tenantId, extensionId) {
  return Object.freeze({
    encrypt: (value) => encryptText(tenantId, extensionId, value),
    decrypt: (value) => decryptText(tenantId, extensionId, value),
    hash: (value) => hashText(tenantId, extensionId, value)
  });
}

module.exports = {
  TEXT_PREFIX,
  encryptBytes,
  decryptBytes,
  encryptText,
  decryptText,
  hashText,
  createCryptoApi
};
