'use strict';

const { Schema } = require('mongoose');

/**
 * Mongoose Schema for Support Ticket model.
 * Collection: plugin_openext_crm_suite_tickets
 */
const TicketSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    ticketNumber: { type: String, required: true, trim: true, index: true },
    requesterType: { type: String, enum: ['Client', 'Employee'], default: 'Client', index: true },
    requesterId: { type: String, trim: true, default: null },
    requesterName: { type: String, trim: true, default: '' },
    requesterCompany: { type: String, trim: true, default: '' },
    clientId: { type: String, trim: true, default: '', index: true }, // Account / Client
    /** Set when the ticket was raised by (or for) a lead-portal user. */
    leadId: { type: String, trim: true, default: '', index: true },
    contactPerson: { type: String, trim: true, default: '' },
    contactEmail: { type: String, trim: true, default: '' },
    contactMobile: { type: String, trim: true, default: '' },
    assignGroup: { type: String, trim: true, default: 'Technical', index: true },
    projectId: { type: String, trim: true, default: null, index: true },
    channelName: { type: String, trim: true, default: 'Email', index: true },
    tags: [{ type: String, trim: true }],
    subject: { type: String, required: true, trim: true, maxlength: 500 },
    description: { type: String, required: true, trim: true, maxlength: 20000 },
    type: {
      type: String,
      trim: true,
      default: 'Service Request',
      index: true
    },
    priority: {
      type: String,
      trim: true,
      default: 'Medium',
      index: true
    },
    status: {
      type: String,
      trim: true,
      default: 'Open',
      index: true
    },
    slaDueDate: { type: Date, required: true, index: true },
    slaHours: { type: Number, required: true, default: 48 },
    slaBreached: { type: Boolean, default: false, index: true },
    firstResponseAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNotes: { type: String, trim: true, maxlength: 2000, default: '' },
    satisfactionRating: { type: Number, min: 1, max: 5, default: null },
    assignedTo: { type: String, trim: true, default: null },
    watchers: [{ type: String, trim: true }],
    messages: [
      {
        senderId: { type: String, default: '' },
        senderName: { type: String, default: '' },
        senderRole: { type: String, default: 'Agent' },
        isInternal: { type: Boolean, default: false },
        message: { type: String, required: true },
        attachments: [{ name: String, url: String, size: Number, type: String }],
        createdAt: { type: Date, default: Date.now }
      }
    ],
    reassignmentHistory: [
      {
        fromUser: String,
        toUser: String,
        reallocatedBy: String,
        reason: String,
        reassignedAt: { type: Date, default: Date.now }
      }
    ],
    escalationLevel: { type: String, default: 'Standard' },
    isArchived: { type: Boolean, default: false, index: true },
    extension: { type: Schema.Types.Mixed, default: () => ({}) },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_tickets',
    timestamps: true
  }
);

TicketSchema.index({ tenantId: 1, ticketNumber: 1 }, { name: 'tck_tenant_number' });
TicketSchema.index({ tenantId: 1, clientId: 1 }, { name: 'tck_tenant_client' });
TicketSchema.index({ tenantId: 1, leadId: 1 }, { name: 'tck_tenant_lead' });
TicketSchema.index({ tenantId: 1, projectId: 1 }, { name: 'tck_tenant_project' });
TicketSchema.index({ tenantId: 1, assignGroup: 1 }, { name: 'tck_tenant_group' });
TicketSchema.index({ tenantId: 1, status: 1, priority: 1 }, { name: 'tck_status_priority' });

module.exports = {
  name: 'Ticket',
  schema: TicketSchema
};
