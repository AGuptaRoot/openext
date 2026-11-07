'use strict';

const { resolveTenantId, isClientUser } = require('./tenant.util');
const { normalizeTenantRoleKey } = require('./tenant-role.util');
const { buildEmployeeProjectScope, getMemberUserIds } = require('./project-access.util');

function accessError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function collectNormalizedRoles(req) {
  return [
    req.user?.role,
    req.tenantMembership?.role,
    ...(Array.isArray(req.user?.roles) ? req.user.roles : []),
    ...(Array.isArray(req.roles) ? req.roles : []),
    ...(Array.isArray(req.tenantMembership?.roles) ? req.tenantMembership.roles : [])
  ]
    .map((r) => normalizeTenantRoleKey(r))
    .filter(Boolean);
}

function resolveUserId(req) {
  const u = req?.user;
  if (!u) return '';
  return String(u._id || u.id || u.userId || u.sub || '').trim();
}

function isAdmin(req) {
  if (!req?.user) return false;
  const roles = collectNormalizedRoles(req);
  return roles.some((r) =>
    ['super-admin', 'tenant-admin', 'admin', 'crm-manager', '1', '101', 'crm_manager'].includes(r)
  );
}

function isGlobalSupportStaff(req) {
  if (isAdmin(req)) return true;
  const roles = collectNormalizedRoles(req);
  // Legacy support-agent / user-agent roles were removed; treat only admins as global support.
  return roles.some((r) => ['crm-manager', 'tenant-admin', 'super-admin', 'admin'].includes(r));
}

/** Project Manager role — scoped to own projects for support tickets. */
function isProjectManager(req) {
  if (!req?.user || isClientUser(req)) return false;
  const roles = collectNormalizedRoles(req);
  return roles.some((role) => role === 'project-manager' || role === '103');
}

function isStaffTicketScoped(req) {
  if (!req?.user || isClientUser(req)) return false;
  if (isGlobalSupportStaff(req)) return false;
  return true;
}

function isTicketProjectScoped(req) {
  return isStaffTicketScoped(req);
}

function getMongoose(req) {
  try {
    return require('mongoose');
  } catch {
    return req?.cms?.mongoose || null;
  }
}

async function getManagedProjectIds(req) {
  const Project = req.cms?.models?.get?.('Project') || req.cms?.models?.Project;
  if (!Project) return [];

  const tenantId = resolveTenantId(req);
  const scope = await buildEmployeeProjectScope(req);
  const projects = await Project.find({
    tenantId,
    isDeleted: false,
    ...scope
  })
    .select('_id')
    .lean();

  return projects.map((row) => String(row._id));
}

async function buildProjectManagerTicketScope(req) {
  const userId = resolveUserId(req);
  const projectIds = await getManagedProjectIds(req);

  const mongoose = getMongoose(req);
  const objectIds = mongoose?.Types?.ObjectId
    ? projectIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id))
    : [];

  const orConditions = [];
  if (userId) {
    const userCandidates = [userId];
    if (mongoose?.Types?.ObjectId?.isValid(userId)) {
      userCandidates.push(new mongoose.Types.ObjectId(userId));
    }
    orConditions.push({ createdBy: { $in: userCandidates } });
    orConditions.push({ assignedTo: { $in: userCandidates } });
  }

  if (projectIds.length > 0) {
    orConditions.push({ projectId: { $in: [...projectIds, ...objectIds] } });
  }

  if (orConditions.length === 0) {
    return { _id: { $in: ['__none__'] } };
  }

  return { $or: orConditions };
}

async function applyProjectManagerTicketListScope(req, filter) {
  if (!isTicketProjectScoped(req)) return filter;
  const scope = await buildProjectManagerTicketScope(req);

  if (filter.$and) {
    return { ...filter, $and: [...filter.$and, scope] };
  }
  if (filter.$or) {
    return { ...filter, $and: [{ $or: filter.$or }, scope] };
  }
  return { ...filter, ...scope };
}

async function assertTicketReadAccess(req, ticket) {
  if (!isTicketProjectScoped(req)) return;

  const userId = resolveUserId(req);
  if (userId && (String(ticket?.createdBy || '') === userId || String(ticket?.assignedTo || '') === userId)) {
    return;
  }

  if (ticket?.projectId) {
    const projectIds = await getManagedProjectIds(req);
    if (projectIds.map(String).includes(String(ticket.projectId))) {
      return;
    }
  }

  throw accessError('Ticket not found', 404);
}

async function assertTicketWriteAccess(req, ticket) {
  await assertTicketReadAccess(req, ticket);
}

async function assertTicketProjectInput(req, projectId) {
  if (!isTicketProjectScoped(req)) return;

  const pid = String(projectId || '').trim();
  if (isProjectManager(req) && !pid) {
    throw accessError('Project is required when creating a support ticket for your managed projects', 400);
  }

  if (pid) {
    const projectIds = await getManagedProjectIds(req);
    if (!projectIds.map(String).includes(pid)) {
      throw accessError('You can only create tickets for projects you manage or are a team member of', 403);
    }
  }
}

/** User IDs eligible for assignment on a project-scoped ticket (members + project leads). */
async function getProjectTeamUserIds(req, projectId) {
  const pid = String(projectId || '').trim();
  if (!pid) return [];

  const ids = new Set();
  const memberIds = await getMemberUserIds(req, pid);
  memberIds.forEach((id) => ids.add(String(id)));

  const Project = req.cms?.models.get('Project');
  if (Project) {
    const mongoose = getMongoose(req);
    const candidates = [pid];
    if (mongoose?.Types?.ObjectId?.isValid(pid)) {
      candidates.push(new mongoose.Types.ObjectId(pid));
    }

    const project = await Project.findOne({
      tenantId: resolveTenantId(req),
      _id: { $in: candidates },
      isDeleted: false
    }).lean();

    if (project) {
      if (project.createdBy) ids.add(String(project.createdBy));
      const assignedList = Array.isArray(project.assignedTo)
        ? project.assignedTo
        : (project.assignedTo ? [project.assignedTo] : []);
      for (const item of assignedList) {
        if (!item) continue;
        if (typeof item === 'object') {
          const uid = item.userId || item._id || item.id;
          if (uid) ids.add(String(uid));
        } else {
          ids.add(String(item));
        }
      }
    }
  }

  return [...ids].filter(Boolean);
}

/** Project managers may assign tickets only to the linked project's team. */
async function assertProjectManagerTicketAssignee(req, { projectId, assigneeId }) {
  if (!isProjectManager(req)) return;

  const pid = String(projectId || '').trim();
  const assignee = String(assigneeId || '').trim();
  if (!assignee) return;

  if (!pid) {
    throw accessError('Link this ticket to a project before assigning a team member', 400);
  }

  const allowedIds = await getProjectTeamUserIds(req, pid);
  if (!allowedIds.map(String).includes(assignee)) {
    throw accessError('You can only assign tickets to members of the linked project team', 403);
  }
}

module.exports = {
  isProjectManager,
  isTicketProjectScoped,
  getManagedProjectIds,
  getProjectTeamUserIds,
  applyProjectManagerTicketListScope,
  assertTicketReadAccess,
  assertTicketWriteAccess,
  assertTicketProjectInput,
  assertProjectManagerTicketAssignee
};
