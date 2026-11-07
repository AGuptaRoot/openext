'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertRequired,
  assertMaxLength
} = require('./common.util');

const VALID_CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'CAD', 'AUD', 'JPY']);

function validateCreditNoteItems(errors, items) {
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('At least one item is required');
    return [];
  }
  const valid = [];
  for (let i = 0; i < items.length; i++) {
    const item = asObject(items[i]);
    const description = trimString(item.description || item.name);
    if (!description) {
      errors.push(`Item #${i + 1} must have a description`);
      continue;
    }
    const quantity = Number(item.quantity !== undefined ? item.quantity : (item.qty !== undefined ? item.qty : 1));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push(`Item #${i + 1} quantity must be greater than 0`);
    }
    const unitPrice = Number(item.unitPrice !== undefined ? item.unitPrice : (item.rate !== undefined ? item.rate : (item.price !== undefined ? item.price : 0)));
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      errors.push(`Item #${i + 1} unitPrice must be a non-negative number`);
    }
    const tax = item.tax !== undefined ? Number(item.tax) : 0;
    const amount = Number(item.amount);
    const calculated = Math.round(quantity * unitPrice * 100) / 100;

    valid.push({
      description,
      quantity,
      unitPrice,
      tax: Math.max(0, tax),
      amount: Number.isFinite(amount) && amount > 0 ? amount : calculated
    });
  }
  return valid;
}

function validateCreditNoteCreate(body) {
  const source = asObject(body);
  const errors = [];

  const clientId = trimString(source.clientId);
  assertRequired(errors, clientId, 'Client');

  const reason = trimString(source.reason) || 'Customer Return / Adjustment';
  assertMaxLength(errors, reason, 500, 'Reason');

  let currency = trimString(source.currency) || 'INR';
  if (currency && !VALID_CURRENCIES.has(currency.toUpperCase())) {
    currency = 'INR';
  } else {
    currency = currency.toUpperCase();
  }

  const items = validateCreditNoteItems(errors, source.items);
  const notes = trimString(source.notes) || '';
  const invoiceId = trimString(source.invoiceId) || null;

  assertMaxLength(errors, notes, 2000, 'Notes');

  if (errors.length) return fail(errors);

  return ok({
    clientId,
    invoiceId,
    reason,
    currency,
    items,
    notes
  });
}

function validateCreditNoteFromInvoice(body) {
  const source = asObject(body);
  const errors = [];

  const invoiceId = trimString(source.invoiceId);
  assertRequired(errors, invoiceId, 'Invoice ID');

  const reason = trimString(source.reason) || 'Invoice Adjustment / Credit';
  assertMaxLength(errors, reason, 500, 'Reason');

  const notes = trimString(source.notes) || '';
  assertMaxLength(errors, notes, 2000, 'Notes');

  // items can be passed specifically, or if omitted/empty, will credit the full eligible balance of the invoice
  let items = [];
  if (Array.isArray(source.items) && source.items.length > 0) {
    items = validateCreditNoteItems(errors, source.items);
  }

  const creditAmount = source.creditAmount !== undefined ? Number(source.creditAmount) : null;
  if (creditAmount !== null && (!Number.isFinite(creditAmount) || creditAmount <= 0)) {
    errors.push('Credit amount must be greater than zero');
  }

  if (errors.length) return fail(errors);

  return ok({
    invoiceId,
    reason,
    notes,
    items,
    creditAmount
  });
}

function validateCreditNoteApply(body) {
  const source = asObject(body);
  const errors = [];

  const invoiceId = trimString(source.invoiceId);
  assertRequired(errors, invoiceId, 'Invoice ID to apply credit to');

  const amount = Number(source.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    errors.push('Amount to apply must be greater than zero');
  }

  if (errors.length) return fail(errors);

  return ok({
    invoiceId,
    amount
  });
}

function validateCreditNoteRefund(body) {
  const source = asObject(body);
  const errors = [];

  const amount = Number(source.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    errors.push('Refund amount must be greater than zero');
  }

  const refundMode = trimString(source.refundMode) || 'Bank Transfer';
  const notes = trimString(source.notes) || '';
  assertMaxLength(errors, notes, 1000, 'Refund notes');

  if (errors.length) return fail(errors);

  return ok({
    amount,
    refundMode,
    notes
  });
}

module.exports = {
  validateCreditNoteCreate,
  validateCreditNoteFromInvoice,
  validateCreditNoteApply,
  validateCreditNoteRefund
};
