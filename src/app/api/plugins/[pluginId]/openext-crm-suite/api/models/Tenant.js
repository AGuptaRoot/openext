'use strict';

const { Schema } = require('mongoose');

const TenantSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
      index: true
    },
    adminMutationLockToken: { type: String, default: null, select: false },
    adminMutationLockUntil: { type: Date, default: null, select: false },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' }
  },
  {
    collection: 'plugin_openext_crm_suite_tenants',
    timestamps: true
  }
);

TenantSchema.index({ tenantId: 1 }, { unique: true, name: 'tenants_tenant_id_unique' });

module.exports = {
  name: 'Tenant',
  schema: TenantSchema
};
