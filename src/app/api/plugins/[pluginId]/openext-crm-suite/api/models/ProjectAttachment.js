'use strict';

const { Schema } = require('mongoose');

const PROJECT_ATTACHMENT_CATEGORIES = [
  'General',
  'Design',
  'Specification',
  'Contract',
  'Invoice',
  'Deliverable',
  'Source Code',
  'Asset',
  'Other'
];

const ProjectAttachmentSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    projectId: { type: String, required: true, trim: true, index: true },
    milestoneId: { type: String, trim: true, default: null, index: true },
    taskId: { type: String, trim: true, default: null, index: true },
    fileName: { type: String, required: true, trim: true, maxlength: 255 },
    originalName: { type: String, trim: true, maxlength: 255, default: '' },
    mimeType: { type: String, trim: true, maxlength: 120, default: 'application/octet-stream' },
    fileSize: { type: Number, default: 0, min: 0 },
    storageProvider: { type: String, enum: ['s3', 'local', 'external', 'url'], default: 'local' },
    storageKey: { type: String, trim: true, maxlength: 1024, default: '' },
    fileUrl: { type: String, required: true, trim: true, maxlength: 2048 },
    category: { type: String, enum: PROJECT_ATTACHMENT_CATEGORIES, default: 'General' },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    uploadedBy: { type: String, default: 'system' },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_project_attachments',
    timestamps: true
  }
);

ProjectAttachmentSchema.index(
  { tenantId: 1, projectId: 1, createdAt: -1 },
  { name: 'project_attachments_tenant_project_created' }
);
ProjectAttachmentSchema.index(
  { tenantId: 1, projectId: 1, category: 1 },
  { name: 'project_attachments_tenant_project_category' }
);

module.exports = {
  name: 'ProjectAttachment',
  schema: ProjectAttachmentSchema,
  PROJECT_ATTACHMENT_CATEGORIES
};
