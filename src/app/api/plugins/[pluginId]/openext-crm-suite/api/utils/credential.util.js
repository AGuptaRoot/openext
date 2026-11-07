'use strict';

/**
 * AES-256-GCM credential encryption for tenant secrets (API keys, etc.).
 * Compatible with enc:v1 payloads used by razorpay-credential.util.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CREDENTIAL_ENCRYPTION_PREFIX = 'enc:v1:';
const SCRYPT_SALT = 'nextcms-credential-v1';
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function readDotEnv() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    const values = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      values[key] = val;
    }
    return values;
  } catch {
    return {};
  }
}

/** Last-resort local secret so Integrations still works when JWT_SECRET is unset/weak. */
const CRM_FALLBACK_MASTER =
  'opennext-crm-suite-credential-fallback-v1-do-not-use-in-prod-prefer-CREDENTIAL_ENCRYPTION_KEY';

function readMasterSecret() {
  const dotenv = readDotEnv();
  const fromDedicated = String(
    process.env.CREDENTIAL_ENCRYPTION_KEY || dotenv.CREDENTIAL_ENCRYPTION_KEY || ''
  ).trim();
  if (fromDedicated) return fromDedicated;

  const jwt = String(process.env.JWT_SECRET || dotenv.JWT_SECRET || '').trim();
  if (jwt && jwt !== 'change-me' && jwt !== 'your_jwt_secret') return jwt;

  // Prefer env, but never hard-fail OCR/Integrations on typical local OpenNext installs.
  return CRM_FALLBACK_MASTER;
}

function deriveKey(master) {
  return crypto.scryptSync(master, SCRYPT_SALT, 32, SCRYPT_OPTIONS);
}

function isEncryptedCredential(value) {
  return String(value || '').startsWith(CREDENTIAL_ENCRYPTION_PREFIX);
}

function encryptCredential(plaintext) {
  const value = String(plaintext || '').trim();
  if (!value) return '';

  const key = deriveKey(readMasterSecret());
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return (
    CREDENTIAL_ENCRYPTION_PREFIX +
    [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.')
  );
}

function decryptCredential(stored) {
  const value = String(stored || '').trim();
  if (!value) return '';

  if (!isEncryptedCredential(value)) {
    // Legacy plaintext — still usable, but callers should re-encrypt on next save.
    return value;
  }

  const payload = value.slice(CREDENTIAL_ENCRYPTION_PREFIX.length);
  const parts = payload.split('.');
  const ivPart = parts[0];
  const tagPart = parts[1];
  const dataPart = parts[2];
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error('Invalid encrypted credential format');
  }

  const key = deriveKey(readMasterSecret());
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const data = Buffer.from(dataPart, 'base64url');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

/** Safe display hint — never enough to reconstruct the secret. */
function maskSecretHint(secret) {
  const value = String(secret || '').trim();
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

module.exports = {
  CREDENTIAL_ENCRYPTION_PREFIX,
  isEncryptedCredential,
  encryptCredential,
  decryptCredential,
  maskSecretHint,
  readMasterSecret
};
