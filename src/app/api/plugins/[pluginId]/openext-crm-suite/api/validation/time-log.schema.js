'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertRequired,
  assertOptionalBoolean,
  assertNonNegativeHours,
  assertOptionalDate,
  assertMaxLength
} = require('./common.util');

function parseTimeLogFields(source) {
  const value = {
    taskId: trimString(source.taskId),
    description: trimString(source.description)
  };

  if (source.workDate !== undefined) {
    value.workDate = source.workDate;
  }
  if (source.hours !== undefined) {
    value.hours = source.hours;
  }
  if (source.isBillable !== undefined) {
    value.isBillable = Boolean(source.isBillable);
  }
  if (source.hourlyRate !== undefined) {
    value.hourlyRate = source.hourlyRate;
  }
  if (source.entryType !== undefined) {
    value.entryType = trimString(source.entryType);
  }
  if (source.approvalStatus !== undefined) {
    value.approvalStatus = trimString(source.approvalStatus);
  }
  if (source.rejectionReason !== undefined) {
    value.rejectionReason = trimString(source.rejectionReason);
  }
  if (source.isLocked !== undefined) {
    value.isLocked = Boolean(source.isLocked);
  }
  if (source.invoiceId !== undefined) {
    value.invoiceId = trimString(source.invoiceId);
  }

  return value;
}

const VALID_APPROVAL_STATUSES = ['Draft', 'Pending', 'Approved', 'Rejected'];
const VALID_ENTRY_TYPES = ['manual', 'timer'];

function validateTimeLogCreate(body) {
  const source = asObject(body);
  const errors = [];
  const value = parseTimeLogFields(source);

  assertRequired(errors, value.taskId, 'taskId');
  if (source.hours === undefined || source.hours === null || source.hours === '') {
    errors.push('hours is required');
  } else {
    value.hours = assertNonNegativeHours(errors, source.hours, 'Hours');
  }

  if (value.workDate !== undefined) {
    value.workDate = assertOptionalDate(errors, value.workDate, 'Work date');
  }

  if (value.hourlyRate !== undefined) {
    const rate = Number(value.hourlyRate);
    if (!Number.isFinite(rate) || rate < 0) {
      errors.push('hourlyRate must be zero or greater');
    } else {
      value.hourlyRate = rate;
    }
  }
  assertMaxLength(errors, value.description, 2000, 'Description');
  assertOptionalBoolean(errors, source.isBillable, 'isBillable');

  if (value.approvalStatus && !VALID_APPROVAL_STATUSES.includes(value.approvalStatus)) {
    errors.push(`approvalStatus must be one of: ${VALID_APPROVAL_STATUSES.join(', ')}`);
  }
  if (value.entryType && !VALID_ENTRY_TYPES.includes(value.entryType)) {
    errors.push(`entryType must be one of: ${VALID_ENTRY_TYPES.join(', ')}`);
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateTimeLogUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.description !== undefined) value.description = trimString(source.description);
  if (source.hours !== undefined) {
    value.hours = assertNonNegativeHours(errors, source.hours, 'Hours');
  }
  if (source.workDate !== undefined) {
    value.workDate = assertOptionalDate(errors, source.workDate, 'Work date');
  }
  if (source.isBillable !== undefined) value.isBillable = Boolean(source.isBillable);
  if (source.hourlyRate !== undefined) {
    const rate = Number(source.hourlyRate);
    if (!Number.isFinite(rate) || rate < 0) {
      errors.push('hourlyRate must be zero or greater');
    } else {
      value.hourlyRate = rate;
    }
  }
  if (source.entryType !== undefined) {
    const entryType = trimString(source.entryType);
    if (entryType && !VALID_ENTRY_TYPES.includes(entryType)) {
      errors.push(`entryType must be one of: ${VALID_ENTRY_TYPES.join(', ')}`);
    } else {
      value.entryType = entryType;
    }
  }
  if (source.approvalStatus !== undefined) {
    const approvalStatus = trimString(source.approvalStatus);
    if (approvalStatus && !VALID_APPROVAL_STATUSES.includes(approvalStatus)) {
      errors.push(`approvalStatus must be one of: ${VALID_APPROVAL_STATUSES.join(', ')}`);
    } else {
      value.approvalStatus = approvalStatus;
    }
  }
  if (source.rejectionReason !== undefined) value.rejectionReason = trimString(source.rejectionReason);
  if (source.isLocked !== undefined) value.isLocked = Boolean(source.isLocked);
  if (source.invoiceId !== undefined) value.invoiceId = trimString(source.invoiceId);

  assertMaxLength(errors, value.description, 2000, 'Description');
  assertOptionalBoolean(errors, source.isBillable, 'isBillable');
  if (!Object.keys(value).length && !errors.length) errors.push('No supported fields were provided');

  if (errors.length) return fail(errors);
  return ok(value);
}

/**
 * Validates check-in payload when starting a running timer session.
 * 
 * Usecase: Ensures taskId is provided and checks optional description, isBillable, and hourlyRate.
 * 
 * @param {Object} body Request body
 * @returns {Object} Validation result containing ok status and cleaned values or error list
 */
function validateCheckIn(body) {
  const source = asObject(body);
  const errors = [];
  const value = {
    taskId: trimString(source.taskId),
    description: trimString(source.description)
  };

  assertRequired(errors, value.taskId, 'taskId');
  assertMaxLength(errors, value.description, 2000, 'Description');
  assertOptionalBoolean(errors, source.isBillable, 'isBillable');
  if (source.isBillable !== undefined) {
    value.isBillable = Boolean(source.isBillable);
  }
  if (source.hourlyRate !== undefined) {
    const rate = Number(source.hourlyRate);
    if (!Number.isFinite(rate) || rate < 0) {
      errors.push('hourlyRate must be zero or greater');
    } else {
      value.hourlyRate = rate;
    }
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

/**
 * Validates check-out payload when completing a running timer session.
 * 
 * Usecase: Checks optional timeLogId and description updates when stopping a check-in session.
 * 
 * @param {Object} body Request body
 * @returns {Object} Validation result containing ok status and cleaned values or error list
 */
function validateCheckOut(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.timeLogId !== undefined) value.timeLogId = trimString(source.timeLogId);
  if (source.description !== undefined) value.description = trimString(source.description);
  assertMaxLength(errors, value.description, 2000, 'Description');

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateReject(body) {
  const source = asObject(body);
  const errors = [];
  const reason = trimString(source.reason || source.rejectionReason);
  if (!reason) {
    errors.push('Rejection reason is required');
  }
  assertMaxLength(errors, reason, 1000, 'Rejection reason');
  if (errors.length) return fail(errors);
  return ok({ reason });
}

function validateBulkApprove(body) {
  const source = asObject(body);
  const errors = [];
  const ids = Array.isArray(source.ids) ? source.ids.map(trimString).filter(Boolean) : [];
  if (!ids.length) {
    errors.push('ids array is required and must contain at least one ID');
  }
  if (errors.length) return fail(errors);
  return ok({ ids });
}

function validateLock(body) {
  const source = asObject(body);
  const errors = [];
  const ids = Array.isArray(source.ids) ? source.ids.map(trimString).filter(Boolean) : [];
  if (!ids.length) {
    errors.push('ids array is required and must contain at least one ID');
  }
  const invoiceId = trimString(source.invoiceId);
  if (errors.length) return fail(errors);
  return ok({ ids, invoiceId });
}

module.exports = {
  validateTimeLogCreate,
  validateTimeLogUpdate,
  validateCheckIn,
  validateCheckOut,
  validateReject,
  validateBulkApprove,
  validateLock
};
