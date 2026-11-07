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

function readMasterSecret() {
  const dotenv = readDotEnv();
  const fromDedicated = String(
    process.env.CREDENTIAL_ENCRYPTION_KEY || dotenv.CREDENTIAL_ENCRYPTION_KEY || ''
  ).trim();
  if (fromDedicated) return fromDedicated;

  const jwt = String(process.env.JWT_SECRET || dotenv.JWT_SECRET || '').trim();
  if (jwt && jwt !== 'change-me' && jwt !== 'your_jwt_secret') return jwt;

  throw new Error(
    'Set CREDENTIAL_ENCRYPTION_KEY (recommended) or a strong JWT_SECRET before storing payment credentials.'
  );
}

function deriveKey(master) {
  return crypto.scryptSync(master, SCRYPT_SALT, 32, SCRYPT_OPTIONS);
}

function isEncryptedCredential(value) {
  return String(value || '').startsWith(CREDENTIAL_ENCRYPTION_PREFIX);
}

function encryptCredential(plaintext) {
  const text = String(plaintext || '').trim();
  if (!text) return '';

  const key = deriveKey(readMasterSecret());
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${CREDENTIAL_ENCRYPTION_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptCredential(stored) {
  const value = String(stored || '').trim();
  if (!value) return '';

  if (!isEncryptedCredential(value)) {
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

function maskCredential(value, visible = 4) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= visible * 2) return '••••••••';
  return `${text.slice(0, visible)}…${text.slice(-visible)}`;
}

function validateRazorpayKeyId(keyId) {
  const id = String(keyId || '').trim();
  if (!id) return { ok: false, message: 'Key ID is required.' };
  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(id)) {
    return { ok: false, message: 'Key ID must look like rzp_test_… or rzp_live_…' };
  }
  return { ok: true };
}

function validateRazorpayKeySecret(keySecret) {
  const secret = String(keySecret || '').trim();
  if (!secret) return { ok: false, message: 'Key Secret is required.' };
  if (secret.length < 8) {
    return { ok: false, message: 'Key Secret looks too short.' };
  }
  return { ok: true };
}

module.exports = {
  CREDENTIAL_ENCRYPTION_PREFIX,
  isEncryptedCredential,
  encryptCredential,
  decryptCredential,
  maskCredential,
  validateRazorpayKeyId,
  validateRazorpayKeySecret,
};
