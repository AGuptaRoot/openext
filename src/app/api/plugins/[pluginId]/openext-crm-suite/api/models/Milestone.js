'use strict';

const { Schema } = require('mongoose');

const MilestoneSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    projectId: { type: String, required: true, trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    summary: { type: String, trim: true, maxlength: 4000, default: '' },
    cost: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['Pending', 'In Progress', 'Completed', 'Cancelled'],
      default: 'Pending',
      set: function (val) {
        if (!val) return 'Pending';
        const s = String(val).trim().toLowerCase();
        if (s === 'in progress' || s === 'in_progress' || s === 'in-progress') return 'In Progress';
        if (s === 'completed' || s === 'complete' || s === 'done') return 'Completed';
        if (s === 'cancelled' || s === 'canceled') return 'Cancelled';
        return 'Pending';
      },
      index: true
    },
    addCostToBudget: { type: Boolean, default: false },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    isProjectDropped: { type: Boolean, default: false, index: true },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_milestones',
    timestamps: true
  }
);

MilestoneSchema.index({ tenantId: 1, projectId: 1, createdAt: -1 }, { name: 'milestones_tenant_project' });
MilestoneSchema.index({ tenantId: 1, status: 1 }, { name: 'milestones_tenant_status' });

module.exports = {
  name: 'Milestone',
  schema: MilestoneSchema
};
