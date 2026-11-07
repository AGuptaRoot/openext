'use strict';

const { PAYMENT_MODES } = require('./payment.schema');
const {
  asObject,
  trimString,
  ok,
  fail,
  assertRequired,
  assertOptionalBoolean,
  assertPositiveAmount,
  assertOptionalDate,
  assertMaxLength,
  assertOptionalHttpUrl
} = require('./common.util');

const DEFAULT_CATEGORIES = ['Travel', 'Software', 'Office', 'Marketing', 'Other'];

function validateExpenseCreate(body) {
  const source = asObject(body);
  const errors = [];
  const title = trimString(source.title || source.itemName);

  assertRequired(errors, title, 'Item Name / Title');
  const amount = assertPositiveAmount(errors, source.amount !== undefined ? source.amount : source.price, 'Price / Amount');
  const rawDate = source.expenseDate || source.purchaseDate;
  const expenseDate = assertOptionalDate(errors, rawDate, 'Purchase date');
  if (!rawDate) errors.push('Purchase date is required');

  const category = trimString(source.category) || 'Other';
  const paymentMode = trimString(source.mode || source.paymentMode) || 'Other';
  if (!PAYMENT_MODES.includes(paymentMode)) {
    // If not standard payment mode, default gracefully to Other
    source.paymentMode = 'Other';
  }
  validateExpenseText(errors, source);
  assertOptionalBoolean(errors, source.submit, 'submit');

  const exchangeRate = Number(source.exchangeRate) || 1;
  const currency = trimString(source.currency) || 'INR';

  if (errors.length) return fail(errors);

  const value = {
    title,
    itemName: title,
    amount,
    price: amount,
    currency,
    exchangeRate: Math.max(0.0001, exchangeRate),
    expenseDate: expenseDate || rawDate,
    purchaseDate: expenseDate || rawDate,
    category,
    paymentMode: source.paymentMode || paymentMode,
    employeeId: trimString(source.employeeId || source.employee) || '',
    employeeName: trimString(source.employeeName) || '',
    purchasedFrom: trimString(source.purchasedFrom || source.vendor) || '',
    bankAccount: trimString(source.bankAccount) || '',
    clientId: trimString(source.clientId) || '',
    projectId: trimString(source.projectId) || '',
    receiptUrl: trimString(source.receiptUrl || source.bill) || '',
    bill: trimString(source.bill || source.receiptUrl) || '',
    notes: trimString(source.notes || source.description) || '',
    description: trimString(source.description || source.notes) || '',
    submit: Boolean(source.submit)
  };

  return ok(value);
}

function validateExpenseUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.title !== undefined || source.itemName !== undefined) {
    value.title = trimString(source.title || source.itemName);
    value.itemName = value.title;
    assertRequired(errors, value.title, 'Item Name / Title');
  }
  if (source.amount !== undefined || source.price !== undefined) {
    value.amount = assertPositiveAmount(errors, source.amount !== undefined ? source.amount : source.price, 'Price / Amount');
    value.price = value.amount;
  }
  if (source.expenseDate !== undefined || source.purchaseDate !== undefined) {
    const rawDate = source.expenseDate || source.purchaseDate;
    value.expenseDate = assertOptionalDate(errors, rawDate, 'Purchase date');
    value.purchaseDate = value.expenseDate;
  }
  if (source.currency !== undefined) value.currency = trimString(source.currency) || 'INR';
  if (source.exchangeRate !== undefined) value.exchangeRate = Math.max(0.0001, Number(source.exchangeRate) || 1);
  if (source.category !== undefined) value.category = trimString(source.category) || 'Other';
  if (source.mode !== undefined || source.paymentMode !== undefined) {
    const paymentMode = trimString(source.mode || source.paymentMode) || 'Other';
    value.paymentMode = PAYMENT_MODES.includes(paymentMode) ? paymentMode : 'Other';
  }
  if (source.employeeId !== undefined || source.employee !== undefined) {
    value.employeeId = trimString(source.employeeId || source.employee) || '';
  }
  if (source.employeeName !== undefined) value.employeeName = trimString(source.employeeName) || '';
  if (source.purchasedFrom !== undefined || source.vendor !== undefined) {
    value.purchasedFrom = trimString(source.purchasedFrom || source.vendor) || '';
  }
  if (source.bankAccount !== undefined) value.bankAccount = trimString(source.bankAccount) || '';
  if (source.clientId !== undefined) value.clientId = trimString(source.clientId) || '';
  if (source.projectId !== undefined) value.projectId = trimString(source.projectId) || '';
  if (source.receiptUrl !== undefined || source.bill !== undefined) {
    value.receiptUrl = trimString(source.receiptUrl || source.bill) || '';
    value.bill = value.receiptUrl;
  }
  if (source.notes !== undefined || source.description !== undefined) {
    value.notes = trimString(source.notes || source.description) || '';
    value.description = value.notes;
  }

  validateExpenseText(errors, value);
  if (!Object.keys(value).length && !errors.length) errors.push('No supported fields were provided');

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateExpenseReject(body) {
  const source = asObject(body);
  const errors = [];
  const reason = trimString(source.reason);

  assertRequired(errors, reason, 'reason');
  assertMaxLength(errors, reason, 500, 'Rejection reason');

  if (errors.length) return fail(errors);
  return ok({ reason });
}

function validateExpenseText(errors, source) {
  assertMaxLength(errors, trimString(source.title), 200, 'Title');
  assertMaxLength(errors, trimString(source.category), 80, 'Category');
  assertMaxLength(errors, trimString(source.notes), 1000, 'Notes');
  const receiptUrl = trimString(source.receiptUrl);
  assertMaxLength(errors, receiptUrl, 500, 'Receipt URL');
  assertOptionalHttpUrl(errors, receiptUrl, 'Receipt URL');
}

module.exports = {
  DEFAULT_CATEGORIES,
  validateExpenseCreate,
  validateExpenseUpdate,
  validateExpenseReject
};
