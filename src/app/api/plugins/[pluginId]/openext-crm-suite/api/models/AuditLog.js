'use strict';

/**
 * @file AuditLog model schema for the Root CRM.
 *
 * CRM Use Case: Tenant-level audit trail and security compliance. Captures every
 * write operation (create/update/delete) across all CRM modules (leads, clients,
 * projects, milestones, invoices, etc.) so administrators can trace who changed what and when.
 * Supports compliance requirements, incident forensics, and change review.
 */

const { Schema } = require('mongoose');

const AuditLogSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, trim: true },
    action: { type: String, required: true, trim: true },
    module: {
      type: String,
      required: true,
      trim: true,
      enum: [
        'lead',
        'client',
        'contact',
        'project',
        'milestone',
        'task',
        'time_log',
        'quotation',
        'quotation_template',
        'invoice',
        'invoice_template',
        'recurring_invoice',
        'credit_note',
        'payment',
        'expense',
        'lead_event',
        'follow_up',
        'lead_attachment',
        'settings',
        'tenant_security',
        'opportunity_pipeline',
        'request_type'
      ]
    },
    recordId: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    metadata: { type: Schema.Types.Mixed, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_audit_logs',
    timestamps: { createdAt: true, updatedAt: false }
  }
);

AuditLogSchema.index(
  { tenantId: 1, module: 1, createdAt: -1 },
  { name: 'audit_tenant_module_created' }
);
AuditLogSchema.index(
  { tenantId: 1, recordId: 1 },
  { name: 'audit_tenant_record' }
);

module.exports = {
  name: 'AuditLog',
  schema: AuditLogSchema
};
