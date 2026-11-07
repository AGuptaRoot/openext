'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const SubTaskSchema = new Schema(
  {
    _id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    currentDate: { type: Date, default: Date.now },
    assignedTo: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    isCompleted: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    completedBy: { type: String, default: null },
    createdBy: { type: String, default: 'system' }
  },
  { _id: true, timestamps: true }
);

const TaskSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    projectId: { type: String, required: true, trim: true, index: true },
    milestoneId: { type: String, trim: true, default: null, index: true },
    dependsOnTaskId: { type: String, trim: true, default: null, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 4000, default: '' },
    status: { type: String, required: true, trim: true },
    priority: { type: String, trim: true, default: 'Medium' },
    assignedTo: { type: String, trim: true, default: '' },
    startDate: { type: Date, default: null },
    dueDate: { type: Date, default: null },
    hoursEstimate: { type: Number, default: 0, min: 0 },
    tags: { type: [String], default: [] },
    category: { type: String, trim: true, default: '' },
    followers: { type: [String], default: [] },
    isRecurring: { type: Boolean, default: false },
    recurringInterval: {
      type: String,
      enum: ['day', 'week', 'month', 'quarter', 'year'],
      default: 'month'
    },
    recurringEvery: { type: Number, default: 1, min: 1 },
    recurringTotalCycles: { type: Number, default: 0 },
    recurringCyclesCompleted: { type: Number, default: 0 },
    recurringNextDate: { type: Date, default: null },
    recurringLastGeneratedAt: { type: Date, default: null },
    recurringParentTaskId: { type: String, default: null },
    subtasks: {
      type: [SubTaskSchema],
      default: []
    },
    notifyClientOnCompletion: { type: Boolean, default: false },
    clientNotifiedAt: { type: Date, default: null },
    clientNotifiedEmail: { type: String, default: null, trim: true },
    lastReminderSentAt: { type: Date, default: null },
    reminderCount: { type: Number, default: 0 },
    /** Per-task automatic client reminder schedule (overrides tenant default when enabled). */
    reminderScheduleEnabled: { type: Boolean, default: false },
    reminderIntervalType: {
      type: String,
      enum: ['hours', 'days', 'weeks', 'months'],
      default: 'hours'
    },
    reminderIntervalValue: { type: Number, default: null, min: 1 },
    clientFeedbackStatus: {
      type: String,
      enum: ['Pending Review', 'Pending Feedback', 'Satisfied', 'Dissatisfied', 'Not Replied', 'Awaiting Reply'],
      default: 'Pending Review',
      index: true
    },
    clientSatisfied: { type: Boolean, default: null },
    clientFeedbackNotes: { type: String, default: '', trim: true, maxlength: 2000 },
    isArchived: { type: Boolean, default: false },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: String, default: null },
    isProjectDropped: { type: Boolean, default: false, index: true },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_tasks',
    timestamps: true
  }
);

TaskSchema.index({ tenantId: 1, projectId: 1 }, { name: 'tasks_tenant_project' });
TaskSchema.index({ tenantId: 1, milestoneId: 1 }, { name: 'tasks_tenant_milestone' });
TaskSchema.index({ tenantId: 1, dependsOnTaskId: 1 }, { name: 'tasks_tenant_depends_on' });
TaskSchema.index({ tenantId: 1, isArchived: 1 }, { name: 'tasks_tenant_archived' });
TaskSchema.index({ tenantId: 1, assignedTo: 1 }, { name: 'tasks_tenant_assigned' });
TaskSchema.index({ tenantId: 1, dueDate: 1 }, { name: 'tasks_tenant_due' });
TaskSchema.index({ tenantId: 1, status: 1 }, { name: 'tasks_tenant_status' });

module.exports = {
  name: 'Task',
  schema: TaskSchema
};
