'use strict';

const { Schema } = require('mongoose');

const CLIENT_ATTACHMENT_CATEGORIES = [
  'General',
  'Contract',
  'Proposal',
  'Invoice',
  'Compliance',
  'NDA',
  'Identification',
  'Tax',
  'KYC',
  'Other'
];

const ClientAttachmentSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    clientId: { type: String, required: true, trim: true, index: true },
    fileName: { type: String, required: true, trim: true, maxlength: 255 },
    originalName: { type: String, trim: true, maxlength: 255, default: '' },
    mimeType: { type: String, trim: true, maxlength: 120, default: '' },
    fileSize: { type: Number, default: 0, min: 0 },
    fileUrl: { type: String, required: true, trim: true, maxlength: 2048 },
    storageProvider: {
      type: String,
      enum: ['s3', 'local', 'url', 'external'],
      default: 'local'
    },
    storageKey: { type: String, trim: true, maxlength: 1024, default: '' },
    category: {
      type: String,
      enum: CLIENT_ATTACHMENT_CATEGORIES,
      default: 'General'
    },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    uploadedBy: { type: String, default: 'system' },
    uploadedByName: { type: String, default: '' },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_client_attachments',
    timestamps: true
  }
);

ClientAttachmentSchema.index(
  { tenantId: 1, clientId: 1, createdAt: -1 },
  { name: 'client_attachments_tenant_client_created' }
);
ClientAttachmentSchema.index(
  { tenantId: 1, clientId: 1, category: 1 },
  { name: 'client_attachments_tenant_client_cat' }
);

module.exports = {
  name: 'ClientAttachment',
  schema: ClientAttachmentSchema,
  CLIENT_ATTACHMENT_CATEGORIES
};
