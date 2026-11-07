'use strict';

const { resolveTenantId, resolveUserId, isClientUser, resolveClientId, resolveClientIdAsync } = require('./tenant.util');
const { isAdmin } = require('./sales-access.util');

function accessError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Non-admin staff users (custom roles, freelancers, employees) have scoped access
 * to only expenses they created or expenses linked to projects they are assigned to / members of.
 */
function isExpenseScoped(req) {
  if (isAdmin(req)) return false;
  if (isClientUser(req)) return false;
  return true;
}

async function getAssignedProjectIds(req) {
  const { buildEmployeeProjectScope } = require('./project-access.util');
  const Project = req.cms?.models.get('Project');
  if (!Project) return [];
  const tenantId = resolveTenantId(req);
  const scope = await buildEmployeeProjectScope(req);
  const projects = await Project.find({
    tenantId,
    isDeleted: false,
    ...scope
  }).select('_id').lean();
  return projects.map((p) => String(p._id));
}

function userOwnsExpense(req, expense, assignedProjectIds = []) {
  const userId = resolveUserId(req);
  if (!userId) return false;
  if (String(expense?.createdBy || '') === userId) return true;
  if (expense?.projectId && assignedProjectIds.map(String).includes(String(expense.projectId))) {
    return true;
  }
  return false;
}

async function assertExpenseReadAccess(req, expense) {
  if (isAdmin(req)) return;
  if (isClientUser(req)) {
    const clientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (clientId && String(expense?.clientId || '') === clientId) return;
    throw accessError('Expense not found', 404);
  }
  if (!isExpenseScoped(req)) return;
  const assignedProjectIds = await getAssignedProjectIds(req);
  if (userOwnsExpense(req, expense, assignedProjectIds)) return;
  throw accessError('Expense not found', 404);
}

async function assertExpenseWriteAccess(req, expense) {
  if (isAdmin(req)) return;
  if (isClientUser(req)) {
    throw accessError('Clients have read-only access to project expenses', 403);
  }
  if (!isExpenseScoped(req)) return;
  const assignedProjectIds = await getAssignedProjectIds(req);
  if (userOwnsExpense(req, expense, assignedProjectIds)) return;
  throw accessError('You can only modify expenses for your assigned projects or created by you', 403);
}

function getMongoose(req) {
  try {
    return require('mongoose');
  } catch {
    return req?.cms?.mongoose || null;
  }
}

async function applyExpenseListScope(req, filter) {
  if (isClientUser(req)) {
    const clientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!clientId) {
      const scope = { _id: '__UNLINKED_CLIENT_NO_MATCH__' };
      if (filter.$and) return { ...filter, $and: [...filter.$and, scope] };
      if (filter.$or) return { ...filter, $and: [{ $or: filter.$or }, scope] };
      return { ...filter, ...scope };
    }
    const scope = { clientId };
    if (filter.$and) {
      return { ...filter, $and: [...filter.$and, scope] };
    }
    if (filter.$or) {
      return { ...filter, $and: [{ $or: filter.$or }, scope] };
    }
    return { ...filter, ...scope };
  }
  if (!isExpenseScoped(req)) return filter;
  const userId = resolveUserId(req);
  const assignedProjectIds = await getAssignedProjectIds(req);

  const mongoose = getMongoose(req);
  const projectCandidates = [...assignedProjectIds];
  assignedProjectIds.forEach((pid) => {
    if (mongoose?.Types?.ObjectId?.isValid(pid)) {
      projectCandidates.push(new mongoose.Types.ObjectId(pid));
    }
  });

  const scope = {
    $or: [
      { createdBy: userId }
    ]
  };

  if (assignedProjectIds.length) {
    scope.$or.push({ projectId: { $in: projectCandidates } });
  }

  if (filter.$and) {
    return { ...filter, $and: [...filter.$and, scope] };
  }
  if (filter.$or) {
    return { ...filter, $and: [{ $or: filter.$or }, scope] };
  }
  return { ...filter, ...scope };
}

module.exports = {
  isExpenseScoped,
  userOwnsExpense,
  getAssignedProjectIds,
  assertExpenseReadAccess,
  assertExpenseWriteAccess,
  applyExpenseListScope
};
