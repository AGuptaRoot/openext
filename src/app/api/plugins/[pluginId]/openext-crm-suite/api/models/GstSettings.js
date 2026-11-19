'use strict';

const { Schema } = require('mongoose');

/**
 * GST settings (GST suite, CRM 3.53.0; documentation/gst-planning/05 §2). One record per tenant.
 *
 * - The seller's GST identity. stateCode / stateName / pan are DERIVED from the GSTIN on every save
 *   (services/gst-settings.service.js), never typed.
 * - Bank accounts are NOT kept here: they stay in Settings → Finance (`bank_accounts`). Only the UPI id
 *   lives here.
 * - Tax rules are settings, not code: a generic service catalogue (defaults may come from the enabled
 *   extension's manifest salesFlow.gst) and generic TCS rules by key (off until the CA's slabs are in).
 * No industry words: extension values arrive as plain keys.
 */

const ServiceTaxSchema = new Schema(
  {
    serviceType: { type: String, required: true, trim: true, match: /^[a-z][a-z0-9_]{1,40}$/ },
    label: { type: String, trim: true, maxlength: 60, default: '' },
    sac: { type: String, required: true, trim: true, match: /^\d{4,8}$/ },
    taxPercent: { type: Number, required: true, min: 0, max: 100 },
    note: { type: String, trim: true, maxlength: 200, default: '' },
    /** '' = typed by the admin; otherwise the id of the extension it was loaded from. */
    source: { type: String, trim: true, maxlength: 60, default: '' }
  },
  { _id: false }
);

const TcsSlabSchema = new Schema(
  {
    /** Upper limit of the slab in rupees (per PAN per financial year); null = no upper limit. */
    upTo: { type: Number, min: 0, default: null },
    rate: { type: Number, required: true, min: 0, max: 100 }
  },
  { _id: false }
);

const TcsRuleSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, match: /^[a-z][a-z0-9_]{1,40}$/ },
    label: { type: String, trim: true, maxlength: 60, default: '' },
    source: { type: String, trim: true, maxlength: 60, default: '' },
    enabled: { type: Boolean, default: false },
    needsPan: { type: Boolean, default: true },
    sectionLabel: { type: String, trim: true, maxlength: 40, default: '' },
    slabs: { type: [TcsSlabSchema], default: [] },
    noPanRate: { type: Number, min: 0, max: 100, default: null }
  },
  { _id: false }
);

const GstSettingsSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true },
    legalName: { type: String, required: true, trim: true, maxlength: 200 },
    tradeName: { type: String, trim: true, maxlength: 200, default: '' },
    gstin: { type: String, required: true, trim: true, uppercase: true, maxlength: 15 },
    // Derived from the GSTIN on every save:
    stateCode: { type: String, trim: true, default: '' },
    stateName: { type: String, trim: true, default: '' },
    pan: { type: String, trim: true, uppercase: true, default: '' },
    /** Composition dealer: issues a bill of supply, charges no GST. */
    compositionScheme: { type: Boolean, default: false },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: '' },
    phone: { type: String, trim: true, maxlength: 20, default: '' },
    address: {
      line1: { type: String, trim: true, maxlength: 200, default: '' },
      line2: { type: String, trim: true, maxlength: 200, default: '' },
      city: { type: String, trim: true, maxlength: 80, default: '' },
      pincode: { type: String, trim: true, maxlength: 10, default: '' }
    },
    /** UPI id for invoices and the QR code (bank accounts stay in Settings → Finance). */
    upiId: { type: String, trim: true, maxlength: 100, default: '' },
    /** Letter of Undertaking for exports / SEZ, filed per financial year ('2026-27'). */
    lut: {
      number: { type: String, trim: true, uppercase: true, maxlength: 20, default: '' },
      fy: { type: String, trim: true, maxlength: 7, default: '' }
    },
    serviceTaxes: { type: [ServiceTaxSchema], default: [] },
    tcsRules: { type: [TcsRuleSchema], default: [] },
    /** 'YYYY-MM-DD': GST documents and cash entries on or before it cannot change. '' = not locked. */
    lockedUpTo: { type: String, trim: true, default: '' },
    defaultTerms: { type: String, trim: true, maxlength: 3000, default: '' },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' }
  },
  {
    collection: 'plugin_openext_crm_suite_gst_settings',
    timestamps: true
  }
);

GstSettingsSchema.index({ tenantId: 1 }, { unique: true, name: 'gst_settings_tenant_unique' });

module.exports = {
  name: 'GstSettings',
  schema: GstSettingsSchema
};
