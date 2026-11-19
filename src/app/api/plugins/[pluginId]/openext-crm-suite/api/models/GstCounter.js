'use strict';

const { Schema } = require('mongoose');

/**
 * GST document number series (GST suite, CRM 3.53.0; documentation/gst-planning/01 §6).
 * One counter per tenant, series and financial year. Numbers are taken with one atomic $inc, so
 * parallel requests never get the same number. Format: SERIES/YY-YY/0001 (16 characters at most).
 *   series: 'INV' tax invoice · 'RV' advance receipt voucher · 'RF' refund voucher · 'CN' credit note
 */
const GstCounterSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true },
    series: { type: String, required: true, trim: true, enum: ['INV', 'RV', 'RF', 'CN'] },
    /** Financial year, short form: '26-27'. */
    fy: { type: String, required: true, trim: true, match: /^\d{2}-\d{2}$/ },
    /** The last number handed out. */
    last: { type: Number, default: 0, min: 0 }
  },
  {
    collection: 'plugin_openext_crm_suite_gst_counters',
    timestamps: true
  }
);

GstCounterSchema.index({ tenantId: 1, series: 1, fy: 1 }, { unique: true, name: 'gst_counters_tenant_series_fy' });

module.exports = {
  name: 'GstCounter',
  schema: GstCounterSchema
};
