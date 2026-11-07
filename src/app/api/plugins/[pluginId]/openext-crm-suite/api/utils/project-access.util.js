'use strict';

const { resolveTenantId, resolveUserId, isClientUser, resolveClientId } = require('./tenant.util');
const { isAdmin } = require('./sales-access.util');

function accessError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** Scoped access: non-admin staff users (Project Managers, Team Members, etc.) can only view/manage projects they created, are assigned to, or are members of. Client users are scoped by clientId. */
function isEmployeeScoped(req) {
  if (isAdmin(req)) return false;
  if (isClientUser(req)) return false;
  return true;
}

async function getMemberUserIds(req, projectId) {
  const ProjectMember = req.cms?.models.get('ProjectMember');
  if (!ProjectMember) return [];

  const rows = await ProjectMember.find({
    tenantId: resolveTenantId(req),
    projectId: String(projectId),
    isDeleted: false
  })
    .select('userId')
    .lean();

  return rows.map((row) => String(row.userId));
}

function userOwnsProject(req, project, memberUserIds = []) {
  const userId = resolveUserId(req);
  if (!userId) return false;
  if (String(project?.createdBy || '') === userId) return true;

  const assignedList = Array.isArray(project?.assignedTo)
    ? project.assignedTo
    : (project?.assignedTo ? [project.assignedTo] : []);

  for (const item of assignedList) {
    if (!item) continue;
    if (typeof item === 'object' && item.userId && String(item.userId) === userId) return true;
    if (typeof item === 'object' && item._id && String(item._id) === userId) return true;
    if (String(item) === userId) return true;
  }

  if (Array.isArray(memberUserIds) && memberUserIds.map(String).includes(userId)) return true;
  return false;
}

async function assertProjectReadAccess(req, project) {
  if (isAdmin(req)) return;
  if (isClientUser(req)) {
    const { resolveClientIdAsync, resolveClientId } = require('./tenant.util');
    const clientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (clientId && String(project.clientId) === String(clientId)) return;
    throw accessError('Project not found', 404);
  }
  if (!isEmployeeScoped(req)) return;

  const memberUserIds = await getMemberUserIds(req, project._id);
  if (userOwnsProject(req, project, memberUserIds)) return;

  throw accessError('Project not found', 404);
}

async function assertProjectWriteAccess(req, project) {
  if (isAdmin(req)) return;
  if (!isEmployeeScoped(req)) return;

  const memberUserIds = await getMemberUserIds(req, project._id);
  if (userOwnsProject(req, project, memberUserIds)) return;

  throw accessError('You can only modify projects you manage or belong to', 403);
}

function getMongoose(req) {
  try {
    return require('mongoose');
  } catch {
    return req?.cms?.mongoose || null;
  }
}

async function buildEmployeeProjectScope(req) {
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);
  const ProjectMember = req.cms?.models.get('ProjectMember');
  const mongoose = getMongoose(req);

  const candidates = [userId];
  if (mongoose?.Types?.ObjectId?.isValid(userId)) {
    candidates.push(new mongoose.Types.ObjectId(userId));
  }

  const memberProjectIds = ProjectMember
    ? (
        await ProjectMember.find({
          tenantId,
          userId: { $in: [userId, String(userId)] },
          isDeleted: false
        })
          .select('projectId')
          .lean()
      ).map((row) => String(row.projectId))
    : [];

  const scope = {
    $or: [
      { createdBy: { $in: candidates } },
      { assignedTo: { $in: candidates } },
      { assignedTo: userId }
    ]
  };

  if (memberProjectIds.length) {
    const objectIds = mongoose?.Types?.ObjectId
      ? memberProjectIds
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
          .map((id) => new mongoose.Types.ObjectId(id))
      : [];
    scope.$or.push({ _id: { $in: [...memberProjectIds, ...objectIds] } });
  }

  return scope;
}

