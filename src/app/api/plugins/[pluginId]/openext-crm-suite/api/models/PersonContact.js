'use strict';

const { Schema } = require('mongoose');

/**
 * PersonContact — standalone CRM contact directory used by Leads.
 * Distinct from client-company Contact (`Contact` model).
 */
const PersonContactSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    salutation: { type: String, trim: true, maxlength: 20, default: '' },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    photoUrl: { type: String, trim: true, maxlength: 2048, default: '' },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: '' },
    phone: { type: String, trim: true, maxlength: 16, default: '' },
    gender: {
      type: String,
      enum: ['', 'Male', 'Female', 'Other', 'Prefer not to say'],
      default: ''
    },
    pan: { type: String, trim: true, uppercase: true, maxlength: 10, default: '' },
    jobTitle: { type: String, trim: true, maxlength: 120, default: '' },
    companyName: { type: String, trim: true, maxlength: 120, default: '' },
    leadIds: { type: [String], default: [] },
    leadsCount: { type: Number, default: 0, min: 0 },
    /** Client company ids this person is linked to (from client Contacts tab). */
    clientIds: { type: [String], default: [] },
    clientsCount: { type: Number, default: 0, min: 0 },
    /** CRM 3.36.0: a client portal user was created for this contact (no second one is allowed). */
    IsportalAssigned: { type: Boolean, default: false },
    portalAssignedAt: { type: Date, default: null },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_person_contacts',
    timestamps: true
  }
);

PersonContactSchema.index({ tenantId: 1, email: 1 }, { name: 'person_contacts_tenant_email' });
PersonContactSchema.index({ tenantId: 1, phone: 1 }, { name: 'person_contacts_tenant_phone' });
PersonContactSchema.index({ tenantId: 1, pan: 1 }, { name: 'person_contacts_tenant_pan' });
PersonContactSchema.index({ tenantId: 1, name: 1 }, { name: 'person_contacts_tenant_name' });
PersonContactSchema.index({ tenantId: 1, companyName: 1 }, { name: 'person_contacts_tenant_company' });
PersonContactSchema.index({ tenantId: 1, createdAt: -1 }, { name: 'person_contacts_tenant_created' });

module.exports = {
  name: 'PersonContact',
  schema: PersonContactSchema
};
