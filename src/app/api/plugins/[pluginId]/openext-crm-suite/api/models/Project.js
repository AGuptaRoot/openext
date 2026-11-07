'use strict';

const { Schema } = require('mongoose');

const ProjectSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    clientId: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, trim: true, maxlength: 4000, default: '' },
    category: { type: String, trim: true, maxlength: 100, default: '' },
    label: { type: String, trim: true, maxlength: 100, default: '' },
    tags: { type: [String], default: [] },
    priority: { type: String, trim: true, default: 'Medium' },
    customFields: { type: Schema.Types.Mixed, default: {} },
    currency: { type: String, trim: true, maxlength: 10, default: 'INR' },
    hoursEstimate: { type: Number, default: 0, min: 0 },
    progressCalculationMethod: {
      type: String,
      enum: ['tasks', 'time', 'manual'],
      default: 'tasks'
    },
    status: { type: String, required: true, trim: true },
    liveUrl: { type: String, trim: true, maxlength: 2048, default: '' },
    budget: { type: Number, default: 0, min: 0 },
    startDate: { type: Date, default: null },
    deadline: { type: Date, default: null },
    assignedTo: { type: [String], default: [] },
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: String, default: null },
    isDropped: { type: Boolean, default: false, index: true },
    droppedAt: { type: Date, default: null },
    droppedBy: { type: String, default: null },
    droppedReason: { type: String, trim: true, default: '' },
    previousStatus: { type: String, trim: true, default: null },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_projects',
    timestamps: true
  }
);

ProjectSchema.index({ tenantId: 1, isDropped: 1 }, { name: 'projects_tenant_isDropped' });
ProjectSchema.index({ tenantId: 1, clientId: 1 }, { name: 'projects_tenant_client' });
ProjectSchema.index({ tenantId: 1, status: 1 }, { name: 'projects_tenant_status' });
ProjectSchema.index({ tenantId: 1, priority: 1 }, { name: 'projects_tenant_priority' });
ProjectSchema.index({ tenantId: 1, category: 1 }, { name: 'projects_tenant_category' });
ProjectSchema.index({ tenantId: 1, label: 1 }, { name: 'projects_tenant_label' });
ProjectSchema.index({ tenantId: 1, tags: 1 }, { name: 'projects_tenant_tags' });
ProjectSchema.index({ tenantId: 1, assignedTo: 1 }, { name: 'projects_tenant_assigned' });
ProjectSchema.index({ tenantId: 1, createdAt: -1 }, { name: 'projects_tenant_created' });

module.exports = {
  name: 'Project',
  schema: ProjectSchema
};
