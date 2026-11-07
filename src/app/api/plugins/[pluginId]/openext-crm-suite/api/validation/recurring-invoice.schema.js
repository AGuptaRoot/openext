'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertRequired,
  assertMaxLength
} = require('./common.util');

const VALID_FREQUENCIES = new Set(['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'custom']);
const VALID_END_CONDITIONS = new Set(['never', 'on_date', 'after_cycles']);
const VALID_STATUSES = new Set(['Active', 'Paused', 'Completed']);
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
    const qty = Number(item.qty);
    if (!Number.isFinite(qty) || qty < 0) {
      errors.push(`Line item #${i + 1} qty must be a non-negative number`);
    }
    const rate = Number(item.rate);
    if (!Number.isFinite(rate) || rate < 0) {
      errors.push(`Line item #${i + 1} rate must be a non-negative number`);
    }
    const tax = item.tax !== undefined ? Number(item.tax) : 0;
    valid.push({
      name: trimString(item.name) || description,
      description: description || trimString(item.name),
      qty,
      rate,
      tax: Math.max(0, tax),
      amount: Math.round(qty * rate * 100) / 100,
      productId: trimString(item.productId) || null
    });
  }
  return valid;
}

function validateRecurringInvoiceCreate(body) {
  const source = asObject(body);
  const errors = [];

  const frequency = trimString(source.frequency) || 'monthly';
  if (!VALID_FREQUENCIES.has(frequency)) {
    errors.push('Invalid recurrence frequency');
  }

  let profileName = trimString(source.profileName);
  if (!profileName) {
    profileName = `${frequency.charAt(0).toUpperCase() + frequency.slice(1)} Recurring Invoice`;
  }
  assertMaxLength(errors, profileName, 200, 'Profile Name');

  const clientId = trimString(source.clientId);
  assertRequired(errors, clientId, 'Client');

  const projectId = trimString(source.projectId) || null;
  const bankAccount = trimString(source.bankAccount) || '';
  const clientCanStopRecurring = Boolean(source.clientCanStopRecurring);

  const customIntervalDays = source.customIntervalDays !== undefined
    ? Math.max(1, Math.min(365, Number(source.customIntervalDays) || 30))
    : 30;

  const startDate = source.startDate ? new Date(source.startDate) : new Date();
  if (isNaN(startDate.getTime())) {
    errors.push('Invalid start date');
  }

  const nextRunDate = source.nextRunDate ? new Date(source.nextRunDate) : new Date(startDate);
  if (isNaN(nextRunDate.getTime())) {
    errors.push('Invalid next run date');
  }

  const endCondition = trimString(source.endCondition) || 'never';
  if (!VALID_END_CONDITIONS.has(endCondition)) {
    errors.push('Invalid end condition');
  }

  let endDate = null;
  if (endCondition === 'on_date' && source.endDate) {
    endDate = new Date(source.endDate);
    if (isNaN(endDate.getTime())) {
      errors.push('Invalid end date');
    }
  }

  let totalCycles = null;
  if (endCondition === 'after_cycles' && source.totalCycles !== undefined) {
    totalCycles = Math.max(1, Number(source.totalCycles) || 1);
  }

  let currency = trimString(source.currency) || 'INR';
  if (currency && !VALID_CURRENCIES.has(currency.toUpperCase())) {
    currency = 'INR';
  } else {
    currency = currency.toUpperCase();
  }

  const lineItems = validateLineItems(errors, source.lineItems || []);
  const discountType = source.discountType === 'amount' ? 'amount' : 'percent';
  const discountValRaw = source.discountValue !== undefined ? Number(source.discountValue) : Number(source.discountPercent);
  const discountValue = Math.max(0, Number.isFinite(discountValRaw) ? discountValRaw : 0);
  const discountPercent = discountType === 'percent' ? Math.min(100, discountValue) : 0;
  const discountAmount = discountType === 'amount' ? discountValue : 0;
  const paymentTermsDays = Math.min(365, Math.max(0, Number(source.paymentTermsDays) || 30));
  const recipientNotes = trimString(source.recipientNotes || source.notes) || '';
  const notes = trimString(source.notes || source.recipientNotes) || '';
  const terms = trimString(source.terms) || '';
  const autoSendEmail = Boolean(source.autoSendEmail);
  const templateId = trimString(source.templateId) || null;

  assertMaxLength(errors, notes, 2000, 'Notes');
  assertMaxLength(errors, recipientNotes, 2000, 'Recipient Notes');
  assertMaxLength(errors, terms, 3000, 'Terms');
  assertMaxLength(errors, bankAccount, 150, 'Bank Account');

  if (errors.length) return fail(errors);

  return ok({
    profileName,
    clientId,
    projectId,
    bankAccount,
    clientCanStopRecurring,
    templateId,
    frequency,
    customIntervalDays,
    startDate,
    nextRunDate,
    endCondition,
    endDate,
    totalCycles,
    status: 'Active',
    currency,
    lineItems,
    discountType,
    discountValue,
    discountPercent,
    discountAmount,
    taxCalculation: source.taxCalculation === 'before_discount' ? 'before_discount' : 'after_discount',
    paymentTermsDays,
    recipientNotes,
    notes,
    terms,
    autoSendEmail
  });
}

function validateRecurringInvoiceUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const updates = {};

  if (source.profileName !== undefined) {
    updates.profileName = trimString(source.profileName);
    assertRequired(errors, updates.profileName, 'Profile Name');
    assertMaxLength(errors, updates.profileName, 200, 'Profile Name');
  }

  if (source.clientId !== undefined) {
    updates.clientId = trimString(source.clientId);
    assertRequired(errors, updates.clientId, 'Client');
  }

  if (source.projectId !== undefined) {
    updates.projectId = trimString(source.projectId) || null;
  }

  if (source.bankAccount !== undefined) {
    updates.bankAccount = trimString(source.bankAccount);
    assertMaxLength(errors, updates.bankAccount, 150, 'Bank Account');
  }

  if (source.clientCanStopRecurring !== undefined) {
    updates.clientCanStopRecurring = Boolean(source.clientCanStopRecurring);
  }

  if (source.frequency !== undefined) {
    const freq = trimString(source.frequency);
    if (VALID_FREQUENCIES.has(freq)) updates.frequency = freq;
    else errors.push('Invalid recurrence frequency');
  }

  if (source.customIntervalDays !== undefined) {
    updates.customIntervalDays = Math.max(1, Math.min(365, Number(source.customIntervalDays) || 30));
  }

  if (source.startDate !== undefined) {
    const d = new Date(source.startDate);
    if (!isNaN(d.getTime())) updates.startDate = d;
    else errors.push('Invalid start date');
  }

  if (source.nextRunDate !== undefined) {
    const d = new Date(source.nextRunDate);
    if (!isNaN(d.getTime())) updates.nextRunDate = d;
    else errors.push('Invalid next run date');
  }

  if (source.endCondition !== undefined) {
    const cond = trimString(source.endCondition);
    if (VALID_END_CONDITIONS.has(cond)) updates.endCondition = cond;
    else errors.push('Invalid end condition');
  }

  if (source.endDate !== undefined) {
    if (!source.endDate) {
      updates.endDate = null;
    } else {
      const d = new Date(source.endDate);
      if (!isNaN(d.getTime())) updates.endDate = d;
      else errors.push('Invalid end date');
    }
  }

  if (source.totalCycles !== undefined) {
    updates.totalCycles = source.totalCycles ? Math.max(1, Number(source.totalCycles)) : null;
  }

  if (source.status !== undefined) {
    const st = trimString(source.status);
    if (VALID_STATUSES.has(st)) updates.status = st;
    else errors.push('Invalid status');
  }

  if (source.currency !== undefined) {
    const curr = trimString(source.currency).toUpperCase();
    if (VALID_CURRENCIES.has(curr)) updates.currency = curr;
  }

  if (source.lineItems !== undefined) {
    updates.lineItems = validateLineItems(errors, source.lineItems);
  }

  if (source.discountType !== undefined) {
    updates.discountType = source.discountType === 'amount' ? 'amount' : 'percent';
  }

  if (source.discountValue !== undefined || source.discountPercent !== undefined || source.discountAmount !== undefined) {
    const dType = updates.discountType || source.discountType || 'percent';
    const val = Number(source.discountValue ?? (dType === 'amount' ? source.discountAmount : source.discountPercent) ?? 0);
    updates.discountValue = Math.max(0, val);
    updates.discountPercent = dType === 'percent' ? Math.min(100, updates.discountValue) : 0;
    updates.discountAmount = dType === 'amount' ? updates.discountValue : 0;
  }

  if (source.taxCalculation !== undefined) {
    updates.taxCalculation = source.taxCalculation === 'before_discount' ? 'before_discount' : 'after_discount';
  }

  if (source.paymentTermsDays !== undefined) {
    updates.paymentTermsDays = Math.min(365, Math.max(0, Number(source.paymentTermsDays) || 30));
  }

  if (source.recipientNotes !== undefined) {
    updates.recipientNotes = trimString(source.recipientNotes);
    assertMaxLength(errors, updates.recipientNotes, 2000, 'Recipient Notes');
  }

  if (source.notes !== undefined) {
    updates.notes = trimString(source.notes);
    assertMaxLength(errors, updates.notes, 2000, 'Notes');
  }

  if (source.terms !== undefined) {
    updates.terms = trimString(source.terms);
    assertMaxLength(errors, updates.terms, 3000, 'Terms');
  }

  if (source.autoSendEmail !== undefined) {
    updates.autoSendEmail = Boolean(source.autoSendEmail);
  }

  if (source.templateId !== undefined) {
    updates.templateId = trimString(source.templateId) || null;
  }

  if (errors.length) return fail(errors);

  return ok(updates);
}

module.exports = {
  validateRecurringInvoiceCreate,
  validateRecurringInvoiceUpdate
};
