'use strict';

const fs = require('fs');
const path = require('path');

const PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/rtf',
  'text/rtf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

const LIMITS = {
  photo: 5 * 1024 * 1024,
  document: 20 * 1024 * 1024
};

const ZIP_LIKE_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getS3Config() {
  const bucket = String(process.env.CRM_S3_BUCKET || process.env.AWS_S3_BUCKET || '').trim();
  const region = String(process.env.CRM_S3_REGION || process.env.AWS_REGION || 'us-east-1').trim();
  const accessKeyId = String(process.env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(process.env.AWS_SECRET_ACCESS_KEY || '').trim();
  const publicBaseUrl = String(process.env.CRM_S3_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  const prefix = String(process.env.CRM_S3_PREFIX || 'crm').trim().replace(/^\/+|\/+$/g, '');

  return { bucket, region, accessKeyId, secretAccessKey, publicBaseUrl, prefix };
}

function isS3Configured() {
  const cfg = getS3Config();
  return Boolean(cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
}

function loadS3Module() {
  try {
    return require('@aws-sdk/client-s3');
  } catch {
    return null;
  }
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'file'));
  return base.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 180) || 'file';
}

function sanitizePathSegment(value, fallback = 'default') {
  const segment = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return segment || fallback;
}

function buildObjectKey({ tenantId, leadId, category, fileName }) {
  const cfg = getS3Config();
  const safeName = `${Date.now()}-${sanitizeFileName(fileName)}`;
  const safeTenantId = sanitizePathSegment(tenantId);
  const safeLeadId = sanitizePathSegment(leadId, 'lead');
  const safeCategory = sanitizePathSegment(category, 'document');
  return `${cfg.prefix}/${safeTenantId}/leads/${safeLeadId}/${safeCategory}/${safeName}`;
}

function buildPublicUrl(storageKey, provider) {
  if (provider === 's3') {
    const cfg = getS3Config();
    if (cfg.publicBaseUrl) return `${cfg.publicBaseUrl}/${storageKey}`;
    return `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${storageKey}`;
  }
  return storageKey.startsWith('/') ? storageKey : `/${storageKey}`;
}

const CRM_PLUGIN_ID = 'openext-crm-suite';

/**
 * Browser-reachable URL for CRM-stored files. Files stored through the S3 Media plugin API open through
 * its own route (/api/plugins/s3_media_plugin/media/:encodedKey/file); older files stream via the CRM's
 * GET /media/file. Both work with the session cookie in <img> and downloads.
 */
function buildCrmMediaFileUrl(storageKey, provider = 'local') {
  const key = String(storageKey || '').trim();
  if (!key) return '';
  // Stored through the S3 Media plugin's API: opened through its own file route.
  if (provider === 's3_media_api') return require('./s3-media-api.util').fileUrl(key);
  const params = new URLSearchParams();
  params.set('key', key);
  if (provider) params.set('provider', String(provider));
  return `/api/plugins/${CRM_PLUGIN_ID}/media/file?${params.toString()}`;
}

function isSafeStorageKey(key) {
  const value = String(key || '').trim();
  if (!value || value.includes('..') || value.includes('\\') || value.includes('\0')) return false;
  if (value.startsWith('/upload/crm/')) return true;
  // S3 object keys used by CRM uploads (no scheme, not absolute path)
  if (!value.startsWith('/') && !/^https?:\/\//i.test(value) && value.length < 1024) {
    return true;
  }
  return false;
}

/**
 * Stores an upload in the S3 Media plugin's bucket (the only place files are kept; never this server's
 * disk). Without the plugin set up the upload fails with STORAGE_NOT_CONFIGURED.
 */
async function storeOnS3Plugin(req, keyTail, buffer, mimeType) {
  const PrivateS3 = require('./private-s3.util');
  const target = await PrivateS3.requireWriteTarget(req);
  // The key the file really has (the S3 Media plugin's API makes its own) and how it was stored.
  const wanted = `${target.prefix}/${keyTail}`;
  const stored = (await PrivateS3.putObject(target, wanted, buffer, mimeType)) || { key: wanted, provider: target.provider };
  return {
    provider: stored.provider,
    storageKey: stored.key,
    fileUrl: buildCrmMediaFileUrl(stored.key, stored.provider)
  };
}

