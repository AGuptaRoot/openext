'use strict';

const { Schema } = require('mongoose');

const ReEngagementRequestSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    campaignId: { type: String, required: true, trim: true, index: true },
    campaignName: { type: String, trim: true, default: 'Marketing Drip' },
    leadId: { type: String, required: true, trim: true, index: true },
    leadName: { type: String, trim: true, default: '' },
    leadCompany: { type: String, trim: true, default: '' },
    leadEmail: { type: String, trim: true, default: '' },
    expectedRevenue: { type: Number, default: 0 },
    actionType: { type: String, trim: true, default: 'Email Button Click' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    status: {
      type: String,
      enum: ['Pending', 'Approved', 'Rejected'],
      default: 'Pending',
      index: true
    },
    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 1000, default: '' },
    createdTaskId: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_reengagement_requests',
    timestamps: true
  }
);

ReEngagementRequestSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

module.exports = {
  name: 'ReEngagementRequest',
  schema: ReEngagementRequestSchema
};
