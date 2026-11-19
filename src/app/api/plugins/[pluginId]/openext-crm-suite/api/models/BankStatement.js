'use strict';

const { Schema } = require('mongoose');

/**
 * Bank statement lines for matching (GST suite, CRM 3.53.0; documentation/gst-planning/04 §3).
 * The statement file is read in the browser: only its lines are saved here (no file is stored anywhere).
 * Lines use the GST app's bank line shape (lib/gst-core bankMatch.js toBankLines).
 */
const BankLineSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    /** 'YYYY-MM-DD' */
    date: { type: String, required: true, trim: true },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    /** UTR / cheque no. */
    reference: { type: String, trim: true, maxlength: 60, default: '' },
    credit: { type: Number, default: 0, min: 0 },
    debit: { type: Number, default: 0, min: 0 },
    balance: { type: Number, default: 0 },
    status: { type: String, enum: ['open', 'matched', 'ignored'], default: 'open' },
    /** { key, kind, id, number?, paymentId, recorded, label, at, by } */
    match: { type: Schema.Types.Mixed, default: null }
  },
  { _id: false }
);

const BankStatementSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    /** Which bank account (free text, e.g. "HDFC current"). */
    account: { type: String, trim: true, maxlength: 120, default: '' },
    fileName: { type: String, trim: true, maxlength: 200, default: '' },
    importedBy: { type: String, default: '' },
    lines: { type: [BankLineSchema], default: [] }
  },
  {
    collection: 'plugin_openext_crm_suite_bank_statements',
    timestamps: true
  }
);

BankStatementSchema.index({ tenantId: 1, account: 1, createdAt: -1 }, { name: 'bank_statements_tenant_account' });

module.exports = {
  name: 'BankStatement',
  schema: BankStatementSchema
};
