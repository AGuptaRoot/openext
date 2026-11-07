'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertRequired,
  assertOptionalDate,
  assertMaxLength
} = require('./common.util');

const VALID_FEEDBACK_STATUSES = new Set([
  'Pending Review',
  'Pending Feedback',
  'Satisfied',
  'Dissatisfied',
  'Not Replied',
  'Awaiting Reply'
]);

const VALID_RECURRING_INTERVALS = new Set(['day', 'week', 'month', 'quarter', 'year']);
const VALID_REMINDER_INTERVAL_TYPES = new Set(['hours', 'days', 'weeks', 'months']);

function parseNotifyClient(val) {
  return val === true || val === 'true' || val === 1 || val === '1' || val === 'on' || val === 'yes';
}

function parseReminderScheduleEnabled(val) {
  return val === true || val === 'true' || val === 1 || val === '1' || val === 'on' || val === 'yes';
}

function applyReminderScheduleFields(source, value, errors) {
  if (source.reminderScheduleEnabled !== undefined) {
    value.reminderScheduleEnabled = parseReminderScheduleEnabled(source.reminderScheduleEnabled);
  }
  if (source.reminderIntervalType !== undefined) {
    const type = trimString(source.reminderIntervalType).toLowerCase() || 'hours';
    if (!VALID_REMINDER_INTERVAL_TYPES.has(type)) {
      errors.push(`Invalid reminderIntervalType. Allowed: ${Array.from(VALID_REMINDER_INTERVAL_TYPES).join(', ')}`);
    } else {
      value.reminderIntervalType = type;
    }
  }
  if (source.reminderIntervalValue !== undefined) {
    if (source.reminderIntervalValue === null || source.reminderIntervalValue === '') {
      value.reminderIntervalValue = null;
    } else {
      const num = parseInt(source.reminderIntervalValue, 10);
      if (isNaN(num) || num < 1) {
        errors.push('reminderIntervalValue must be a positive number');
      } else {
        value.reminderIntervalValue = Math.min(8760, num); // max 1 year in hours-equivalent units
      }
    }
  }
}

function parseClientSatisfied(val) {
  if (val === undefined || val === null || val === '') return null;
  return val === true || val === 'true' || val === 1 || val === '1' || val === 'yes';
}

function parseNumber(val, defaultVal = 0, min = 0) {
  if (val === undefined || val === null || val === '') return defaultVal;
  const num = parseInt(val, 10);
  if (isNaN(num)) return defaultVal;
  return Math.max(min, num);
}

