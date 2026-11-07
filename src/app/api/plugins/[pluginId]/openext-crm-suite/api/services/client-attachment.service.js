'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');
const ClientService = require('./client.service');
const StorageUtil = require('../utils/storage.util');
const { CLIENT_ATTACHMENT_CATEGORIES } = require('../models/ClientAttachment');

function getAttachmentModel(req) {
  const ClientAttachment = req.cms?.models.get('ClientAttachment');
  if (!ClientAttachment) throw new Error('ClientAttachment model is not registered');
  return ClientAttachment;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

async function listAttachments(req, clientId, category = '') {
  await ClientService.getById(req, clientId);
  const ClientAttachment = getAttachmentModel(req);
  const filter = { ...baseFilter(req), clientId: String(clientId) };
  if (category && category !== 'All') {
    filter.category = category;
  }
  return ClientAttachment.find(filter)
    .sort({ createdAt: -1 })
    .lean();
}

async function uploadAttachment(req, clientId) {
  const client = await ClientService.getById(req, clientId);
  const upload = await StorageUtil.readUploadFile(req, 'file');
  if (!upload) throw appError('Document file is required (field name: file)');

  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const user = req.user || {};
  const userName = user.displayName || user.name || user.username || user.email || 'Team Member';

  const category = req.body?.category && CLIENT_ATTACHMENT_CATEGORIES.includes(req.body.category)
    ? req.body.category
    : 'General';
  const description = String(req.body?.description || '').slice(0, 1000);

  const stored = await StorageUtil.uploadLeadFile({
    req,
    tenantId,
    leadId: `client_${clientId}`,
    category: 'document',
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    buffer: upload.buffer,
    size: upload.size
  });

  const ClientAttachment = getAttachmentModel(req);
  let doc;
  try {
    doc = await ClientAttachment.create({
      tenantId,
      clientId: String(clientId),
      fileName: StorageUtil.sanitizeFileName(upload.fileName),
      originalName: String(upload.fileName || '').slice(0, 255),
      mimeType: upload.mimeType,
      fileSize: upload.size,
      fileUrl: stored.fileUrl,
      storageProvider: stored.provider,
      storageKey: stored.storageKey,
      category,
      description,
      uploadedBy: userId,
      uploadedByName: userName,
      createdBy: userId,
      updatedBy: userId
    });
  } catch (error) {
    await StorageUtil.deleteStoredFile(stored.provider, stored.storageKey, req);
    throw error;
  }

  const result = doc.toObject();
  await AuditService.log(req, {
    action: 'client_document_uploaded',
    module: 'client',
    recordId: String(clientId),
    description: `Client document uploaded: ${upload.fileName} (${category})`,
    metadata: { clientId: String(clientId), attachmentId: result._id.toString(), fileUrl: stored.fileUrl }
  });

  return result;
}

async function createRecord(req, clientId, input = {}) {
  await ClientService.getById(req, clientId);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const user = req.user || {};
  const userName = user.displayName || user.name || user.username || user.email || 'Team Member';

  const fileName = String(input.fileName || input.name || '').trim();
  const fileUrl = String(input.fileUrl || input.url || '').trim();
  if (!fileName) throw appError('File name is required', 422);
  if (!fileUrl) throw appError('File URL is required', 422);

  const category = input.category && CLIENT_ATTACHMENT_CATEGORIES.includes(input.category)
    ? input.category
    : 'General';

  let normalizedUrl = fileUrl;
  if (!/^https?:\/\//i.test(normalizedUrl) && !normalizedUrl.startsWith('/')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  const ClientAttachment = getAttachmentModel(req);
  const doc = await ClientAttachment.create({
    tenantId,
    clientId: String(clientId),
    fileName,
    originalName: fileName,
    mimeType: input.mimeType || 'text/uri-list',
    fileSize: Number(input.fileSize) || 0,
    fileUrl: normalizedUrl,
    storageProvider: 'url',
    storageKey: '',
    category,
    description: String(input.description || '').slice(0, 1000),
    uploadedBy: userId,
    uploadedByName: userName,
    createdBy: userId,
    updatedBy: userId
  });

  const result = doc.toObject();
  await AuditService.log(req, {
    action: 'client_document_linked',
    module: 'client',
    recordId: String(clientId),
    description: `Client document linked: ${fileName} (${category})`,
    metadata: { clientId: String(clientId), attachmentId: result._id.toString(), fileUrl }
  });

  return result;
}

async function removeAttachment(req, clientId, attachmentId) {
  await ClientService.getById(req, clientId);
  const ClientAttachment = getAttachmentModel(req);
  const userId = resolveUserId(req);

  const existing = await ClientAttachment.findOne({
    ...baseFilter(req),
    _id: attachmentId,
    clientId: String(clientId)
  }).lean();

  if (!existing) throw appError('Document attachment not found', 404);

  await ClientAttachment.findOneAndUpdate(
    { ...baseFilter(req), _id: attachmentId },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        updatedBy: userId
      }
    }
  );

  await AuditService.log(req, {
    action: 'client_document_deleted',
    module: 'client',
    recordId: String(clientId),
    description: `Client document removed: ${existing.fileName}`,
    metadata: { clientId: String(clientId), attachmentId: String(attachmentId) }
  });

  return { success: true, message: 'Document removed' };
}

/**
 * Stream / redirect a client document for authenticated download.
 * Avoids relying on public /upload or s3-media-plugin URLs from the browser.
 */
async function downloadAttachment(req, clientId, attachmentId) {
  await ClientService.getById(req, clientId);
  const ClientAttachment = getAttachmentModel(req);

  const existing = await ClientAttachment.findOne({
    ...baseFilter(req),
    _id: attachmentId,
    clientId: String(clientId)
  }).lean();

  if (!existing) throw appError('Document attachment not found', 404);

  const fileName = existing.originalName || existing.fileName || 'document';
  const mimeType = existing.mimeType || 'application/octet-stream';

  // Linked external URL (no uploaded binary)
  if (
    (!existing.storageKey || existing.storageProvider === 'external' || existing.storageProvider === 'url') &&
    /^https?:\/\//i.test(String(existing.fileUrl || ''))
  ) {
    return {
      redirectUrl: String(existing.fileUrl),
      fileName,
      mimeType
    };
  }

  const stored = await StorageUtil.readStoredFile(
    existing.storageProvider,
    existing.storageKey,
    existing.fileUrl,
    req
  );

  if (stored.redirectUrl) {
    return {
      redirectUrl: stored.redirectUrl,
      fileName,
      mimeType
    };
  }

  return {
    buffer: stored.buffer,
    fileName,
    mimeType: stored.mimeType || mimeType
  };
}

module.exports = {
  listAttachments,
  uploadAttachment,
  createRecord,
  removeAttachment,
  downloadAttachment,
  CLIENT_ATTACHMENT_CATEGORIES
};
