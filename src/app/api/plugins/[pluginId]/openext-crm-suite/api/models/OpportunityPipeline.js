'use strict';

const { Schema } = require('mongoose');

/**
 * Opportunity sales pipeline — one or more named pipelines per tenant.
 * Only one pipeline may be active; settings.opportunity_stages mirrors the active pipeline.
 */
const PipelineStageSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    /** Internal stage type used by CRM workflows (independent of visible label). */
    type: {
      type: String,
      required: true,
      enum: [
        'OPEN',
        'SAMPLE_SENT',
        'SAMPLE_APPROVED',
        'QUOTATION_SENT',
        'NEGOTIATION',
        'QUOTATION_ACCEPTED',
        'WON',
        'LOST'
      ],
      default: 'OPEN'
    },
    probability: { type: Number, min: 0, max: 100, default: 50 }
  },
  { _id: false }
);

const OpportunityPipelineSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    /** Built-in default pipeline — cannot be deleted. */
    isDefault: { type: Boolean, default: false, index: true },
    /** Exactly one active pipeline per tenant (enforced in service). */
    isActive: { type: Boolean, default: false, index: true },
    /** Soft enable/disable without deleting. Inactive pipelines are not selectable for new deals. */
    isEnabled: { type: Boolean, default: true },
    /** When true, Quotation Sent + Negotiation stage types are required. */
    quotationWorkflowEnabled: { type: Boolean, default: true },
    /** Contributed by an extension (its id). */
    extensionId: { type: String, trim: true, default: null, index: true },
    pipelineKey: { type: String, trim: true, default: null, index: true },
    stages: { type: [PipelineStageSchema], default: [] },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_opportunity_pipelines',
    timestamps: true
  }
);

OpportunityPipelineSchema.index(
  { tenantId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false }, name: 'opp_pipeline_tenant_name' }
);

module.exports = {
  name: 'OpportunityPipeline',
  schema: OpportunityPipelineSchema
};
