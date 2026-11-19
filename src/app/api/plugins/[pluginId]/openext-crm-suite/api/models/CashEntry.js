'use strict';

const { Schema } = require('mongoose');

/**
 * Cash book — manual entries only (GST suite, CRM 3.53.0; documentation/gst-planning/02 §3).
 *
 * Cash payments (Payment mode Cash), approved cash expenses and cash refunds appear in the cash book by
 * themselves, read from their own records: they are never copied here. This holds only what has no other
 * record: opening balance, petty cash, bank deposits / withdrawals, owner drawings and costs an extension
 * links to its own records (refType / refId, e.g. "travel.booking").
 * There is no running balance field: the book is built (sorted, balance added) every time it is read.
 */

const { BASE_CASH_CATEGORIES } = require('../utils/cash-categories.util');

const CashEntrySchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    type: { type: String, enum: ['in', 'out'], required: true },
    /** 'YYYY-MM-DD' (India date). */
    date: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0.01 },
    category: { type: String, trim: true, maxlength: 60, default: 'Other' },
    /** Person or party. */
    name: { type: String, trim: true, maxlength: 120, default: '' },
    note: { type: String, trim: true, maxlength: 500, default: '' },
    /** Generic link to an extension record: "<extensionId>.<refType>" + its id. */
    refType: { type: String, trim: true, maxlength: 80, default: '' },
    refId: { type: String, trim: true, maxlength: 64, default: '' },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    /** Soft delete, kept for the audit trail. */
    isDeleted: { type: Boolean, default: false },
    deletedBy: { type: String, default: null },
    deletedAt: { type: Date, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_cash_entries',
    timestamps: true
  }
);

CashEntrySchema.index({ tenantId: 1, isDeleted: 1, date: 1 }, { name: 'cash_entries_tenant_date' });
CashEntrySchema.index({ tenantId: 1, refType: 1, refId: 1 }, { name: 'cash_entries_tenant_ref' });

module.exports = {
  name: 'CashEntry',
  schema: CashEntrySchema,
  BASE_CASH_CATEGORIES
};
