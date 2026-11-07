'use strict';

const { Schema } = require('mongoose');
const { TENANT_ROLES } = require('../utils/tenant-role.util');

const TenantMembershipSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    userId: { type: String, required: true, trim: true, index: true },
    role: { type: String, required: true, trim: true },
    designation: { type: String, trim: true, default: '', maxlength: 120 },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true
    },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' }
  },
  {
    collection: 'plugin_openext_crm_suite_tenant_memberships',
    timestamps: true
  }
);

TenantMembershipSchema.index(
  { tenantId: 1, userId: 1 },
  { unique: true, name: 'tenant_memberships_tenant_user_unique' }
);
TenantMembershipSchema.index(
  { userId: 1, status: 1 },
  { name: 'tenant_memberships_user_status' }
);
TenantMembershipSchema.index(
  { tenantId: 1, role: 1, status: 1 },
  { name: 'tenant_memberships_tenant_role_status' }
);

module.exports = {
  name: 'TenantMembership',
  schema: TenantMembershipSchema
};
