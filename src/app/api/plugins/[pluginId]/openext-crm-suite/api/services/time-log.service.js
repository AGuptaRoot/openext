'use strict';

const { resolveTenantId, resolveUserId, isClientUser, resolveClientId } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { resolveUsernames } = require('../utils/user.util');
const SettingService = require('./setting.service');
const AuditService = require('./audit.service');
const ProjectService = require('./project.service');
const {
  assertTaskReadAccess,
  assertTaskWriteAccess,
  assertProjectReadAccess,
  buildEmployeeProjectScope,
  buildEmployeeTaskScope,
  getMemberUserIds,
  userOwnsProject,
  userOwnsTask,
  isEmployeeScoped
} = require('../utils/project-access.util');
const { isAdmin } = require('../utils/sales-access.util');

function getMongoose(req) {
  try {
    return require('mongoose');
  } catch {
    return req?.cms?.mongoose || null;
  }
}

function getTimeLogModel(req) {
  const TimeLog = req.cms?.models.get('TimeLog');
  if (!TimeLog) throw new Error('TimeLog model is not registered');
  return TimeLog;
}

function getTaskModel(req) {
  const Task = req.cms?.models.get('Task');
  if (!Task) throw new Error('Task model is not registered');
  return Task;
}

function getProjectMemberModel(req) {
  return req.cms?.models.get('ProjectMember') || null;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function parseHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    throw appError('Hours must be between 0.01 and 24');
  }
  return Math.round(hours * 100) / 100;
}

function parseWorkDate(value) {
  if (!value) throw appError('workDate is required');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw appError('Invalid workDate');
  return date;
}

function computeBillableAmount(hours, hourlyRate, isBillable) {
  if (!isBillable) return 0;
  const rate = Number(hourlyRate) || 0;
  return Math.round(hours * rate * 100) / 100;
}

async function getDefaultHourlyRate(req) {
  const settings = await SettingService.getAll(req).catch(() => ({}));
  return Number(settings.default_hourly_rate) || 0;
}

/**
 * Checks if the current authenticated user is an assigned member of the task.
 * 
 * Rule: Task timer starts by only his task assigned member and also super admin.
 */
function isTaskAssignedMember(req, task) {
  const userId = String(resolveUserId(req) || '').trim();
  if (!userId) return false;

  const assignedTo = String(task?.assignedTo || '').trim();
  if (assignedTo && (assignedTo === userId || assignedTo.toLowerCase() === userId.toLowerCase())) {
    return true;
  }

  const assignees = Array.isArray(task?.assignedTo)
    ? task.assignedTo
    : (Array.isArray(task?.assignees)
        ? task.assignees
        : (Array.isArray(task?.assignedUsers)
            ? task.assignedUsers
            : (Array.isArray(task?.assignedMembers) ? task.assignedMembers : [])));
  if (assignees.some((a) => String(a || '').trim() === userId || String(a || '').trim().toLowerCase() === userId.toLowerCase())) {
    return true;
  }

  if (Array.isArray(task?.subtasks) && task.subtasks.some((st) => String(st?.assignedTo || '').trim() === userId || String(st?.assignedTo || '').trim().toLowerCase() === userId.toLowerCase())) {
    return true;
  }

  const currentUsername = String(req?.user?.username || req?.user?.name || '').trim().toLowerCase();
  if (currentUsername && assignedTo && assignedTo.toLowerCase() === currentUsername) {
    return true;
  }

  return false;
}

/**
 * Resolves the effective hourly rate for a member on a specific project from ProjectMember settings.
 * 
 * Rule: Count according to his hourly rate that decided in project members hourly rate.
 */
async function resolveProjectMemberHourlyRate(req, projectId, targetUserId) {
  const ProjectMember = getProjectMemberModel(req);
  const tenantId = resolveTenantId(req);
  const userId = String(targetUserId || resolveUserId(req) || '').trim();

  if (ProjectMember && projectId && userId) {
    try {
      const member = await ProjectMember.findOne({
        tenantId,
        projectId: String(projectId),
        userId: userId,
        isDeleted: false
      }).lean();

      if (member && member.hourlyRate !== undefined && member.hourlyRate !== null) {
        const rate = Number(member.hourlyRate);
        if (Number.isFinite(rate) && rate >= 0) {
          return rate;
        }
      }
    } catch (err) {
      console.warn('[TimeLogService] Project member hourly rate lookup failed:', err?.message || err);
    }
  }

  return getDefaultHourlyRate(req);
}

async function findTaskContext(req, taskId) {
  const task = await getTaskModel(req).findOne({ ...baseFilter(req), _id: taskId }).lean();
  if (!task) throw appError('Task not found', 404);

  const project = await ProjectService.findProjectOrThrow(req, task.projectId);
  await assertTaskReadAccess(req, task, project);
  return { task, project };
}

async function findTimeLogOrThrow(req, id) {
  const log = await getTimeLogModel(req).findOne({ ...baseFilter(req), _id: id }).lean();
  if (!log) throw appError('Time log not found', 404);

  const { task, project } = await findTaskContext(req, log.taskId);
  await assertTimeLogReadAccess(req, log);
  return { log, task, project };
}

function userOwnsTimeLog(req, log) {
  return String(log.createdBy || '') === resolveUserId(req);
}

