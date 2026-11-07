'use strict';

const { Schema } = require('mongoose');

const TaskTemplateSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 4000, default: '' },
    category: { type: String, trim: true, maxlength: 100, default: '' },
    priority: { type: String, trim: true, default: 'Medium' },
    hoursEstimate: { type: Number, default: 0, min: 0 },
    tags: { type: [String], default: [] },
    subtasks: {
      type: [
        {
          title: { type: String, required: true, trim: true },
          description: { type: String, default: '', trim: true }
        }
      ],
      default: []
    },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_task_templates',
    timestamps: true
  }
);

TaskTemplateSchema.index({ tenantId: 1, title: 1 }, { name: 'task_templates_tenant_title' });
TaskTemplateSchema.index({ tenantId: 1, isDeleted: 1, createdAt: -1 }, { name: 'task_templates_tenant_created' });

module.exports = {
  name: 'TaskTemplate',
  schema: TaskTemplateSchema
};
