'use strict';

const { Schema } = require('mongoose');

/**
 * Mongoose Schema for Customer CSAT & Post-Delivery Feedback model.
 * Collection: plugin_openext_crm_suite_customer_feedbacks
 */
const CustomerFeedbackSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    clientId: { type: String, required: true, trim: true, index: true },
    orderId: { type: String, trim: true, default: null, index: true },
    sampleId: { type: String, trim: true, default: null, index: true },
    ticketId: { type: String, trim: true, default: null, index: true },
    /** Related client task(s) chosen during CSAT review. */
    taskId: { type: String, trim: true, default: null, index: true },
    taskIds: { type: [String], default: [] },
    /** Denormalized task title(s) for list columns (comma-separated when multiple). */
    taskName: { type: String, trim: true, maxlength: 500, default: '' },
    rating: { type: Number, required: true, min: 1, max: 5 },
    category: {
      type: String,
      enum: ['Product Quality', 'Delivery Speed', 'Customer Service', 'Pricing', 'General'],
      default: 'General'
    },
    comments: { type: String, trim: true, maxlength: 2000, default: '' },
    submittedBy: { type: String, trim: true, default: '' },
    submittedAt: { type: Date, default: Date.now, index: true },
    createdBy: { type: String, default: 'system' }
  },
  {
    collection: 'plugin_openext_crm_suite_customer_feedbacks',
    timestamps: true
  }
);

CustomerFeedbackSchema.index({ tenantId: 1, clientId: 1 }, { name: 'fb_tenant_client' });
CustomerFeedbackSchema.index({ tenantId: 1, rating: 1 }, { name: 'fb_tenant_rating' });

module.exports = {
  name: 'CustomerFeedback',
  schema: CustomerFeedbackSchema
};