async function assertTimeLogReadAccess(req, log) {
  if (isAdmin(req)) return;
  if (isClientUser(req)) {
    const { resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (userClientId && String(log.clientId || '') === userClientId) return;
    const Project = req.cms?.models.get('Project');
    if (Project && log.projectId && userClientId) {
      const project = await Project.findOne({ tenantId: resolveTenantId(req), _id: log.projectId }).lean();
      if (project && String(project.clientId || '') === userClientId) return;
    }
    throw appError('Time log not found', 404);
  }
  if (!isEmployeeScoped(req)) return;
  if (userOwnsTimeLog(req, log)) return;

  // Check if user has access to the project of this time log
  if (log.projectId) {
    const Project = req.cms?.models.get('Project');
    if (Project) {
      const project = await Project.findOne({ tenantId: resolveTenantId(req), _id: log.projectId, isDeleted: false }).lean();
      if (project) {
        const memberUserIds = await getMemberUserIds(req, project._id);
        if (userOwnsProject(req, project, memberUserIds)) return;
      }
    }
  }

  // Check if user has access to the task of this time log
  if (log.taskId) {
    const Task = req.cms?.models.get('Task');
    if (Task) {
      const task = await Task.findOne({ tenantId: resolveTenantId(req), _id: log.taskId, isDeleted: false }).lean();
      if (task) {
        const memberUserIds = await getMemberUserIds(req, task.projectId);
        if (userOwnsTask(req, task, null, memberUserIds)) return;
      }
    }
  }

  throw appError('Time log not found', 404);
}

async function assertTimeLogWriteAccess(req, log) {
  if (isAdmin(req)) return;
  if (isClientUser(req)) {
    throw appError('Clients have read-only access to time logs', 403);
  }
  if (!isEmployeeScoped(req)) return;
  if (userOwnsTimeLog(req, log)) return;

  // Project manager can modify / approve time logs on projects they manage
  if (log.projectId) {
    const Project = req.cms?.models.get('Project');
    if (Project) {
      const project = await Project.findOne({ tenantId: resolveTenantId(req), _id: log.projectId, isDeleted: false }).lean();
      if (project) {
        const memberUserIds = await getMemberUserIds(req, project._id);
        if (userOwnsProject(req, project, memberUserIds)) return;
      }
    }
  }

  throw appError('You can only modify your own time logs or time logs on projects you manage', 403);
}

async function buildEmployeeTimeLogScope(req) {
  const userId = resolveUserId(req);
  if (!userId) return { createdBy: '__ANONYMOUS__' };
  const tenantId = resolveTenantId(req);
  const mongoose = getMongoose(req);

  const candidates = [userId];
  if (mongoose?.Types?.ObjectId?.isValid(userId)) {
    candidates.push(new mongoose.Types.ObjectId(userId));
  }

  // 1. Projects the user has access to (created, assigned, or member)
  const Project = req.cms?.models.get('Project');
  let accessibleProjectIds = [];
  if (Project) {
    const projectScope = await buildEmployeeProjectScope(req);
    const projects = await Project.find({
      tenantId,
      isDeleted: false,
      ...projectScope
    })
      .select('_id')
      .lean();
    accessibleProjectIds = projects.map((p) => String(p._id));
  }

  // 2. Tasks the user has access to (created, assigned, or in accessible projects)
  const Task = req.cms?.models.get('Task');
  let accessibleTaskIds = [];
  if (Task) {
    const taskScope = await buildEmployeeTaskScope(req);
    const tasks = await Task.find({
      tenantId,
      isDeleted: false,
      ...taskScope
    })
      .select('_id')
      .lean();
    accessibleTaskIds = tasks.map((t) => String(t._id));
  }

  const projectObjectIds = mongoose?.Types?.ObjectId
    ? accessibleProjectIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id))
    : [];

  const taskObjectIds = mongoose?.Types?.ObjectId
    ? accessibleTaskIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id))
    : [];

  const orConditions = [
    { createdBy: { $in: candidates } },
    { createdBy: userId },
    { userId: { $in: candidates } },
    { userId: userId }
  ];

  if (accessibleProjectIds.length) {
    orConditions.push({ projectId: { $in: [...accessibleProjectIds, ...projectObjectIds] } });
  }

  if (accessibleTaskIds.length) {
    orConditions.push({ taskId: { $in: [...accessibleTaskIds, ...taskObjectIds] } });
  }

  return { $or: orConditions };
}

async function applyEmployeeTimeLogListScope(req, filter) {
  if (isAdmin(req)) return filter;
  if (isClientUser(req)) {
    const { resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId) {
      const clientScope = { _id: '__UNLINKED_CLIENT_NO_MATCH__' };
      if (filter.$and) return { ...filter, $and: [...filter.$and, clientScope] };
      if (filter.$or) return { ...filter, $and: [{ $or: filter.$or }, clientScope] };
      return { ...filter, ...clientScope };
    }
    const Project = req.cms?.models.get('Project');
    let projectIds = [];
    if (Project) {
      const clientProjects = await Project.find({
        tenantId: resolveTenantId(req),
        clientId: userClientId,
        isDeleted: false
      }).select('_id').lean();
      projectIds = clientProjects.map((p) => String(p._id));
    }
    const clientScope = {
      $or: [
        { clientId: userClientId },
        ...(projectIds.length ? [{ projectId: { $in: projectIds } }] : [])
      ]
    };
    if (filter.$and) return { ...filter, $and: [...filter.$and, clientScope] };
    if (filter.$or) return { ...filter, $and: [{ $or: filter.$or }, clientScope] };
    return { ...filter, ...clientScope };
  }

  if (!isEmployeeScoped(req)) return filter;

  const tenantId = resolveTenantId(req);

  // If filtered by specific taskId (e.g. on task detail / task drawer)
  const requestedTaskId = filter.taskId || req.query?.taskId;
  if (requestedTaskId && typeof requestedTaskId === 'string') {
    const Task = req.cms?.models.get('Task');
    if (Task) {
      const task = await Task.findOne({ tenantId, _id: requestedTaskId, isDeleted: false }).lean();
      if (task) {
        let project = null;
        if (task.projectId) {
          const Project = req.cms?.models.get('Project');
          if (Project) {
            project = await Project.findOne({ tenantId, _id: task.projectId, isDeleted: false }).lean();
          }
        }
        await assertTaskReadAccess(req, task, project);
        return filter;
      }
    }
  }

  // If filtered by specific projectId (e.g. on project detail -> time logs tab)
  const requestedProjectId = filter.projectId || req.query?.projectId;
  if (requestedProjectId && typeof requestedProjectId === 'string') {
    const Project = req.cms?.models.get('Project');
    if (Project) {
      const project = await Project.findOne({ tenantId, _id: requestedProjectId, isDeleted: false }).lean();
      if (project) {
        await assertProjectReadAccess(req, project);
        return filter;
      }
    }
  }

  const scope = await buildEmployeeTimeLogScope(req);

  if (filter.$and) {
    return { ...filter, $and: [...filter.$and, scope] };
  }
  if (filter.$or) {
    return { ...filter, $and: [{ $or: filter.$or }, scope] };
  }
  return { ...filter, ...scope };
}

