'use strict';

const { Schema } = require('mongoose');

/**
 * Mongoose Schema for SampleRequest model.
 * Collection: plugin_openext_crm_suite_sample_requests
 */
const SampleRequestSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    sampleNumber: { type: String, required: true, trim: true, index: true },
    leadId: { type: String, default: null, trim: true, index: true },
    clientId: { type: String, default: null, trim: true, index: true },
    opportunityId: { type: String, default: null, trim: true, index: true },
    productName: { type: String, required: true, trim: true, maxlength: 200 },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    unit: { type: String, trim: true, default: 'pcs' },
    items: {
      type: [
        {
          productName: { type: String, trim: true, maxlength: 200 },
          quantity: { type: Number, min: 1, default: 1 },
          unit: { type: String, trim: true, default: 'pcs' }
        }
      ],
      default: []
    },
    deliveryAddress: { type: String, trim: true, maxlength: 1000, default: '' },
    urgency: { type: String, enum: ['Low', 'Normal', 'High', 'Urgent'], default: 'Normal' },
    /** When true, sample is billable and currency/chargeAmount apply. */
    isChargeable: { type: Boolean, default: false },
    chargeAmount: { type: Number, min: 0, default: 0 },
    currency: { type: String, trim: true, uppercase: true, maxlength: 10, default: 'INR' },
    exchangeRate: { type: Number, min: 0.0001, default: 1 },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    status: {
      type: String,
      enum: [
        'Requested',
        'Approved',
        'Rejected',
        'Preparing',
        'Dispatched',
        'Delivered',
        'Completed',
        // Called off by the client (or on their behalf) before it arrived.
        'Cancelled'
      ],
      default: 'Requested',
      index: true
    },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 1000, default: null },
    stockLocation: { type: String, trim: true, default: '' },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, trim: true, default: '' },
    cancellationReason: { type: String, trim: true, maxlength: 500, default: '' },
    courierName: { type: String, trim: true, default: '' },
    trackingNumber: { type: String, trim: true, default: '' },
    dispatchDate: { type: Date, default: null },
    estimatedDeliveryDate: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    recipientName: { type: String, trim: true, default: '' },
    feedback: {
      rating: { type: Number, min: 1, max: 5, default: null },
      comments: { type: String, trim: true, maxlength: 2000, default: '' },
      interestedInOrder: { type: Boolean, default: null },
      requiresImprovement: { type: Boolean, default: false },
      routedDepartment: {
        type: String,
        enum: ['R&D / Technical', 'Quality Control', 'Production', 'Sales', 'None'],
        default: 'None'
      },
      improvementNotes: { type: String, trim: true, maxlength: 2000, default: '' },
      routedTaskId: { type: String, trim: true, default: null },
      feedbackDate: { type: Date, default: null },
      submittedBy: { type: String, default: null }
    },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_sample_requests',
    timestamps: true
  }
);

SampleRequestSchema.index({ tenantId: 1, sampleNumber: 1 }, { name: 'sample_requests_number' });
SampleRequestSchema.index({ tenantId: 1, status: 1 }, { name: 'sample_requests_status' });
SampleRequestSchema.index({ tenantId: 1, leadId: 1 }, { name: 'sample_requests_lead' });
SampleRequestSchema.index({ tenantId: 1, clientId: 1 }, { name: 'sample_requests_client' });
SampleRequestSchema.index({ tenantId: 1, opportunityId: 1 }, { name: 'sample_requests_opportunity' });

module.exports = {
  name: 'SampleRequest',
  schema: SampleRequestSchema
};
