'use strict';

const { Schema } = require('mongoose');

/**
 * Payment-gateway fee log (GST suite, CRM 3.53.0; documentation/gst-planning/04 §2).
 * One row per Razorpay payment, ever: the gross received, the gateway's fee and the GST on that fee, the net
 * that reaches the bank and the settlement it came in. Written once when the payment is recorded (never
 * on a repeated confirmation); fee / settlement filled later from Razorpay when not known yet.
 * Reconciliation only: input tax credit is claimed from Razorpay's monthly GST invoice (GSTR-2B).
 */
const GatewayFeeSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    gateway: { type: String, trim: true, default: 'razorpay' },
    /** pay_xxx */
    paymentId: { type: String, required: true, trim: true },
    orderId: { type: String, trim: true, default: '' },
    invoiceId: { type: String, trim: true, default: '' },
    /** The CRM Payment _id. */
    crmPaymentId: { type: String, trim: true, default: '' },
    method: { type: String, trim: true, default: '' },
    /** 'YYYY-MM-DD' (India date). */
    paidOn: { type: String, required: true, trim: true },
    currency: { type: String, trim: true, default: 'INR' },
    /** Rupees. */
    gross: { type: Number, required: true, min: 0 },
    /** null = not known yet. */
    fee: { type: Number, default: null },
    gstOnFee: { type: Number, default: null },
    /** gross - fee - gstOnFee, once the fee is known. */
    net: { type: Number, default: null },
    /** setl_xxx and its date, from Razorpay's settlement reconciliation. */
    settlementId: { type: String, trim: true, default: '' },
    settledOn: { type: String, trim: true, default: '' },
    /** Set when that settlement is matched to a bank statement line. */
    bankLineId: { type: String, trim: true, default: '' }
  },
  {
    collection: 'plugin_openext_crm_suite_gateway_fees',
    timestamps: true
  }
);

GatewayFeeSchema.index({ tenantId: 1, gateway: 1, paymentId: 1 }, { unique: true, name: 'gateway_fees_tenant_payment' });
GatewayFeeSchema.index({ tenantId: 1, paidOn: 1 }, { name: 'gateway_fees_tenant_paid_on' });
GatewayFeeSchema.index({ tenantId: 1, settlementId: 1 }, { name: 'gateway_fees_tenant_settlement' });

module.exports = {
  name: 'GatewayFee',
  schema: GatewayFeeSchema
};
