'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CREDENTIAL_ENCRYPTION_PREFIX = 'enc:v1:';
const SCRYPT_SALT = 'nextcms-credential-v1';
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function readDotEnv() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../../../.env'),
    path.resolve(__dirname, '../../../../../.env'),
    'C:/Users/AdarshGupta/Documents/OpenExt/openNext gitlab/.env'
  ];
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
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
      if (values.CREDENTIAL_ENCRYPTION_KEY || values.JWT_SECRET) {
        return values;
      }
    } catch {
      /* continue */
    }
  }
  return {};
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
    'Set CREDENTIAL_ENCRYPTION_KEY (recommended) or a strong JWT_SECRET before reading payment credentials.'
  );
}

function deriveKey(master) {
  return crypto.scryptSync(master, SCRYPT_SALT, 32, SCRYPT_OPTIONS);
}

function isEncryptedCredential(value) {
  return String(value || '').startsWith(CREDENTIAL_ENCRYPTION_PREFIX);
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

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

module.exports = {
  isEncryptedCredential,
  decryptCredential
};
