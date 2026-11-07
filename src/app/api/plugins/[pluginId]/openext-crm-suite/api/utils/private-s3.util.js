'use strict';

/**
 * Where the CRM keeps its files (uploads, extension sdk.files: passport / Aadhaar images, provider
 * tickets, confirmation evidence, vouchers, itineraries): only in the S3 Media plugin's bucket, never on
 * this server's disk. Without the plugin set up, uploads fail with STORAGE_NOT_CONFIGURED.
 *
 * How the CRM reaches the bucket:
 *   1. The S3 Media plugin's HTTP API (utils/s3-media-api.util.js: POST /api/plugins/s3_media_plugin/
 *      media/upload, GET …/media/:key/file, DELETE …/media/:key) as the signed-in user — provider
 *      "s3_media_api" on the file row, the key the plugin made. The plugin keeps its AWS keys.
 *   2. When that API cannot be reached or refuses the user (e.g. a system hook without a user session):
 *      the plugin's storage provider (api/storage-provider.js, plugin 1.7.0+), else its saved settings
 *      read here with its keys decrypted the same way (enc:v1:, AES-256-GCM), never logged —
 *      provider "s3_media".
 * Files written earlier with the server's S3 env settings (provider "s3") stay readable.
 *
 * Objects are written under the CRM's own folder (CRM_S3_PRIVATE_PREFIX, default "crm-private") —
 * outside the media library's prefix, so they never show in its gallery — and no public URL is made.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Storage = require('./storage.util');
const MediaApi = require('./s3-media-api.util');

const MEDIA_PREFIX = 'enc:v1:';
const MEDIA_SALT = 'nextcms-s3-credential-v1';
const MEDIA_SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const CACHE_MS = 60 * 1000;

let cache = { at: 0, value: undefined };

function privatePrefix() {
  return String(process.env.CRM_S3_PRIVATE_PREFIX || 'crm-private').trim().replace(/^\/+|\/+$/g, '') || 'crm-private';
}

/**
 * KEY=value pairs of the first .env found next to the CMS, looked for the way the S3 Media plugin
 * does: the working folder and its parent, then the folders above this plugin.
 */
function dotEnvValues() {
  const dirs = [process.cwd(), path.resolve(process.cwd(), '..')];
  for (let up = 2; up <= 8; up += 1) dirs.push(path.resolve(__dirname, ...Array(up).fill('..')));
  for (const dir of dirs.filter((d, i, all) => all.indexOf(d) === i)) {
    try {
      const file = path.join(dir, '.env');
      if (!fs.existsSync(file)) continue;
      const values = {};
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq <= 0) continue;
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        values[t.slice(0, eq).trim()] = v;
      }
      if (Object.keys(values).length) return values;
    } catch {
      /* next folder */
    }
  }
  return {};
}

/** A credential the S3 Media plugin stored; '' when it cannot be read. Plain values pass through. */
function decryptMediaCredential(stored) {
  const value = String(stored || '').trim();
  if (!value) return '';
  if (!value.startsWith(MEDIA_PREFIX)) return value;
  const [ivPart, tagPart, dataPart] = value.slice(MEDIA_PREFIX.length).split('.');
  if (!ivPart || !tagPart || !dataPart) return '';
  const env = dotEnvValues();
  const secrets = [
    process.env.CREDENTIAL_ENCRYPTION_KEY,
    env.CREDENTIAL_ENCRYPTION_KEY,
    process.env.JWT_SECRET,
    env.JWT_SECRET,
    // The S3 Media plugin's own fallbacks (credentialCrypto.getAllCandidateSecrets).
    'nextcms-s3-dev-only-key',
    'change-me',
    'your_jwt_secret'
  ]
    .map((s) => String(s || '').trim())
    .filter((s, i, all) => s && all.indexOf(s) === i);
  for (const secret of secrets) {
    try {
      const key = crypto.scryptSync(secret, MEDIA_SALT, 32, MEDIA_SCRYPT);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      /* try the next secret */
    }
  }
  return '';
}

function envConfig() {
  if (!Storage.isS3Configured()) return null;
  const cfg = Storage.getS3Config();
  return { provider: 's3', source: 'env', bucket: cfg.bucket, region: cfg.region, endpoint: '', accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, prefix: cfg.prefix };
}

