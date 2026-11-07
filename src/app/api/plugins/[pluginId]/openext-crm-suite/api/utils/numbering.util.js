'use strict';

/**
 * Auto-numbering for quotations, invoices, payments, and client tax IDs.
 * Sequence counters are stored as CRM settings keys (not shown in Settings UI).
 */
const COUNTER_KEYS = {
  quotation: { counter: 'quotation_sequence', prefixKey: 'quotation_prefix', defaultPrefix: 'QUO-' },
  invoice: { counter: 'invoice_sequence', prefixKey: 'invoice_prefix', defaultPrefix: 'INV-' },
  // Separate series on purpose: a proforma must never consume a tax-invoice
  // number, and the two are reported differently.
  proforma: { counter: 'proforma_sequence', prefixKey: 'proforma_prefix', defaultPrefix: 'PI-' },
  payment: { counter: 'payment_sequence', prefixKey: 'payment_prefix', defaultPrefix: 'PAY-' },
  expense: { counter: 'expense_sequence', prefixKey: 'expense_prefix', defaultPrefix: 'EXP-' },
  salesOrder: { counter: 'sales_order_sequence', prefixKey: 'sales_order_prefix', defaultPrefix: 'SO-' },
  sales_order: { counter: 'sales_order_sequence', prefixKey: 'sales_order_prefix', defaultPrefix: 'SO-' },
  creditNote: { counter: 'credit_note_sequence', prefixKey: 'credit_note_prefix', defaultPrefix: 'CN-' },
  credit_note: { counter: 'credit_note_sequence', prefixKey: 'credit_note_prefix', defaultPrefix: 'CN-' },
  refund: { counter: 'refund_sequence', prefixKey: 'refund_prefix', defaultPrefix: 'REF-' },
  clientTaxId: {
    counter: 'client_tax_id_sequence',
    prefixKey: 'client_tax_id_prefix',
    defaultPrefix: 'TAX-'
  }
};

/**
 * Format: PREFIX + zero-padded sequence e.g. QUO-0001
 */
function formatNumber(prefix, sequence) {
  const safePrefix = String(prefix || '');
  const num = Math.max(1, Number(sequence) || 1);
  return `${safePrefix}${String(num).padStart(4, '0')}`;
}

function parseSequenceFromDocumentNumber(prefix, documentNumber) {
  const safePrefix = String(prefix || '');
  const docNo = String(documentNumber || '').trim();
  if (!docNo.startsWith(safePrefix)) return null;
  const parsed = parseInt(docNo.slice(safePrefix.length), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
}

/**
 * Keep the settings counter in sync when a document number is assigned explicitly.
 */
async function syncSequenceFromDocumentNumber(req, type, documentNumber) {
  const config = COUNTER_KEYS[type];
  if (!config) return;

  const SettingService = require('../services/setting.service');
  const settings = await SettingService.getAll(req);
  const prefix = settings[config.prefixKey] || config.defaultPrefix || '';
  const parsed = parseSequenceFromDocumentNumber(prefix, documentNumber);
  if (parsed == null) return;

  await SettingService.setCounterAtLeast(req, config.counter, parsed);
}

/**
 * Get next document number and increment tenant counter atomically via settings.
 */
async function getNextNumber(req, type) {
  const config = COUNTER_KEYS[type];
  if (!config) throw new Error(`Unknown number type: ${type}`);

  const SettingService = require('../services/setting.service');
  const settings = await SettingService.getAll(req);

  const prefix =
    settings[config.prefixKey] || config.defaultPrefix || '';
  const next = await SettingService.incrementCounter(req, config.counter);

  return formatNumber(prefix, next);
}

/**
 * Allocate a unique invoice-style document number, retrying if the counter lags behind existing records.
 */
async function allocateUniqueNumber(req, type, options = {}) {
  const config = COUNTER_KEYS[type];
  if (!config) throw new Error(`Unknown number type: ${type}`);

  const SettingService = require('../services/setting.service');
  const settings = await SettingService.getAll(req);
  const prefix = settings[config.prefixKey] || config.defaultPrefix || '';
  const preferred = options.preferredNumber ? String(options.preferredNumber).trim() : '';

  if (preferred) {
    const parsed = parseSequenceFromDocumentNumber(prefix, preferred);
    if (parsed != null) {
      await SettingService.setCounterAtLeast(req, config.counter, parsed);
    }
    return preferred;
  }

  const existsFn = typeof options.exists === 'function' ? options.exists : null;
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 12);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = await getNextNumber(req, type);
    if (!existsFn) return candidate;

    const taken = await existsFn(candidate);
    if (!taken) return candidate;

    const parsed = parseSequenceFromDocumentNumber(prefix, candidate);
    if (parsed != null) {
      await SettingService.setCounterAtLeast(req, config.counter, parsed);
    }
  }

  throw new Error(`Unable to allocate a unique ${type} number`);
}

module.exports = {
  formatNumber,
  parseSequenceFromDocumentNumber,
  syncSequenceFromDocumentNumber,
  getNextNumber,
  allocateUniqueNumber,
  COUNTER_KEYS
};
