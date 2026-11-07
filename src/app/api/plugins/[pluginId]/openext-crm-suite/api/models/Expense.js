'use strict';

const { Schema } = require('mongoose');

const EXPENSE_STATUSES = ['Draft', 'Submitted', 'Approved', 'Rejected'];

const ExpenseSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    expenseNo: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    itemName: { type: String, trim: true, maxlength: 200, default: '' },
    amount: { type: Number, required: true, min: 0 },
    price: { type: Number, min: 0, default: 0 },
    currency: { type: String, trim: true, default: 'INR', maxlength: 8 },
    exchangeRate: { type: Number, default: 1, min: 0.0001 },
    expenseDate: { type: Date, required: true },
    purchaseDate: { type: Date, default: null },
    category: { type: String, trim: true, default: 'Other', maxlength: 80 },
    employeeId: { type: String, trim: true, default: '' },
    employeeName: { type: String, trim: true, default: '', maxlength: 200 },
    purchasedFrom: { type: String, trim: true, default: '', maxlength: 200 },
    bankAccount: { type: String, trim: true, default: '', maxlength: 200 },
    clientId: { type: String, trim: true, default: '' },
    projectId: { type: String, trim: true, default: '' },
    paymentMode: {
      type: String,
      enum: ['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Card', 'Other'],
      default: 'Other'
    },
    receiptUrl: { type: String, trim: true, maxlength: 500, default: '' },
    bill: { type: String, trim: true, maxlength: 500, default: '' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    status: {
      type: String,
      enum: EXPENSE_STATUSES,
      default: 'Draft'
    },
    submittedAt: { type: Date, default: null },
    approvedBy: { type: String, trim: true, default: '' },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 500, default: '' },
    isBillable: { type: Boolean, default: false },
    isBilled: { type: Boolean, default: false },
    billedInvoiceId: { type: String, default: null },
    billedInvoiceNo: { type: String, trim: true, default: '' },
    billedAt: { type: Date, default: null },
    recurringProfileId: { type: String, default: null },
    recurringCycle: { type: Number, default: null },
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
    collection: 'plugin_openext_crm_suite_expenses',
    timestamps: true
  }
);

ExpenseSchema.index({ tenantId: 1, expenseNo: 1 }, { unique: true, name: 'expenses_tenant_expense_no' });
ExpenseSchema.index({ tenantId: 1, status: 1 }, { name: 'expenses_tenant_status' });
ExpenseSchema.index({ tenantId: 1, expenseDate: -1 }, { name: 'expenses_tenant_date' });
ExpenseSchema.index({ tenantId: 1, projectId: 1 }, { name: 'expenses_tenant_project' });
ExpenseSchema.index({ tenantId: 1, clientId: 1 }, { name: 'expenses_tenant_client' });
ExpenseSchema.index({ tenantId: 1, createdBy: 1 }, { name: 'expenses_tenant_created_by' });

module.exports = {
  name: 'Expense',
  schema: ExpenseSchema,
  EXPENSE_STATUSES
};
