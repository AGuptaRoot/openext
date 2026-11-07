'use strict';

const { Schema } = require('mongoose');

const TimeLogSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    taskId: { type: String, required: true, trim: true, index: true },
    projectId: { type: String, required: true, trim: true, index: true },
    workDate: { type: Date, required: true },
    hours: { type: Number, required: true, min: 0.01, max: 24 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    isBillable: { type: Boolean, default: true },
    hourlyRate: { type: Number, default: 0, min: 0 },
    billableAmount: { type: Number, default: 0, min: 0 },
    checkInTime: { type: Date, default: null },
    checkOutTime: { type: Date, default: null },
    status: { type: String, enum: ['Running', 'Completed'], default: 'Completed', index: true },
    entryType: { type: String, enum: ['manual', 'timer'], default: 'manual' },
    approvalStatus: { type: String, enum: ['Draft', 'Pending', 'Approved', 'Rejected'], default: 'Approved', index: true },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, default: '' },
    isLocked: { type: Boolean, default: false, index: true },
    isProjectDropped: { type: Boolean, default: false, index: true },
    invoiceId: { type: String, default: null, index: true },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_time_logs',
    timestamps: true
  }
);

TimeLogSchema.index({ tenantId: 1, taskId: 1, workDate: -1 }, { name: 'time_logs_task_date' });
TimeLogSchema.index({ tenantId: 1, projectId: 1, workDate: -1 }, { name: 'time_logs_project_date' });
TimeLogSchema.index({ tenantId: 1, createdBy: 1, workDate: -1 }, { name: 'time_logs_user_date' });
TimeLogSchema.index({ tenantId: 1, isBillable: 1, workDate: -1 }, { name: 'time_logs_billable_date' });

module.exports = {
  name: 'TimeLog',
  schema: TimeLogSchema
};
