'use strict';

const { Schema } = require('mongoose');

const CreditNoteItemSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1, min: 0.01 },
    unitPrice: { type: Number, required: true, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0, max: 100 },
    amount: { type: Number, required: true, default: 0, min: 0 }
  },
  { _id: true }
);

const CreditNoteAppliedInvoiceSchema = new Schema(
  {
    invoiceId: { type: String, required: true, trim: true },
    invoiceNo: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0.01 },
    appliedAt: { type: Date, default: Date.now },
    appliedBy: { type: String, default: 'system' }
  },
  { _id: true }
);

/**
 * Credit Note Model Schema
 */
const CreditNoteSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    creditNoteNumber: { type: String, required: true, trim: true, uppercase: true },
    clientId: { type: String, required: true, trim: true, index: true },
    clientName: { type: String, required: true, trim: true, maxlength: 200 },
    invoiceId: { type: String, trim: true, default: null, index: true },
    invoiceNumber: { type: String, trim: true, default: '' },
    creditDate: { type: Date, default: Date.now },
    subtotal: { type: Number, default: 0, min: 0 },
    taxTotal: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, default: 0, min: 0 },
    remainingBalance: { type: Number, required: true, default: 0, min: 0 },
    refundAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, trim: true, default: 'INR', uppercase: true, maxlength: 10 },
    status: {
      type: String,
      enum: ['Draft', 'Open', 'Partially Applied', 'Applied', 'Refunded', 'Void'],
      default: 'Open'
    },
    reason: { type: String, trim: true, default: 'Customer Return / Adjustment', maxlength: 500 },
    items: { type: [CreditNoteItemSchema], default: [] },
    appliedInvoices: { type: [CreditNoteAppliedInvoiceSchema], default: [] },
    notes: { type: String, trim: true, default: '', maxlength: 2000 },
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: String, default: null },
    voidReason: { type: String, default: '' },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: String, default: null },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_credit_notes',
    timestamps: true
  }
);

CreditNoteSchema.index({ tenantId: 1, creditNoteNumber: 1 }, { name: 'credit_notes_tenant_num' });
CreditNoteSchema.index({ tenantId: 1, clientId: 1, creditDate: -1 }, { name: 'credit_notes_tenant_client_date' });
CreditNoteSchema.index({ tenantId: 1, status: 1 }, { name: 'credit_notes_tenant_status' });

module.exports = {
  name: 'CreditNote',
  schema: CreditNoteSchema
};
