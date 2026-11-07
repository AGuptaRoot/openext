'use strict';

const { Schema } = require('mongoose');
const { LineItemSchema } = require('./Estimate');

const InvoiceTemplateSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    category: { type: String, trim: true, maxlength: 100, default: 'General', index: true },
    currency: { type: String, required: true, trim: true, default: 'INR' },
    paymentTermsDays: { type: Number, default: 30, min: 0, max: 365 },
    taxCalculation: {
      type: String,
      enum: ['after_discount', 'before_discount'],
      default: 'after_discount'
    },
    lineItems: { type: [LineItemSchema], default: [] },
    discountType: {
      type: String,
      enum: ['percent', 'amount'],
      default: 'percent'
    },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    discountAmount: { type: Number, default: 0, min: 0 },
    paymentDetails: { type: String, trim: true, default: '' },
    billingAddress: { type: String, trim: true, default: '' },
    shippingAddress: { type: String, trim: true, default: '' },
    shippingState: { type: String, trim: true, default: '' },
    shippingCharge: { type: Number, default: 0, min: 0 },
    tags: { type: [String], default: [] },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    recipientNotes: { type: String, trim: true, maxlength: 2000, default: '' },
    adminNotes: { type: String, trim: true, maxlength: 2000, default: '' },
    terms: { type: String, trim: true, maxlength: 3000, default: '' },
    reminder: {
      enabled: { type: Boolean, default: false },
      timing: {
        type: String,
        enum: ['after_due_date', 'before_due_date'],
        default: 'after_due_date'
      },
      count: { type: Number, default: 1, min: 1 },
      days: { type: Number, default: 3, min: 1 }
    },
    isDefault: { type: Boolean, default: false },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_invoice_templates',
    timestamps: true
  }
);

InvoiceTemplateSchema.index({ tenantId: 1, name: 1 }, { name: 'invoice_templates_tenant_name' });
InvoiceTemplateSchema.index({ tenantId: 1, category: 1 }, { name: 'invoice_templates_tenant_cat' });

module.exports = {
  name: 'InvoiceTemplate',
  schema: InvoiceTemplateSchema
};
