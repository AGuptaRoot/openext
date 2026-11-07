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

const VALID_MILESTONE_STATUSES = ['Pending', 'In Progress', 'Completed', 'Cancelled'];

function parseCost(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const num = Number(raw);
  return Number.isNaN(num) ? 0 : Math.max(0, num);
}

function parseAddCostToBudget(raw) {
  if (raw === true || raw === 'true' || raw === 1 || raw === '1' || raw === 'yes' || raw === 'on') {
    return true;
  }
  return false;
}

function validateMilestoneCreate(body) {
  const source = asObject(body);
  const errors = [];

  const title = trimString(source.title);
  const projectId = trimString(source.projectId);
  const summary = trimString(source.summary ?? source.description);
  const status = trimString(source.status) || 'Pending';
  const cost = parseCost(source.cost);
  const addCostToBudget = parseAddCostToBudget(source.addCostToBudget ?? source.add_cost_to_budget);

  assertRequired(errors, title, 'Milestone Title');
  assertRequired(errors, projectId, 'Project ID');
  assertRequired(errors, summary, 'Milestone Summary');

  assertMaxLength(errors, title, 200, 'Milestone Title');
  assertMaxLength(errors, summary, 4000, 'Milestone Summary');

  if (!VALID_MILESTONE_STATUSES.includes(status)) {
    errors.push(`Invalid status. Must be one of: ${VALID_MILESTONE_STATUSES.join(', ')}`);
  }

  const startDate = assertOptionalDate(errors, source.startDate, 'Start date');
  const endDate = assertOptionalDate(errors, source.endDate ?? source.deadline, 'End date');
  assertDateOrder(errors, startDate, endDate, 'Start date', 'End date');

  if (errors.length) return fail(errors);

  return ok({
    projectId,
    title,
    summary,
    cost,
    status,
    addCostToBudget,
    startDate,
    endDate
  });
}

function validateMilestoneUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.title !== undefined) {
    value.title = trimString(source.title);
    assertRequired(errors, value.title, 'Milestone Title');
    assertMaxLength(errors, value.title, 200, 'Milestone Title');
  }

  if (source.summary !== undefined || source.description !== undefined) {
    value.summary = trimString(source.summary ?? source.description);
    assertRequired(errors, value.summary, 'Milestone Summary');
    assertMaxLength(errors, value.summary, 4000, 'Milestone Summary');
  }

  if (source.cost !== undefined) {
    value.cost = parseCost(source.cost);
  }

  if (source.status !== undefined) {
    value.status = trimString(source.status);
    if (!VALID_MILESTONE_STATUSES.includes(value.status)) {
      errors.push(`Invalid status. Must be one of: ${VALID_MILESTONE_STATUSES.join(', ')}`);
    }
  }

  if (source.addCostToBudget !== undefined || source.add_cost_to_budget !== undefined) {
    value.addCostToBudget = parseAddCostToBudget(source.addCostToBudget ?? source.add_cost_to_budget);
  }

  if (source.startDate !== undefined) {
    value.startDate = assertOptionalDate(errors, source.startDate, 'Start date');
  }

  if (source.endDate !== undefined || source.deadline !== undefined) {
    value.endDate = assertOptionalDate(errors, source.endDate ?? source.deadline, 'End date');
  }

  assertDateOrder(errors, value.startDate, value.endDate, 'Start date', 'End date');

  if (!Object.keys(value).length && !errors.length) {
    errors.push('No supported fields were provided');
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

module.exports = {
  VALID_MILESTONE_STATUSES,
  validateMilestoneCreate,
  validateMilestoneUpdate,
  parseCost,
  parseAddCostToBudget
};
