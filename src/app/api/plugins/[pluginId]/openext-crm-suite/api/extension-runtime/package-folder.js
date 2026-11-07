'use strict';

/**
 * On-disk copy of uploaded CRM workspace extensions inside the plugin folder.
 *
 *   openext-crm-suite/extensions/
 *     <tenant>/
 *       active.json                         which extension is enabled (mirror of the active_extension setting)
 *       <extensionId>/<version>/
 *         .package.json                     { extensionId, version, checksum, files: [{ path, sha256, size }] }
 *         crm-extension.json, request-type.json, README.md
 *         json/…  ui/…  api/…               the package files exactly as uploaded
 *
 * The folder is the ONLY place package files are stored. The database keeps
 * just the extension record (CrmExtension: id, version, checksum, per-file
 * sha256 index, trust state) and the active_extension setting.
 *
 * The CMS deletes the plugin folder on every plugin update and on removal.
 * When the folder of the active extension is missing or does not match the
 * recorded hashes, the extension counts as "not found": the workspace falls
 * back to the default extension (crm-extension.service.js) and the admin
 * re-uploads the zip.
 *
 * Reads never throw; writes return { ok, error }.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const os = require('os');

/*
 * Under Node's test runner (NODE_TEST_CONTEXT is set in every test process)
 * packages go to a per-process temp folder so tests never write into the
 * plugin. Production always uses <plugin>/extensions.
 */
const DEFAULT_ROOT = process.env.NODE_TEST_CONTEXT
  ? path.join(os.tmpdir(), `crm-extensions-test-${process.pid}`)
  : path.resolve(__dirname, '..', '..', 'extensions');
let ROOT = DEFAULT_ROOT;

/** Tests point the store at a temp folder; production never calls this. */
function setRoot(dir) {
  ROOT = dir ? path.resolve(dir) : DEFAULT_ROOT;
  verified.clear();
}

function getRoot() {
  return ROOT;
}
const META_FILE = '.package.json';
const ACTIVE_FILE = 'active.json';
const VERIFY_TTL_MS = 60 * 1000;

/** tenant|extension|checksum → { ok, at } */
const verified = new Map();

function safeSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 80) || '_';
}

function tenantDir(tenantId) {
  return path.join(ROOT, safeSegment(tenantId));
}

function extensionDir(tenantId, extensionId) {
  return path.join(tenantDir(tenantId), safeSegment(extensionId));
}

function versionDir(tenantId, extensionId, version) {
  return path.join(extensionDir(tenantId, extensionId), safeSegment(version));
}

/** Resolve a package path inside `base`; null if it would escape. */
function inside(base, relPath) {
  const target = path.resolve(base, String(relPath || '').replace(/\\/g, '/'));
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function log(logger, level, ...args) {
  const target = logger || console;
  (target[level] || target.log || console.log).call(target, '[crm-ext-folder]', ...args);
}

/**
 * Write the package to extensions/<tenant>/<id>/<version>/ atomically.
 * Older versions are removed unless `options.keepOtherVersions` is set (install
 * keeps them until the database record of the new version is saved, then
 * calls pruneOtherVersions).
 * @param {Map<string, Buffer>} files  package files by relative path
 * @returns {{ ok: boolean, dir?: string, error?: string }}
 */
/*
 * Windows: renaming or deleting a folder fails with EPERM / EBUSY / EACCES
 * while another process has a file inside it open — antivirus scanning the
 * new files, the search indexer, or a dev server's file watcher (the plugin
 * folder can live inside the CMS source tree). Such locks last milliseconds
 * to a few seconds, so folder moves retry, and fall back to copy + delete.
 */
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const RM_OPTIONS = Object.freeze({ recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Move a folder into place; survives short-lived file locks on Windows. */
function moveDirSync(from, to) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!error || !LOCK_CODES.has(error.code)) throw error;
      sleepSync(Math.min(100 * 2 ** attempt, 1000));
    }
  }
  // Still locked: copy instead. The copy is complete before the temp folder goes.
  fs.rmSync(to, RM_OPTIONS);
  fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: true });
  removeQuietly(from);
}

/** Best-effort delete; a leftover is cleaned on the next install of this extension. */
function removeQuietly(target) {
  try {
    fs.rmSync(target, RM_OPTIONS);
    return true;
  } catch {
    return false;
  }
}

