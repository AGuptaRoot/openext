'use strict';

/**
 * CRM Extension UI Assets Route (Contract §7).
 *
 * GET /x-assets/:extensionId/:version/<path inside the package>
 * e.g. /x-assets/services/2.0.0/ui/mount.js
 *
 * Serves only files recorded with area 'ui' in the extension's file index, read
 * from the plugin folder extensions/<tenant>/<id>/<version>/ and checked against
 * their sha256. The version in the URL must equal the installed version.
 */

const { requireAnyPermission } = require('../middleware/permission.middleware');
const { resolveTenantId } = require('../utils/tenant.util');

const MAX_DEPTH = 6;
/** tenant:extension → { at, def } (definition lookups for asset requests, 10 s). */
const definitionCache = new Map();

const ASSET_PERMISSIONS = [
  'crm.dashboard.view',
  'crm.leads.read',
  'crm.opportunities.read',
  'crm.finance.read',
  'crm.tickets.read',
  'crm.projects.read',
  'crm.clients.read',
  'crm.settings.manage'
];

/**
 * Convert stored file bytes to an exact Buffer.
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

function setHeader(res, name, value) {
  if (typeof res.setHeader === 'function') {
    res.setHeader(name, value);
  } else if (typeof res.set === 'function') {
    res.set(name, value);
  } else if (typeof res.header === 'function') {
    res.header(name, value);
  } else {
    if (!res.headers) res.headers = {};
    res.headers[name] = value;
  }
}

/** A request header from a Node-style object or a fetch Headers instance. */
function requestHeader(req, name) {
  const headers = req && req.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  return String(headers[name] || headers[name.toLowerCase()] || '');
}

