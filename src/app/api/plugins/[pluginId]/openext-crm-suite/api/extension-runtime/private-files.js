'use strict';

/**
 * Private files an extension keeps (sdk.files) — e.g. ID document images.
 *
 * Storage (utils/private-s3.util): only the S3 Media plugin's bucket — through its storage provider
 * (plugin 1.7.0+), else its saved settings — in folder CRM_S3_PRIVATE_PREFIX (default "crm-private"),
 * under <prefix>/<tenant>/extensions/<extension>/<recordType>/<recordId>/. Without the plugin set up a
 * save fails (STORAGE_NOT_CONFIGURED); nothing new is written to this server's disk. Files a private
 * server folder held before (CRM_PRIVATE_FILES_DIR) can still be read.
 *
 * Every file is encrypted before it leaves the CRM (data-protection.js), so
 * the stored object is useless without the CRM's key, and is only ever read
 * back through the extension's own permission-checked routes.
 *
 * File facts live in the extension's CRM-owned table:
 *   model        X_<extensionId>__Files
 *   collection   plugin_openext_crm_suite_x_<extensionId>__files
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Storage = require('../utils/storage.util');
const PrivateS3 = require('../utils/private-s3.util');
const { getMongooseModel, safeId } = require('./models');
const { encryptBytes, decryptBytes } = require('./data-protection');
const { runtimeError, OBJECT_ID_RE } = require('./values');

const MODEL_DEF = Object.freeze({
  name: '_Files',
  fields: Object.freeze([
    Object.freeze({ key: 'recordType', type: 'text', index: true }),
    Object.freeze({ key: 'recordId', type: 'text', index: true }),
    Object.freeze({ key: 'name', type: 'text' }),
    Object.freeze({ key: 'mimeType', type: 'text' }),
    Object.freeze({ key: 'size', type: 'number' }),
    Object.freeze({ key: 'sha256', type: 'text' }),
    Object.freeze({ key: 'provider', type: 'text' }),
    Object.freeze({ key: 'storageKey', type: 'text' })
  ])
});

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_BYTES = 5 * 1024 * 1024;
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,60}$/;

function privateRoot() {
  return path.resolve(process.env.CRM_PRIVATE_FILES_DIR || path.join(process.cwd(), 'storage', 'crm-private-files'));
}

function localPath(storageKey) {
  const root = privateRoot();
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(root + path.sep)) throw runtimeError(500, 'Invalid private file location', 'FILE_CORRUPT');
  return full;
}

/** "data:image/png;base64,…" or plain base64 → { buffer, mimeType } */
function decodeInput(input) {
  const raw = String((input && input.data) || '').trim();
  let mimeType = String((input && input.mimeType) || '').trim().toLowerCase();
  let base64 = raw;
  const match = raw.match(/^data:([a-z0-9.+/-]+);base64,(.*)$/is);
  if (match) {
    mimeType = mimeType || match[1].toLowerCase();
    base64 = match[2];
  }
  base64 = base64.replace(/\s+/g, '');
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) throw runtimeError(400, 'files.save: data must be base64 or a data URL', 'INVALID_FILE');
  if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
  if (!ALLOWED_TYPES.has(mimeType)) throw runtimeError(400, 'files.save: only JPG, PNG, WEBP or PDF files are allowed', 'INVALID_FILE_TYPE');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw runtimeError(400, 'files.save: the file is empty', 'INVALID_FILE');
  if (buffer.length > MAX_BYTES) throw runtimeError(413, 'files.save: the file is larger than 5 MB', 'FILE_TOO_LARGE');
  if (!Storage.hasExpectedFileSignature(mimeType, buffer)) {
    throw runtimeError(400, `files.save: the file content is not a valid ${mimeType}`, 'INVALID_FILE');
  }
  return { buffer, mimeType };
}

async function lean(query) {
  return query && typeof query.lean === 'function' ? query.lean() : query;
}

function present(row) {
  return {
    id: String(row._id),
    name: row.name || '',
    mimeType: row.mimeType || '',
    size: Number(row.size) || 0,
    recordType: row.recordType || '',
    recordId: row.recordId || '',
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null
  };
}

