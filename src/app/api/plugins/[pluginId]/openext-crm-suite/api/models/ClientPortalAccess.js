'use strict';

const { Schema } = require('mongoose');

const PORTAL_STATUSES = ['Pending_Approval', 'Invited', 'Active', 'Rejected', 'Suspended', 'Deactivated'];
const PORTAL_ROLES = ['Admin', 'Standard', 'Viewer'];
const PORTAL_MODULE_PERMISSIONS = [
  'invoices',
  'estimates',
  'contracts',
  'projects',
  'tasks',
  'documents',
  'tickets',
  'payments'
];

const ClientPortalAccessSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    /**
     * Empty for portal access granted straight from a lead, which happens once
     * the deal reaches Requirement Confirmed and before the lead is ever
     * converted into a client. Exactly one of clientId / leadId is set.
     */
    clientId: { type: String, trim: true, default: '', index: true },
    leadId: { type: String, trim: true, default: '', index: true },
    contactId: { type: String, trim: true, default: '', index: true },
    contactName: { type: String, default: '', trim: true },
    username: { type: String, trim: true, default: '' },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, trim: true, default: '' },
    initialPassword: { type: String, trim: true, default: '' },
    status: {
      type: String,
      enum: PORTAL_STATUSES,
      default: 'Invited'
    },
    portalRole: {
      type: String,
      enum: PORTAL_ROLES,
      default: 'Standard'
    },
    allowedPermissions: {
      type: [String],
      enum: PORTAL_MODULE_PERMISSIONS,
      default: ['invoices', 'contracts', 'projects', 'documents', 'tickets']
    },
    invitationToken: { type: String, default: null },
    invitationExpiresAt: { type: Date, default: null },
    invitedAt: { type: Date, default: Date.now },
    invitedBy: { type: String, default: 'system' },
    requestedBy: { type: String, default: null },
    requestedAt: { type: Date, default: null },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    rejectedBy: { type: String, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, default: '' },
    stagedPassword: { type: String, trim: true, default: '' },
    cmsUserId: { type: String, trim: true, default: null, index: true },
    activatedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    suspendedBy: { type: String, default: null },
    suspensionReason: { type: String, trim: true, default: '' },
    twoFactorEnabled: { type: Boolean, default: false },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_client_portal_access',
    timestamps: true
  }
);

ClientPortalAccessSchema.index(
  { tenantId: 1, clientId: 1, email: 1 },
  { name: 'client_portal_tenant_client_email' }
);
ClientPortalAccessSchema.index(
  { tenantId: 1, contactId: 1 },
  { name: 'client_portal_tenant_contact' }
);
ClientPortalAccessSchema.index(
  { tenantId: 1, leadId: 1, email: 1 },
  { name: 'client_portal_tenant_lead_email' }
);

module.exports = {
  name: 'ClientPortalAccess',
  schema: ClientPortalAccessSchema,
  PORTAL_STATUSES,
  PORTAL_ROLES,
  PORTAL_MODULE_PERMISSIONS
};
