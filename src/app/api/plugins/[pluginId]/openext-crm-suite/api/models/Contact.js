'use strict';

const { Schema } = require('mongoose');

/**
 * Contact model — people linked to a client company.
 */
const ContactSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    companyId: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: '' },
    phone: { type: String, trim: true, maxlength: 16, match: /^$|^\+?\d{7,15}$/, default: '' },
    designation: { type: String, trim: true, maxlength: 80, default: '' },
    /** Directory PersonContact id when linked from Contacts module. */
    personContactId: { type: String, trim: true, default: null, index: true },
    isPrimary: { type: Boolean, default: false },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    status: { type: String, default: 'active' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_contacts',
    timestamps: true
  }
);

ContactSchema.index({ tenantId: 1, companyId: 1 }, { name: 'contacts_tenant_company' });

module.exports = {
  name: 'Contact',
  schema: ContactSchema
};
