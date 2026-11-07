'use strict';

const { Schema } = require('mongoose');

// Allowed values live in a mongoose-free module so services can read them.
const {
  EVENT_TYPES,
  EVENT_STATUSES,
  EVENT_KINDS,
  EVENT_SOURCES
} = require('../utils/lead-event.constants');

/**
 * Where the sales rep physically was. Captured from the browser when the
 * activity is created and again when it is marked Completed, so a field visit
 * can be evidenced on the Activity Location report.
 */
const ActivityLocationSchema = new Schema(
  {
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    /** Metres of GPS uncertainty reported by the browser. */
    accuracy: { type: Number, default: null },
    /** Reverse-geocoded label; may be blank when lookup fails. */
    address: { type: String, trim: true, maxlength: 400, default: '' },
    capturedAt: { type: Date, default: null },
    /** Why there are no coordinates (permission denied, unsupported, timeout). */
    unavailableReason: { type: String, trim: true, maxlength: 200, default: '' }
  },
  { _id: false }
);

const LeadEventSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    leadId: { type: String, required: true, trim: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    eventType: { type: String, trim: true, maxlength: 80, default: 'Other' },
    eventDate: { type: Date, required: true },
    status: { type: String, enum: EVENT_STATUSES, default: 'Open' },
    kind: { type: String, enum: EVENT_KINDS, default: 'logged', index: true },
    source: { type: String, enum: EVENT_SOURCES, default: 'manual', index: true },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    assignedTo: { type: String, trim: true, default: '' },

    /** Rep's position when the activity was created. */
    createdLocation: { type: ActivityLocationSchema, default: null },
    /** Rep's starting location when accepting the assigned activity. */
    acceptedLocation: { type: ActivityLocationSchema, default: null },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: String, trim: true, default: '' },
    /** Rep's position when they pressed Completed. */
    completedLocation: { type: ActivityLocationSchema, default: null },
    /** Planned / target location pinned for field visits or meetings. */
    goalLocation: { type: ActivityLocationSchema, default: null },
    reachedGoalArea: { type: Boolean, default: false },
    reachedGoalAt: { type: Date, default: null },
    reachedAt: { type: Date, default: null },
    latestUserLocation: { type: ActivityLocationSchema, default: null },
    latestDistanceFromGoal: { type: Number, default: null },
    completedAt: { type: Date, default: null },
    completedBy: { type: String, trim: true, default: '' },

    /** Set once a commercial-requirement activity has been converted. */
    convertedOpportunityId: { type: String, trim: true, default: '' },

    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_lead_events',
    timestamps: true
  }
);

LeadEventSchema.index({ tenantId: 1, leadId: 1, eventDate: -1 }, { name: 'lead_events_tenant_lead_date' });
// Backs the Activity Location report: tenant feed newest-first, coordinates only.
LeadEventSchema.index({ tenantId: 1, createdAt: -1 }, { name: 'lead_events_tenant_created' });

module.exports = {
  name: 'LeadEvent',
  schema: LeadEventSchema,
  EVENT_TYPES,
  EVENT_STATUSES,
  EVENT_KINDS,
  EVENT_SOURCES
};