/** Writes the (encrypted) bytes to the S3 Media plugin's bucket; never to this server's disk. */
async function writeBytes(target, storageKey, bytes) {
  // { key, provider }: through the plugin's HTTP API the plugin makes the key.
  const stored = await PrivateS3.putObject(target, storageKey, bytes);
  return stored && stored.key ? stored : { key: storageKey, provider: target.provider };
}

function isS3Provider(provider) {
  return provider === 's3' || provider === 's3_media' || provider === 's3_media_api';
}

async function readBytes(req, row) {
  if (isS3Provider(row.provider)) {
    // Read from the S3 the file was written to (server env vars, or the S3 Media plugin's settings).
    const cfg = await PrivateS3.configFor(req, row.provider);
    if (!cfg) throw runtimeError(503, 'The S3 storage holding this file is not configured any more', 'STORAGE_UNAVAILABLE');
    return PrivateS3.getObject(cfg, row.storageKey);
  }
  const full = localPath(row.storageKey);
  if (!fs.existsSync(full)) throw runtimeError(404, 'The stored file is missing', 'FILE_MISSING');
  return fs.readFileSync(full);
}

async function removeBytes(req, row) {
  try {
    if (isS3Provider(row.provider)) {
      const cfg = await PrivateS3.configFor(req, row.provider);
      if (cfg) await PrivateS3.deleteObject(cfg, row.storageKey);
    } else fs.rmSync(localPath(row.storageKey), { force: true });
  } catch {
    /* best effort; the row is gone and the bytes are encrypted */
  }
}

/** The sdk.files object for one request. */
function createFilesApi(req, def, { tenantId, userId }) {
  const extensionId = def.id;
  const scope = () => ({ tenantId, extensionId, isDeleted: false });
  const model = () => getMongooseModel(req, extensionId, MODEL_DEF);
  const findRow = async (id) => {
    if (!OBJECT_ID_RE.test(String(id || ''))) return null;
    const Model = await model();
    return lean(Model.findOne({ _id: String(id), ...scope() }));
  };

  return Object.freeze({
    /**
     * @param {{ data: string, mimeType?: string, name?: string, recordType: string, recordId: string }} input
     * @returns {{ id, name, mimeType, size, recordType, recordId, createdAt }}
     */
    async save(input = {}) {
      const recordType = String(input.recordType || '');
      const recordId = String(input.recordId || '');
      if (!SEGMENT_RE.test(recordType) || !SEGMENT_RE.test(recordId)) {
        throw runtimeError(400, 'files.save: recordType and recordId are required (letters, digits, "-" or "_")', 'INVALID_FILE');
      }
      const { buffer, mimeType } = decodeInput(input);
      const name = Storage.sanitizeFileName(input.name || `file.${mimeType.split('/')[1]}`);
      // The S3 Media plugin only: without it the upload fails, nothing is kept on this server.
      const target = await PrivateS3.requireWriteTarget(req);
      const prefix = `${target.prefix}/`;
      const storageKey =
        `${prefix}${Storage.sanitizePathSegment(tenantId)}/extensions/${safeId(extensionId)}/` +
        `${recordType}/${recordId}/${crypto.randomUUID()}.bin`;

      const stored = await writeBytes(target, storageKey, encryptBytes(tenantId, extensionId, buffer));
      const Model = await model();
      const created = await Model.create({
        ...scope(),
        recordType,
        recordId,
        name,
        mimeType,
        size: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        provider: stored.provider,
        storageKey: stored.key,
        createdBy: userId,
        updatedBy: userId
      });
      return present(typeof created?.toObject === 'function' ? created.toObject() : created);
    },

    /** File facts without the content, or null. */
    async info(id) {
      const row = await findRow(id);
      return row ? present(row) : null;
    },

    /** File facts plus `dataUrl` (decrypted content), or null. */
    async read(id) {
      const row = await findRow(id);
      if (!row) return null;
      const plain = decryptBytes(tenantId, extensionId, await readBytes(req, row));
      return { ...present(row), dataUrl: `data:${row.mimeType};base64,${plain.toString('base64')}` };
    },

    /** Delete the stored bytes and the row. */
    async remove(id) {
      const row = await findRow(id);
      if (!row) return false;
      await removeBytes(req, row);
      const Model = await model();
      await Model.deleteOne({ _id: row._id, ...scope() });
      return true;
    }
  });
}

module.exports = { MODEL_DEF, ALLOWED_TYPES, MAX_BYTES, privateRoot, decodeInput, createFilesApi };
