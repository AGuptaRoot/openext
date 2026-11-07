'use strict';

const { Schema } = require('mongoose');

/**
 * Activity Periodic Location Log
 * Stores periodic geolocation logs (e.g., every 30 minutes while an activity is in progress).
 */
const ActivityLocationLogSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    activityId: { type: String, required: true, trim: true, index: true },
    leadId: { type: String, trim: true, default: '', index: true },
    salesRepId: { type: String, required: true, trim: true, index: true },
    salesRepName: { type: String, trim: true, default: '' },
    activityType: { type: String, trim: true, default: 'Other' },
    activityTitle: { type: String, trim: true, default: '' },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    accuracy: { type: Number, default: null },
    address: { type: String, trim: true, default: '' },
    distanceFromGoal: { type: Number, default: null },
    distanceFormatted: { type: String, trim: true, default: '' },
    reachedGoalArea: { type: Boolean, default: false },
    reachedGoalAreaText: { type: String, trim: true, default: 'No' },
    statusText: { type: String, trim: true, default: 'Not Reached Goal Area' },
    reachedAt: { type: Date, default: null },
    loggedAt: { type: Date, default: Date.now, index: true }
  },
  {
    collection: 'plugin_openext_crm_suite_activity_location_logs',
    timestamps: true
  }
);

ActivityLocationLogSchema.index(
  { tenantId: 1, activityId: 1, loggedAt: 1 },
  { name: 'activity_location_logs_tenant_activity_logged' }
);

module.exports = {
  name: 'ActivityLocationLog',
  schema: ActivityLocationLogSchema
};
