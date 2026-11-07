'use strict';

const { Schema } = require('mongoose');

/**
 * Payment model — records payments against invoices (full CRUD in Payments module).
 */
const PaymentSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    clientId: { type: String, required: true, trim: true, index: true },
    invoiceId: { type: String, required: true, trim: true, index: true },
    paymentNo: { type: String, required: true, trim: true },
    paymentDate: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    mode: {
      type: String,
      enum: ['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Card', 'Other'],
      default: 'Other'
    },
    projectId: { type: String, trim: true, default: '' },
    currency: { type: String, trim: true, default: 'INR' },
    exchangeRate: { type: Number, default: 1, min: 0.0001 },
    transactionId: { type: String, trim: true, maxlength: 150, default: '' },
    /** Paid on this proforma before it became the tax invoice (the advance); invoiceId is the tax invoice. */
    proformaInvoiceId: { type: String, trim: true, default: null },
    paymentGateway: { type: String, trim: true, maxlength: 100, default: '' },
    bankAccount: { type: String, trim: true, maxlength: 150, default: '' },
    receipt: { type: String, trim: true, default: '' },
    remark: { type: String, trim: true, maxlength: 1000, default: '' },
    reference: { type: String, trim: true, maxlength: 120, default: '' },
    status: {
      type: String,
      enum: ['Pending', 'Completed', 'Partially Refunded', 'Refunded', 'Disputed', 'Failed', 'Cancelled'],
      default: 'Completed'
    },
    refundedAmount: { type: Number, default: 0, min: 0 },
    refundStatus: {
      type: String,
      enum: ['None', 'Pending Approval', 'Approved', 'Rejected', 'Processed'],
      default: 'None'
    },
    refunds: [
      {
        refundNo: { type: String, trim: true },
        amount: { type: Number, required: true, min: 0.01 },
        reason: { type: String, trim: true, maxlength: 1000, required: true },
        mode: {
          type: String,
          enum: ['Bank Transfer', 'UPI', 'Original Payment Method', 'Cash', 'Card', 'Cheque', 'Other'],
          default: 'Bank Transfer'
        },
        bankAccount: { type: String, trim: true, default: '' },
        transactionId: { type: String, trim: true, default: '' },
        receipt: { type: String, trim: true, default: '' },
        status: {
          type: String,
          enum: ['Pending Approval', 'Approved', 'Rejected', 'Processed'],
          default: 'Pending Approval'
        },
        requestedBy: { type: String, default: 'system' },
        requestedByName: { type: String, default: '' },
        requestedAt: { type: Date, default: Date.now },
        approvedBy: { type: String, default: null },
        approvedByName: { type: String, default: null },
        approvedAt: { type: Date, default: null },
        rejectedBy: { type: String, default: null },
        rejectedByName: { type: String, default: null },
        rejectedAt: { type: Date, default: null },
        rejectionReason: { type: String, default: '' },
        processedAt: { type: Date, default: null }
      }
    ],
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_payments',
    timestamps: true
  }
);

PaymentSchema.index({ tenantId: 1, invoiceId: 1 }, { name: 'payments_tenant_invoice' });
PaymentSchema.index({ tenantId: 1, clientId: 1 }, { name: 'payments_tenant_client' });
PaymentSchema.index({ tenantId: 1, paymentDate: -1 }, { name: 'payments_tenant_date' });

module.exports = {
  name: 'Payment',
  schema: PaymentSchema
};