async function enrichLogs(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];

  const Task = req.cms?.models.get('Task');
  const Project = req.cms?.models.get('Project');
  const taskMap = {};
  const projectMap = {};

  if (Task) {
    const taskIds = [...new Set(items.map((item) => String(item.taskId || '')))].filter(Boolean);
    const tasks = await Task.find({
      tenantId: resolveTenantId(req),
      _id: { $in: taskIds }
    })
      .select('title projectId assignedTo')
      .lean();
    for (const task of tasks) {
      taskMap[String(task._id)] = task;
    }
  }

  const userIds = [
    ...new Set([
      ...items.flatMap((item) => [
        String(item.createdBy || '').trim(),
        String(item.userId || '').trim(),
        String(item.updatedBy || '').trim()
      ]),
      ...Object.values(taskMap).map((t) => String(t.assignedTo || '').trim())
    ])
  ].filter(Boolean);
  const nameMap = await resolveUsernames(req, userIds);

  if (Project) {
    const projectIds = [
      ...new Set([
        ...items.map((item) => String(item.projectId || '')),
        ...Object.values(taskMap).map((t) => String(t.projectId || ''))
      ])
    ].filter(Boolean);

    const projects = await Project.find({
      tenantId: resolveTenantId(req),
      _id: { $in: projectIds }
    })
      .select('name clientId')
      .lean();
    for (const project of projects) {
      projectMap[String(project._id)] = project;
    }
  }

  const Company = req.cms?.models.get('Company');
  const clientMap = {};
  if (Company && typeof Company.find === 'function') {
    const clientIds = [
      ...new Set([
        ...items.map((item) => String(item.clientId || '')),
        ...Object.values(projectMap).map((p) => String(p.clientId?._id || p.clientId || ''))
      ])
    ].filter(Boolean);
    if (clientIds.length) {
      const clients = await Company.find({
        tenantId: resolveTenantId(req),
        _id: { $in: clientIds }
      }).select('name companyName').lean();
      if (Array.isArray(clients)) {
        for (const client of clients) {
          clientMap[String(client._id)] = client.companyName || client.name || 'Client';
        }
      }
    }
  }

  return items.map((item) => {
    const task = taskMap[String(item.taskId)];
    const effectiveProjectId = item.projectId || task?.projectId;
    const project = projectMap[String(effectiveProjectId)];
    const effectiveClientId = item.clientId || project?.clientId?._id || project?.clientId;
    const clientName = (effectiveClientId ? clientMap[String(effectiveClientId)] : null) || item.clientName || '—';
    const taskAssignee = task?.assignedTo ? nameMap[task.assignedTo] || task.assignedTo : null;
    const logUser = item.userId ? nameMap[item.userId] || item.userId : null;
    const createdByUser = item.createdBy && item.createdBy !== 'system' ? nameMap[item.createdBy] || item.createdBy : null;

    const resolvedUser = logUser || taskAssignee || createdByUser || 'Team Member';

    return {
      ...item,
      clientId: effectiveClientId || item.clientId,
      clientName,
      username: resolvedUser,
      assignedUsername: resolvedUser,
      memberUsername: resolvedUser,
      taskAssignedUsername: taskAssignee || resolvedUser,
      taskTitle: task?.title || item.taskTitle || '—',
      projectName: project?.name || item.projectName || '—'
    };
  });
}

/**
 * Retrieves paginated time logs matching filter parameters.
 * 
 * Usecase: Lists time logs with optional task, project, billable, and check-in/out status filters.
 * Sorts by createdAt descending so new logs appear at the top.
 * 
 * @param {Object} req Express request object containing query parameters
 * @returns {Promise<Object>} Enriched items and pagination metadata
 */
