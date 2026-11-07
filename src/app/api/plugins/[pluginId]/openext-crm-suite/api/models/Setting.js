'use strict';

const { Schema } = require('mongoose');

/**
 * Setting model — one document per config key per tenant.
 *
 * Example documents:
 *   { tenantId: 'default', key: 'tax_rate', value: 18, category: 'finance' }
 *   { tenantId: 'default', key: 'pipeline_stages', value: ['New', 'Won'], category: 'pipeline' }
 *
 * Collection name follows plugin prefix from Phase 1 plan Section 5.1.
 */
const SettingSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    key: { type: String, required: true, trim: true },
    value: { type: Schema.Types.Mixed, required: true },
    category: {
      type: String,
      trim: true,
      default: 'general'
    },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    status: { type: String, default: 'active' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_settings',
    timestamps: true
  }
);

// One key per tenant — prevents duplicate settings rows
SettingSchema.index(
  { tenantId: 1, key: 1 },
  { unique: true, name: 'unique_tenant_setting_key' }
);

module.exports = {
  name: 'Setting',
  schema: SettingSchema
};
