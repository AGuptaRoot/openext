'use strict';

const { Schema } = require('mongoose');

const CampaignStatsSchema = new Schema(
  {
    sent: { type: Number, default: 0 },
    opened: { type: Number, default: 0 },
    clicked: { type: Number, default: 0 },
    reEngagedLeads: { type: Number, default: 0 },
    revenueGenerated: { type: Number, default: 0 }
  },
  { _id: false }
);

const CampaignSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    type: {
      type: String,
      enum: ['Email Drip', 'Lost Lead Re-engagement', 'Repeat Business Nurture', 'Promotional Announcement'],
      default: 'Lost Lead Re-engagement'
    },
    targetAudience: {
      type: String,
      enum: ['Lost Leads', 'Unqualified Leads', 'Dormant Clients (>90 days)', 'All Contacts'],
      default: 'Lost Leads'
    },
    status: {
      type: String,
      enum: ['Draft', 'Active', 'Paused', 'Completed'],
      default: 'Draft'
    },
    subject: { type: String, required: true, trim: true, maxlength: 250 },
    content: { type: String, required: true, trim: true, maxlength: 10000 },
    scheduledDate: { type: Date, default: null },
    executedAt: { type: Date, default: null },
    stats: {
      type: CampaignStatsSchema,
      default: () => ({ sent: 0, opened: 0, clicked: 0, reEngagedLeads: 0, revenueGenerated: 0 })
    },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_campaigns',
    timestamps: true
  }
);

CampaignSchema.index({ tenantId: 1, status: 1 }, { name: 'campaigns_tenant_status' });
CampaignSchema.index({ tenantId: 1, type: 1 }, { name: 'campaigns_tenant_type' });
CampaignSchema.index({ tenantId: 1, createdAt: -1 }, { name: 'campaigns_tenant_created' });

module.exports = {
  name: 'Campaign',
  schema: CampaignSchema
};
