'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertRequired,
  assertOptionalDate,
  assertMaxLength,
  assertDateOrder
} = require('./common.util');

function parseTags(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.includes(',')) {
      return [...new Set(trimmed.split(',').map((x) => x.trim()).filter(Boolean))];
    }
    return [trimmed];
  }
  return [];
}

function parsePriority(raw) {
  const p = String(raw || '').trim();
  if (!p) return 'Medium';
  const lower = p.toLowerCase();
  if (lower === 'urgent') return 'Urgent';
  if (lower === 'high') return 'High';
  if (lower === 'medium') return 'Medium';
  if (lower === 'low') return 'Low';
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function parseCustomFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const sanitized = {};
  for (const [k, v] of Object.entries(raw)) {
    const cleanKey = String(k || '').trim().replace(/\s+/g, '_');
    if (cleanKey) {
      sanitized[cleanKey] = v;
    }
  }
  return sanitized;
}

function parseAssignedTo(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.includes(',')) {
      return [...new Set(trimmed.split(',').map((x) => x.trim()).filter(Boolean))];
    }
    return [trimmed];
  }
  return [];
}

function parseBudget(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const num = Number(raw);
  return Number.isNaN(num) ? 0 : Math.max(0, num);
}

function parseHoursEstimate(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const num = Number(raw);
  return Number.isNaN(num) ? 0 : Math.max(0, num);
}

function parseProgressCalculationMethod(raw) {
  const method = String(raw || '').trim().toLowerCase();
  if (method === 'time' || method === 'based on project total time') return 'time';
  if (method === 'manual') return 'manual';
  return 'tasks'; // default: based on task completion
}

function parseCurrency(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return c || 'INR';
}

function parseProjectFields(source) {
  const rawTags = source.tags !== undefined ? parseTags(source.tags) : (source.label ? parseTags(source.label) : []);
  const fields = {
    clientId: trimString(source.clientId),
    name: trimString(source.name),
    description: trimString(source.description),
    category: trimString(source.category),
    label: trimString(source.label) || (rawTags[0] || ''),
    tags: rawTags,
    priority: parsePriority(source.priority),
    customFields: parseCustomFields(source.customFields),
    currency: parseCurrency(source.currency),
    hoursEstimate: parseHoursEstimate(source.hoursEstimate),
    progressCalculationMethod: parseProgressCalculationMethod(source.progressCalculationMethod),
    status: trimString(source.status),
    liveUrl: trimString(source.liveUrl),
    budget: parseBudget(source.budget),
    assignedTo: parseAssignedTo(source.assignedTo)
  };

  if (source.startDate !== undefined) {
    fields.startDate = source.startDate;
  }
  if (source.deadline !== undefined) {
    fields.deadline = source.deadline;
  }

  return fields;
}

function validateProjectCreate(body) {
  const source = asObject(body);
  const errors = [];
  const fields = parseProjectFields(source);

  assertRequired(errors, fields.name, 'Name');
  assertRequired(errors, fields.clientId, 'clientId');
  assertOptionalDate(errors, fields.startDate, 'Start date');
  assertOptionalDate(errors, fields.deadline, 'Deadline');
  assertDateOrder(errors, fields.startDate, fields.deadline, 'Start date', 'Deadline');
  validateProjectLengths(errors, fields);

  if (errors.length) return fail(errors);
  return ok(fields);
}

function validateProjectUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.clientId !== undefined) value.clientId = trimString(source.clientId);
  if (source.name !== undefined) value.name = trimString(source.name);
  if (source.description !== undefined) value.description = trimString(source.description);
  if (source.category !== undefined) value.category = trimString(source.category);
  if (source.label !== undefined) value.label = trimString(source.label);
  if (source.tags !== undefined) {
    value.tags = parseTags(source.tags);
    if (source.label === undefined && value.tags.length) {
      value.label = value.tags[0];
    }
  }
  if (source.priority !== undefined) value.priority = parsePriority(source.priority);
  if (source.customFields !== undefined) value.customFields = parseCustomFields(source.customFields);
  if (source.currency !== undefined) value.currency = parseCurrency(source.currency);
  if (source.hoursEstimate !== undefined) value.hoursEstimate = parseHoursEstimate(source.hoursEstimate);
  if (source.progressCalculationMethod !== undefined) {
    value.progressCalculationMethod = parseProgressCalculationMethod(source.progressCalculationMethod);
  }
  if (source.status !== undefined) value.status = trimString(source.status);
  if (source.liveUrl !== undefined) value.liveUrl = trimString(source.liveUrl);
  if (source.budget !== undefined) value.budget = parseBudget(source.budget);
  if (source.assignedTo !== undefined) value.assignedTo = parseAssignedTo(source.assignedTo);
  if (source.startDate !== undefined) {
    value.startDate = assertOptionalDate(errors, source.startDate, 'Start date');
  }
  if (source.deadline !== undefined) {
    value.deadline = assertOptionalDate(errors, source.deadline, 'Deadline');
  }
  if (source.name !== undefined) assertRequired(errors, value.name, 'Name');
  if (source.clientId !== undefined) assertRequired(errors, value.clientId, 'clientId');
  assertDateOrder(errors, value.startDate, value.deadline, 'Start date', 'Deadline');
  validateProjectLengths(errors, value);
  if (!Object.keys(value).length && !errors.length) errors.push('No supported fields were provided');

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateProjectLengths(errors, value) {
  if (value.name !== undefined) assertMaxLength(errors, value.name, 160, 'Project name');
  if (value.description !== undefined) assertMaxLength(errors, value.description, 4000, 'Description');
  if (value.category !== undefined) assertMaxLength(errors, value.category, 100, 'Category');
  if (value.label !== undefined) assertMaxLength(errors, value.label, 100, 'Label');
  if (value.priority !== undefined) assertMaxLength(errors, value.priority, 50, 'Priority');
  if (value.currency !== undefined) assertMaxLength(errors, value.currency, 10, 'Currency');
  if (value.status !== undefined) assertMaxLength(errors, value.status, 80, 'Status');
  if (value.liveUrl !== undefined) assertMaxLength(errors, value.liveUrl, 2048, 'Live URL');
  if (Array.isArray(value.tags)) {
    for (const tag of value.tags) {
      assertMaxLength(errors, tag, 100, 'Tag');
    }
  }
  if (Array.isArray(value.assignedTo)) {
    for (const uid of value.assignedTo) {
      assertMaxLength(errors, uid, 128, 'Assigned user');
    }
  } else if (typeof value.assignedTo === 'string') {
    assertMaxLength(errors, value.assignedTo, 128, 'Assigned user');
  }
}

function validateProjectMember(body) {
  const source = asObject(body);
  const errors = [];
  const userId = trimString(source.userId ?? source.memberId);

  assertRequired(errors, userId, 'userId');

  let hourlyRate = 0;
  if (source.hourlyRate !== undefined && source.hourlyRate !== null && source.hourlyRate !== '') {
    const parsedRate = Number(source.hourlyRate);
    if (!Number.isFinite(parsedRate) || parsedRate < 0) {
      errors.push('Hourly rate must be a non-negative number');
    } else {
      hourlyRate = Math.round(parsedRate * 100) / 100;
    }
  }

  const role = trimString(source.role) || 'member';

  if (errors.length) return fail(errors);
  return ok({ userId, role, hourlyRate });
}

function validateProjectMemberUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.hourlyRate !== undefined && source.hourlyRate !== null && source.hourlyRate !== '') {
    const parsedRate = Number(source.hourlyRate);
    if (!Number.isFinite(parsedRate) || parsedRate < 0) {
      errors.push('Hourly rate must be a non-negative number');
    } else {
      value.hourlyRate = Math.round(parsedRate * 100) / 100;
    }
  } else if (source.hourlyRate === null || source.hourlyRate === '') {
    value.hourlyRate = 0;
  }

  if (source.role !== undefined) {
    value.role = trimString(source.role) || 'member';
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

module.exports = {
  validateProjectCreate,
  validateProjectUpdate,
  validateProjectMember,
  validateProjectMemberUpdate,
  parseAssignedTo,
  parseBudget,
  parseHoursEstimate,
  parseProgressCalculationMethod,
  parseCurrency,
  parseTags,
  parsePriority,
  parseCustomFields
};
