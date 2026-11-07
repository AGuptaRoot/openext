'use strict';

const {
  asObject,
  trimString,
  ok,
  fail,
  assertRequired,
  assertMaxLength
} = require('./common.util');

const VALID_PRIORITIES = new Set(['Low', 'Medium', 'High', 'Urgent']);

function validateSubtasksList(errors, subtasks) {
  if (!Array.isArray(subtasks)) return [];
  const valid = [];
  for (let i = 0; i < subtasks.length; i++) {
    const item = asObject(subtasks[i]);
    const title = trimString(item.title);
    if (!title) {
      errors.push(`Subtask #${i + 1} must have a title`);
      continue;
    }
    if (title.length > 200) {
      errors.push(`Subtask #${i + 1} title cannot exceed 200 characters`);
    }
    valid.push({
      title,
      description: trimString(item.description) || ''
    });
  }
  return valid;
}

function validateTaskTemplateCreate(body) {
  const source = asObject(body);
  const errors = [];

  const title = trimString(source.title);
  assertRequired(errors, title, 'Title');
  if (title && title.length > 200) {
    errors.push('Title cannot exceed 200 characters');
  }

  const priority = trimString(source.priority) || 'Medium';
  if (priority && !VALID_PRIORITIES.has(priority)) {
    errors.push(`Invalid priority. Allowed: ${Array.from(VALID_PRIORITIES).join(', ')}`);
  }

  const description = trimString(source.description) || '';
  if (description.length > 4000) {
    errors.push('Description cannot exceed 4000 characters');
  }

  const category = trimString(source.category) || '';
  if (category.length > 100) {
    errors.push('Category cannot exceed 100 characters');
  }

  let hoursEstimate = 0;
  if (source.hoursEstimate !== undefined && source.hoursEstimate !== null && source.hoursEstimate !== '') {
    const num = Number(source.hoursEstimate);
    if (isNaN(num) || num < 0) {
      errors.push('hoursEstimate must be a non-negative number');
    } else {
      hoursEstimate = num;
    }
  }

  const tags = Array.isArray(source.tags)
    ? source.tags.map((t) => trimString(t)).filter(Boolean)
    : [];

  const subtasks = validateSubtasksList(errors, source.subtasks || []);

  if (errors.length) return fail(errors);

  return ok({
    title,
    description,
    category,
    priority,
    hoursEstimate,
    tags,
    subtasks
  });
}

function validateTaskTemplateUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.title !== undefined) {
    const title = trimString(source.title);
    if (!title) {
      errors.push('Title is required');
    } else if (title.length > 200) {
      errors.push('Title cannot exceed 200 characters');
    } else {
      value.title = title;
    }
  }

  if (source.description !== undefined) {
    const desc = trimString(source.description) || '';
    if (desc.length > 4000) errors.push('Description cannot exceed 4000 characters');
    else value.description = desc;
  }

  if (source.category !== undefined) {
    const cat = trimString(source.category) || '';
    if (cat.length > 100) errors.push('Category cannot exceed 100 characters');
    else value.category = cat;
  }

  if (source.priority !== undefined) {
    const prio = trimString(source.priority);
    if (prio && !VALID_PRIORITIES.has(prio)) {
      errors.push(`Invalid priority. Allowed: ${Array.from(VALID_PRIORITIES).join(', ')}`);
    } else {
      value.priority = prio || 'Medium';
    }
  }

  if (source.hoursEstimate !== undefined) {
    const num = Number(source.hoursEstimate);
    if (isNaN(num) || num < 0) {
      errors.push('hoursEstimate must be a non-negative number');
    } else {
      value.hoursEstimate = num;
    }
  }

  if (source.tags !== undefined) {
    value.tags = Array.isArray(source.tags)
      ? source.tags.map((t) => trimString(t)).filter(Boolean)
      : [];
  }

  if (source.subtasks !== undefined) {
    value.subtasks = validateSubtasksList(errors, source.subtasks);
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateTaskTemplateInstantiate(body) {
  const source = asObject(body);
  const errors = [];

  const projectId = trimString(source.projectId);
  assertRequired(errors, projectId, 'projectId');

  const milestoneId = trimString(source.milestoneId) || null;
  const assignedTo = trimString(source.assignedTo) || '';
  const status = trimString(source.status) || undefined;
  const title = trimString(source.title) || undefined;
  const dueDate = source.dueDate ? new Date(source.dueDate) : null;

  if (dueDate && isNaN(dueDate.getTime())) {
    errors.push('Due date is invalid');
  }

  if (errors.length) return fail(errors);

  return ok({
    projectId,
    milestoneId,
    assignedTo,
    status,
    title,
    dueDate,
    notifyClientOnCompletion: Boolean(source.notifyClientOnCompletion)
  });
}

module.exports = {
  validateTaskTemplateCreate,
  validateTaskTemplateUpdate,
  validateTaskTemplateInstantiate
};
