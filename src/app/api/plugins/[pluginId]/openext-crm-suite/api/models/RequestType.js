'use strict';

const { Schema } = require('mongoose');

const FIELD_TYPES = ['text', 'number', 'select', 'radio', 'multiselect'];

const RequestTypeOptionSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    value: { type: String, required: true, trim: true, maxlength: 120 }
  },
  { _id: false }
);

const RequestTypeFieldSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    /** Stable identifier used in Lead commercial values — never rename as a DB key. */
    key: { type: String, required: true, trim: true, maxlength: 80 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, required: true, enum: FIELD_TYPES, default: 'text' },
    required: { type: Boolean, default: false },
    placeholder: { type: String, trim: true, maxlength: 200, default: '' },
    helpText: { type: String, trim: true, maxlength: 500, default: '' },
    options: { type: [RequestTypeOptionSchema], default: [] },
    /** Qualification Match: values that count as a match for select/radio/multi/text. */
    matchValues: { type: [String], default: [] },
    /** Qualification Match: inclusive numeric range (number fields). */
    matchNumberMin: { type: Number, default: null },
    matchNumberMax: { type: Number, default: null },
    /** When false, field is collected but not scored. */
    matchEnabled: { type: Boolean, default: true }
  },
  { _id: false }
);

const RequestTypeSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    /** Stable unique key (slug) — never use display name as identifier. */
    key: { type: String, required: true, trim: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    isEnabled: { type: Boolean, default: true, index: true },
    /** Seeded system types — protected from hard-delete when still referenced. */
    isSystem: { type: Boolean, default: false },
    fields: { type: [RequestTypeFieldSchema], default: [] },
    sortOrder: { type: Number, default: 0 },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_request_types',
    timestamps: true
  }
);

RequestTypeSchema.index(
  { tenantId: 1, key: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false }, name: 'request_type_tenant_key' }
);
RequestTypeSchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false }, name: 'request_type_tenant_name' }
);
RequestTypeSchema.index({ tenantId: 1, isEnabled: 1, sortOrder: 1 }, { name: 'request_type_list' });

module.exports = {
  name: 'RequestType',
  schema: RequestTypeSchema,
  FIELD_TYPES
};
