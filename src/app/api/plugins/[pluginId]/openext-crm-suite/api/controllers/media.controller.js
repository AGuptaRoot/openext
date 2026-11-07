'use strict';

const StorageUtil = require('../utils/storage.util');
const { resolveTenantId } = require('../utils/tenant.util');

function sendError(res, error) {
  const status = error.status || 500;
  res.status(status).json({
    success: false,
    error: error.message || 'Upload failed'
  });
}

/**
 * POST /media/upload
 * Multipart field: file
 * Optional fields: folder (clients|leads|expenses|…), entityId
 */
async function upload(req, res) {
  try {
    const uploadFile = await StorageUtil.readUploadFile(req, 'file');
    if (!uploadFile) {
      const err = new Error('File is required (field name: file)');
      err.status = 400;
      throw err;
    }

    const tenantId = resolveTenantId(req);
    const folder = String(req.body?.folder || req.query?.folder || 'general')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 40) || 'general';
    const entityId = String(req.body?.entityId || req.query?.entityId || 'shared')
      .trim()
      .slice(0, 120) || 'shared';

    const category = String(uploadFile.mimeType || '').startsWith('image/')
      ? 'photo'
      : 'document';

    const stored = await StorageUtil.uploadCrmFile({
      req,
      tenantId,
      entityType: folder,
      entityId,
      category,
      fileName: uploadFile.fileName,
      mimeType: uploadFile.mimeType,
      buffer: uploadFile.buffer,
      size: uploadFile.size
    });

    // Prefer durable CRM /media/file URL (works for local + private S3)
    const browserUrl =
      stored.fileUrl ||
      StorageUtil.buildCrmMediaFileUrl(stored.storageKey, stored.provider || 'local');

    res.status(201).json({
      success: true,
      data: {
        url: browserUrl,
        fileUrl: browserUrl,
        storageKey: stored.storageKey,
        provider: stored.provider,
        source: stored.source || stored.provider,
        fileName: StorageUtil.sanitizeFileName(uploadFile.fileName),
        originalName: uploadFile.fileName,
        mimeType: uploadFile.mimeType,
        fileSize: uploadFile.size
      },
      message: 'File uploaded to S3 storage'
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * GET /media/file?key=...&provider=local|s3
 * Authenticated stream for avatars and other CRM media (browser <img> / download).
 */
async function serveFile(req, res) {
  try {
    const key = String(req.query.key || req.query.storageKey || '').trim();
    const provider = String(req.query.provider || '').trim().toLowerCase();

    if (!key) {
      const err = new Error('Missing media key');
      err.status = 400;
      throw err;
    }
    if (!StorageUtil.isSafeStorageKey(key)) {
      const err = new Error('Invalid media key');
      err.status = 400;
      throw err;
    }

    const stored = await StorageUtil.readStoredFile(
      provider || (key.startsWith('/upload/') ? 'local' : 's3'),
      key,
      key,
      req
    );

    if (stored.redirectUrl) {
      res.redirect(302, stored.redirectUrl);
      return;
    }

    res.setHeader('Content-Type', stored.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(stored.buffer);
  } catch (error) {
    sendError(res, error);
  }
}

async function storageStatus(req, res) {
  try {
    const data = await StorageUtil.storageStatus(req);
    res.json({ success: true, data, message: 'Storage status loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  upload,
  serveFile,
  storageStatus
};