function writePackage(tenantId, def, files, logger, options = {}) {
  const finalDir = versionDir(tenantId, def.id, def.version);
  const parent = extensionDir(tenantId, def.id);
  const tempDir = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    const index = [];
    for (const [rel, data] of files.entries()) {
      const target = inside(tempDir, rel);
      if (!target) throw new Error(`unsafe path ${rel}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      index.push({ path: rel, sha256: sha256(data), size: data.length });
    }
    fs.writeFileSync(
      path.join(tempDir, META_FILE),
      JSON.stringify(
        { extensionId: def.id, version: def.version, checksum: def.checksum || '', writtenAt: new Date().toISOString(), files: index },
        null,
        2
      )
    );
    fs.rmSync(finalDir, RM_OPTIONS);
    moveDirSync(tempDir, finalDir);
    if (!options.keepOtherVersions) {
      // The new version is in place; an old folder that is still locked must not fail the upload.
      for (const entry of fs.readdirSync(parent)) {
        if (entry !== path.basename(finalDir) && !removeQuietly(path.join(parent, entry))) {
          log(logger, 'warn', `could not remove old folder ${entry} of ${def.id}; it is removed on the next install`);
        }
      }
    }
    forget(tenantId, def.id);
    return { ok: true, dir: finalDir };
  } catch (error) {
    removeQuietly(tempDir);
    log(logger, 'warn', `could not write ${def.id}@${def.version}:`, error.message);
    return { ok: false, error: error.message };
  }
}

/** Delete one version folder (used when recording an install failed). */
function removeVersion(tenantId, extensionId, version, logger) {
  try {
    fs.rmSync(versionDir(tenantId, extensionId, version), RM_OPTIONS);
    forget(tenantId, extensionId);
    return true;
  } catch (error) {
    log(logger, 'warn', `could not remove ${extensionId}@${version}:`, error.message);
    return false;
  }
}

/** Delete every version folder of an extension except `keepVersion` (and stray temp folders). */
function pruneOtherVersions(tenantId, extensionId, keepVersion, logger) {
  const parent = extensionDir(tenantId, extensionId);
  const keep = safeSegment(keepVersion);
  try {
    let clean = true;
    for (const entry of fs.readdirSync(parent)) {
      if (entry !== keep && !removeQuietly(path.join(parent, entry))) clean = false;
    }
    if (!clean) log(logger, 'warn', `could not remove every old folder of ${extensionId}; they are removed on the next install`);
    return true;
  } catch (error) {
    if (error && error.code !== 'ENOENT') log(logger, 'warn', `could not prune ${extensionId}:`, error.message);
    return false;
  }
}

/** Delete every version of an extension for a tenant. */
function removePackage(tenantId, extensionId, logger) {
  try {
    fs.rmSync(extensionDir(tenantId, extensionId), RM_OPTIONS);
    forget(tenantId, extensionId);
    return true;
  } catch (error) {
    log(logger, 'warn', `could not remove ${extensionId}:`, error.message);
    return false;
  }
}

/**
 * Check the folder copy against the definition's recorded file hashes.
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyPackage(tenantId, def) {
  const key = `${tenantId}|${def.id}|${def.checksum || ''}`;
  const hit = verified.get(key);
  if (hit && hit.ok && Date.now() - hit.at < VERIFY_TTL_MS) return { ok: true };

  const dir = versionDir(tenantId, def.id, def.version);
  const result = (() => {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8'));
    } catch {
      return { ok: false, reason: 'folder missing' };
    }
    if (meta.version !== def.version || (def.checksum && meta.checksum !== def.checksum)) {
      return { ok: false, reason: 'folder holds a different upload' };
    }
    for (const entry of def.fileIndex || []) {
      const target = inside(dir, entry.path);
      if (!target) return { ok: false, reason: `unsafe path ${entry.path}` };
      let data;
      try {
        data = fs.readFileSync(target);
      } catch {
        return { ok: false, reason: `${entry.path} missing` };
      }
      if (entry.sha256 && sha256(data) !== entry.sha256) return { ok: false, reason: `${entry.path} changed on disk` };
    }
    return { ok: true };
  })();
  verified.set(key, { ok: result.ok, at: Date.now() });
  return result;
}

/** Read files of one area (e.g. "api") from a verified folder copy; null if unavailable. */
function readArea(tenantId, def, area) {
  if (!verifyPackage(tenantId, def).ok) return null;
  const dir = versionDir(tenantId, def.id, def.version);
  const files = new Map();
  for (const entry of def.fileIndex || []) {
    if (entry.area !== area) continue;
    const target = inside(dir, entry.path);
    if (!target) return null;
    try {
      const data = fs.readFileSync(target);
      if (entry.sha256 && sha256(data) !== entry.sha256) return null;
      files.set(entry.path, data);
    } catch {
      return null;
    }
  }
  return files;
}

/**
 * True when the extension's files are usable: built-ins, and uploads recorded
 * without a file index (manifestVersion 1 packages from before 3.6.0) are
 * always available; everything else needs a verified folder.
 */
function isAvailable(tenantId, def) {
  if (!def || def.isInternal !== false) return true;
  if (!Array.isArray(def.fileIndex) || !def.fileIndex.length) return true;
  return verifyPackage(tenantId, def).ok;
}

/** One verified file from the folder copy; null when missing or changed. */
function readFile(tenantId, def, relPath) {
  const entry = (def.fileIndex || []).find((f) => f.path === relPath);
  if (!entry) return null;
  const target = inside(versionDir(tenantId, def.id, def.version), relPath);
  if (!target) return null;
  try {
    const data = fs.readFileSync(target);
    if (entry.sha256 && sha256(data) !== entry.sha256) return null;
    return data;
  } catch {
    return null;
  }
}

/** Record which extension is enabled for the tenant (human-readable mirror of the setting). */
function writeActive(tenantId, def, logger) {
  try {
    fs.mkdirSync(tenantDir(tenantId), { recursive: true });
    fs.writeFileSync(
      path.join(tenantDir(tenantId), ACTIVE_FILE),
      JSON.stringify(
        {
          activeExtensionId: def.id,
          name: def.name,
          version: def.version || '',
          source: def.isInternal === false ? 'uploaded' : 'builtin',
          checksum: def.checksum || '',
          updatedAt: new Date().toISOString()
        },
        null,
        2
      )
    );
    return true;
  } catch (error) {
    log(logger, 'warn', 'could not write active.json:', error.message);
    return false;
  }
}

function readActive(tenantId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tenantDir(tenantId), ACTIVE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

function forget(tenantId, extensionId) {
  const prefix = `${tenantId}|${extensionId}|`;
  for (const key of verified.keys()) if (key.startsWith(prefix)) verified.delete(key);
}

module.exports = {
  setRoot,
  getRoot,
  isAvailable,
  readFile,
  META_FILE,
  ACTIVE_FILE,
  tenantDir,
  extensionDir,
  versionDir,
  writePackage,
  removeVersion,
  pruneOtherVersions,
  removePackage,
  verifyPackage,
  readArea,
  writeActive,
  readActive,
  forget,
  _verified: verified
};
