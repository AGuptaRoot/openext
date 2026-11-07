'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { assertLeadWriteAccess } = require('../utils/sales-access.util');
const AuditService = require('./audit.service');
const LeadService = require('./lead.service');
const StorageUtil = require('../utils/storage.util');

function getAttachmentModel(req) {
  const LeadAttachment = req.cms?.models.get('LeadAttachment');
  if (!LeadAttachment) throw new Error('LeadAttachment model is not registered');
  return LeadAttachment;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

async function uploadPhoto(req, leadId) {
  const lead = await LeadService.getById(req, leadId, { includeQuality: false });
  assertLeadWriteAccess(req, lead);

  if (lead.convertedClientId) {
    throw appError('Cannot upload photo for a converted lead', 409);
  }

  const upload = await StorageUtil.readUploadFile(req, 'file');
  if (!upload) throw appError('Photo file is required (field name: file)');

  const tenantId = resolveTenantId(req);
  const stored = await StorageUtil.uploadLeadFile({
    req,
    tenantId,
    leadId: String(leadId),
    category: 'photo',
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    buffer: upload.buffer,
    size: upload.size
  });

  let updated;
  try {
    updated = await LeadService.update(req, leadId, { photoUrl: stored.fileUrl });
  } catch (error) {
    await StorageUtil.deleteStoredFile(stored.provider, stored.storageKey, req);
    throw error;
  }

  await AuditService.log(req, {
    action: 'photo_uploaded',
    module: 'lead',
    recordId: String(leadId),
    description: `Lead photo uploaded: ${upload.fileName}`,
    metadata: { fileUrl: stored.fileUrl, provider: stored.provider }
  });

  return {
    photoUrl: updated.photoUrl,
    provider: stored.provider,
    storageKey: stored.storageKey
  };
}

async function listAttachments(req, leadId) {
  await LeadService.getById(req, leadId, { includeQuality: false });
  const LeadAttachment = getAttachmentModel(req);
  return LeadAttachment.find({ ...baseFilter(req), leadId: String(leadId) })
    .sort({ createdAt: -1 })
    .lean();
}

async function uploadAttachment(req, leadId) {
  const lead = await LeadService.getById(req, leadId, { includeQuality: false });
  assertLeadWriteAccess(req, lead);

  if (lead.convertedClientId) {
    throw appError('Cannot upload documents for a converted lead', 409);
  }

  const upload = await StorageUtil.readUploadFile(req, 'file');
  if (!upload) throw appError('Document file is required (field name: file)');

  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const stored = await StorageUtil.uploadLeadFile({
    req,
    tenantId,
    leadId: String(leadId),
    category: 'document',
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    buffer: upload.buffer,
    size: upload.size
  });

  const LeadAttachment = getAttachmentModel(req);
  let doc;
  try {
    doc = await LeadAttachment.create({
      tenantId,
      leadId: String(leadId),
      fileName: StorageUtil.sanitizeFileName(upload.fileName),
      originalName: String(upload.fileName || '').slice(0, 255),
      mimeType: upload.mimeType,
      fileSize: upload.size,
      fileUrl: stored.fileUrl,
      storageProvider: stored.provider,
      storageKey: stored.storageKey,
      category: 'document',
      uploadedBy: userId,
      createdBy: userId,
      updatedBy: userId
    });
  } catch (error) {
    await StorageUtil.deleteStoredFile(stored.provider, stored.storageKey, req);
    throw error;
  }

  const result = doc.toObject();
  await AuditService.log(req, {
    action: 'uploaded',
    module: 'lead_attachment',
    recordId: result._id.toString(),
    description: `Lead document uploaded: ${upload.fileName}`,
    metadata: { leadId: String(leadId), fileUrl: stored.fileUrl, provider: stored.provider }
  });

  return result;
}

async function removeAttachment(req, leadId, attachmentId) {
  const lead = await LeadService.getById(req, leadId, { includeQuality: false });
  assertLeadWriteAccess(req, lead);

  const LeadAttachment = getAttachmentModel(req);
  const userId = resolveUserId(req);

  const existing = await LeadAttachment.findOne({
    ...baseFilter(req),
    _id: attachmentId,
    leadId: String(leadId)
  }).lean();

  if (!existing) throw appError('Attachment not found', 404);

  await LeadAttachment.findOneAndUpdate(
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

  await StorageUtil.deleteStoredFile(existing.storageProvider, existing.storageKey, req);

  await AuditService.log(req, {
    action: 'deleted',
    module: 'lead_attachment',
    recordId: attachmentId,
    description: `Lead document deleted: ${existing.originalName || existing.fileName}`,
    metadata: { leadId: String(leadId) }
  });

  return { deleted: true, id: attachmentId };
}

function getStorageStatus() {
  let sdkInstalled = false;
  try {
    require.resolve('@aws-sdk/client-s3');
    sdkInstalled = true;
  } catch {
    sdkInstalled = false;
  }

  return {
    s3Configured: StorageUtil.isS3Configured(),
    s3SdkInstalled: sdkInstalled,
    storageMode: StorageUtil.isS3Configured() && sdkInstalled ? 's3' : 'local'
  };
}

module.exports = {
  uploadPhoto,
  listAttachments,
  uploadAttachment,
  removeAttachment,
  getStorageStatus
};
