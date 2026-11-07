'use strict';

const { Schema } = require('mongoose');

const CLIENT_EVENT_TYPES = [
  'Call',
  'Meeting',
  'Email',
  'Demo',
  'Follow-up',
  'Note',
  'Milestone',
  'Other'
];

const CLIENT_EVENT_STATUSES = ['Open', 'Completed'];

const ClientEventSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    clientId: { type: String, required: true, trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    eventType: { type: String, enum: CLIENT_EVENT_TYPES, default: 'Other' },
    eventDate: { type: Date, required: true },
    durationMinutes: { type: Number, default: 0, min: 0, max: 1440 },
    status: { type: String, enum: CLIENT_EVENT_STATUSES, default: 'Open' },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    attendees: { type: [String], default: [] },
    nextAction: { type: String, trim: true, maxlength: 500, default: '' },
    createdBy: { type: String, default: 'system' },
    createdByName: { type: String, default: '' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_client_events',
    timestamps: true
  }
);

ClientEventSchema.index(
  { tenantId: 1, clientId: 1, eventDate: -1 },
  { name: 'client_events_tenant_client_date' }
);

module.exports = {
  name: 'ClientEvent',
  schema: ClientEventSchema,
  CLIENT_EVENT_TYPES,
  CLIENT_EVENT_STATUSES
};
