'use strict';

const { Schema } = require('mongoose');

const ATTACHMENT_CATEGORIES = ['document'];

const LeadAttachmentSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    leadId: { type: String, required: true, trim: true, index: true },
    fileName: { type: String, required: true, trim: true, maxlength: 255 },
    originalName: { type: String, trim: true, maxlength: 255, default: '' },
    mimeType: { type: String, trim: true, maxlength: 120, default: '' },
    fileSize: { type: Number, default: 0, min: 0 },
    fileUrl: { type: String, required: true, trim: true, maxlength: 1000 },
    storageProvider: { type: String, enum: ['s3', 'local'], default: 'local' },
    storageKey: { type: String, trim: true, maxlength: 500, default: '' },
    category: { type: String, enum: ATTACHMENT_CATEGORIES, default: 'document' },
    uploadedBy: { type: String, default: 'system' },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_lead_attachments',
    timestamps: true
  }
);

LeadAttachmentSchema.index(
  { tenantId: 1, leadId: 1, createdAt: -1 },
  { name: 'lead_attachments_tenant_lead_created' }
);

module.exports = {
  name: 'LeadAttachment',
  schema: LeadAttachmentSchema,
  ATTACHMENT_CATEGORIES
};
