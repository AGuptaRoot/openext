'use strict';

/**
 * CRM 3.59.0 — a user's push choices: the alert types they switched off (e.g. ["followup_due"]).
 * No row = every type on. The in-app bell always keeps every alert; this only decides the phone push.
 */

const { Schema } = require('mongoose');

const CrmPushPreferenceSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true },
    userId: { type: String, required: true, trim: true },
    off: { type: [String], default: [] }
  },
  {
    collection: 'plugin_openext_crm_suite_push_preferences',
    timestamps: true
  }
);

CrmPushPreferenceSchema.index({ tenantId: 1, userId: 1 }, { unique: true, name: 'crm_push_preference_user' });

module.exports = {
  name: 'CrmPushPreference',
  schema: CrmPushPreferenceSchema
};