const S3_PLUGIN_IDS = ['s3_media_plugin', 's3-media-plugin'];

let providerCache;

/**
 * The S3 Media plugin's storage provider module, or null (plugin missing or older than 1.7.0). Looked for
 * next to this plugin in the host's plugin folder, or in CRM_S3_PLUGIN_DIR.
 */
function loadStorageProvider() {
  if (providerCache !== undefined) return providerCache;
  providerCache = null;
  const dirs = [];
  if (process.env.CRM_S3_PLUGIN_DIR) dirs.push(path.resolve(String(process.env.CRM_S3_PLUGIN_DIR)));
  for (const id of S3_PLUGIN_IDS) dirs.push(path.resolve(__dirname, '..', '..', '..', id));
  for (const dir of dirs) {
    const file = path.join(dir, 'api', 'storage-provider.js');
    try {
      if (!fs.existsSync(file)) continue;
      const mod = require(file);
      if (mod && Number(mod.version) >= 1 && ['status', 'put', 'get', 'remove'].every((k) => typeof mod[k] === 'function')) {
        providerCache = mod;
        break;
      }
    } catch {
      /* next place */
    }
  }
  return providerCache;
}

function loadMongoose() {
  try {
    return require('mongoose');
  } catch {
    return null;
  }
}

/** Runs a query that may return a mongoose Query, an adapter thenable or a plain value. */
async function settle(query) {
  if (!query) return null;
  const leaned = typeof query.lean === 'function' ? query.lean() : query;
  if (leaned && typeof leaned.then === 'function') return await leaned;
  if (leaned && typeof leaned.exec === 'function') return await leaned.exec();
  return leaned || null;
}

async function rowsOf(Model) {
  if (!Model) return [];
  try {
    if (typeof Model.find === 'function') {
      const rows = await settle(Model.find({}));
      return Array.isArray(rows) ? rows : [];
    }
    if (typeof Model.findOne === 'function') {
      let q = Model.findOne({});
      if (q && typeof q.sort === 'function') q = q.sort({ updatedAt: -1 });
      const row = await settle(q);
      return row ? [row] : [];
    }
  } catch {
    /* not readable */
  }
  return [];
}

/** A stored row as a plain document: MySQL rows can keep their fields in a `doc` JSON column. */
function plainRow(row) {
  if (!row || typeof row !== 'object') return null;
  const base = typeof row.toObject === 'function' ? row.toObject() : row;
  let doc = base.doc;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      doc = null;
    }
  }
  return doc && typeof doc === 'object' ? { ...doc, ...base } : base;
}

/**
 * The S3 Media plugin's saved settings rows. The plugin registers 'S3Config' as `<pluginId>_S3Config`
 * on the user database (table `<pluginid>_s3configs`); the CRM's own SDK cannot see another plugin's
 * models, so they are read from the user database directly.
 */
async function s3ConfigRows(req) {
  const scoped = req && req.cms && req.cms.models && typeof req.cms.models.get === 'function' ? req.cms.models.get('S3Config') : null;
  const fromScoped = await rowsOf(scoped);
  if (fromScoped.length) return { rows: fromScoped, userDb: null, model: scoped };
  let userDb = null;
  try {
    userDb = req && req.cms && req.cms.database && typeof req.cms.database.user === 'function' ? await req.cms.database.user() : null;
  } catch {
    userDb = null;
  }
  if (!userDb) return { rows: [], userDb: null, model: null };
  for (const id of S3_PLUGIN_IDS) {
    const model = userDb.models && userDb.models[`${id}_S3Config`];
    const rows = await rowsOf(model);
    if (rows.length) return { rows, userDb, model };
  }
  const mongoose = loadMongoose();
  if (mongoose && typeof userDb.model === 'function') {
    for (const id of S3_PLUGIN_IDS) {
      const table = `${id.toLowerCase()}_s3configs`;
      const name = `__crm_probe_${table}`;
      let Model = null;
      try {
        Model = (userDb.models && userDb.models[name]) || userDb.model(name, new mongoose.Schema({}, { strict: false, collection: table }));
      } catch {
        Model = null;
      }
      const rows = await rowsOf(Model);
      if (rows.length) return { rows, userDb, model: Model };
    }
  }
  return { rows: [], userDb, model: null };
}