async function list(req) {
  const TimeLog = getTimeLogModel(req);
  const { page, limit, skip } = parsePagination(req.query);
  let filter = baseFilter(req);

  if (isClientUser(req)) {
    const { resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId) {
      return {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        unlinkedClient: true,
        message: 'Client email ID not found in CRM records'
      };
    }
    const Project = req.cms?.models.get('Project');
    const Task = getTaskModel(req);
    let projectIds = [];
    if (Project) {
      const clientProjects = await Project.find({
        tenantId: resolveTenantId(req),
        isDeleted: false,
        clientId: userClientId
      }).select('_id').lean();
      projectIds = clientProjects.map((p) => String(p._id));
    }
    let taskIds = [];
    if (Task) {
      const tasksInClient = await Task.find({
        tenantId: resolveTenantId(req),
        isDeleted: false,
        $or: [
          { clientId: userClientId },
          { projectId: { $in: projectIds } }
        ]
      }).select('_id').lean();
      taskIds = tasksInClient.map((t) => String(t._id));
    }

    if (req.query?.projectId) {
      const requestedProjectId = String(req.query.projectId).trim();
      if (!projectIds.includes(requestedProjectId)) {
        return {
          items: [],
          pagination: { page, limit, total: 0, totalPages: 0 }
        };
      }
      const tasksInProject = Task ? (await Task.find({ tenantId: resolveTenantId(req), projectId: requestedProjectId }).select('_id').lean()).map((t) => String(t._id)) : [];
      filter.$or = [
        { projectId: requestedProjectId },
        { taskId: { $in: tasksInProject } }
      ];
    } else {
      filter.$or = [
        { clientId: userClientId },
        { projectId: { $in: projectIds } },
        { taskId: { $in: taskIds } }
      ];
    }
  } else if (req.query?.clientId) {
    const cId = String(req.query.clientId).trim();
    const Project = req.cms?.models.get('Project');
    const Task = getTaskModel(req);
    let projectIds = [];
    if (Project) {
      const clientProjects = await Project.find({
        tenantId: resolveTenantId(req),
        isDeleted: false,
        clientId: cId
      }).select('_id').lean();
      projectIds = clientProjects.map((p) => String(p._id));
    }
    let taskIds = [];
    if (Task) {
      const tasksInClient = await Task.find({
        tenantId: resolveTenantId(req),
        isDeleted: false,
        $or: [
          { clientId: cId },
          { projectId: { $in: projectIds } }
        ]
      }).select('_id').lean();
      taskIds = tasksInClient.map((t) => String(t._id));
    }

    filter.$or = [
      { clientId: cId },
      { projectId: { $in: projectIds } },
      { taskId: { $in: taskIds } }
    ];
  } else if (req.query?.taskId) {
    filter.taskId = String(req.query.taskId).trim();
  } else if (req.query?.projectId) {
    const pId = String(req.query.projectId).trim();
    const Task = getTaskModel(req);
    const tasksInProject = await Task.find({ tenantId: resolveTenantId(req), projectId: pId }).select('_id').lean();
    const taskIds = tasksInProject.map((t) => String(t._id));
    filter.$or = [
      { projectId: pId },
      { taskId: { $in: taskIds } }
    ];
  }
  if (req.query?.status) filter.status = String(req.query.status).trim();
  if (req.query?.approvalStatus) filter.approvalStatus = String(req.query.approvalStatus).trim();

  const entryType = String(req.query?.entryType || '').trim().toLowerCase();
  if (entryType === 'timer') {
    filter.entryType = 'timer';
  } else if (entryType === 'manual') {
    // Older rows may omit entryType; treat missing as manual.
    filter.$and = [
      ...(filter.$and || []),
      {
        $or: [
          { entryType: 'manual' },
          { entryType: { $exists: false } },
          { entryType: null }
        ]
      }
    ];
  }

  if (req.query?.isLocked === 'true' || req.query?.isLocked === true) {
    filter.isLocked = true;
  } else if (req.query?.isLocked === 'false' || req.query?.isLocked === false) {
    filter.isLocked = { $ne: true };
  }

  if (req.query?.billable === 'true' || req.query?.isBillable === 'true' || req.query?.isBillable === true) {
    filter.isBillable = true;
  } else if (
    req.query?.billable === 'false' ||
    req.query?.isBillable === 'false' ||
    req.query?.isBillable === false
  ) {
    filter.isBillable = { $ne: true };
  }

  if (req.query?.userId) filter.createdBy = String(req.query.userId).trim();
  if (req.query?.isProjectDropped === 'true' || req.query?.dropped === 'true') {
    filter.isProjectDropped = true;
  } else if (req.query?.isProjectDropped === 'all') {
    /* no project dropped filter */
  } else {
    filter.isProjectDropped = { $ne: true };
  }

  if (req.query?.from || req.query?.to) {
    filter.workDate = {};
    if (req.query.from) filter.workDate.$gte = new Date(req.query.from);
    if (req.query.to) {
      const toDate = new Date(req.query.to);
      toDate.setHours(23, 59, 59, 999);
      filter.workDate.$lte = toDate;
    }
  }

  if (req.query?.search) {
    const { toLiteralSearchTerm, mergeSearchOr } = require('../utils/search.util');
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      const searchRegex = new RegExp(term, 'i');
      const Task = getTaskModel(req);
      const Project = req.cms?.models.get('Project');
      const tenantId = resolveTenantId(req);
      const [matchedTasks, matchedProjects] = await Promise.all([
        Task
          ? Task.find({
              tenantId,
              isDeleted: false,
              $or: [{ title: searchRegex }, { name: searchRegex }]
            })
              .select('_id')
              .limit(100)
              .lean()
          : Promise.resolve([]),
        Project
          ? Project.find({
              tenantId,
              isDeleted: false,
              name: searchRegex
            })
              .select('_id')
              .limit(100)
              .lean()
          : Promise.resolve([])
      ]);
      const searchOr = [
        { description: searchRegex },
        { taskId: searchRegex },
        { projectId: searchRegex },
        { createdBy: searchRegex }
      ];
      if (matchedTasks.length) {
        searchOr.push({ taskId: { $in: matchedTasks.map((t) => String(t._id)) } });
      }
      if (matchedProjects.length) {
        searchOr.push({ projectId: { $in: matchedProjects.map((p) => String(p._id)) } });
      }
      mergeSearchOr(filter, searchOr);
    }
  }

  const sortKeyRaw = String(req.query?.sortBy || req.query?.sort || 'workDate').trim();
  const sortDirRaw = String(req.query?.sortDir || req.query?.order || 'desc').toLowerCase();
  const sortDir = sortDirRaw === 'asc' || sortDirRaw === '1' ? 1 : -1;
  const sortableFields = new Set(['workDate', 'hours', 'createdAt', 'updatedAt', 'approvalStatus', 'entryType']);
  const wantsTitleSort = sortKeyRaw === 'taskTitle' || sortKeyRaw === 'projectName' || sortKeyRaw === 'userName';

  const scopedFilter = await applyEmployeeTimeLogListScope(req, filter);

  if (wantsTitleSort) {
    // Title sorts need enriched fields — load a bounded set, enrich, sort, then page.
    const maxSortScan = Math.min(500, Math.max(limit * 20, 100));
    const allItems = await TimeLog.find(scopedFilter)
      .sort({ workDate: -1, _id: -1 })
      .limit(maxSortScan)
      .lean();
    const enriched = await enrichLogs(req, allItems);
    enriched.sort((a, b) => {
      const av =
        sortKeyRaw === 'projectName'
          ? String(a.projectName || '')
          : sortKeyRaw === 'userName'
            ? String(a.userName || a.memberUsername || a.createdBy || '')
            : String(a.taskTitle || a.taskName || '');
      const bv =
        sortKeyRaw === 'projectName'
          ? String(b.projectName || '')
          : sortKeyRaw === 'userName'
            ? String(b.userName || b.memberUsername || b.createdBy || '')
            : String(b.taskTitle || b.taskName || '');
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });
    const total = enriched.length;
    const items = enriched.slice(skip, skip + limit);
    return {
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
    };
  }

  const sortField = sortableFields.has(sortKeyRaw) ? sortKeyRaw : 'workDate';
  const sort = { [sortField]: sortDir, _id: -1 };
  const [items, total] = await Promise.all([
    TimeLog.find(scopedFilter).sort(sort).skip(skip).limit(limit).lean(),
    TimeLog.countDocuments(scopedFilter)
  ]);

  return {
    items: await enrichLogs(req, items),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

async function listByTask(req, taskId) {
  req.query = { ...(req.query || {}), taskId: String(taskId) };
  return list(req);
}
async function getById(req, id) {
  const { log } = await findTimeLogOrThrow(req, id);
  const [enriched] = await enrichLogs(req, [log]);
  return enriched;
}

async function create(req, input) {
  const TimeLog = getTimeLogModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  if (!input.taskId) throw appError('taskId is required');

  const { task, project } = await findTaskContext(req, input.taskId);
  await assertTaskWriteAccess(req, task, project);

  const hours = parseHours(input.hours);
  const workDate = parseWorkDate(input.workDate);
  const isBillable = input.isBillable !== false && input.isBillable !== 'false';
  const targetUserId = input.userId ? String(input.userId).trim() : (task.assignedTo || userId);
  
  // RULE: Hourly rate defaults to project member's hourly rate
  const memberRate = await resolveProjectMemberHourlyRate(req, task.projectId, targetUserId);
  const hourlyRate =
    input.hourlyRate !== undefined && input.hourlyRate !== ''
      ? Math.max(0, Number(input.hourlyRate) || 0)
      : memberRate;
  const billableAmount = computeBillableAmount(hours, hourlyRate, isBillable);

  const entryType = input.entryType === 'timer' ? 'timer' : 'manual';
  const approvalStatus = input.approvalStatus || (isAdmin(req) ? 'Approved' : 'Approved');

  const log = await TimeLog.create({
    tenantId,
    taskId: String(task._id),
    projectId: String(task.projectId),
    workDate,
    hours,
    description: input.description ? String(input.description).trim() : '',
    isBillable,
    hourlyRate,
    billableAmount,
    entryType,
    approvalStatus,
    approvedBy: approvalStatus === 'Approved' ? userId : null,
    approvedAt: approvalStatus === 'Approved' ? new Date() : null,
    isLocked: Boolean(input.isLocked),
    invoiceId: input.invoiceId ? String(input.invoiceId).trim() : null,
    createdBy: targetUserId,
    updatedBy: userId
  });

  const doc = log.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'time_log',
    recordId: doc._id.toString(),
    description: `Time logged: ${hours}h on task "${task.title}"`,
    metadata: { taskId: doc.taskId, projectId: doc.projectId, hours, isBillable, billableAmount, entryType }
  });

  const [enriched] = await enrichLogs(req, [doc]);
  return enriched;
}

