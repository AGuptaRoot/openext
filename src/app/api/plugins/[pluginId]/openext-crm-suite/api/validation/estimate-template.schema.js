'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertRequired,
  assertMaxLength
} = require('./common.util');

const VALID_TAX_CALC_MODES = new Set(['after_discount', 'before_discount']);
const VALID_CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'CAD', 'AUD', 'JPY']);

function validateLineItems(errors, lineItems) {
  if (!Array.isArray(lineItems)) return [];
  const valid = [];
  for (let i = 0; i < lineItems.length; i++) {
    const item = asObject(lineItems[i]);
    const description = trimString(item.description);
    if (!description && !trimString(item.name)) {
      errors.push(`Line item #${i + 1} must have a description or item name`);
      continue;
    }
    if (description.length > 500) {
      errors.push(`Line item #${i + 1} description cannot exceed 500 characters`);
    }

    const qty = Number(item.qty);
    if (!Number.isFinite(qty) || qty < 0) {
      errors.push(`Line item #${i + 1} qty must be a non-negative number`);
    }

    const rate = Number(item.rate);
    if (!Number.isFinite(rate) || rate < 0) {
      errors.push(`Line item #${i + 1} rate must be a non-negative number`);
    }

    const tax = item.tax !== undefined ? Number(item.tax) : 0;
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) {
      errors.push(`Line item #${i + 1} tax must be between 0 and 100`);
    }

    const amount = Number(item.amount);
    const calculatedAmount = Math.round(qty * rate * 100) / 100;

    valid.push({
      name: trimString(item.name) || description,
      description: description || trimString(item.name),
      qty,
      rate,
      tax: Math.max(0, tax),
      amount: Number.isFinite(amount) && amount > 0 ? amount : calculatedAmount,
      file: trimString(item.file) || '',
      productId: trimString(item.productId) || null
    });
  }
  return valid;
}

function validateEstimateTemplateCreate(body) {
  const source = asObject(body);
  const errors = [];

  const name = trimString(source.name);
  assertRequired(errors, name, 'Template Name');
  assertMaxLength(errors, name, 200, 'Template Name');

  const description = trimString(source.description);
  assertMaxLength(errors, description, 1000, 'Description');

  const category = trimString(source.category) || 'General';
  assertMaxLength(errors, category, 100, 'Category');

  let currency = trimString(source.currency) || 'INR';
  if (currency && !VALID_CURRENCIES.has(currency.toUpperCase())) {
    currency = 'INR';
  } else {
    currency = currency.toUpperCase();
  }

  let taxCalculation = trimString(source.taxCalculation) || 'after_discount';
  if (!VALID_TAX_CALC_MODES.has(taxCalculation)) {
    taxCalculation = 'after_discount';
  }

  const lineItems = validateLineItems(errors, source.lineItems || []);

  const discountPercent = source.discountPercent !== undefined && source.discountPercent !== null
    ? Math.min(100, Math.max(0, Number(source.discountPercent) || 0))
    : 0;

  const shippingState = trimString(source.shippingState) || '';
  const notes = trimString(source.notes) || '';
  const recipientNotes = trimString(source.recipientNotes) || '';
  const terms = trimString(source.terms) || '';
  const isDefault = Boolean(source.isDefault);

  assertMaxLength(errors, notes, 2000, 'Notes');
  assertMaxLength(errors, recipientNotes, 2000, 'Recipient Notes');
  assertMaxLength(errors, terms, 3000, 'Terms');

  if (errors.length) return fail(errors);

  return ok({
    name,
    description,
    category,
    currency,
    taxCalculation,
    lineItems,
    discountPercent,
    shippingState,
    notes,
    recipientNotes,
    terms,
    isDefault
  });
}

function validateEstimateTemplateUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const updates = {};

  if (source.name !== undefined) {
    updates.name = trimString(source.name);
    assertRequired(errors, updates.name, 'Template Name');
    assertMaxLength(errors, updates.name, 200, 'Template Name');
  }

  if (source.description !== undefined) {
    updates.description = trimString(source.description);
    assertMaxLength(errors, updates.description, 1000, 'Description');
  }

  if (source.category !== undefined) {
    updates.category = trimString(source.category) || 'General';
    assertMaxLength(errors, updates.category, 100, 'Category');
  }

  if (source.currency !== undefined) {
    const cur = trimString(source.currency).toUpperCase();
    if (VALID_CURRENCIES.has(cur)) updates.currency = cur;
  }

  if (source.taxCalculation !== undefined) {
    const mode = trimString(source.taxCalculation);
    if (VALID_TAX_CALC_MODES.has(mode)) updates.taxCalculation = mode;
  }

  if (source.lineItems !== undefined) {
    updates.lineItems = validateLineItems(errors, source.lineItems);
  }

  if (source.discountPercent !== undefined && source.discountPercent !== null) {
    updates.discountPercent = Math.min(100, Math.max(0, Number(source.discountPercent) || 0));
  }

  if (source.shippingState !== undefined) {
    updates.shippingState = trimString(source.shippingState);
  }

  if (source.notes !== undefined) {
    updates.notes = trimString(source.notes);
    assertMaxLength(errors, updates.notes, 2000, 'Notes');
  }

  if (source.recipientNotes !== undefined) {
    updates.recipientNotes = trimString(source.recipientNotes);
    assertMaxLength(errors, updates.recipientNotes, 2000, 'Recipient Notes');
  }

  if (source.terms !== undefined) {
    updates.terms = trimString(source.terms);
    assertMaxLength(errors, updates.terms, 3000, 'Terms');
  }

  if (source.isDefault !== undefined) {
    updates.isDefault = Boolean(source.isDefault);
  }

  if (errors.length) return fail(errors);
  return ok(updates);
}

module.exports = {
  validateEstimateTemplateCreate,
  validateEstimateTemplateUpdate
};
