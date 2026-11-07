'use strict';

const { Schema } = require('mongoose');

const MilestoneTemplateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    order: { type: Number, default: 0 },
    dueDayOffset: { type: Number, default: 14, min: 0 } // days from project start
  },
  { _id: true }
);

const TaskTemplateSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    priority: { type: String, default: 'Medium', trim: true },
    hoursEstimate: { type: Number, default: 0, min: 0 },
    milestoneIndex: { type: Number, default: null }, // index in milestones array
    dayOffset: { type: Number, default: 0, min: 0 }, // days from start
    dueDayOffset: { type: Number, default: 7, min: 0 } // days from start
  },
  { _id: true }
);

const ProjectTemplateSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    category: { type: String, trim: true, maxlength: 100, default: '' },
    priority: { type: String, trim: true, default: 'Medium' },
    currency: { type: String, trim: true, maxlength: 10, default: 'INR' },
    hoursEstimate: { type: Number, default: 0, min: 0 },
    milestones: { type: [MilestoneTemplateSchema], default: [] },
    tasks: { type: [TaskTemplateSchema], default: [] },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_project_templates',
    timestamps: true
  }
);

ProjectTemplateSchema.index({ tenantId: 1, name: 1 }, { name: 'project_templates_tenant_name' });
ProjectTemplateSchema.index({ tenantId: 1, isDeleted: 1, createdAt: -1 }, { name: 'project_templates_tenant_created' });

module.exports = {
  name: 'ProjectTemplate',
  schema: ProjectTemplateSchema
};