/** False when the host records the S3 Media plugin as installed but disabled. */
async function pluginEnabled(userDb) {
  const Plugin = userDb && userDb.models && userDb.models.Plugin;
  if (!Plugin || typeof Plugin.findOne !== 'function') return true;
  for (const pluginId of S3_PLUGIN_IDS) {
    try {
      const row = plainRow(await settle(Plugin.findOne({ pluginId })));
      if (row) return row.isActive === true || row.isActive === 1 || String(row.isActive) === 'true' || String(row.isActive) === '1';
    } catch {
      /* next id */
    }
  }
  return true;
}

/**
 * The S3 Media plugin as a write target, or null when it is not installed, disabled or not configured:
 * through its storage provider when it has one (it keeps its keys), else from its saved settings.
 */
async function mediaPluginConfig(req) {
  const { rows, userDb, model } = await s3ConfigRows(req);
  if (!rows.length) return null;
  if (userDb && !(await pluginEnabled(userDb))) return null;
  const provider = loadStorageProvider();
  if (provider && model) {
    // The plugin's own models context: its settings model, nothing else of the CRM.
    const cms = { models: { get: (name) => (name === 'S3Config' ? model : null), register: () => model } };
    const state = await provider.status(cms).catch(() => null);
    if (!state || !state.configured) return null;
    const target = {
      provider: 's3_media',
      source: 's3_media_plugin',
      via: 'plugin',
      bucket: String(state.bucket || ''),
      region: String(state.region || ''),
      prefix: privatePrefix()
    };
    // Not enumerable: never copied into logs or answers.
    Object.defineProperty(target, 'storage', { value: { provider, cms }, enumerable: false });
    return target;
  }
  const sorted = rows
    .map(plainRow)
    .filter(Boolean)
    .sort((x, y) => new Date(y.updatedAt || 0).getTime() - new Date(x.updatedAt || 0).getTime());
  for (const doc of sorted) {
    const bucket = String(doc.accessPointArn || doc.bucket || '').trim();
    const accessKeyId = decryptMediaCredential(doc.accessKeyId);
    const secretAccessKey = decryptMediaCredential(doc.secretAccessKey);
    if (!bucket || !accessKeyId || !secretAccessKey) continue;
    return {
      provider: 's3_media',
      source: 's3_media_plugin',
      bucket,
      region: String(doc.region || 'us-east-1').trim(),
      endpoint: String(doc.endpoint || '').trim(),
      accessKeyId,
      secretAccessKey,
      prefix: privatePrefix()
    };
  }
  return null;
}

/** The S3 Media plugin's HTTP API as a target for this request (it carries the request, not enumerable). */
function apiTarget(req) {
  if (!MediaApi.available(req)) return null;
  const target = { provider: 's3_media_api', source: 's3_media_plugin', via: 'api', bucket: '', region: '', prefix: privatePrefix() };
  Object.defineProperty(target, 'api', { value: { req }, enumerable: false });
  return target;
}

