/**
 * Storage provider for other plugins (1.7.0), e.g. the OpenNext CRM: they store, read and delete their
 * files in this plugin's bucket through this module, on the server. This plugin alone reads its
 * settings and decrypts its AWS keys — the caller never sees bucket credentials.
 *
 *   const provider = require('<plugins>/s3_media_plugin/api/storage-provider.js');
 *   provider.version                                   1
 *   await provider.status(cms)                         { configured, bucket, region, usesAccessPoint } (no keys)
 *   await provider.put(cms, key, buffer, contentType)  { key, size, storage: 's3' }
 *   await provider.get(cms, key)                       { buffer, contentType, contentLength }
 *   await provider.remove(cms, key)
 *
 * `cms` is a context whose models.get('S3Config') returns this plugin's settings model.
 *
 * Keys are the caller's own folder ("crm-private/<tenant>/…"), never inside this plugin's media prefix,
 * so private files do not show in the media gallery and get no public URL or public cache headers.
 * Nothing is ever written to local disk.
 */

const S3Service = require('./services/S3Service');
const SettingsService = require('./services/SettingsService');

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9!_.*'()\/-]{0,1023}$/;

function badKey(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'INVALID_STORAGE_KEY';
  return error;
}

/** A safe object key outside the media prefix, or an error. */
async function checkKey(cms, key) {
  const value = String(key || '').trim();
  if (!KEY_RE.test(value) || value.includes('..') || value.includes('//')) throw badKey('Invalid storage key');
  const prefix = await S3Service.mediaPrefix(cms);
  if (prefix && (value === prefix || value.startsWith(`${prefix}/`))) {
    throw badKey('Private files cannot be stored inside the media library folder');
  }
  return value;
}

module.exports = {
  version: 1,

  async status(cms) {
    const config = await SettingsService.getPublicConfig(cms);
    return {
      configured: Boolean(config.isConfigured),
      bucket: config.accessPointArn || config.bucket || '',
      region: config.region || '',
      usesAccessPoint: Boolean(config.usesAccessPoint),
    };
  },

  async put(cms, key, buffer, contentType) {
    const safeKey = await checkKey(cms, key);
    return S3Service.putPrivateObject(cms, safeKey, buffer, contentType);
  },

  async get(cms, key) {
    const safeKey = await checkKey(cms, key);
    return S3Service.fetchObject(cms, safeKey);
  },

  async remove(cms, key) {
    const safeKey = await checkKey(cms, key);
    await S3Service.deleteObject(cms, safeKey);
  },
};
