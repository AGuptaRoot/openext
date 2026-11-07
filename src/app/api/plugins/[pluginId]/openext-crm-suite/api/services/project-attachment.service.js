'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');
const StorageUtil = require('../utils/storage.util');
const { PROJECT_ATTACHMENT_CATEGORIES } = require('../models/ProjectAttachment');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getProjectModel(req) {
  const Project = req.cms?.models.get('Project');
  if (!Project) throw appError('Project model is not registered', 500);
  return Project;
}

function getAttachmentModel(req) {
  const ProjectAttachment = req.cms?.models.get('ProjectAttachment');
  if (!ProjectAttachment) throw appError('ProjectAttachment model is not registered', 500);
  return ProjectAttachment;
}

async function verifyProjectAccess(req, projectId) {
  const tenantId = resolveTenantId(req);
  const Project = getProjectModel(req);
  const project = await Project.findOne({ _id: projectId, tenantId, isDeleted: false }).lean();
  if (!project) throw appError('Project not found or access denied', 404);
  return project;
}

async function listDocuments(req, projectId, options = {}) {
  await verifyProjectAccess(req, projectId);
  const tenantId = resolveTenantId(req);
  const ProjectAttachment = getAttachmentModel(req);

  const query = {
    tenantId,
    projectId,
    isDeleted: false
  };

  if (options.category && options.category !== 'all') {
    query.category = options.category;
  }
  if (options.milestoneId) {
    query.milestoneId = options.milestoneId;
  }
  if (options.taskId) {
    query.taskId = options.taskId;
  }

  return ProjectAttachment.find(query).sort({ createdAt: -1 }).lean();
}

async function uploadDocument(req, projectId, body = {}) {
  const project = await verifyProjectAccess(req, projectId);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const ProjectAttachment = getAttachmentModel(req);

  const upload = await StorageUtil.readUploadFile(req, 'file');
  if (!upload) throw appError('Document file is required (field name: file)', 400);

  const category = PROJECT_ATTACHMENT_CATEGORIES.includes(body.category)
    ? body.category
    : 'General';

  const stored = await StorageUtil.uploadCrmFile({
    req,
    tenantId,
    entityType: 'projects',
    entityId: String(projectId),
    category: 'document',
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    buffer: upload.buffer,
    size: upload.size
  });

  let createdDoc;
  try {
    const doc = await ProjectAttachment.create({
      tenantId,
      projectId: String(projectId),
      milestoneId: body.milestoneId || null,
      taskId: body.taskId || null,
      fileName: StorageUtil.sanitizeFileName(upload.fileName),
      originalName: String(upload.fileName || '').slice(0, 255),
      mimeType: upload.mimeType,
      fileSize: upload.size,
      fileUrl: stored.fileUrl,
      storageProvider: stored.provider,
      storageKey: stored.storageKey,
      category,
      description: String(body.description || '').trim().slice(0, 1000),
      uploadedBy: userId,
      createdBy: userId,
      updatedBy: userId
    });
    createdDoc = doc.toObject ? doc.toObject() : doc;
  } catch (error) {
    await StorageUtil.deleteStoredFile(stored.provider, stored.storageKey, req);
    throw error;
  }

  await AuditService.log(req, {
    action: 'created',
    module: 'project',
    recordId: projectId,
    description: `Uploaded project document "${upload.fileName}" (${category}) to project "${project.name}"`,
    metadata: {
      documentId: createdDoc._id,
      fileName: upload.fileName,
      category,
      fileSize: upload.size,
      fileUrl: stored.fileUrl
    }
  });

  return createdDoc;
}

async function createDocument(req, projectId, payload = {}) {
  const project = await verifyProjectAccess(req, projectId);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const ProjectAttachment = getAttachmentModel(req);

  const fileUrl = String(payload.fileUrl || payload.url || '').trim();
  const originalName = String(payload.originalName || payload.fileName || payload.name || '').trim();
  if (!fileUrl) throw appError('File URL is required', 400);
  if (!originalName) throw appError('Document name is required', 400);

  const category = PROJECT_ATTACHMENT_CATEGORIES.includes(payload.category)
    ? payload.category
    : 'General';

  let normalizedUrl = fileUrl;
  if (!/^https?:\/\//i.test(normalizedUrl) && !normalizedUrl.startsWith('/')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  const fileName = String(payload.fileName || originalName).trim();
  const mimeType = String(payload.mimeType || 'text/uri-list').trim();
  const fileSize = Number(payload.fileSize) || 0;

  const doc = await ProjectAttachment.create({
    tenantId,
    projectId: String(projectId),
    milestoneId: payload.milestoneId || null,
    taskId: payload.taskId || null,
    fileName,
    originalName,
    mimeType,
    fileSize,
    fileUrl: normalizedUrl,
    storageProvider: payload.storageProvider || 'url',
    storageKey: payload.storageKey || '',
    category,
    description: String(payload.description || '').trim().slice(0, 1000),
    uploadedBy: userId,
    createdBy: userId,
    updatedBy: userId
  });
  const createdDoc = doc.toObject ? doc.toObject() : doc;

  await AuditService.log(req, {
    action: 'created',
    module: 'project',
    recordId: projectId,
    description: `Linked document "${originalName}" (${category}) to project "${project.name}"`,
    metadata: { documentId: createdDoc._id, fileName, category, fileUrl: normalizedUrl }
  });

  return createdDoc;
}

async function deleteDocument(req, projectId, documentId) {
  const project = await verifyProjectAccess(req, projectId);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const ProjectAttachment = getAttachmentModel(req);

  const doc = await ProjectAttachment.findOne({
    _id: documentId,
    projectId,
    tenantId,
    isDeleted: false
  });

  if (!doc) throw appError('Project document not found', 404);

  doc.isDeleted = true;
  doc.deletedAt = new Date();
  doc.deletedBy = userId;
  await doc.save();

  await AuditService.log(req, {
    action: 'deleted',
    module: 'project',
    recordId: projectId,
    description: `Removed project document "${doc.originalName || doc.fileName}" from project "${project.name}"`,
    metadata: { documentId, fileName: doc.fileName }
  });

  return { success: true, message: 'Document removed successfully' };
}

module.exports = {
  listDocuments,
  uploadDocument,
  createDocument,
  deleteDocument,
  PROJECT_ATTACHMENT_CATEGORIES
};