async function update(req, id, input) {
  const TimeLog = getTimeLogModel(req);
  const userId = resolveUserId(req);
  const { log: existing, task } = await findTimeLogOrThrow(req, id);
  await assertTimeLogWriteAccess(req, existing);

  if (existing.isLocked || existing.invoiceId) {
    throw appError('Time log is locked after billing/invoicing and cannot be modified', 403);
  }

  const updates = { updatedBy: userId };
  let hours = existing.hours;
  let hourlyRate = existing.hourlyRate;
  let isBillable = existing.isBillable;

  if (input.workDate !== undefined) updates.workDate = parseWorkDate(input.workDate);
  if (input.hours !== undefined) hours = parseHours(input.hours);
  if (input.description !== undefined) updates.description = String(input.description).trim();
  if (input.isBillable !== undefined) {
    isBillable = input.isBillable !== false && input.isBillable !== 'false';
  }
  if (input.hourlyRate !== undefined) {
    hourlyRate = Math.max(0, Number(input.hourlyRate) || 0);
  }
  if (input.entryType !== undefined) updates.entryType = input.entryType;
  if (input.approvalStatus !== undefined) updates.approvalStatus = input.approvalStatus;
  if (input.rejectionReason !== undefined) updates.rejectionReason = String(input.rejectionReason).trim();
  if (input.isLocked !== undefined && isAdmin(req)) updates.isLocked = Boolean(input.isLocked);
  if (input.invoiceId !== undefined && isAdmin(req)) updates.invoiceId = String(input.invoiceId).trim();

  updates.hours = hours;
  updates.isBillable = isBillable;
  updates.hourlyRate = hourlyRate;
  updates.billableAmount = computeBillableAmount(hours, hourlyRate, isBillable);

  const log = await TimeLog.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  if (!log) throw appError('Time log not found', 404);

  await AuditService.log(req, {
    action: 'updated',
    module: 'time_log',
    recordId: id,
    description: `Time log updated on task "${task.title}"`,
    metadata: { taskId: log.taskId, hours, isBillable, hourlyRate, billableAmount: updates.billableAmount }
  });

  const [enriched] = await enrichLogs(req, [log]);
  return enriched;
}

async function remove(req, id) {
  const TimeLog = getTimeLogModel(req);
  const userId = resolveUserId(req);
  const { log: existing, task } = await findTimeLogOrThrow(req, id);
  await assertTimeLogWriteAccess(req, existing);

  if (existing.isLocked || existing.invoiceId) {
    throw appError('Time log is locked after billing/invoicing and cannot be deleted', 403);
  }

  const log = await TimeLog.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  if (!log) throw appError('Time log not found', 404);

  await AuditService.log(req, {
    action: 'deleted',
    module: 'time_log',
    recordId: id,
    description: `Time log deleted from task "${task.title}"`
  });

  return { success: true, id };
}

/**
 * Submits a time log for manager/admin approval.
 */
async function submitForApproval(req, id) {
  const TimeLog = getTimeLogModel(req);
  const userId = resolveUserId(req);
  const { log: existing } = await findTimeLogOrThrow(req, id);
  await assertTimeLogWriteAccess(req, existing);

  if (existing.isLocked || existing.invoiceId) {
    throw appError('Time log is locked and cannot change approval status', 403);
  }

  const updated = await TimeLog.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        approvalStatus: 'Pending',
        submittedAt: new Date(),
        submittedBy: userId,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'approval_submitted',
    module: 'time_log',
    recordId: id,
    description: `Time log submitted for approval`
  });

  const [enriched] = await enrichLogs(req, [updated]);
  return enriched;
}

/**
 * Approves a pending time log (Admin/Manager only).
 */
async function approve(req, id) {
  if (!isAdmin(req)) {
    throw appError('Only administrators or project managers can approve time logs', 403);
  }

  const TimeLog = getTimeLogModel(req);
  const userId = resolveUserId(req);
  const { log: existing } = await findTimeLogOrThrow(req, id);

  const updated = await TimeLog.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        approvalStatus: 'Approved',
        approvedBy: userId,
        approvedAt: new Date(),
        rejectionReason: null,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'approved',
    module: 'time_log',
    recordId: id,
    description: `Time log approved`
  });

  const [enriched] = await enrichLogs(req, [updated]);
  return enriched;
}

/**
 * Rejects a pending time log with a required reason (Admin/Manager only).
 */
async function reject(req, id, reason) {
  if (!isAdmin(req)) {
    throw appError('Only administrators or project managers can reject time logs', 403);
  }

  const trimmedReason = String(reason || '').trim();
  if (!trimmedReason) {
    throw appError('Rejection reason is required');
  }

  const TimeLog = getTimeLogModel(req);
  const userId = resolveUserId(req);
  await findTimeLogOrThrow(req, id);

  const updated = await TimeLog.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        approvalStatus: 'Rejected',
        rejectedBy: userId,
        rejectedAt: new Date(),
        rejectionReason: trimmedReason,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'rejected',
    module: 'time_log',
    recordId: id,
    description: `Time log rejected: ${trimmedReason}`
  });

  const [enriched] = await enrichLogs(req, [updated]);
  return enriched;
}

/**
 * Bulk approves multiple time logs in one batch (Admin/Manager only).
 */
async function bulkApprove(req, ids) {
  if (!isAdmin(req)) {
    throw appError('Only administrators or project managers can bulk approve time logs', 403);
  }

  if (!Array.isArray(ids) || !ids.length) {
    throw appError('ids array is required');
  }

  const TimeLog = getTimeLogModel(req);
  const userId = resolveUserId(req);
  const now = new Date();

  const res = await TimeLog.updateMany(
    { ...baseFilter(req), _id: { $in: ids }, isLocked: false },
    {
      $set: {
        approvalStatus: 'Approved',
        approvedBy: userId,
        approvedAt: now,
        rejectionReason: null,
        updatedBy: userId
      }
    }
  );

  await AuditService.log(req, {
    action: 'bulk_approved',
    module: 'time_log',
    recordId: ids.join(','),
    description: `Bulk approved ${res.modifiedCount || 0} time logs`
  });

  return { success: true, count: res.modifiedCount || 0 };
}

