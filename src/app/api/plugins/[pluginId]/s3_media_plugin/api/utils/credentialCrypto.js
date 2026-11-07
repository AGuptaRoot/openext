const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CREDENTIAL_ENCRYPTION_PREFIX = 'enc:v1:';
const SCRYPT_SALT = 'nextcms-s3-credential-v1';
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function readDotEnv() {
  const candidateDirs = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.resolve(__dirname, '../../../../'),
    path.resolve(__dirname, '../../../../../'),
    path.resolve(__dirname, '../../../'),
    path.resolve(__dirname, '../../'),
  ];

  for (const dir of candidateDirs) {
    try {
      const envPath = path.resolve(dir, '.env');
      if (fs.existsSync(envPath)) {
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
        if (Object.keys(values).length > 0) return values;
      }
    } catch {
      // Continue to next directory candidate
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

  // Soft fallback: still allow saves in local/dev without encryption key.
  return 'nextcms-s3-dev-only-key';
}

function getAllCandidateSecrets() {
  const dotenv = readDotEnv();
  const candidates = [];
  const add = (val) => {
    const str = String(val || '').trim();
    if (str && !candidates.includes(str)) {
      candidates.push(str);
    }
  };

  // 1. Current preferred master secret
  add(readMasterSecret());

  // 2. Dedicated encryption keys
  add(process.env.CREDENTIAL_ENCRYPTION_KEY);
  add(dotenv.CREDENTIAL_ENCRYPTION_KEY);

  // 3. JWT secrets
  add(process.env.JWT_SECRET);
  add(dotenv.JWT_SECRET);

  // 4. Default / common fallbacks
  add('nextcms-s3-dev-only-key');
  add('change-me');
  add('your_jwt_secret');

  return candidates;
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
    return '';
  }

  let iv, tag, data;
  try {
    iv = Buffer.from(ivPart, 'base64url');
    tag = Buffer.from(tagPart, 'base64url');
    data = Buffer.from(dataPart, 'base64url');
  } catch {
    return '';
  }

  const candidates = getAllCandidateSecrets();
  for (const secret of candidates) {
    try {
      const key = deriveKey(secret);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
      return decrypted.toString('utf8');
    } catch {
      // Key mismatch or auth tag mismatch with this secret; try next candidate
    }
  }

  // Gracefully handle unrecoverable credentials:
  console.warn(
    '[s3-media-plugin] Unable to authenticate/decrypt stored credential (encryption key mismatch or invalid auth tag). Returning empty credential.'
  );
  return '';
}

function maskCredential(value, visible = 4) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= visible * 2) return '••••••••';
  return `${text.slice(0, visible)}…${text.slice(-visible)}`;
}

module.exports = {
  CREDENTIAL_ENCRYPTION_PREFIX,
  isEncryptedCredential,
  encryptCredential,
  decryptCredential,
  maskCredential,
};
