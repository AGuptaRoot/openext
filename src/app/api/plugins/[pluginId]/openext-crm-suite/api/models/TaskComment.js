'use strict';

const { Schema } = require('mongoose');

const TaskCommentSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    taskId: { type: String, required: true, trim: true, index: true },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_task_comments',
    timestamps: true
  }
);

TaskCommentSchema.index({ tenantId: 1, taskId: 1, createdAt: -1 }, { name: 'task_comments_task' });

module.exports = {
  name: 'TaskComment',
  schema: TaskCommentSchema
};