/**
 * Starts a new Check-in timer session for a task.
 * 
 * Usecase: Allows users to check in to start tracking time on a specific task.
 * 
 * Rule 1: Task timer starts by only his task assigned member and also super admin.
 * Rule 2: When check in timer of any task starts, count according to his hourly rate
 *         that was decided in project members hourly rate.
 * 
 * @param {Object} req Express request object
 * @param {Object} input Check-in details containing taskId, description, isBillable, hourlyRate
 * @returns {Promise<Object>} Created active check-in time log
 */
async function checkIn(req, input) {
  const TimeLog = getTimeLogModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  if (!input.taskId) throw appError('taskId is required for Check-in');

  const existingActive = await TimeLog.findOne({
    ...baseFilter(req),
    createdBy: userId,
    status: 'Running'
  }).lean();

  if (existingActive) {
    throw appError('You already have an active Check-in session running. Check out first before starting a new session.', 409);
  }

  const { task, project } = await findTaskContext(req, input.taskId);
  await assertTaskWriteAccess(req, task, project);

  // RULE 1: Task timer starts by only his task assigned member and also super admin
  if (!isAdmin(req) && !isTaskAssignedMember(req, task)) {
    throw appError('Task timer can only be started by the assigned task member or super admin', 403);
  }

  const checkInTime = new Date();
  const workDate = new Date(checkInTime);
  workDate.setHours(0, 0, 0, 0);

  const isBillable = input.isBillable !== false && input.isBillable !== 'false';
  
  // RULE 2: Count according to his hourly rate decided in project members hourly rate
  const memberHourlyRate = await resolveProjectMemberHourlyRate(req, task.projectId, userId);
  const hourlyRate =
    input.hourlyRate !== undefined && input.hourlyRate !== '' && Number(input.hourlyRate) > 0
      ? Math.max(0, Number(input.hourlyRate) || 0)
      : memberHourlyRate;

  const log = await TimeLog.create({
    tenantId,
    taskId: String(task._id),
    projectId: String(task.projectId),
    workDate,
    hours: 0.01,
    checkInTime,
    checkOutTime: null,
    status: 'Running',
    description: input.description ? String(input.description).trim() : '',
    isBillable,
    hourlyRate,
    billableAmount: 0,
    createdBy: userId,
    updatedBy: userId
  });

  const doc = log.toObject();
  await AuditService.log(req, {
    action: 'check_in',
    module: 'time_log',
    recordId: doc._id.toString(),
    description: `Checked in on task "${task.title}"`,
    metadata: { taskId: doc.taskId, checkInTime: checkInTime.toISOString(), hourlyRate }
  });

  const [enriched] = await enrichLogs(req, [doc]);
  return enriched;
}

/**
 * Stops an active Check-in timer session (Check-out) and calculates total hours.
 * 
 * Usecase: Calculates elapsed time between checkInTime and checkOutTime, converts it to hours,
 * updates billable amounts based on project member hourly rate, and marks status as Completed.
 * 
 * @param {Object} req Express request object
 * @param {Object} input Check-out details containing timeLogId (optional) and description (optional)
 * @returns {Promise<Object>} Completed time log with final duration
 */
async function checkOut(req, input = {}) {
  const TimeLog = getTimeLogModel(req);
  const userId = resolveUserId(req);
  const filter = { ...baseFilter(req), status: 'Running' };

  if (input.timeLogId) {
    filter._id = String(input.timeLogId);
  } else {
    filter.createdBy = userId;
  }

  const existingLog = await TimeLog.findOne(filter).lean();
  if (!existingLog) {
    throw appError('No active Check-in session found to Check-out', 404);
  }

  await assertTimeLogWriteAccess(req, existingLog);

  const checkOutTime = new Date();
  const startMs = new Date(existingLog.checkInTime || existingLog.createdAt || checkOutTime).getTime();
  const endMs = checkOutTime.getTime();
  const elapsedMs = Math.max(1000, endMs - startMs);

  // RULE 2: Fallback to project member rate if hourlyRate was not previously set
  const memberRate = await resolveProjectMemberHourlyRate(req, existingLog.projectId, existingLog.createdBy);
  const effectiveRate = input.hourlyRate !== undefined && input.hourlyRate !== '' && Number(input.hourlyRate) > 0
    ? Math.max(0, Number(input.hourlyRate) || 0)
    : (existingLog.hourlyRate !== undefined && existingLog.hourlyRate !== null && Number(existingLog.hourlyRate) > 0
        ? Number(existingLog.hourlyRate)
        : memberRate);

  const calculatedHours = Math.max(0.01, Math.round((elapsedMs / (1000 * 60 * 60)) * 100) / 100);
  const billableAmount = computeBillableAmount(calculatedHours, effectiveRate, existingLog.isBillable);

  const updates = {
    checkOutTime,
    hours: calculatedHours,
    hourlyRate: effectiveRate,
    billableAmount,
    status: 'Completed',
    updatedBy: userId
  };

  if (input.description !== undefined && String(input.description).trim()) {
    updates.description = String(input.description).trim();
  }

  const updatedLog = await TimeLog.findOneAndUpdate(
    { ...baseFilter(req), _id: existingLog._id },
    { $set: updates },
    { new: true }
  ).lean();

  const { task } = await findTaskContext(req, updatedLog.taskId);

  await AuditService.log(req, {
    action: 'check_out',
    module: 'time_log',
    recordId: updatedLog._id.toString(),
    description: `Checked out from task "${task.title}" (${calculatedHours}h logged @ ${effectiveRate}/hr = ${billableAmount})`,
    metadata: { taskId: updatedLog.taskId, hours: calculatedHours, hourlyRate: effectiveRate, billableAmount }
  });

  const [enriched] = await enrichLogs(req, [updatedLog]);
  return enriched;
}

async function bulkApprove(req, ids) {
  const TimeLog = getTimeLogModel(req);
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);
  const targetIds = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  if (!targetIds.length) throw appError('No time log IDs provided', 400);

  const result = await TimeLog.updateMany(
    { tenantId, _id: { $in: targetIds }, isDeleted: false },
    {
      $set: {
        approvalStatus: 'Approved',
        approvedBy: userId,
        approvedAt: new Date(),
        rejectionReason: '',
        updatedBy: userId
      }
    }
  );

  await AuditService.log(req, {
    action: 'bulk_approved',
    module: 'time_log',
    recordId: targetIds.join(','),
    description: `Bulk approved ${result.modifiedCount || targetIds.length} time log entries`
  });

  return { success: true, count: result.modifiedCount || targetIds.length };
}

