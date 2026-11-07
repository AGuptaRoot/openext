'use strict';

const { Schema } = require('mongoose');

/**
 * One timestamped note on a lead.
 *
 * Replaces the single free-text `Lead.notes` field for new entries: each note
 * is its own row so the Notes tab can list them separately with who wrote them
 * and when. The legacy `Lead.notes` string is left untouched and is still
 * displayed, so nothing written before this existed is lost.
 */
const LeadNoteSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    leadId: { type: String, required: true, trim: true, index: true },
    content: { type: String, required: true, trim: true, maxlength: 5000 },
    createdBy: { type: String, default: 'system' },
    /** Resolved at write time so the list reads correctly even if the user is removed. */
    createdByName: { type: String, trim: true, default: '' },
    updatedBy: { type: String, default: 'system' },
    /** Set the first time the note is edited, so the UI can show "edited". */
    editedAt: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_lead_notes',
    timestamps: true
  }
);

// Newest-first listing per lead.
LeadNoteSchema.index({ tenantId: 1, leadId: 1, createdAt: -1 }, { name: 'lead_notes_tenant_lead_date' });

module.exports = {
  name: 'LeadNote',
  schema: LeadNoteSchema
};
