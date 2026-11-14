'use strict';

const { Schema } = require('mongoose');

/** Single line on a quotation or invoice */
const LineItemSchema = new Schema(
  {
    name: { type: String, trim: true, default: '' },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    qty: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0 },
    tax: { type: Number, default: 0, min: 0, max: 100 },
    amount: { type: Number, required: true, min: 0 },
    file: { type: String, trim: true, default: '' },
    productId: { type: String, trim: true, default: null },
    /** What the quantity counts, e.g. "Rooms × Nights" or "2 Adults". */
    unit: { type: String, trim: true, maxlength: 60, default: '' },
    /** Values of the line columns the active extension declares (salesFlow.quotationLineFields). */
    extra: { type: Schema.Types.Mixed, default: () => ({}) },
    /** The extension's own reference for this line (never printed or shown to customers). */
    sourceRef: { type: String, trim: true, maxlength: 64, default: '' },
    /** Line group key the active extension declares (salesFlow.quotationLineGroups); '' = ungrouped. */
    group: { type: String, trim: true, maxlength: 40, default: '' }
  },
  { _id: false }
);

/**
 * Estimate (Quotation) model — stored as "estimates" collection per plan.
 * API routes use /quotations for clarity.
 */
/** Titled text block on a quotation (inclusions, cancellation policy, ...) */
const SectionSchema = new Schema(
  {
    title: { type: String, trim: true, maxlength: 80, default: '' },
    body: { type: String, trim: true, maxlength: 3000, default: '' }
  },
  { _id: false }
);

const EstimateSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    clientId: { type: String, trim: true, default: '', index: true },
    leadId: { type: String, trim: true, default: '', index: true },
    /**
     * How the client is asked to pay, when proforma & advance payment is on.
     *
     * `full` is the whole quotation; `advance` takes a part payment first,
     * either a percentage of the total or a fixed amount. Ignored entirely
     * while the feature is off.
     */
    paymentType: { type: String, enum: ['full', 'advance'], default: 'full' },
    advanceMode: { type: String, enum: ['percent', 'amount'], default: 'percent' },
    advanceValue: { type: Number, default: 0, min: 0 },
    /** Proforma raised from this quotation, if any. */
    proformaInvoiceId: { type: String, trim: true, default: '', index: true },
    proformaInvoiceNo: { type: String, trim: true, default: '' },
    opportunityId: { type: String, trim: true, default: '', index: true },
    dealId: { type: String, trim: true, default: '', index: true },
    /**
     * CRM 3.51.0: a client quotation made from the active extension's own record (salesFlow.clientQuotation:
     * the start step returned { recordId }, e.g. Travel's client trip) instead of a lead. The extension's id.
     */
    extensionRecordId: { type: String, trim: true, maxlength: 64, default: '', index: true },
    quotationNo: { type: String, required: true, trim: true },
    title: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    issueDate: { type: Date, required: true },
    expiryDate: { type: Date, default: null },
    status: {
      type: String,
      // Closed (CRM 3.28.0): another quotation of the same opportunity was accepted (salesFlow.lockOpportunityOnAccept).
      enum: ['Draft', 'Sent', 'Accepted', 'Rejected', 'Expired', 'Converted', 'Closed'],
      default: 'Draft'
    },
    closedAt: { type: Date, default: null },
    closedReason: { type: String, trim: true, default: '' },
    closedByQuotationId: { type: String, trim: true, default: '' },
    currency: { type: String, required: true, trim: true, default: 'INR' },
    taxCalculation: {
      type: String,
      enum: ['after_discount', 'before_discount'],
      default: 'after_discount'
    },
    lineItems: { type: [LineItemSchema], default: [] },
    subtotal: { type: Number, required: true, default: 0 },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    discountAmount: { type: Number, default: 0, min: 0 },
    discountApproval: {
      status: { type: String, enum: ['NotRequired', 'Pending', 'Approved', 'Rejected'], default: 'NotRequired' },
      requestedPercent: { type: Number, default: 0 },
      approvedBy: { type: String, default: null },
      approvedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: '' }
    },
    taxTotal: { type: Number, required: true, default: 0 },
    shippingCharge: { type: Number, default: 0 },
    shippingState: { type: String, trim: true, default: '' },
    grandTotal: { type: Number, required: true, default: 0 },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    recipientNotes: { type: String, trim: true, maxlength: 2000, default: '' },
    /** Titled text blocks printed after the totals (e.g. inclusions, cancellation policy). */
    sections: { type: [SectionSchema], default: [] },
    terms: { type: String, trim: true, maxlength: 3000, default: '' },
    version: { type: Number, default: 1, min: 1 },
    revisionOf: { type: String, trim: true, default: null, index: true },
    isLatestVersion: { type: Boolean, default: true, index: true },
    revisionNotes: { type: String, trim: true, maxlength: 1000, default: '' },
    portalToken: { type: String, trim: true, default: null, index: true },
    portalViewedAt: { type: Date, default: null },
    acceptedMetadata: {
      acceptedBy: { type: String, trim: true, default: null },
      acceptedEmail: { type: String, trim: true, default: null },
      acceptedIp: { type: String, trim: true, default: null },
      signature: { type: String, trim: true, default: null },
      acceptedAt: { type: Date, default: null },
      comments: { type: String, trim: true, default: '' }
    },
    rejectedMetadata: {
      rejectedBy: { type: String, trim: true, default: null },
      rejectedEmail: { type: String, trim: true, default: null },
      rejectedIp: { type: String, trim: true, default: null },
      rejectedAt: { type: Date, default: null },
      reason: { type: String, trim: true, default: '' }
    },
    acceptedSnapshot: { type: Schema.Types.Mixed, default: null },
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: String, default: null },
    convertedInvoiceId: { type: String, default: null },
    convertedSalesOrderId: { type: String, default: null },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    /** Customer / contact details when this record was created (CRM 3.35.0); never rewritten later. */
    customerSnapshot: { type: Schema.Types.Mixed, default: null },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_estimates',
    timestamps: true
  }
);

EstimateSchema.index(
  { tenantId: 1, quotationNo: 1 },
  { name: 'estimates_tenant_quotation_no' }
);
EstimateSchema.index({ tenantId: 1, clientId: 1 }, { name: 'estimates_tenant_client' });
EstimateSchema.index({ tenantId: 1, leadId: 1 }, { name: 'estimates_tenant_lead' });
EstimateSchema.index({ tenantId: 1, status: 1 }, { name: 'estimates_tenant_status' });
EstimateSchema.index({ tenantId: 1, isArchived: 1, isLatestVersion: 1 }, { name: 'estimates_tenant_active_latest' });

module.exports = {
  name: 'Estimate',
  schema: EstimateSchema,
  LineItemSchema,
  SectionSchema
};