async function lockTimeLogs(req, { ids, invoiceId = null }) {
  const TimeLog = getTimeLogModel(req);
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);
  const targetIds = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  if (!targetIds.length) throw appError('No time log IDs provided', 400);

  const updates = { isLocked: true, updatedBy: userId };
  if (invoiceId) updates.invoiceId = String(invoiceId).trim();

  const result = await TimeLog.updateMany(
    { tenantId, _id: { $in: targetIds }, isDeleted: false },
    { $set: updates }
  );

  return { success: true, count: result.modifiedCount || targetIds.length, isLocked: true };
}

async function unlockTimeLogs(req, { ids }) {
  const TimeLog = getTimeLogModel(req);
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);
  const targetIds = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  if (!targetIds.length) throw appError('No time log IDs provided', 400);

  const result = await TimeLog.updateMany(
    { tenantId, _id: { $in: targetIds }, isDeleted: false },
    { $set: { isLocked: false, invoiceId: null, updatedBy: userId } }
  );

  return { success: true, count: result.modifiedCount || targetIds.length, isLocked: false };
}

function getIsoDateOnly(date) {
  if (!date) return '';
  if (typeof date === 'string') {
    const match = date.match(/^\d{4}-\d{2}-\d{2}/);
    if (match) return match[0];
  }
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function parseTargetMondayUtc(weekStartInput) {
  let year, month, day;
  if (typeof weekStartInput === 'string' && /^\d{4}-\d{2}-\d{2}/.test(weekStartInput)) {
    const parts = weekStartInput.slice(0, 10).split('-').map(Number);
    year = parts[0];
    month = parts[1] - 1;
    day = parts[2];
  } else {
    const d = (weekStartInput instanceof Date && !Number.isNaN(weekStartInput.getTime())) ? weekStartInput : new Date();
    year = d.getFullYear();
    month = d.getMonth();
    day = d.getDate();
  }

  const targetUtc = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  const dayOfWeek = targetUtc.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const distanceToMonday = (dayOfWeek + 6) % 7; // Mon -> 0, Tue -> 1, ..., Sun -> 6

  targetUtc.setUTCDate(targetUtc.getUTCDate() - distanceToMonday);
  return targetUtc;
}

async function getWeeklyTimesheet(req, options = {}) {
  const TimeLog = getTimeLogModel(req);
  const tenantId = resolveTenantId(req);

  const rawWeekStart = options.weekStart || req.query?.weekStart;
  const mondayUtc = parseTargetMondayUtc(rawWeekStart);

  const sundayUtc = new Date(mondayUtc);
  sundayUtc.setUTCDate(mondayUtc.getUTCDate() + 6);

  const daysHeader = [];
  const dateToDayIndex = new Map();
  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  for (let i = 0; i < 7; i++) {
    const curDate = new Date(mondayUtc);
    curDate.setUTCDate(mondayUtc.getUTCDate() + i);
    const dateIso = curDate.toISOString().slice(0, 10);
    const dayNum = curDate.getUTCDate();
    const monthStr = monthNames[curDate.getUTCMonth()];

    daysHeader.push({
      index: i,
      date: dateIso,
      dateString: dateIso,
      dayName: dayNames[i],
      label: `${dayNames[i]} ${dayNum} ${monthStr}`
    });
    dateToDayIndex.set(dateIso, i);
  }

  const filterStart = new Date(mondayUtc.getTime() - 24 * 60 * 60 * 1000);
  const filterEnd = new Date(sundayUtc.getTime() + 24 * 60 * 60 * 1000 + 86399999);

  const filter = {
    tenantId,
    isDeleted: false,
    workDate: { $gte: filterStart, $lte: filterEnd }
  };

  const targetUserId = options.userId || req.query?.userId;
  if (targetUserId) filter.createdBy = String(targetUserId).trim();

  const targetProjectId = options.projectId || req.query?.projectId;
  if (targetProjectId) filter.projectId = String(targetProjectId).trim();

  const scopedFilter = await applyEmployeeTimeLogListScope(req, filter);
  const logs = await TimeLog.find(scopedFilter).sort({ workDate: 1 }).lean();
  const enriched = await enrichLogs(req, logs);

  const taskMap = new Map();

  for (const log of enriched) {
    let logDateIso = getIsoDateOnly(log.workDate);
    let dayIndex = dateToDayIndex.get(logDateIso);

    if (dayIndex === undefined && log.workDate) {
      const ld = new Date(log.workDate);
      if (!Number.isNaN(ld.getTime())) {
        const localIso = `${ld.getFullYear()}-${String(ld.getMonth() + 1).padStart(2, '0')}-${String(ld.getDate()).padStart(2, '0')}`;
        dayIndex = dateToDayIndex.get(localIso);
      }
    }

    if (dayIndex === undefined || dayIndex < 0 || dayIndex >= 7) {
      continue;
    }

    const key = `${log.projectId}__${log.taskId}`;
    if (!taskMap.has(key)) {
      taskMap.set(key, {
        taskId: log.taskId,
        taskTitle: log.taskTitle || 'Untitled Task',
        projectId: log.projectId,
        projectName: log.projectName || 'General Project',
        assignedUsername: log.creatorUsername || log.assignedUsername || 'Team Member',
        isBillable: log.isBillable,
        days: [0, 0, 0, 0, 0, 0, 0],
        dayHours: [0, 0, 0, 0, 0, 0, 0],
        dayLogs: [[], [], [], [], [], [], []],
        totalHours: 0,
        billableAmount: 0
      });
    }

    const row = taskMap.get(key);
    const rounded = Math.round((row.days[dayIndex] + log.hours) * 100) / 100;
    row.days[dayIndex] = rounded;
    row.dayHours[dayIndex] = rounded;
    row.dayLogs[dayIndex].push(log);
    row.totalHours = Math.round((row.totalHours + log.hours) * 100) / 100;
    row.billableAmount = Math.round((row.billableAmount + (log.billableAmount || 0)) * 100) / 100;
  }

  const rows = Array.from(taskMap.values());
  const dayTotals = [0, 0, 0, 0, 0, 0, 0];
  let grandTotalHours = 0;
  let totalBillableAmount = 0;
  let totalEntries = 0;

  for (const r of rows) {
    for (let i = 0; i < 7; i++) {
      dayTotals[i] = Math.round((dayTotals[i] + r.days[i]) * 100) / 100;
      totalEntries += (r.dayLogs[i] || []).length;
    }
    grandTotalHours = Math.round((grandTotalHours + r.totalHours) * 100) / 100;
    totalBillableAmount = Math.round((totalBillableAmount + r.billableAmount) * 100) / 100;
  }

  return {
    weekStart: mondayUtc.toISOString().slice(0, 10),
    weekEnd: sundayUtc.toISOString().slice(0, 10),
    days: daysHeader,
    rows,
    totals: {
      dayTotals,
      grandTotalHours,
      totalBillableAmount,
      totalEntries
    }
  };
}

function monthRange() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
}