async function handleAsset(req, res) {
  try {
    const extensionId = String(req.params?.extensionId || '').trim().toLowerCase();
    const version = String(req.params?.version || '').trim();

    if (!extensionId || !version) {
      return res.status(400).json({
        success: false,
        error: 'Invalid asset path',
        code: 'INVALID_ASSET_PATH'
      });
    }

    const segments = [];
    for (let i = 1; i <= MAX_DEPTH; i += 1) {
      const seg = req.params?.[`p${i}`];
      if (seg !== undefined) {
        segments.push(seg);
      }
    }

    if (segments.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid asset path',
        code: 'INVALID_ASSET_PATH'
      });
    }

    for (const seg of segments) {
      if (typeof seg !== 'string' || seg.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid asset path',
          code: 'INVALID_ASSET_PATH'
        });
      }
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        return res.status(400).json({
          success: false,
          error: 'Invalid asset path',
          code: 'INVALID_ASSET_PATH'
        });
      }
      if (
        !decoded ||
        decoded === '.' ||
        decoded === '..' ||
        decoded.includes('..') ||
        decoded.includes('/') ||
        decoded.includes('\\') ||
        decoded.includes('\0')
      ) {
        return res.status(400).json({
          success: false,
          error: 'Invalid asset path',
          code: 'INVALID_ASSET_PATH'
        });
      }
    }

    const path = segments.join('/');
    if (path.startsWith('/') || path.endsWith('/') || path.includes('//')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid asset path',
        code: 'INVALID_ASSET_PATH'
      });
    }

    // Permission check
    const permCheck = requireAnyPermission(ASSET_PERMISSIONS);
    await permCheck(req, res);
    if (res.headersSent || (res.statusCode && res.statusCode >= 400)) {
      return;
    }

    // Built-in extensions have no uploaded files
    if (extensionId === 'product' || extensionId === 'project') {
      return res.status(404).json({
        success: false,
        error: 'Asset not found',
        code: 'ASSET_NOT_FOUND'
      });
    }

    const tenantId = resolveTenantId(req);

    // Files live only in the plugin folder: extensions/<tenant>/<id>/<version>/.
    const CrmExtensionService = require('../services/crm-extension.service');
    const PackageFolder = require('../extension-runtime/package-folder');
    // A page loads ~20 files of one package: the definition is looked up once per 10 s per process.
    const cacheKey = `${tenantId}:${extensionId}`;
    const cached = definitionCache.get(cacheKey);
    let def = cached && Date.now() - cached.at < 10000 ? cached.def : null;
    const fresh = async () => {
      const latest = await CrmExtensionService.getDefinition(req, extensionId);
      if (latest) definitionCache.set(cacheKey, { at: Date.now(), def: latest });
      else definitionCache.delete(cacheKey);
      return latest;
    };
    if (!def) def = await fresh();
    // A package uploaded in the last few seconds: never answer from the old definition.
    else if (String(def.version) !== version || !(def.fileIndex || []).some((f) => f.path === path)) def = await fresh();
    if (!def || def.isInternal !== false) {
      return res.status(404).json({ success: false, error: 'Asset not found', code: 'ASSET_NOT_FOUND' });
    }
    if (String(def.version) !== version) {
      return res.status(404).json({ success: false, error: 'Asset version mismatch', code: 'ASSET_VERSION_MISMATCH' });
    }
    const entry = (def.fileIndex || []).find((f) => f.path === path);
    if (!entry || entry.area !== 'ui') {
      return res.status(404).json({ success: false, error: 'Asset not found', code: 'ASSET_NOT_FOUND' });
    }
    /*
     * Caching: the browser keeps the file but checks it on every load
     * (no-cache + ETag of the file's sha256). An admin can upload a package
     * again with the same version; with "immutable" the browser kept the old
     * files for a year. An unchanged file costs a 304 with no body — checked
     * before the file is read from disk.
     */
    const etag = entry.sha256 ? `"${entry.sha256}"` : '';
    setHeader(res, 'Cache-Control', 'private, no-cache');
    setHeader(res, 'X-Content-Type-Options', 'nosniff');
    if (etag) {
      setHeader(res, 'ETag', etag);
      if (requestHeader(req, 'if-none-match').split(',').map((t) => t.trim().replace(/^W\//, '')).includes(etag)) {
        res.status(304);
        if (typeof res.end === 'function') return res.end();
        return typeof res.send === 'function' ? res.send() : undefined;
      }
    }

    let data = PackageFolder.readFile(tenantId, def, path);
    if (!data && cached) {
      def = await fresh();
      const again = def && (def.fileIndex || []).find((f) => f.path === path);
      if (again) data = PackageFolder.readFile(tenantId, def, path);
    }
    if (!data) {
      return res.status(404).json({
        success: false,
        error: 'Extension files are missing from the plugin folder; upload the package again',
        code: 'EXTENSION_FILES_MISSING'
      });
    }
    const row = { contentType: entry.contentType };

    const buf = data;

    setHeader(res, 'Content-Type', row.contentType || 'application/octet-stream');

    if (path.endsWith('.html') || (row.contentType || '').includes('text/html')) {
      setHeader(
        res,
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'"
      );
    }

    if (typeof res.send === 'function') {
      res.send(buf);
    } else if (typeof res.end === 'function') {
      res.end(buf);
    }
  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to serve asset',
        code: 'ASSET_LOAD_ERROR'
      });
    }
  }
}

module.exports = function registerCrmExtensionAssetsRoutes(app) {
  const permCheck = requireAnyPermission(ASSET_PERMISSIONS);
  for (let depth = 1; depth <= MAX_DEPTH; depth += 1) {
    const pattern = `/x-assets/:extensionId/:version/${Array.from({ length: depth }, (_, i) => `:p${i + 1}`).join('/')}`;
    app.get(pattern, permCheck, handleAsset);
  }
};

module.exports.handleAsset = handleAsset;
module.exports.MAX_DEPTH = MAX_DEPTH;
module.exports.ASSET_PERMISSIONS = ASSET_PERMISSIONS;
module.exports.toBuffer = toBuffer;