async function uploadToS3({ storageKey, buffer, mimeType }) {
  const s3 = loadS3Module();
  if (!s3) {
    throw appError(
      'S3 is configured but @aws-sdk/client-s3 is not installed. Run: npm install @aws-sdk/client-s3',
      500
    );
  }

  const cfg = getS3Config();
  const client = new s3.S3Client({
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey
    }
  });

  await client.send(
    new s3.PutObjectCommand({
      Bucket: cfg.bucket,
      Key: storageKey,
      Body: buffer,
      ContentType: mimeType || 'application/octet-stream'
    })
  );

  return {
    provider: 's3',
    storageKey,
    fileUrl: buildCrmMediaFileUrl(storageKey, 's3'),
    s3Url: buildPublicUrl(storageKey, 's3')
  };
}

async function deleteStoredFile(provider, storageKey, req = null) {
  if (!storageKey) return;

  if (provider === 's3_media' || provider === 's3_media_api') {
    try {
      const PrivateS3 = require('./private-s3.util');
      const cfg = await PrivateS3.configFor(req, provider);
      if (cfg) await PrivateS3.deleteObject(cfg, storageKey);
    } catch {
      /* best effort */
    }
    return;
  }

  if (provider === 's3' && isS3Configured()) {
    const s3 = loadS3Module();
    if (!s3) return;
    const cfg = getS3Config();
    const client = new s3.S3Client({
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey
      }
    });
    try {
      await client.send(new s3.DeleteObjectCommand({ Bucket: cfg.bucket, Key: storageKey }));
    } catch {
      /* best effort */
    }
    return;
  }

  if (provider === 'local' && storageKey.startsWith('/upload/')) {
    const absolutePath = path.join(process.cwd(), 'public', storageKey.replace(/^\/upload\//, 'upload/'));
    try {
      if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Read a previously stored file into a Buffer for authenticated plugin downloads.
 * Supports local /upload paths and S3 object keys.
 */
async function readStoredFile(provider, storageKey, fileUrl = '', req = null) {
  const key = String(storageKey || '').trim();
  const url = String(fileUrl || '').trim();
  const resolvedProvider = String(provider || '').trim().toLowerCase() || (key.startsWith('/upload/') ? 'local' : '');

  if ((resolvedProvider === 's3_media' || resolvedProvider === 's3_media_api') && key) {
    const PrivateS3 = require('./private-s3.util');
    const cfg = await PrivateS3.configFor(req, resolvedProvider);
    if (!cfg) throw appError('The S3 Media plugin holding this file is not configured', 503);
    return {
      buffer: await PrivateS3.getObject(cfg, key),
      mimeType: guessMimeFromFileName(key) || 'application/octet-stream'
    };
  }

  if ((resolvedProvider === 's3' || (!resolvedProvider && isS3Configured() && key && !key.startsWith('/'))) && key) {
    if (!isS3Configured()) {
      throw appError('S3 storage is not configured on this server', 500);
    }
    const s3 = loadS3Module();
    if (!s3) {
      throw appError('S3 SDK is not installed on this server', 500);
    }
    const cfg = getS3Config();
    const client = new s3.S3Client({
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey
      }
    });
    const response = await client.send(
      new s3.GetObjectCommand({
        Bucket: cfg.bucket,
        Key: key
      })
    );
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return {
      buffer: Buffer.concat(chunks),
      mimeType: response.ContentType || guessMimeFromFileName(key) || 'application/octet-stream'
    };
  }

  const localPathCandidate = key.startsWith('/upload/')
    ? key
    : url.startsWith('/upload/')
      ? url
      : '';
  if (localPathCandidate) {
    const absolutePath = path.join(
      process.cwd(),
      'public',
      localPathCandidate.replace(/^\/upload\//, 'upload/')
    );
    if (!fs.existsSync(absolutePath)) {
      throw appError('Stored file is missing on disk', 404);
    }
    return {
      buffer: fs.readFileSync(absolutePath),
      mimeType: guessMimeFromFileName(localPathCandidate) || 'application/octet-stream'
    };
  }

  if (/^https?:\/\//i.test(url)) {
    return { redirectUrl: url };
  }

  throw appError('No downloadable file location found for this document', 404);
}

/**
 * Extract uploaded file from plugin multipart req.body (Next.js File object).
 */
async function readUploadFile(req, fieldName = 'file') {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const file = body[fieldName] || body.photo || body.document;
  if (!file) return null;

  if (typeof file.arrayBuffer === 'function') {
    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = file.name || 'upload';
    const rawMime = String(file.type || '').trim().toLowerCase();
    const mimeType =
      rawMime && rawMime !== 'application/octet-stream'
        ? rawMime
        : guessMimeFromFileName(fileName);
    return {
      buffer,
      fileName,
      mimeType,
      size: buffer.length
    };
  }

  return null;
}

function guessMimeFromFileName(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.rtf': 'application/rtf',
    '.zip': 'application/zip',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  };
  return map[ext] || 'application/octet-stream';
}

function startsWithBytes(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte);
}

function hasExpectedFileSignature(mimeType, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;

  switch (mimeType) {
    case 'image/jpeg':
      return startsWithBytes(buffer, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/gif': {
      const header = buffer.subarray(0, 6).toString('ascii');
      return header === 'GIF87a' || header === 'GIF89a';
    }
    case 'image/webp':
      return buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'application/pdf':
      return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    case 'application/msword':
    case 'application/vnd.ms-excel':
      return startsWithBytes(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    case 'application/zip':
    case 'application/x-zip-compressed':
      return startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
        startsWithBytes(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
        startsWithBytes(buffer, [0x50, 0x4b, 0x07, 0x08]);
    case 'application/vnd.ms-powerpoint':
      return startsWithBytes(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case 'text/plain':
    case 'text/csv':
    case 'text/markdown':
    case 'application/rtf':
    case 'text/rtf':
      return !buffer.includes(0x00);
    default:
      return false;
  }
}

function resolveMimeType(fileName, declaredMime) {
  const raw = String(declaredMime || '').trim().toLowerCase();
  const guessed = guessMimeFromFileName(fileName);
  if (!raw || raw === 'application/octet-stream' || raw === 'binary/octet-stream') {
    return guessed;
  }
  return raw;
}

function assertAllowedUpload(category, mimeType, size, buffer, fileName = '') {
  const limit = LIMITS[category] || LIMITS.document;
  if (size > limit) {
    throw appError(`File must be smaller than ${Math.round(limit / (1024 * 1024))}MB`, 400);
  }

  let effectiveMime = resolveMimeType(fileName, mimeType);
  const allowed = category === 'photo' ? PHOTO_MIME_TYPES : DOCUMENT_MIME_TYPES;

  if (!allowed.has(effectiveMime)) {
    const guessed = guessMimeFromFileName(fileName);
    if (allowed.has(guessed)) effectiveMime = guessed;
  }

  if (!allowed.has(effectiveMime)) {
    throw appError(
      category === 'photo'
        ? 'Photo must be JPG, PNG, WEBP, or GIF'
        : 'Document type not allowed (PDF, Word, Excel, PowerPoint, ZIP, text, CSV, Markdown, RTF, or image)',
      400
    );
  }

  if (!hasExpectedFileSignature(effectiveMime, buffer)) {
    const zipLike =
      ZIP_LIKE_MIME_TYPES.has(effectiveMime) &&
      (startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
        startsWithBytes(buffer, [0x50, 0x4b, 0x05, 0x06]));
    const textLike =
      (effectiveMime.startsWith('text/') ||
        effectiveMime === 'application/rtf' ||
        effectiveMime === 'text/rtf') &&
      !buffer.includes(0x00);
    if (!zipLike && !textLike) {
      throw appError('File content does not match its declared type', 400);
    }
  }

  return effectiveMime;
}

async function uploadLeadFile({ req, tenantId, leadId, category, fileName, mimeType, buffer, size }) {
  const effectiveMime = assertAllowedUpload(category, mimeType, size, buffer, fileName);
  const safeName = `${Date.now()}-${sanitizeFileName(fileName)}`;
  const keyTail =
    `${sanitizePathSegment(tenantId)}/leads/${sanitizePathSegment(leadId, 'lead')}/` +
    `${sanitizePathSegment(category, 'document')}/${safeName}`;
  return storeOnS3Plugin(req, keyTail, buffer, effectiveMime);
}

/**
 * Generic CRM media upload (avatars, receipts, attachments).
 * Paths: /upload/crm/{tenant}/{entityType}/{entityId}/{category}/{file}
 */
async function uploadCrmFile({
  req,
  tenantId,
  entityType = 'general',
  entityId = 'shared',
  category = 'document',
  fileName,
  mimeType,
  buffer,
  size,
  skipSignature = false
}) {
  const effectiveCategory =
    category === 'photo' || String(mimeType || '').startsWith('image/')
      ? 'photo'
      : String(guessMimeFromFileName(fileName) || '').startsWith('image/')
        ? 'photo'
        : 'document';

  const effectiveMime = skipSignature
    ? resolveMimeType(fileName, mimeType)
    : assertAllowedUpload(effectiveCategory, mimeType, size, buffer, fileName);

  if (skipSignature) {
    const limit = LIMITS[effectiveCategory] || LIMITS.document;
    if (size > limit) {
      throw appError(`File must be smaller than ${Math.round(limit / (1024 * 1024))}MB`, 400);
    }
    const allowed =
      effectiveCategory === 'photo' ? PHOTO_MIME_TYPES : DOCUMENT_MIME_TYPES;
    if (!allowed.has(effectiveMime)) {
      throw appError(
        effectiveCategory === 'photo'
          ? 'Photo must be JPG, PNG, WEBP, or GIF'
          : 'Document type not allowed (PDF, Word, Excel, PowerPoint, ZIP, text, CSV, Markdown, RTF, or image)',
        400
      );
    }
  }

  const safeEntityType = sanitizePathSegment(entityType, 'general');
  const safeEntityId = sanitizePathSegment(entityId, 'shared');
  const safeName = `${Date.now()}-${sanitizeFileName(fileName)}`;
  const safeTenantId = sanitizePathSegment(tenantId);
  const safeCategory = sanitizePathSegment(effectiveCategory, 'document');
  const stored = await storeOnS3Plugin(
    req,
    `${safeTenantId}/${safeEntityType}/${safeEntityId}/${safeCategory}/${safeName}`,
    buffer,
    effectiveMime
  );
  return { ...stored, source: stored.provider, mimeType: effectiveMime };
}

function getStorageStatus() {
  let sdkInstalled = false;
  try {
    require.resolve('@aws-sdk/client-s3');
    sdkInstalled = true;
  } catch {
    sdkInstalled = false;
  }

  // New files go to the S3 Media plugin only (see storageStatus(req) for whether it is set up).
  return {
    s3Configured: isS3Configured(),
    s3SdkInstalled: sdkInstalled,
    storageMode: 's3_media'
  };
}

/** Whether uploads can be stored: the S3 Media plugin set up and the S3 SDK installed. No keys returned. */
async function storageStatus(req) {
  const base = getStorageStatus();
  const PrivateS3 = require('./private-s3.util');
  const target = await PrivateS3.resolveWriteTarget(req).catch(() => null);
  return {
    ...base,
    s3Configured: Boolean(target),
    storageMode: target && base.s3SdkInstalled ? 's3_media' : 'none',
    bucket: target ? target.bucket : '',
    message: target
      ? 'Files are stored on S3 through the S3 Media plugin.'
      : 'Uploads are disabled until the S3 Media plugin is configured: files are never stored on this server.'
  };
}

module.exports = {
  PHOTO_MIME_TYPES,
  DOCUMENT_MIME_TYPES,
  LIMITS,
  isS3Configured,
  getS3Config,
  readUploadFile,
  uploadLeadFile,
  uploadCrmFile,
  storageStatus,
  deleteStoredFile,
  uploadToS3,
  readStoredFile,
  sanitizeFileName,
  sanitizePathSegment,
  hasExpectedFileSignature,
  buildPublicUrl,
  buildCrmMediaFileUrl,
  isSafeStorageKey,
  getStorageStatus
};