async function sumHoursThisMonth(req, { billableOnly = false, startDate = null, endDate = null } = {}) {
  const TimeLog = getTimeLogModel(req);
  const { start, end } = monthRange();
  const filter = {
    ...baseFilter(req)
  };
  if (startDate || endDate) {
    filter.workDate = {
      ...(startDate ? { $gte: startDate } : {}),
      ...(endDate ? { $lte: endDate } : {})
    };
  } else if (startDate === null && endDate === null && req?.query?.period === 'all') {
    // no date filter for 'all'
  } else {
    filter.workDate = { $gte: start, $lt: end };
  }
  if (billableOnly) filter.isBillable = true;

  const scopedFilter = await applyEmployeeTimeLogListScope(req, filter);
  const rows = await TimeLog.find(scopedFilter).select('hours billableAmount').lean();

  const totalHours = rows.reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
  const billableAmount = rows.reduce((sum, row) => sum + (Number(row.billableAmount) || 0), 0);

  return {
    totalHours: Math.round(totalHours * 100) / 100,
    billableAmount: Math.round(billableAmount * 100) / 100
  };
}

async function sumHoursForTask(req, taskId) {
  const TimeLog = getTimeLogModel(req);
  const filter = { ...baseFilter(req), taskId: String(taskId) };
  const scopedFilter = await applyEmployeeTimeLogListScope(req, filter);
  const rows = await TimeLog.find(scopedFilter).select('hours billableAmount isBillable').lean();

  const totalHours = rows.reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
  const billableHours = rows
    .filter((row) => row.isBillable)
    .reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
  const billableAmount = rows.reduce((sum, row) => sum + (Number(row.billableAmount) || 0), 0);

  return {
    totalHours: Math.round(totalHours * 100) / 100,
    billableHours: Math.round(billableHours * 100) / 100,
    billableAmount: Math.round(billableAmount * 100) / 100,
    totalBillableAmount: Math.round(billableAmount * 100) / 100,
    entryCount: rows.length
  };
}

/**
 * Retrieves the current user's active running check-in session (if any).
 * 
 * Usecase: Powers the live timer/ticker UI for active task tracking.
 * 
 * @param {Object} req Express request object
 * @returns {Promise<Object|null>} Active running time log or null
 */
async function getActiveCheckIn(req) {
  const TimeLog = getTimeLogModel(req);
  const userId = resolveUserId(req);
  const filter = {
    ...baseFilter(req),
    createdBy: userId,
    status: 'Running'
  };

  const activeLog = await TimeLog.findOne(filter).sort({ checkInTime: -1 }).lean();
  if (!activeLog) return null;

  const [enriched] = await enrichLogs(req, [activeLog]);
  const elapsedMs = Math.max(0, Date.now() - new Date(activeLog.checkInTime || activeLog.createdAt).getTime());
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const elapsedHours = Math.round((elapsedMs / (1000 * 60 * 60)) * 100) / 100;

  return {
    ...enriched,
    elapsedMs,
    elapsedSeconds,
    elapsedHours
  };
}

async function exportTimeLogs(req, query = {}) {
  const TimeLog = getTimeLogModel(req);
  let filter = baseFilter(req);

  if (query.taskId) filter.taskId = String(query.taskId).trim();
  if (query.projectId) filter.projectId = String(query.projectId).trim();
  if (query.userId) filter.userId = String(query.userId).trim();
  if (query.approvalStatus) filter.approvalStatus = String(query.approvalStatus).trim();
  if (query.entryType) filter.entryType = String(query.entryType).trim();
  if (query.isBillable !== undefined && query.isBillable !== '') {
    filter.isBillable = query.isBillable === 'true' || query.isBillable === true;
  }
  if (query.from || query.to) {
    filter.workDate = {};
    if (query.from) filter.workDate.$gte = new Date(query.from);
    if (query.to) {
      const toDate = new Date(query.to);
      toDate.setHours(23, 59, 59, 999);
      filter.workDate.$lte = toDate;
    }
  }

  const raw = await TimeLog.find(filter).sort({ workDate: -1, createdAt: -1 }).lean();
  const enriched = await enrichLogs(req, raw);

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'time_log',
    recordId: 'export',
    description: `Exported ${enriched.length} time logs in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `time_logs_export_${nowStr}.json`,
      content: JSON.stringify(enriched, null, 2),
      data: enriched,
      count: enriched.length
    };
  }

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const headers = [
    'ID',
    'User Name',
    'Project Name',
    'Task Title',
    'Hours',
    'Hourly Rate',
    'Billable Amount',
    'Billable',
    'Approval Status',
    'Entry Type',
    'Locked',
    'Work Date',
    'Check In Time',
    'Check Out Time',
    'Notes',
    'Created At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const log of enriched) {
    rows.push(
      [
        log._id,
        log.userName || log.userEmail || '',
        log.projectName || '',
        log.taskTitle || '',
        Number(log.hours || 0),
        Number(log.hourlyRate || 0),
        Number(log.billableAmount || 0),
        log.isBillable ? 'Yes' : 'No',
        log.approvalStatus || 'Approved',
        log.entryType || 'Manual',
        log.isLocked ? 'Yes' : 'No',
        log.workDate ? new Date(log.workDate).toISOString().slice(0, 10) : '',
        log.checkInTime ? new Date(log.checkInTime).toISOString() : '',
        log.checkOutTime ? new Date(log.checkOutTime).toISOString() : '',
        log.notes || log.memo || '',
        log.createdAt ? new Date(log.createdAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `time_logs_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enriched.length
  };
}

module.exports = {
  list,
  listByTask,
  getById,
  create,
  update,
  remove,
  submitForApproval,
  approve,
  reject,
  bulkApprove,
  lockTimeLogs,
  unlockTimeLogs,
  getWeeklyTimesheet,
  sumHoursThisMonth,
  sumHoursForTask,
  getActiveCheckIn,
  checkIn,
  checkOut,
  enrichLogs,
  exportTimeLogs
};
