'use strict';

/**
 * CRM 3.59.0 — a phone that receives push notifications (Firebase Cloud Messaging) for one CRM user of one
 * tenant. The FCM token is stored encrypted (it lets anyone send to that phone); `tokenHash` finds a token
 * again without decrypting. A token belongs to one user + tenant at a time: registering it again (e.g. a
 * different person logs in on the same phone) moves it.
 */

const { Schema } = require('mongoose');

const CrmPushDeviceSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    userId: { type: String, required: true, trim: true },
    tokenHash: { type: String, required: true, trim: true, maxlength: 128 },
    token: { type: String, required: true },
    platform: { type: String, enum: ['android', 'ios', 'web'], required: true },
    appVersion: { type: String, default: '', trim: true, maxlength: 40 },
    deviceName: { type: String, default: '', trim: true, maxlength: 80 },
    lastSeenAt: { type: Date, default: Date.now }
  },
  {
    collection: 'plugin_openext_crm_suite_push_devices',
    timestamps: true
  }
);

CrmPushDeviceSchema.index({ tenantId: 1, tokenHash: 1 }, { unique: true, name: 'crm_push_device_token' });
CrmPushDeviceSchema.index({ tenantId: 1, userId: 1 }, { name: 'crm_push_device_user' });

module.exports = {
  name: 'CrmPushDevice',
  schema: CrmPushDeviceSchema
};