async function applyEmployeeProjectListScope(req, filter) {
  if (!isEmployeeScoped(req)) return filter;
  const scope = await buildEmployeeProjectScope(req);

  if (filter.$and) {
    return { ...filter, $and: [...filter.$and, scope] };
  }
  if (filter.$or) {
    return { ...filter, $and: [{ $or: filter.$or }, scope] };
  }
  return { ...filter, ...scope };
}

function userOwnsTask(req, task, project, memberUserIds = []) {
  const userId = resolveUserId(req);
  if (!userId) return false;
  if (String(task?.createdBy || '') === userId) return true;
  if (String(task?.assignedTo || '') === userId) return true;
  if (project && userOwnsProject(req, project, memberUserIds)) return true;
  return false;
}

async function assertTaskReadAccess(req, task, project) {
  if (isAdmin(req)) return;
  if (isClientUser(req)) {
    const { resolveClientIdAsync, resolveClientId } = require('./tenant.util');
    const clientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (clientId && (String(task?.clientId) === String(clientId) || (project && String(project?.clientId) === String(clientId)))) return;
    throw accessError('Task not found', 404);
  }
  if (!isEmployeeScoped(req)) return;

  const memberUserIds = await getMemberUserIds(req, task.projectId);
  if (userOwnsTask(req, task, project, memberUserIds)) return;

  throw accessError('Task not found', 404);
}

async function assertTaskWriteAccess(req, task, project) {
  if (isAdmin(req)) return;
  if (isClientUser(req)) {
    const { resolveClientIdAsync, resolveClientId } = require('./tenant.util');
    const clientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (clientId && (String(task?.clientId) === String(clientId) || (project && String(project?.clientId) === String(clientId)))) return;
    throw accessError('You can only modify tasks for your projects', 403);
  }
  if (!isEmployeeScoped(req)) return;

  const memberUserIds = await getMemberUserIds(req, task.projectId);
  if (userOwnsTask(req, task, project, memberUserIds)) return;

  throw accessError('You can only modify tasks assigned to you or in your projects', 403);
}

async function buildEmployeeTaskScope(req) {
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);
  const Project = req.cms?.models.get('Project');
  const ProjectMember = req.cms?.models.get('ProjectMember');
  const mongoose = getMongoose(req);

  let projectIds = [];
  if (Project) {
    const projectScope = await buildEmployeeProjectScope(req);
    const projects = await Project.find({
      tenantId,
      isDeleted: false,
      ...projectScope
    })
      .select('_id')
      .lean();
    projectIds = projects.map((row) => String(row._id));
  }

  const candidates = [userId];
  if (mongoose?.Types?.ObjectId?.isValid(userId)) {
    candidates.push(new mongoose.Types.ObjectId(userId));
  }

  const scope = {
    $or: [
      { createdBy: { $in: candidates } },
      { createdBy: userId },
      { assignedTo: { $in: candidates } },
      { assignedTo: userId }
    ]
  };

  if (projectIds.length) {
    const projectObjectIds = mongoose?.Types?.ObjectId
      ? projectIds
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
          .map((id) => new mongoose.Types.ObjectId(id))
      : [];
    scope.$or.push({ projectId: { $in: [...projectIds, ...projectObjectIds] } });
  }

  return scope;
}

async function applyEmployeeTaskListScope(req, filter) {
  if (!isEmployeeScoped(req)) return filter;
  const scope = await buildEmployeeTaskScope(req);

  if (filter.$and) {
    return { ...filter, $and: [...filter.$and, scope] };
  }
  if (filter.$or) {
    return { ...filter, $and: [{ $or: filter.$or }, scope] };
  }
  return { ...filter, ...scope };
}

module.exports = {
  isEmployeeScoped,
  getMemberUserIds,
  userOwnsProject,
  userOwnsTask,
  assertProjectReadAccess,
  assertProjectWriteAccess,
  buildEmployeeProjectScope,
  applyEmployeeProjectListScope,
  assertTaskReadAccess,
  assertTaskWriteAccess,
  buildEmployeeTaskScope,
  applyEmployeeTaskListScope
};
