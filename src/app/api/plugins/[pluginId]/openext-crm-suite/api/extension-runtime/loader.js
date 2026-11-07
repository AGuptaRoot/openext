'use strict';

/**
 * Loads an approved extension backend for a tenant, once, and caches it.
 *
 * Cache key: tenantId | extensionId | checksum. A new upload has a new
 * checksum, so it can never be served from an older cache entry. Revocation
 * does not depend on the cache: the runtime checks trust on every request.
 *
 * Integrity: every api/ file read from the extension folder must hash to the
 * sha256 recorded in the extension row's fileIndex at install time, and the
 * row's checksum must equal the checksum the admin approved.
 */

const { resolveTenantId } = require('../utils/tenant.util');
const { createPackageRuntime } = require('./sandbox');
const { createSdk } = require('./sdk');

const REGISTER_TIMEOUT_MS = 10000;
const cache = new Map();

function key(tenantId, extensionId, checksum) {
  return `${tenantId}|${extensionId}|${checksum}`;
}

/**
 * Stored file bytes as an exact Buffer. `lean()` returns a BSON Binary whose
 * internal `.buffer` may be larger than the data, so read exactly
 * `length()` / `position` bytes.
 */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data && data._bsontype === 'Binary') {
    if (typeof data.read === 'function' && typeof data.length === 'function') {
      return Buffer.from(data.read(0, data.length()));
    }
    const size = typeof data.position === 'number' ? data.position : undefined;
    return Buffer.from(size === undefined ? data.buffer : data.buffer.subarray(0, size));
  }
  if (data && data.buffer instanceof Uint8Array) return Buffer.from(data.buffer);
  if (data && data.type === 'Buffer' && Array.isArray(data.data)) return Buffer.from(data.data);
  return Buffer.from(String(data || ''), 'utf8');
}

function loadError(message, code = 'EXTENSION_BACKEND_FAILED') {
  const error = new Error(message);
  error.status = 503;
  error.code = code;
  return error;
}

function isApproved(def) {
  return def.trust === 'approved' && Boolean(def.checksum) && def.approvedChecksum === def.checksum;
}

/**
 * api/ files from the extension's folder in the plugin directory
 * (extensions/<tenant>/<id>/<version>/api/…). Every file must match the
 * sha256 recorded at install; a missing or changed file means the package is
 * no longer trustworthy and is never loaded.
 */
async function readApiFiles(req, def) {
  const PackageFolder = require('./package-folder');
  const tenantId = resolveTenantId(req);
  const check = PackageFolder.verifyPackage(tenantId, def);
  if (!check.ok) {
    throw loadError(`The extension files are not usable (${check.reason}); upload the package again`, 'EXTENSION_FILES_MISSING');
  }
  const files = PackageFolder.readArea(tenantId, def, 'api');
  if (!files) {
    throw loadError('Integrity check failed for the api/ files; upload the package again', 'EXTENSION_INTEGRITY_FAILED');
  }
  return files;
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(loadError(message, 'EXTENSION_TIMEOUT')), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function recordStatus(req, def, status, errorMessage) {
  try {
    const Model = req.cms?.models?.get?.('CrmExtension');
    if (!Model || typeof Model.updateOne !== 'function') return;
    await Model.updateOne(
      { tenantId: resolveTenantId(req), extensionId: def.id, isDeleted: false },
      {
        $set: {
          backendStatus: status,
          backendError: errorMessage ? String(errorMessage).slice(0, 500) : '',
          backendLoadedAt: status === 'loaded' ? new Date() : null
        }
      }
    );
  } catch {
    /* status is informational */
  }
}

/**
 * @returns {Promise<{ require: Function, toContext: Function, dispose: Function }>}
 * @throws 503 when not approved, failed, or integrity broken
 */
async function ensureLoaded(req, def) {
  if (!isApproved(def)) throw loadError('The backend of this extension is not approved', 'EXTENSION_BACKEND_NOT_APPROVED');
  const tenantId = resolveTenantId(req);
  const k = key(tenantId, def.id, def.checksum);
  const hit = cache.get(k);
  if (hit) {
    if (hit.status === 'loaded') return hit.runtime;
    if (hit.status === 'failed') throw loadError(`The extension backend failed to load: ${hit.error}`);
    return hit.promise;
  }

  const entry = { status: 'loading', runtime: null, error: '', promise: null };
  entry.promise = (async () => {
    try {
      const files = await readApiFiles(req, def);
      const logger = req.cms?.logger || console;
      const runtime = createPackageRuntime({ extensionId: def.id, files, logger });
      const entryPath = def.entry && def.entry.api;
      if (entryPath && files.has(entryPath)) {
        const main = runtime.require(entryPath);
        if (main && typeof main.register === 'function') {
          await withTimeout(Promise.resolve(main.register(runtime.wrapHost(createSdk(req, def)))), REGISTER_TIMEOUT_MS, 'register() timed out');
        }
      }
      entry.status = 'loaded';
      entry.runtime = runtime;
      await recordStatus(req, def, 'loaded');
      return runtime;
    } catch (error) {
      entry.status = 'failed';
      entry.error = (error && error.message) || String(error);
      (req.cms?.logger || console).error?.(`[crm-ext:${def.id}] backend load failed:`, entry.error);
      await recordStatus(req, def, 'failed', entry.error);
      throw error && error.status ? error : loadError(`The extension backend failed to load: ${entry.error}`);
    }
  })();
  cache.set(k, entry);
  return entry.promise;
}

/** Drop cached backends for a tenant's extension (install, approve, revoke, uninstall). */
function invalidate(tenantId, extensionId) {
  const prefix = `${tenantId}|${extensionId}|`;
  for (const [k, entry] of cache.entries()) {
    if (!k.startsWith(prefix)) continue;
    try {
      entry.runtime?.dispose();
    } catch {
      /* ignore */
    }
    cache.delete(k);
  }
}

function clearAll() {
  for (const entry of cache.values()) {
    try {
      entry.runtime?.dispose();
    } catch {
      /* ignore */
    }
  }
  cache.clear();
}

module.exports = { ensureLoaded, invalidate, clearAll, isApproved, toBuffer, _cache: cache };
