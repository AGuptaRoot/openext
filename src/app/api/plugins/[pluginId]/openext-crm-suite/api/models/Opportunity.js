'use strict';

const { Schema } = require('mongoose');

const OpportunityProductSchema = new Schema(
  {
    productName: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, default: '' },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    unitPrice: { type: Number, required: true, min: 0, default: 0 },
    tax: { type: Number, min: 0, max: 100, default: 18 },
    amount: { type: Number, required: true, min: 0, default: 0 }
  },
  { _id: false }
);

/**
 * Mongoose Schema for Opportunity model.
 * Collection: plugin_openext_crm_suite_opportunities
 */
const OpportunitySchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    opportunityNumber: { type: String, required: true, trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    leadId: { type: String, default: null, trim: true, index: true },
    // Account link — optional when the deal is created from a lead only
    clientId: { type: String, default: '', trim: true, index: true },
    contactId: { type: String, default: null, trim: true, index: true },
    contactPerson: { type: String, trim: true, default: '' },
    contactEmail: { type: String, trim: true, default: '' },
    contactMobile: { type: String, trim: true, default: '' },
    products: { type: [OpportunityProductSchema], default: [] },
    expectedRevenue: { type: Number, required: true, min: 0, default: 0 },
    /** ISO 4217 currency code for this deal (per-record; not rewritten by global settings). */
    currency: { type: String, trim: true, uppercase: true, maxlength: 10, default: 'INR' },
    exchangeRate: { type: Number, min: 0.0001, default: 1 },
    shippingState: { type: String, trim: true, default: '' },
    shippingCharge: { type: Number, min: 0, default: 0 },
    probability: { type: Number, required: true, min: 0, max: 100, default: 10 },
    weightedRevenue: { type: Number, required: true, min: 0, default: 0 },
    stage: {
      type: String,
      trim: true,
      default: 'Discovery',
      index: true
    },
    /** Internal stage type from the opportunity's pipeline (WON/LOST/NEGOTIATION/…). */
    stageType: {
      type: String,
      trim: true,
      default: 'OPEN',
      index: true
    },
    /** OpportunityPipeline id this deal belongs to. */
    pipelineId: { type: String, default: null, trim: true, index: true },
    salesOwner: { type: String, trim: true, default: '' },
    expectedCloseDate: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    lostReason: { type: String, trim: true, maxlength: 1000, default: null },
    /** Why the CRM closed it itself, e.g. 'lead_converted' (salesFlow.completeOpportunitiesOnConversion). */
    closedReason: { type: String, trim: true, maxlength: 60, default: '' },
    /** Latest quotation generated from this deal (history may include more). */
    generatedQuotationId: { type: String, default: null, trim: true },
    /** Final accepted quotation — once set, no new quotations may be created. */
    /**
     * Opened to the client portal.
     *
     * A lead that has not been converted has no Client record, so this flag on
     * the deal is what tells a portal login "this prospect may sign in and see
     * their own records". Set when portal access is sent from the lead or deal
     * page, cleared when it is revoked.
     */
    isPortal: { type: Boolean, default: false, index: true },
    portalEnabledAt: { type: Date, default: null },
    portalEnabledBy: { type: String, trim: true, default: '' },
    acceptedQuotationId: { type: String, default: null, trim: true, index: true },
    generatedSalesOrderId: { type: String, default: null, trim: true },
    extension: { type: Schema.Types.Mixed, default: () => ({}) },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    /** Customer / contact details when this record was created (CRM 3.35.0); never rewritten later. */
    customerSnapshot: { type: Schema.Types.Mixed, default: null },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_opportunities',
    timestamps: true
  }
);

OpportunitySchema.index({ tenantId: 1, opportunityNumber: 1 }, { name: 'opp_tenant_number' });
OpportunitySchema.index({ tenantId: 1, stage: 1 }, { name: 'opp_tenant_stage' });
OpportunitySchema.index({ tenantId: 1, clientId: 1 }, { name: 'opp_tenant_client' });

module.exports = {
  name: 'Opportunity',
  schema: OpportunitySchema
};
