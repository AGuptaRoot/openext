'use strict';

const { Schema } = require('mongoose');

const FOLLOW_UP_STATUSES = ['Open', 'Completed'];

const FollowUpSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    leadId: { type: String, required: true, trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    dueDate: { type: Date, required: true },
    status: { type: String, enum: FOLLOW_UP_STATUSES, default: 'Open' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_follow_ups',
    timestamps: true
  }
);

FollowUpSchema.index({ tenantId: 1, leadId: 1, dueDate: 1 }, { name: 'follow_ups_tenant_lead_due' });

module.exports = {
  name: 'FollowUp',
  schema: FollowUpSchema,
  FOLLOW_UP_STATUSES
};
