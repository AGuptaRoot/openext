'use strict';

const { Schema } = require('mongoose');

const RecurringExpenseExecutionLogSchema = new Schema(
  {
    runId: { type: String, required: true, trim: true },
    runDate: { type: Date, default: Date.now },
    expenseId: { type: String, default: null },
    expenseNo: { type: String, default: '' },
    status: { type: String, enum: ['Success', 'Failed'], default: 'Success' },
    error: { type: String, default: '' }
  },
  { _id: true }
);

const RecurringExpenseSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    profileName: { type: String, required: true, trim: true, maxlength: 200 },
    vendorName: { type: String, trim: true, maxlength: 200, default: '' },
    itemName: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, trim: true, default: 'Other', maxlength: 80 },
    amount: { type: Number, required: true, min: 0 },
    price: { type: Number, min: 0, default: 0 },
    currency: { type: String, required: true, trim: true, default: 'INR', maxlength: 8 },
    exchangeRate: { type: Number, default: 1, min: 0.0001 },
    frequency: {
      type: String,
      enum: ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'custom'],
      default: 'monthly'
    },
    customIntervalDays: { type: Number, default: 30, min: 1, max: 365 },
    startDate: { type: Date, required: true, default: Date.now },
    nextRunDate: { type: Date, required: true, index: true },
    lastRunDate: { type: Date, default: null },
    endCondition: {
      type: String,
      enum: ['never', 'on_date', 'after_cycles'],
      default: 'never'
    },
    endDate: { type: Date, default: null },
    totalCycles: { type: Number, default: null, min: 1 },
    cyclesCompleted: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ['Active', 'Paused', 'Completed'],
      default: 'Active',
      index: true
    },
    employeeId: { type: String, trim: true, default: '' },
    employeeName: { type: String, trim: true, default: '' },
    projectId: { type: String, trim: true, default: '' },
    clientId: { type: String, trim: true, default: '' },
    bankAccount: { type: String, trim: true, default: '' },
    paymentMode: {
      type: String,
      enum: ['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Card', 'Other'],
      default: 'Bank Transfer'
    },
    isBillable: { type: Boolean, default: false },
    autoSubmit: { type: Boolean, default: true },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    executionLogs: { type: [RecurringExpenseExecutionLogSchema], default: [] },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_recurring_expenses',
    timestamps: true
  }
);

RecurringExpenseSchema.index(
  { tenantId: 1, status: 1, nextRunDate: 1 },
  { name: 'recurring_expenses_tenant_run' }
);
RecurringExpenseSchema.index(
  { tenantId: 1, category: 1 },
  { name: 'recurring_expenses_tenant_cat' }
);

module.exports = {
  name: 'RecurringExpense',
  schema: RecurringExpenseSchema
};
