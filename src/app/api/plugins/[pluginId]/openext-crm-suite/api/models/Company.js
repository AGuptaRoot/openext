'use strict';

const { Schema } = require('mongoose');

/** Address sub-document for client billing and shipping */
const BillingAddressSchema = new Schema(
  {
    street: { type: String, trim: true, maxlength: 200, default: '' },
    city: { type: String, trim: true, maxlength: 80, default: '' },
    state: { type: String, trim: true, maxlength: 80, default: '' },
    country: { type: String, trim: true, maxlength: 80, default: '' },
    zip: { type: String, trim: true, maxlength: 20, default: '' }
  },
  { _id: false }
);

/** Comprehensive multi-address sub-document for client branches, billing & shipping */
const ClientAddressSchema = new Schema(
  {
    _id: { type: Schema.Types.Mixed, default: () => new (require('mongoose').Types.ObjectId)() },
    type: {
      type: String,
      enum: ['billing', 'shipping', 'branch', 'warehouse', 'headquarters'],
      default: 'shipping'
    },
    label: { type: String, trim: true, maxlength: 100, default: '' },
    street: { type: String, trim: true, maxlength: 200, default: '' },
    city: { type: String, trim: true, maxlength: 80, default: '' },
    state: { type: String, trim: true, maxlength: 80, default: '' },
    country: { type: String, trim: true, maxlength: 80, default: 'India' },
    zip: { type: String, trim: true, maxlength: 20, default: '' },
    isDefault: { type: Boolean, default: false },
    taxNumber: { type: String, trim: true, maxlength: 50, default: '' },
    contactPerson: { type: String, trim: true, maxlength: 100, default: '' },
    phone: { type: String, trim: true, maxlength: 20, default: '' },
    notes: { type: String, trim: true, maxlength: 500, default: '' }
  },
  { timestamps: true }
);

/**
 * Company (Client) model — Phase 1 plan Section 5.4.
 */
const CompanySchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    companyKey: { type: String, trim: true, maxlength: 120, default: '' },
    companyTokens: { type: [String], default: [] },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: '' },
    phone: { type: String, trim: true, maxlength: 16, match: /^$|^\+?\d{7,15}$/, default: '' },
    billingAddress: { type: BillingAddressSchema, default: () => ({}) },
    shippingAddress: { type: BillingAddressSchema, default: () => ({}) },
    addresses: { type: [ClientAddressSchema], default: [] },
    taxId: { type: String, trim: true, maxlength: 50, default: '' },
    website: { type: String, trim: true, maxlength: 200, match: /^$|^https?:\/\//i, default: '' },
    avatarUrl: { type: String, trim: true, default: '' },
    category: { type: String, trim: true, maxlength: 100, default: '' },
    tags: { type: [String], default: [] },
    customFields: { type: Schema.Types.Mixed, default: () => ({}) },
    /**
     * Plugin-extension payload kept on the client by older extension versions
     * (JSON, keyed by extension id). Read-only for the CRM; new extension data
     * lives in the extension's own tables, linked by the client id.
     */
    extension: { type: Schema.Types.Mixed, default: () => ({}) },
    leadId: { type: String, default: null },
    mergedIntoId: { type: String, trim: true, default: null },
    mergedFromIds: { type: [String], default: [] },
    mergedAt: { type: Date, default: null },
    mergedBy: { type: String, default: null },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    status: { type: String, default: 'Active' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_companies',
    timestamps: true
  }
);

CompanySchema.index({ tenantId: 1, name: 1 }, { name: 'companies_tenant_name' });
CompanySchema.index({ tenantId: 1, email: 1 }, { name: 'companies_tenant_email' });
CompanySchema.index({ tenantId: 1, phone: 1 }, { name: 'companies_tenant_phone' });
CompanySchema.index({ tenantId: 1, tags: 1 }, { name: 'companies_tenant_tags' });
CompanySchema.index({ tenantId: 1, companyTokens: 1 }, { name: 'companies_tenant_company_tokens' });
CompanySchema.index({ tenantId: 1, mergedIntoId: 1 }, { name: 'companies_tenant_merged_into' });

module.exports = {
  name: 'Company',
  schema: CompanySchema
};
