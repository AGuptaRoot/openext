'use strict';

const { Schema } = require('mongoose');

/**
 * Advance receipt voucher (GST suite, CRM 3.53.0; documentation/gst-planning/01 §5).
 *
 * For services, GST is due when an advance is received, before the tax invoice exists. Money paid on a
 * proforma gets a receipt voucher with the tax inside it (split by rate in the quotation's proportions).
 * When the tax invoice is issued the voucher is marked adjusted (GSTR-1 Table 11B); the invoice itself is
 * reported in full, so the tax is never counted twice.
 */
const RateSchema = new Schema(
  {
    taxPercent: { type: Number, default: 0 },
    taxable: { type: Number, default: 0 },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    utgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 }
  },
  { _id: false }
);

const AdvanceReceiptSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    /** Own series: RV/26-27/0001. */
    receiptNo: { type: String, required: true, trim: true },
    /** 'YYYY-MM-DD', the India date the money was received. */
    receiptDate: { type: String, required: true, trim: true },
    /** The CRM Payment this voucher records (one voucher per payment). */
    paymentId: { type: String, required: true, trim: true },
    clientId: { type: String, required: true, trim: true, index: true },
    quotationId: { type: String, trim: true, default: '' },
    proformaId: { type: String, trim: true, default: '' },
    placeOfSupply: { type: String, trim: true, default: '' },
    posCode: { type: String, trim: true, default: '' },
    isInterstate: { type: Boolean, default: false },
    /** Money received (tax included). */
    amount: { type: Number, required: true, min: 0.01 },
    rates: { type: [RateSchema], default: [] },
    taxable: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    /** Set when the tax invoice is issued → GSTR-1 Table 11B. */
    adjustedInvoiceId: { type: String, default: null },
    adjustedInvoiceNo: { type: String, default: '' },
    adjustedOn: { type: String, default: null },
    /** A cancelled trip: refund voucher instead of an invoice. */
    refundVoucherNo: { type: String, default: null },
    status: { type: String, enum: ['open', 'adjusted', 'refunded'], default: 'open', index: true },
    engine: { type: String, default: '' },
    createdBy: { type: String, default: 'system' }
  },
  {
    collection: 'plugin_openext_crm_suite_advance_receipts',
    timestamps: true
  }
);

AdvanceReceiptSchema.index({ tenantId: 1, receiptNo: 1 }, { unique: true, name: 'advance_receipts_tenant_no' });
AdvanceReceiptSchema.index({ tenantId: 1, paymentId: 1 }, { unique: true, name: 'advance_receipts_tenant_payment' });
AdvanceReceiptSchema.index({ tenantId: 1, receiptDate: 1 }, { name: 'advance_receipts_tenant_date' });
AdvanceReceiptSchema.index({ tenantId: 1, proformaId: 1 }, { name: 'advance_receipts_tenant_proforma' });

module.exports = {
  name: 'AdvanceReceipt',
  schema: AdvanceReceiptSchema
};
