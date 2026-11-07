'use strict';

const { Schema } = require('mongoose');
const { LineItemSchema } = require('./Estimate');

const RecurringExecutionLogSchema = new Schema(
  {
    runId: { type: String, required: true, trim: true },
    runDate: { type: Date, default: Date.now },
    invoiceId: { type: String, default: null },
    invoiceNo: { type: String, default: '' },
    status: { type: String, enum: ['Success', 'Failed'], default: 'Success' },
    error: { type: String, default: '' }
  },
  { _id: true }
);

const RecurringInvoiceSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    profileName: { type: String, required: true, trim: true, maxlength: 200 },
    clientId: { type: String, required: true, trim: true, index: true },
    templateId: { type: String, default: null, trim: true },
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
    projectId: { type: String, default: null, trim: true },
    bankAccount: { type: String, default: '', trim: true },
    clientCanStopRecurring: { type: Boolean, default: false },
    currency: { type: String, required: true, trim: true, default: 'INR' },
    lineItems: { type: [LineItemSchema], default: [] },
    discountType: { type: String, enum: ['percent', 'amount'], default: 'percent' },
    discountValue: { type: Number, default: 0, min: 0 },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    discountAmount: { type: Number, default: 0, min: 0 },
    taxCalculation: {
      type: String,
      enum: ['after_discount', 'before_discount'],
      default: 'after_discount'
    },
    paymentTermsDays: { type: Number, default: 30, min: 0, max: 365 },
    recipientNotes: { type: String, trim: true, maxlength: 2000, default: '' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    terms: { type: String, trim: true, maxlength: 3000, default: '' },
    autoSendEmail: { type: Boolean, default: false },
    executionLogs: { type: [RecurringExecutionLogSchema], default: [] },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_recurring_invoices',
    timestamps: true
  }
);

RecurringInvoiceSchema.index(
  { tenantId: 1, status: 1, nextRunDate: 1 },
  { name: 'recurring_invoices_tenant_run' }
);
RecurringInvoiceSchema.index({ tenantId: 1, clientId: 1 }, { name: 'recurring_invoices_tenant_client' });

module.exports = {
  name: 'RecurringInvoice',
  schema: RecurringInvoiceSchema
};
