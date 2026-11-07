'use strict';

/**
 * The S3 Media plugin's HTTP API, called by the CRM server as the signed-in user (their cookie /
 * authorization header is forwarded, so the plugin checks its own s3.read / s3.write permissions):
 *
 *   POST   /api/plugins/s3_media_plugin/media/upload            multipart { file, folder } → { s3Key, url }
 *   GET    /api/plugins/s3_media_plugin/media/:encodedKey/file  the stored bytes
 *   DELETE /api/plugins/s3_media_plugin/media/:encodedKey
 *
 * The plugin keeps its bucket and AWS keys; the CRM never reads them. The object key is made by the
 * plugin (<media prefix>/<folder>/<time>-<name>) and the CRM records the key it answers with.
 *
 * Where the API is: CRM_S3_API_ORIGIN (e.g. http://localhost:3000), else BACKEND_URL / INTERNAL_API_URL,
 * else the origin of the request being served.
 */

const BASE_PATH = '/api/plugins/s3_media_plugin';
const TIMEOUT_MS = 60 * 1000;

function header(req, name) {
  const headers = req && req.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '').trim();
  return String(headers[name] || headers[name.toLowerCase()] || '').trim();
}

const cleanOrigin = (value) => {
  const text = String(value || '').trim().replace(/\/+$/, '');
  try {
    const url = new URL(text);
    return url.hostname ? `${url.protocol}//${url.host}` : '';
  } catch {
    return '';
  }
};

/** The origin the S3 Media plugin's API answers on, or '' when it cannot be known. */
function apiOrigin(req) {
  for (const value of [process.env.CRM_S3_API_ORIGIN, process.env.BACKEND_URL, process.env.INTERNAL_API_URL]) {
    const origin = cleanOrigin(value);
    if (origin) return origin;
  }
  const fromUrl = cleanOrigin(req && (req.url || req.originalUrl));
  if (fromUrl) return fromUrl;
  const host = header(req, 'x-forwarded-host').split(',')[0].trim() || header(req, 'host');
  if (!host) return '';
  const proto = header(req, 'x-forwarded-proto').split(',')[0].trim() || (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
  return cleanOrigin(`${proto}://${host}`);
}

/** The signed-in user's credentials for the plugin's own permission check (never logged). */
function authHeaders(req) {
  const out = {};
  const cookie = header(req, 'cookie');
  const authorization = header(req, 'authorization');
  const tenant = header(req, 'x-tenant-id');
  if (cookie) out.cookie = cookie;
  if (authorization) out.authorization = authorization;
  if (tenant) out['x-tenant-id'] = tenant;
  return out;
}

function available(req) {
  return typeof fetch === 'function' && Boolean(apiOrigin(req));
}

const encodeKey = (key) => Buffer.from(String(key), 'utf8').toString('base64url');

function apiError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function call(req, method, path, init = {}) {
  const origin = apiOrigin(req);
  if (!origin || typeof fetch !== 'function') throw apiError(503, 'The S3 Media plugin API cannot be reached from this server', 'S3_API_UNAVAILABLE');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(`${origin}${BASE_PATH}${path}`, {
      method,
      headers: { ...authHeaders(req), ...(init.headers || {}) },
      body: init.body,
      redirect: 'manual',
      ...(controller ? { signal: controller.signal } : {})
    });
  } catch {
    throw apiError(503, 'The S3 Media plugin API cannot be reached from this server', 'S3_API_UNAVAILABLE');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.ok) return res;
  let message = '';
  try {
    const body = await res.json();
    message = String((body && (body.message || body.error)) || '');
  } catch {
    message = '';
  }
  if (res.status === 401 || res.status === 403) {
    throw apiError(403, `${message || 'Not allowed'} — give this role the S3 Media permissions (s3.read, s3.write).`, 'S3_API_FORBIDDEN');
  }
  if (res.status === 404) throw apiError(503, 'The S3 Media plugin is not installed or not active', 'S3_API_UNAVAILABLE');
  if (/not configured/i.test(message)) {
    throw apiError(503, 'File storage is not set up. Configure the S3 Media plugin (bucket and access keys) in OpenExt.', 'STORAGE_NOT_CONFIGURED');
  }
  throw apiError(res.status >= 500 ? 502 : res.status, message || 'The S3 Media plugin could not store the file', 'S3_API_FAILED');
}

/**
 * Uploads bytes through POST /media/upload. Returns { key, url }: the object key the plugin made.
 */
async function upload(req, { buffer, fileName, mimeType, folder }) {
  const form = new FormData();
  const type = mimeType || 'application/octet-stream';
  form.append('file', new Blob([buffer], { type }), String(fileName || 'upload.bin'));
  if (folder) form.append('folder', String(folder).slice(0, 80));
  const res = await call(req, 'POST', '/media/upload', { body: form });
  const body = await res.json().catch(() => ({}));
  const key = String((body && (body.s3Key || (body.asset && body.asset.key))) || '');
  if (!key) throw apiError(502, 'The S3 Media plugin did not return the stored file', 'S3_API_FAILED');
  return { key, url: String(body.url || '') };
}

/** The stored bytes of a key (GET /media/:encodedKey/file). */
async function download(req, key) {
  const res = await call(req, 'GET', `/media/${encodeKey(key)}/file`);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    mimeType: String(res.headers.get('content-type') || 'application/octet-stream')
  };
}

/**
 * The browser URL of a stored file: the S3 Media plugin's own route GET /media/:encodedKey/file
 * (same origin as the app; the plugin checks the signed-in user's s3.read).
 */
function fileUrl(key) {
  const value = String(key || '').trim();
  return value ? `${BASE_PATH}/media/${encodeKey(value)}/file` : '';
}

/** Deletes a key (DELETE /media/:encodedKey). */
async function remove(req, key) {
  await call(req, 'DELETE', `/media/${encodeKey(key)}`);
}

module.exports = { BASE_PATH, apiOrigin, available, upload, download, remove, encodeKey, fileUrl };
