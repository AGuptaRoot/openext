'use strict';

const { Schema } = require('mongoose');
const { LineItemSchema, SectionSchema } = require('./Estimate');

const EstimateTemplateSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    category: { type: String, trim: true, maxlength: 100, default: 'General', index: true },
    currency: { type: String, required: true, trim: true, default: 'INR' },
    taxCalculation: {
      type: String,
      enum: ['after_discount', 'before_discount'],
      default: 'after_discount'
    },
    lineItems: { type: [LineItemSchema], default: [] },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    shippingState: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    recipientNotes: { type: String, trim: true, maxlength: 2000, default: '' },
    terms: { type: String, trim: true, maxlength: 3000, default: '' },
    /** Titled text blocks copied into quotations made from this template. */
    sections: { type: [SectionSchema], default: [] },
    isDefault: { type: Boolean, default: false },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_estimate_templates',
    timestamps: true
  }
);

EstimateTemplateSchema.index({ tenantId: 1, name: 1 }, { name: 'estimate_templates_tenant_name' });
EstimateTemplateSchema.index({ tenantId: 1, category: 1 }, { name: 'estimate_templates_tenant_cat' });

module.exports = {
  name: 'EstimateTemplate',
  schema: EstimateTemplateSchema
};
