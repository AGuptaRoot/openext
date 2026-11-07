'use strict';

const { Schema } = require('mongoose');

const NOTE_CATEGORIES = [
  'General',
  'Important',
  'Billing',
  'Meeting',
  'Call',
  'Follow-up',
  'Requirement'
];

const NOTE_COLORS = [
  'blue',
  'emerald',
  'amber',
  'purple',
  'rose',
  'slate'
];

const ClientNoteSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    clientId: { type: String, required: true, trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    content: { type: String, required: true, trim: true, maxlength: 5000 },
    category: { type: String, enum: NOTE_CATEGORIES, default: 'General' },
    color: { type: String, enum: NOTE_COLORS, default: 'blue' },
    isPinned: { type: Boolean, default: false },
    isPrivate: { type: Boolean, default: false },
    createdBy: { type: String, default: 'system' },
    createdByName: { type: String, default: '' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_client_notes',
    timestamps: true
  }
);

ClientNoteSchema.index(
  { tenantId: 1, clientId: 1, isPinned: -1, createdAt: -1 },
  { name: 'client_notes_tenant_client_pinned_date' }
);

module.exports = {
  name: 'ClientNote',
  schema: ClientNoteSchema,
  NOTE_CATEGORIES,
  NOTE_COLORS
};
