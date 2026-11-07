'use strict';

/**
 * In-app notifications for CRM staff (CRM 3.33.0), e.g. an extension's "Passport Expiry Alert".
 * One row per user and alert; `dedupeKey` makes the same alert reach a user only once.
 * Never holds document numbers or other secrets: a title, a short message and an in-app link.
 */

const { Schema } = require('mongoose');

const CrmNotificationSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    userId: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    message: { type: String, default: '', trim: true, maxlength: 500 },
    link: { type: String, default: '', trim: true, maxlength: 300 },
    linkLabel: { type: String, default: '', trim: true, maxlength: 40 },
    // Who raised it: 'crm' or 'ext:<extensionId>'.
    source: { type: String, default: 'crm', trim: true, maxlength: 80 },
    dedupeKey: { type: String, required: true, trim: true, maxlength: 200 },
    readAt: { type: Date, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_notifications',
    timestamps: true
  }
);

// Once per user and alert; newest first per user.
CrmNotificationSchema.index({ tenantId: 1, userId: 1, dedupeKey: 1 }, { unique: true, name: 'crm_notifications_once' });
CrmNotificationSchema.index({ tenantId: 1, userId: 1, createdAt: -1 }, { name: 'crm_notifications_user_date' });

module.exports = {
  name: 'CrmNotification',
  schema: CrmNotificationSchema
};
