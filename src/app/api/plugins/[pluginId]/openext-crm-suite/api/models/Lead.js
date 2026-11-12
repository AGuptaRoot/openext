'use strict';

const { Schema } = require('mongoose');

/**
 * Interested Product Item Subdocument
 */
const LeadInterestedProductSchema = new Schema(
  {
    productId: { type: String, trim: true, default: '' },
    sku: { type: String, trim: true, default: '' },
    productName: { type: String, required: true, trim: true },
    category: { type: String, trim: true, default: 'General' },
    unitPrice: { type: Number, required: true, default: 0, min: 0 },
    quantity: { type: Number, required: true, default: 1, min: 1 },
    totalValue: { type: Number, required: true, default: 0, min: 0 },
    notes: { type: String, trim: true, default: '', maxlength: 500 }
  },
  { _id: true }
);

/**
 * Qualification Subdocument Schema
 */
const LeadQualificationSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['Not Started', 'In Review', 'Qualified', 'Rejected'],
      default: 'Not Started'
    },
    industry: { type: String, trim: true, maxlength: 120, default: '' },
    customerType: { type: String, trim: true, maxlength: 120, default: '' },
    businessPotential: { type: String, trim: true, maxlength: 120, default: '' },
    annualRequirement: { type: String, trim: true, maxlength: 200, default: '' },
    geographicCoverage: { type: String, trim: true, maxlength: 200, default: '' },
    expectedRevenue: { type: Number, default: null },
    /** Deal Value entered on the lead form (null = not given). */
    value: { type: Number, default: null, min: 0 },
    /** Currency of the Deal Value (ISO code; empty = workspace default). */
    currency: { type: String, trim: true, uppercase: true, maxlength: 3, default: '' },
    targetPrice: { type: String, trim: true, maxlength: 120, default: '' },
    paymentTerms: { type: String, trim: true, maxlength: 120, default: '' },
    technicalFeasibility: { type: String, trim: true, maxlength: 120, default: '' },
    sampleRequired: { type: Boolean, default: false },
    qualityApproved: { type: Boolean, default: false },
    contractRequired: { type: Boolean, default: false },
    contractType: { type: String, trim: true, default: '', maxlength: 120 },
    qualificationNotes: { type: String, trim: true, maxlength: 2000, default: '' },
    rejectionReason: { type: String, trim: true, maxlength: 2000, default: '' },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: null }
  },
  { _id: false }
);

/**
 * Commercial requirement (project software vs product) + match score.
 */
const LeadCommercialRequirementSchema = new Schema(
  {
    kind: {
      type: String,
      enum: ['', 'project', 'product', 'dynamic'],
      default: ''
    },
    /** Stable RequestType id — survives rename of display name. */
    requestTypeId: { type: String, trim: true, default: null, index: true },
    requestTypeKey: { type: String, trim: true, default: '' },
    /** Dynamic field values keyed by RequestType field.key */
    values: { type: Schema.Types.Mixed, default: () => ({}) },
    /**
     * Lead-specific selectable options keyed by field.key.
     * Shape: { [fieldKey]: [{ value, label }] } — not shared with other leads
     * unless promoted into the Request Type global catalog.
     */
    customOptions: { type: Schema.Types.Mixed, default: () => ({}) },
    /**
     * When Request Type is Product: lead needs a sample request.
     * Mirrored to qualification.sampleRequired on save.
     */
    needsSampleRequest: { type: Boolean, default: false },
    matchedRequirements: { type: [Schema.Types.Mixed], default: [] },
    unmatchedRequirements: { type: [Schema.Types.Mixed], default: [] },
    missingRequirements: { type: [Schema.Types.Mixed], default: [] },
    project: {
      softwareType: { type: String, trim: true, maxlength: 120, default: '' },
      technologies: { type: [String], default: [] },
      modulesFeatures: { type: [String], default: [] },
      numberOfUsers: { type: String, trim: true, maxlength: 80, default: '' },
      integrations: { type: [String], default: [] },
      budget: { type: Number, default: null },
      expectedDelivery: { type: String, trim: true, maxlength: 40, default: '' }
    },
    product: {
      productName: { type: String, trim: true, maxlength: 200, default: '' },
      category: { type: String, trim: true, maxlength: 120, default: '' },
      specification: { type: String, trim: true, maxlength: 120, default: '' },
      targetPrice: { type: String, trim: true, maxlength: 120, default: '' },
      certifications: { type: [String], default: [] },
      quantity: { type: Number, default: null }
    },
    score: { type: Number, default: null },
    scoreBreakdown: {
      type: [
        {
          key: { type: String, default: '' },
          label: { type: String, default: '' },
          score: { type: Number, default: 0 },
          detail: { type: String, default: '' },
          status: { type: String, default: '' }
        }
      ],
      default: []
    },
    scoredAt: { type: Date, default: null },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: String, default: null }
  },
  { _id: false }
);

/**
 * Lead model — sales pipeline records.
 */
const LeadSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    salutation: { type: String, trim: true, maxlength: 20, default: '' },
    jobTitle: { type: String, trim: true, maxlength: 120, default: '' },
    gender: {
      type: String,
      enum: ['', 'Male', 'Female', 'Other', 'Prefer not to say'],
      default: ''
    },
    title: { type: String, trim: true, maxlength: 200, default: '' },
    leadType: { type: String, trim: true, maxlength: 80, default: '' },
    requestType: { type: String, trim: true, maxlength: 120, default: '' },
    /** Stable RequestType._id selected on the lead. */
    requestTypeId: { type: String, trim: true, default: null, index: true },
    priority: { type: String, trim: true, maxlength: 80, default: '' },
    nextFollowUp: { type: Date, default: null },
    contactId: { type: String, trim: true, default: '', index: true },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 16, match: /^\+?\d{7,15}$/ },
    company: { type: String, required: true, trim: true, maxlength: 120 },
    companyKey: { type: String, trim: true, maxlength: 120, default: '' },
    companyTokens: { type: [String], default: [] },
    pan: { type: String, trim: true, uppercase: true, maxlength: 10, match: /^$|^[A-Z]{5}\d{4}[A-Z]$/, default: '' },
    stage: { type: String, required: true, trim: true },
    stageUpdatedAt: { type: Date, default: Date.now },
    source: { type: String, trim: true, maxlength: 80, default: '' },
    /**
     * Deal Value entered on the lead form (null = not given) and its currency (ISO code; empty =
     * workspace default). 3.40.1: declared on the lead itself — before, the paths were only on the
     * qualification sub-schema, so MongoDB (Mongoose strict mode) silently dropped lead.value on create
     * and update. The qualification copies are kept so no stored data changes meaning.
     */
    value: { type: Number, default: null, min: 0 },
    currency: { type: String, trim: true, uppercase: true, maxlength: 3, default: '' },
    tags: { type: [String], default: [] },
    customFields: { type: Schema.Types.Mixed, default: () => ({}) },
    /**
     * Plugin-extension payload on the lead document (JSON), keyed by extension id
     * then section: { "<extensionId>": { "<Section>": { "<Field>": value } } }.
     * Workspace extensions (CRM 3.10.0+) keep their values in their own tables instead.
     */
    extension: { type: Schema.Types.Mixed, default: () => ({}) },
    assignedTo: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    photoUrl: { type: String, trim: true, maxlength: 500, default: '' },
    visitingCardUrl: { type: String, trim: true, maxlength: 1000, default: '' },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    address: { type: String, trim: true, maxlength: 500, default: '' },
    city: { type: String, trim: true, maxlength: 120, default: '' },
    state: { type: String, trim: true, maxlength: 120, default: '' },
    country: { type: String, trim: true, maxlength: 120, default: '' },
    postalCode: { type: String, trim: true, maxlength: 32, default: '' },
    placeId: { type: String, trim: true, maxlength: 256, default: '' },
    locationCapturedAt: { type: Date, default: null },
    interestedProducts: { type: [LeadInterestedProductSchema], default: [] },
    qualification: {
      type: LeadQualificationSchema,
      default: () => ({ status: 'Not Started' })
    },
    commercialRequirement: {
      type: LeadCommercialRequirementSchema,
      default: () => ({ kind: '' })
    },
    convertedClientId: { type: String, default: null },
    convertedAt: { type: Date, default: null },
    isPortal: { type: Boolean, default: false, index: true },
    portalEnabledAt: { type: Date, default: null },
    portalEnabledBy: { type: String, default: null },
    mergedIntoId: { type: String, trim: true, default: null },
    mergedFromIds: { type: [String], default: [] },
    mergedAt: { type: Date, default: null },
    mergedBy: { type: String, default: null },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    status: { type: String, default: 'active' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_leads',
    timestamps: true
  }
);

LeadSchema.index({ tenantId: 1, stage: 1 }, { name: 'leads_tenant_stage' });
LeadSchema.index({ tenantId: 1, isPortal: 1 }, { name: 'leads_tenant_is_portal' });
LeadSchema.index({ tenantId: 1, assignedTo: 1 }, { name: 'leads_tenant_assigned' });
LeadSchema.index({ tenantId: 1, createdAt: -1 }, { name: 'leads_tenant_created' });
LeadSchema.index({ tenantId: 1, email: 1 }, { name: 'leads_tenant_email' });
LeadSchema.index({ tenantId: 1, phone: 1 }, { name: 'leads_tenant_phone' });
LeadSchema.index({ tenantId: 1, pan: 1 }, { name: 'leads_tenant_pan' });
LeadSchema.index({ tenantId: 1, companyTokens: 1 }, { name: 'leads_tenant_company_tokens' });
LeadSchema.index({ tenantId: 1, tags: 1 }, { name: 'leads_tenant_tags' });
LeadSchema.index({ tenantId: 1, source: 1 }, { name: 'leads_tenant_source' });
LeadSchema.index({ tenantId: 1, status: 1 }, { name: 'leads_tenant_status' });
LeadSchema.index({ tenantId: 1, mergedIntoId: 1 }, { name: 'leads_tenant_merged_into' });
LeadSchema.index({ tenantId: 1, 'qualification.status': 1 }, { name: 'leads_tenant_qualification_status' });

module.exports = {
  name: 'Lead',
  schema: LeadSchema,
  LeadSchema
};
