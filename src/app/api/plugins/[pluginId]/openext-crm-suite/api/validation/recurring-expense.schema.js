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
const VALID_PAYMENT_MODES = new Set(['Cash', 'Bank Transfer', 'UPI', 'Cheque', 'Card', 'Other']);

function validateRecurringExpenseCreate(body) {
  const source = asObject(body);
  const errors = [];

  const profileName = trimString(source.profileName);
  assertRequired(errors, profileName, 'Profile Name');
  assertMaxLength(errors, profileName, 200, 'Profile Name');

  const itemName = trimString(source.itemName || source.title || profileName);
  assertRequired(errors, itemName, 'Item Name');
  assertMaxLength(errors, itemName, 200, 'Item Name');

  const rawAmount = source.price !== undefined ? source.price : source.amount;
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    errors.push('Price / Amount must be a positive number greater than 0');
  }

  const frequency = trimString(source.frequency) || 'monthly';
  if (!VALID_FREQUENCIES.has(frequency)) {
    errors.push(`Invalid frequency: "${frequency}". Allowed: ${Array.from(VALID_FREQUENCIES).join(', ')}`);
  }

  let customIntervalDays = 30;
  if (frequency === 'custom') {
    customIntervalDays = Number(source.customIntervalDays);
    if (!Number.isFinite(customIntervalDays) || customIntervalDays < 1 || customIntervalDays > 365) {
      errors.push('Custom interval days must be between 1 and 365');
    }
  }

  let startDate = new Date();
  if (source.startDate) {
    const d = new Date(source.startDate);
    if (isNaN(d.getTime())) {
      errors.push('Start Date must be a valid date');
    } else {
      startDate = d;
    }
  }

  const endCondition = trimString(source.endCondition) || 'never';
  if (!VALID_END_CONDITIONS.has(endCondition)) {
    errors.push(`Invalid endCondition: "${endCondition}". Allowed: ${Array.from(VALID_END_CONDITIONS).join(', ')}`);
  }

  let endDate = null;
  if (endCondition === 'on_date') {
    if (!source.endDate) {
      errors.push('End Date is required when end condition is "on_date"');
    } else {
      const ed = new Date(source.endDate);
      if (isNaN(ed.getTime())) {
        errors.push('End Date must be a valid date');
      } else if (ed <= startDate) {
        errors.push('End Date must be after Start Date');
      } else {
        endDate = ed;
      }
    }
  }

  let totalCycles = null;
  if (endCondition === 'after_cycles') {
    totalCycles = Number(source.totalCycles);
    if (!Number.isFinite(totalCycles) || totalCycles < 1) {
      errors.push('Total cycles must be a positive integer greater than or equal to 1');
    }
  }

  const currency = trimString(source.currency) || 'INR';
  const exchangeRate = source.exchangeRate !== undefined ? Number(source.exchangeRate) : 1;
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    errors.push('Exchange rate must be greater than 0');
  }

  const paymentMode = trimString(source.paymentMode) || 'Bank Transfer';
  if (paymentMode && !VALID_PAYMENT_MODES.has(paymentMode)) {
    errors.push(`Invalid payment mode. Allowed: ${Array.from(VALID_PAYMENT_MODES).join(', ')}`);
  }

  if (errors.length) return fail(errors);

  return ok({
    profileName,
    itemName,
    vendorName: trimString(source.vendorName || source.purchasedFrom),
    category: trimString(source.category) || 'Other',
    price: Math.round(amount * 100) / 100,
    amount: Math.round(amount * 100) / 100,
    currency,
    exchangeRate,
    frequency,
    customIntervalDays,
    startDate,
    endCondition,
    endDate,
    totalCycles,
    status: VALID_STATUSES.has(source.status) ? source.status : 'Active',
    employeeId: trimString(source.employeeId),
    employeeName: trimString(source.employeeName),
    projectId: trimString(source.projectId),
    clientId: trimString(source.clientId),
    bankAccount: trimString(source.bankAccount),
    paymentMode,
    isBillable: Boolean(source.isBillable),
    autoSubmit: source.autoSubmit !== undefined ? Boolean(source.autoSubmit) : true,
    description: trimString(source.description),
    notes: trimString(source.notes)
  });
}

function validateRecurringExpenseUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const patch = {};

  if (source.profileName !== undefined) {
    const profileName = trimString(source.profileName);
    assertRequired(errors, profileName, 'Profile Name');
    assertMaxLength(errors, profileName, 200, 'Profile Name');
    patch.profileName = profileName;
  }

  if (source.itemName !== undefined || source.title !== undefined) {
    const itemName = trimString(source.itemName || source.title);
    assertRequired(errors, itemName, 'Item Name');
    assertMaxLength(errors, itemName, 200, 'Item Name');
    patch.itemName = itemName;
  }

  if (source.price !== undefined || source.amount !== undefined) {
    const rawAmount = source.price !== undefined ? source.price : source.amount;
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push('Price / Amount must be a positive number greater than 0');
    } else {
      patch.price = Math.round(amount * 100) / 100;
      patch.amount = Math.round(amount * 100) / 100;
    }
  }

  if (source.vendorName !== undefined || source.purchasedFrom !== undefined) {
    patch.vendorName = trimString(source.vendorName || source.purchasedFrom);
  }

  if (source.category !== undefined) {
    patch.category = trimString(source.category) || 'Other';
  }

  if (source.frequency !== undefined) {
    const frequency = trimString(source.frequency);
    if (!VALID_FREQUENCIES.has(frequency)) {
      errors.push(`Invalid frequency: "${frequency}"`);
    } else {
      patch.frequency = frequency;
    }
  }

  if (source.customIntervalDays !== undefined) {
    const customIntervalDays = Number(source.customIntervalDays);
    if (!Number.isFinite(customIntervalDays) || customIntervalDays < 1 || customIntervalDays > 365) {
      errors.push('Custom interval days must be between 1 and 365');
    } else {
      patch.customIntervalDays = customIntervalDays;
    }
  }

  if (source.startDate !== undefined) {
    const d = new Date(source.startDate);
    if (isNaN(d.getTime())) errors.push('Start Date must be a valid date');
    else patch.startDate = d;
  }

  if (source.endCondition !== undefined) {
    const endCondition = trimString(source.endCondition);
    if (!VALID_END_CONDITIONS.has(endCondition)) errors.push(`Invalid endCondition: "${endCondition}"`);
    else patch.endCondition = endCondition;
  }

  if (source.endDate !== undefined) {
    if (source.endDate === null || source.endDate === '') {
      patch.endDate = null;
    } else {
      const ed = new Date(source.endDate);
      if (isNaN(ed.getTime())) errors.push('End Date must be a valid date');
      else patch.endDate = ed;
    }
  }

  if (source.totalCycles !== undefined) {
    if (source.totalCycles === null || source.totalCycles === '') {
      patch.totalCycles = null;
    } else {
      const totalCycles = Number(source.totalCycles);
      if (!Number.isFinite(totalCycles) || totalCycles < 1) errors.push('Total cycles must be >= 1');
      else patch.totalCycles = totalCycles;
    }
  }

  if (source.currency !== undefined) patch.currency = trimString(source.currency);
  if (source.exchangeRate !== undefined) {
    const r = Number(source.exchangeRate);
    if (!Number.isFinite(r) || r <= 0) errors.push('Exchange rate must be > 0');
    else patch.exchangeRate = r;
  }

  if (source.status !== undefined) {
    if (VALID_STATUSES.has(source.status)) patch.status = source.status;
    else errors.push(`Invalid status: "${source.status}"`);
  }

  if (source.employeeId !== undefined) patch.employeeId = trimString(source.employeeId);
  if (source.employeeName !== undefined) patch.employeeName = trimString(source.employeeName);
  if (source.projectId !== undefined) patch.projectId = trimString(source.projectId);
  if (source.clientId !== undefined) patch.clientId = trimString(source.clientId);
  if (source.bankAccount !== undefined) patch.bankAccount = trimString(source.bankAccount);
  if (source.paymentMode !== undefined) {
    const pm = trimString(source.paymentMode);
    if (VALID_PAYMENT_MODES.has(pm)) patch.paymentMode = pm;
  }
  if (source.isBillable !== undefined) patch.isBillable = Boolean(source.isBillable);
  if (source.autoSubmit !== undefined) patch.autoSubmit = Boolean(source.autoSubmit);
  if (source.description !== undefined) patch.description = trimString(source.description);
  if (source.notes !== undefined) patch.notes = trimString(source.notes);

  if (errors.length) return fail(errors);
  return ok(patch);
}

module.exports = {
  validateRecurringExpenseCreate,
  validateRecurringExpenseUpdate
};