function validateTaskCreate(body) {
  const source = asObject(body);
  const errors = [];

  let clientSatisfied = parseClientSatisfied(source.clientSatisfied);
  let feedbackStatus = trimString(source.clientFeedbackStatus) || 'Pending Review';
  if (clientSatisfied === null) {
    if (feedbackStatus === 'Satisfied') clientSatisfied = true;
    else if (feedbackStatus === 'Dissatisfied') clientSatisfied = false;
  } else if (source.clientFeedbackStatus === undefined) {
    if (clientSatisfied === true) feedbackStatus = 'Satisfied';
    else if (clientSatisfied === false) feedbackStatus = 'Dissatisfied';
    else feedbackStatus = 'Pending Review';
  }

  const isRecurring = source.isRecurring === true || source.isRecurring === 'true' || source.isRecurring === 1 || source.isRecurring === '1';

  const value = {
    projectId: trimString(source.projectId),
    milestoneId: trimString(source.milestoneId) || null,
    dependsOnTaskId: trimString(source.dependsOnTaskId) || null,
    title: trimString(source.title),
    description: trimString(source.description),
    status: trimString(source.status),
    priority: trimString(source.priority),
    assignedTo: trimString(source.assignedTo),
    notifyClientOnCompletion: parseNotifyClient(source.notifyClientOnCompletion),
    clientFeedbackStatus: feedbackStatus,
    clientSatisfied,
    clientFeedbackNotes: trimString(source.clientFeedbackNotes) || '',
    isRecurring
  };

  if (source.followers !== undefined) {
    if (Array.isArray(source.followers)) {
      value.followers = [...new Set(source.followers.map(String).map((s) => s.trim()).filter(Boolean))];
    } else if (typeof source.followers === 'string' && source.followers.trim()) {
      value.followers = [source.followers.trim()];
    } else {
      value.followers = [];
    }
  }

  if (isRecurring) {
    const interval = trimString(source.recurringInterval).toLowerCase() || 'month';
    if (!VALID_RECURRING_INTERVALS.has(interval)) {
      errors.push(`Invalid recurringInterval. Allowed: ${Array.from(VALID_RECURRING_INTERVALS).join(', ')}`);
    }
    value.recurringInterval = interval;
    value.recurringEvery = parseNumber(source.recurringEvery, 1, 1);
    value.recurringTotalCycles = parseNumber(source.recurringTotalCycles, 0, 0);
    if (source.recurringNextDate !== undefined) {
      value.recurringNextDate = assertOptionalDate(errors, source.recurringNextDate, 'Recurring next date');
    }
  }

  assertRequired(errors, value.title, 'Title');
  assertRequired(errors, value.projectId, 'projectId');
  validateTaskLengths(errors, value);

  if (value.clientFeedbackStatus && !VALID_FEEDBACK_STATUSES.has(value.clientFeedbackStatus)) {
    errors.push(`Invalid client feedback status. Allowed: ${Array.from(VALID_FEEDBACK_STATUSES).join(', ')}`);
  }

  if (source.dueDate !== undefined) {
    value.dueDate = assertOptionalDate(errors, source.dueDate, 'Due date');
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateTaskUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.title !== undefined) value.title = trimString(source.title);
  if (source.description !== undefined) value.description = trimString(source.description);
  if (source.milestoneId !== undefined) value.milestoneId = trimString(source.milestoneId) || null;
  if (source.dependsOnTaskId !== undefined) {
    value.dependsOnTaskId = trimString(source.dependsOnTaskId) || null;
  }
  if (source.status !== undefined) value.status = trimString(source.status);
  if (source.priority !== undefined) value.priority = trimString(source.priority);
  if (source.assignedTo !== undefined) value.assignedTo = trimString(source.assignedTo);
  if (source.notifyClientOnCompletion !== undefined) {
    value.notifyClientOnCompletion = parseNotifyClient(source.notifyClientOnCompletion);
  }
  if (source.clientFeedbackStatus !== undefined) {
    const st = trimString(source.clientFeedbackStatus);
    if (st && !VALID_FEEDBACK_STATUSES.has(st)) {
      errors.push(`Invalid client feedback status. Allowed: ${Array.from(VALID_FEEDBACK_STATUSES).join(', ')}`);
    } else {
      value.clientFeedbackStatus = st;
      if (st === 'Satisfied') value.clientSatisfied = true;
      else if (st === 'Dissatisfied') value.clientSatisfied = false;
      else if (st === 'Not Replied' || st === 'Pending Feedback' || st === 'Pending Review' || st === 'Awaiting Reply') value.clientSatisfied = null;
    }
  }
  if (source.clientSatisfied !== undefined && value.clientSatisfied === undefined) {
    value.clientSatisfied = parseClientSatisfied(source.clientSatisfied);
    if (value.clientSatisfied === true) value.clientFeedbackStatus = 'Satisfied';
    else if (value.clientSatisfied === false) value.clientFeedbackStatus = 'Dissatisfied';
  }
  if (source.clientFeedbackNotes !== undefined) {
    value.clientFeedbackNotes = trimString(source.clientFeedbackNotes) || '';
  }

  if (source.followers !== undefined) {
    if (Array.isArray(source.followers)) {
      value.followers = [...new Set(source.followers.map(String).map((s) => s.trim()).filter(Boolean))];
    } else if (typeof source.followers === 'string' && source.followers.trim()) {
      value.followers = [source.followers.trim()];
    } else {
      value.followers = [];
    }
  }

  if (source.isRecurring !== undefined) {
    value.isRecurring = source.isRecurring === true || source.isRecurring === 'true' || source.isRecurring === 1 || source.isRecurring === '1';
  }
  if (source.recurringInterval !== undefined) {
    const interval = trimString(source.recurringInterval).toLowerCase() || 'month';
    if (!VALID_RECURRING_INTERVALS.has(interval)) {
      errors.push(`Invalid recurringInterval. Allowed: ${Array.from(VALID_RECURRING_INTERVALS).join(', ')}`);
    }
    value.recurringInterval = interval;
  }
  if (source.recurringEvery !== undefined) {
    value.recurringEvery = parseNumber(source.recurringEvery, 1, 1);
  }
  if (source.recurringTotalCycles !== undefined) {
    value.recurringTotalCycles = parseNumber(source.recurringTotalCycles, 0, 0);
  }
  if (source.recurringNextDate !== undefined) {
    value.recurringNextDate = assertOptionalDate(errors, source.recurringNextDate, 'Recurring next date');
  }
  if (source.recurringCyclesCompleted !== undefined) {
    value.recurringCyclesCompleted = parseNumber(source.recurringCyclesCompleted, 0, 0);
  }

  applyReminderScheduleFields(source, value, errors);

  if (source.dueDate !== undefined) {
    value.dueDate = assertOptionalDate(errors, source.dueDate, 'Due date');
  }
  if (source.title !== undefined) assertRequired(errors, value.title, 'Title');
  validateTaskLengths(errors, value);
  if (!Object.keys(value).length && !errors.length) errors.push('No supported fields were provided');

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateTaskStatusChange(body) {
  const source = asObject(body);
  const errors = [];
  const status = trimString(source.status);

  assertRequired(errors, status, 'status');
  assertMaxLength(errors, status, 80, 'Status');

  const result = { status };
  if (source.clientFeedbackStatus !== undefined) {
    const st = trimString(source.clientFeedbackStatus);
    if (st && !VALID_FEEDBACK_STATUSES.has(st)) {
      errors.push(`Invalid client feedback status. Allowed: ${Array.from(VALID_FEEDBACK_STATUSES).join(', ')}`);
    } else {
      result.clientFeedbackStatus = st;
    }
  }
  if (source.clientSatisfied !== undefined) {
    result.clientSatisfied = parseClientSatisfied(source.clientSatisfied);
  }
  if (source.clientFeedbackNotes !== undefined) {
    result.clientFeedbackNotes = trimString(source.clientFeedbackNotes);
  }
  if (source.notifyClientOnCompletion !== undefined) {
    result.notifyClientOnCompletion = parseNotifyClient(source.notifyClientOnCompletion);
  }

  if (errors.length) return fail(errors);
  return ok(result);
}

function validateTaskComment(body) {
  const source = asObject(body);
  const errors = [];
  const commentBody = trimString(source.body);

  assertRequired(errors, commentBody, 'body');
  assertMaxLength(errors, commentBody, 2000, 'Comment');

  if (errors.length) return fail(errors);
  return ok({ body: commentBody });
}

function validateTaskLengths(errors, value) {
  if (value.title !== undefined) assertMaxLength(errors, value.title, 200, 'Title');
  if (value.description !== undefined) assertMaxLength(errors, value.description, 4000, 'Description');
  if (value.status !== undefined) assertMaxLength(errors, value.status, 80, 'Status');
  if (value.priority !== undefined) assertMaxLength(errors, value.priority, 40, 'Priority');
  if (value.assignedTo !== undefined) assertMaxLength(errors, value.assignedTo, 128, 'Assigned user');
  if (value.clientFeedbackNotes !== undefined) assertMaxLength(errors, value.clientFeedbackNotes, 2000, 'Feedback notes');
}

function validateSubtaskCreate(body) {
  const source = asObject(body);
  const errors = [];
  const title = trimString(source.title);
  const description = trimString(source.description);
  const assignedTo = trimString(source.assignedTo);

  assertRequired(errors, title, 'Title');
  assertMaxLength(errors, title, 200, 'Subtask title');
  if (description) assertMaxLength(errors, description, 2000, 'Subtask description');

  let currentDate = new Date();
  if (source.currentDate) {
    const parsedDate = new Date(source.currentDate);
    if (!isNaN(parsedDate.getTime())) currentDate = parsedDate;
  }

  if (errors.length) return fail(errors);
  return ok({
    title,
    description: description || '',
    assignedTo: assignedTo || '',
    currentDate,
    isCompleted: Boolean(source.isCompleted)
  });
}

function validateSubtaskUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.title !== undefined) {
    value.title = trimString(source.title);
    assertRequired(errors, value.title, 'Title');
    assertMaxLength(errors, value.title, 200, 'Subtask title');
  }
  if (source.description !== undefined) {
    value.description = trimString(source.description);
    assertMaxLength(errors, value.description, 2000, 'Subtask description');
  }
  if (source.assignedTo !== undefined) {
    value.assignedTo = trimString(source.assignedTo);
  }
  if (source.isCompleted !== undefined) {
    value.isCompleted = Boolean(source.isCompleted);
  }
  if (source.currentDate !== undefined) {
    const parsedDate = new Date(source.currentDate);
    if (!isNaN(parsedDate.getTime())) value.currentDate = parsedDate;
  }

  if (!Object.keys(value).length && !errors.length) errors.push('No subtask fields were provided');
  if (errors.length) return fail(errors);
  return ok(value);
}

function validateTaskFollower(body) {
  const source = asObject(body);
  const userId = trimString(source.userId);
  return ok({ userId });
}

function validateTaskFollowers(body) {
  const source = asObject(body);
  let followers = [];
  if (Array.isArray(source.followers)) {
    followers = [...new Set(source.followers.map(String).map((s) => s.trim()).filter(Boolean))];
  } else if (typeof source.followers === 'string') {
    followers = source.followers.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return ok({ followers });
}

module.exports = {
  VALID_FEEDBACK_STATUSES,
  parseNotifyClient,
  parseClientSatisfied,
  validateTaskCreate,
  validateTaskUpdate,
  validateTaskStatusChange,
  validateTaskComment,
  validateSubtaskCreate,
  validateSubtaskUpdate,
  validateTaskFollower,
  validateTaskFollowers
};
