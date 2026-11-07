'use strict';

const { Schema } = require('mongoose');
const { LineItemSchema } = require('./Estimate');

/**
 * Invoice model — complete with parity features:
 * recurring profiles, credit note adjustments, archiving, write-offs, and multi-status tracking.
 */
const InvoiceSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    clientId: { type: String, required: true, trim: true, index: true },
    quotationId: { type: String, default: null },
    /**
     * What this document is.
     *
     * `tax` is the ordinary tax invoice. `proforma` is a payment request raised
     * from a quotation — not a tax document, numbered from its own series and
     * excluded from tax and revenue reporting. On conversion the payment moves
     * to the tax invoice and the proforma is closed with a pointer to it.
     */
    documentType: { type: String, enum: ['tax', 'proforma'], default: 'tax', index: true },
    /** Set on a proforma once it has been turned into a tax invoice. */
    convertedInvoiceId: { type: String, default: null, trim: true, index: true },
    convertedInvoiceNo: { type: String, default: '', trim: true },
    convertedAt: { type: Date, default: null },
    /** The opportunity this invoice bills (raised from a won deal); quotation invoices link via the quotation. */
    opportunityId: { type: String, default: null, trim: true, index: true },
    /** The proforma a tax invoice came from, for the audit trail. */
    proformaInvoiceId: { type: String, default: null, trim: true, index: true },
    proformaInvoiceNo: { type: String, default: '', trim: true },
    /** On a tax invoice: the advance carried from its proforma(s) at conversion. */
    advancePaid: { type: Number, default: 0, min: 0 },
    salesOrderId: { type: String, default: null, trim: true, index: true },
    salesOrderNo: { type: String, default: null, trim: true },
    recurringProfileId: { type: String, default: null, index: true },
    recurringCycle: { type: Number, default: null },
    invoiceNo: { type: String, required: true, trim: true },
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },
    status: {
      type: String,
      // Converted: a proforma turned into the tax invoice (settled, kept for history).
      enum: ['Draft', 'Sent', 'Viewed', 'Partially Paid', 'Paid', 'Overdue', 'Written Off', 'Cancelled', 'Converted'],
      default: 'Draft'
    },
    currency: { type: String, required: true, trim: true, default: 'INR' },
    exchangeRate: { type: Number, default: 1, min: 0 },
    projectId: { type: String, default: null, trim: true, index: true },
    bankAccount: { type: String, trim: true, default: '' },
    paymentDetails: { type: String, trim: true, default: '' },
    billingAddress: { type: String, trim: true, default: '' },
    shippingAddress: { type: String, trim: true, default: '' },
    lineItems: { type: [LineItemSchema], default: [] },
    discountType: {
      type: String,
      enum: ['percent', 'amount'],
      default: 'percent'
    },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    discountAmount: { type: Number, default: 0, min: 0 },
    taxCalculation: {
      type: String,
      enum: ['after_discount', 'before_discount'],
      default: 'after_discount'
    },
    subtotal: { type: Number, required: true, default: 0 },
    taxTotal: { type: Number, required: true, default: 0 },
    grandTotal: { type: Number, required: true, default: 0 },
    amountPaid: { type: Number, required: true, default: 0 },
    creditAmount: { type: Number, required: true, default: 0, min: 0 },
    creditNoteIds: { type: [String], default: [] },
    balanceDue: { type: Number, required: true, default: 0 },
    file: { type: String, trim: true, default: '' },
    attachments: { type: [Schema.Types.Mixed], default: [] },
    reminder: {
      enabled: { type: Boolean, default: false },
      timing: {
        type: String,
        enum: ['after_due_date', 'before_due_date'],
        default: 'after_due_date'
      },
      count: { type: Number, default: 1, min: 1 },
      days: { type: Number, default: 3, min: 1 }
    },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    terms: { type: String, trim: true, maxlength: 3000, default: '' },
    viewedAt: { type: Date, default: null },
    /** Secure token for client-facing invoice view & pay portal (set on send, omitted until then) */
    payToken: { type: String, trim: true },
    payTokenViewedAt: { type: Date, default: null },
    writtenOffAt: { type: Date, default: null },
    writtenOffReason: { type: String, trim: true, maxlength: 1000, default: '' },
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: String, default: null },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    /** Customer / contact details when this record was created (CRM 3.35.0); never rewritten later. */
    customerSnapshot: { type: Schema.Types.Mixed, default: null },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_invoices',
    timestamps: true
  }
);

InvoiceSchema.index(
  { tenantId: 1, invoiceNo: 1 },
  { unique: true, name: 'invoices_tenant_invoice_no' }
);
InvoiceSchema.index({ tenantId: 1, clientId: 1 }, { name: 'invoices_tenant_client' });
InvoiceSchema.index(
  { tenantId: 1, status: 1, dueDate: 1 },
  { name: 'invoices_tenant_status_due' }
);
InvoiceSchema.index(
  { tenantId: 1, isArchived: 1, isDeleted: 1, createdAt: -1 },
  { name: 'invoices_tenant_archived_created' }
);
InvoiceSchema.index(
  { payToken: 1 },
  { unique: true, sparse: true, name: 'invoices_pay_token' }
);

module.exports = {
  name: 'Invoice',
  schema: InvoiceSchema
};