/** Settings-based target (no HTTP API): cached for a minute when found. */
async function directTarget(req) {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value = null;
  try {
    value = await mediaPluginConfig(req);
  } catch {
    value = null;
  }
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Where new files go: the S3 Media plugin only (never this server's disk) — its HTTP API when this
 * request can reach it, else its settings — or null when it is not set up.
 */
async function resolveWriteTarget(req) {
  return apiTarget(req) || directTarget(req);
}

/** The S3 Media plugin target, or an error the user can act on: files are never kept on this server. */
async function requireWriteTarget(req) {
  const cfg = await resolveWriteTarget(req);
  if (cfg) return cfg;
  const error = new Error(
    'File storage is not set up. Configure and enable the S3 Media plugin (bucket and access keys) in OpenExt: files are stored only on S3, never on this server.'
  );
  error.status = 503;
  error.code = 'STORAGE_NOT_CONFIGURED';
  throw error;
}

/** The config a stored file was written with (by its provider). */
async function configFor(req, provider) {
  // Files written earlier with the server's S3 env settings stay readable.
  if (provider === 's3') return envConfig();
  if (provider === 's3_media_api') return apiTarget(req) || (await directTarget(req));
  if (provider === 's3_media') {
    const cfg = await directTarget(req);
    if (cfg && cfg.provider === 's3_media') return cfg;
    return mediaPluginConfig(req).catch(() => null);
  }
  return null;
}

function client(cfg) {
  let sdk;
  try {
    sdk = require('@aws-sdk/client-s3');
  } catch {
    const error = new Error('S3 is configured but @aws-sdk/client-s3 is not installed on this server');
    error.status = 500;
    throw error;
  }
  const options = {
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    useArnRegion: true
  };
  const endpoint = String(cfg.endpoint || '').trim();
  if (endpoint) {
    options.endpoint = /^https?:\/\//i.test(endpoint) ? endpoint.replace(/\/+$/, '') : `https://${endpoint.replace(/\/+$/, '')}`;
    options.forcePathStyle = false;
  }
  return { sdk, s3: new sdk.S3Client(options) };
}

/** API problems where the plugin's settings can still be used instead (no reachable API, no user rights). */
const FALL_BACK = new Set(['S3_API_UNAVAILABLE', 'S3_API_FORBIDDEN']);

/**
 * Stores bytes. `key` is where the CRM would like them; the answer is where they really are:
 * { key, provider } (through the HTTP API the S3 Media plugin makes the key). Record both.
 */
async function putObject(cfg, key, bytes, contentType = 'application/octet-stream') {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const type = contentType || 'application/octet-stream';
  if (cfg && cfg.api) {
    const prefix = privatePrefix();
    const dir = path.posix.dirname(String(key));
    const folder = (dir.startsWith(`${prefix}/`) ? `crm/${dir.slice(prefix.length + 1)}` : dir === '.' ? 'crm' : dir).slice(0, 80);
    try {
      const stored = await MediaApi.upload(cfg.api.req, { buffer, fileName: path.posix.basename(String(key)), mimeType: type, folder });
      return { key: stored.key, provider: 's3_media_api' };
    } catch (error) {
      const direct = FALL_BACK.has(error && error.code) ? await directTarget(cfg.api.req) : null;
      if (!direct) throw error;
      console.warn(`[plugin:openext-crm-suite] S3 Media API not usable (${error.code}); storing through the plugin's settings`);
      return putObject(direct, key, buffer, type);
    }
  }
  if (cfg && cfg.storage) {
    await cfg.storage.provider.put(cfg.storage.cms, key, buffer, type);
    return { key, provider: cfg.provider };
  }
  const { sdk, s3 } = client(cfg);
  await s3.send(new sdk.PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: buffer, ContentType: type }));
  return { key, provider: cfg.provider };
}

async function getObject(cfg, key) {
  if (cfg && cfg.api) return (await MediaApi.download(cfg.api.req, key)).buffer;
  if (cfg && cfg.storage) return (await cfg.storage.provider.get(cfg.storage.cms, key)).buffer;
  const { sdk, s3 } = client(cfg);
  const res = await s3.send(new sdk.GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function deleteObject(cfg, key) {
  if (cfg && cfg.api) {
    await MediaApi.remove(cfg.api.req, key);
    return;
  }
  if (cfg && cfg.storage) {
    await cfg.storage.provider.remove(cfg.storage.cms, key);
    return;
  }
  const { sdk, s3 } = client(cfg);
  await s3.send(new sdk.DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

/** For the admin: where new private files go (no keys, bucket name only). */
async function status(req) {
  const cfg = await resolveWriteTarget(req);
  if (!cfg) return { mode: 'none', source: null, bucket: '', prefix: '' };
  // via: 'api' (the plugin's HTTP API), 'plugin' (its storage provider) or 'settings' (read directly).
  return { mode: 's3', source: cfg.source, via: cfg.via || 'settings', bucket: cfg.bucket, region: cfg.region, prefix: cfg.prefix };
}

function clearCache() {
  cache = { at: 0, value: undefined };
  providerCache = undefined;
}

module.exports = { resolveWriteTarget, requireWriteTarget, configFor, putObject, getObject, deleteObject, status, clearCache, decryptMediaCredential, privatePrefix };
