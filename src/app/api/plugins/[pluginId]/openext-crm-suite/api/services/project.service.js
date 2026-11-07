'use strict';

const {
  resolveTenantId,
  resolveUserId,
  isClientUser,
  resolveClientId,
  applyClientScope
} = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const { resolveUsernames, resolveUserDesignations } = require('../utils/user.util');
const SettingService = require('./setting.service');
const AuditService = require('./audit.service');
const { parseAssignedTo } = require('../validation/project.schema');
const {
  assertProjectReadAccess,
  assertProjectWriteAccess,
  applyEmployeeProjectListScope,
  getMemberUserIds
} = require('../utils/project-access.util');

function getProjectModel(req) {
  const Project = req.cms?.models.get('Project');
  if (!Project) throw new Error('Project model is not registered');
  return Project;
}

function getProjectMemberModel(req) {
  return req.cms?.models.get('ProjectMember') || null;
}

function getCompanyModel(req) {
  return req.cms?.models.get('Company') || null;
}

function getTaskModel(req) {
  return req.cms?.models.get('Task') || null;
}

function isLiveStatus(status) {
  return String(status || '').trim().toLowerCase() === 'live';
}

function normalizeLiveUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function isValidLiveUrl(url) {
  const normalized = normalizeLiveUrl(url);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function renderClientPortalCtaHtml(portalLoginUrl) {
  if (!portalLoginUrl) return '';
  return `
    <div style="margin: 20px 0;">
      <a href="${portalLoginUrl}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;">
        Open Client Portal
      </a>
    </div>
  `;
}

async function sendProjectLiveNotification(req, project, liveUrl) {
  try {
    if (!project?.clientId || !liveUrl) return null;
    const Company = getCompanyModel(req);
    if (!Company) return null;
    const client = await Company.findOne({
      tenantId: resolveTenantId(req),
      _id: String(project.clientId),
      isDeleted: false
    }).lean();

    if (!client || !client.email) return null;

    const MailService = require('./mail.service');
    const { buildClientPortalLoginUrl } = require('../utils/public-origin.util');
    const mailConfig = await MailService.resolveMailConfig(req);
    const companyName = mailConfig.fromName || 'Root CRM';
    const safeUrl = normalizeLiveUrl(liveUrl);

    const subject = `Your project is Live: ${project.name}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #0f172a; margin-top: 0;">Project is Live 🚀</h2>
        <p>Dear ${client.name || 'Client'},</p>
        <p>Great news — <strong>${project.name}</strong> is now <strong>Live</strong>.</p>
        <div style="background: #f8fafc; border-left: 4px solid #7c3aed; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
          <p style="margin: 0 0 8px 0; color: #475569; font-size: 0.85rem;">Live link</p>
          <a href="${safeUrl}" style="color: #5b21b6; word-break: break-all; font-weight: 600;">${safeUrl}</a>
        </div>
        <p>Please review the live site and reply to this email if you have any feedback.</p>
        ${renderClientPortalCtaHtml(buildClientPortalLoginUrl(req))}
        <p style="color: #64748b; font-size: 0.85rem; margin-top: 24px;">Best regards,<br><strong>${companyName}</strong></p>
      </div>
    `;

    await MailService.sendViaEmailPlugin(req, {
      to: client.email,
      subject,
      html
    });

    await AuditService.log(req, {
      action: 'notification_sent',
      module: 'project',
      recordId: String(project._id),
      description: `Live URL email sent to client (${client.email}) for project: ${project.name}`,
      metadata: {
        projectId: String(project._id),
        recipientEmail: client.email,
        liveUrl: safeUrl,
        sentAt: new Date()
      }
    });

    return { emailedTo: client.email, liveUrl: safeUrl };
  } catch (err) {
    console.error('[project] Failed to send live notification:', err?.message || err);
    return null;
  }
}

function getMilestoneModel(req) {
  return req.cms?.models.get('Milestone') || null;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  const filter = { tenantId: resolveTenantId(req), isDeleted: false };
  return applyClientScope(req, filter, 'clientId');
}

async function getValidStatuses(req) {
  return SettingService.getProjectStatuses(req);
}

async function getValidPriorities(req) {
  return SettingService.getProjectPriorities(req);
}

function assertValidStatus(status, validStatuses) {
  if (!validStatuses.includes(status)) {
    throw appError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
  }
}

function assertValidPriority(priority, validPriorities) {
  if (!validPriorities.includes(priority)) {
    throw appError(`Invalid priority. Must be one of: ${validPriorities.join(', ')}`);
  }
}

function computeProjectProgressPercent(project, stats = {}) {
  const {
    totalTasks = 0,
    completedTasks = 0,
    totalMilestones = 0,
    completedMilestones = 0,
    totalHours = 0
  } = stats;

  const method = project?.progressCalculationMethod || 'tasks';

  if (method === 'time' && Number(project?.hoursEstimate) > 0) {
    return Math.min(100, Math.round((totalHours / Number(project.hoursEstimate)) * 100));
  }

  if (method === 'manual') {
    return project?.status === 'Completed' ? 100 : 0;
  }

  const progressParts = [];
  if (totalTasks > 0) progressParts.push((completedTasks / totalTasks) * 100);
  if (totalMilestones > 0) progressParts.push((completedMilestones / totalMilestones) * 100);

  if (progressParts.length) {
    return Math.round(progressParts.reduce((sum, value) => sum + value, 0) / progressParts.length);
  }

  return project?.status === 'Completed' ? 100 : 0;
}

async function loadProjectProgressStats(req, projectIds) {
  const ids = [...new Set((projectIds || []).map((id) => String(id)).filter(Boolean))];
  const empty = {
    taskCounts: {},
    milestoneCounts: {},
    hoursByProject: {}
  };
  if (!ids.length) return empty;

  const tenantId = resolveTenantId(req);
  const Task = getTaskModel(req);
  const Milestone = getMilestoneModel(req);
  const TimeLog = req.cms?.models.get('TimeLog');

  const taskCounts = {};
  const milestoneCounts = {};
  const hoursByProject = {};

  const lookups = [];

  if (Task && typeof Task.aggregate === 'function') {
    lookups.push(
      Task.aggregate([
        { $match: { tenantId, isDeleted: false, projectId: { $in: ids } } },
        {
          $group: {
            _id: '$projectId',
            total: { $sum: 1 },
            completed: {
              $sum: {
                $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0]
              }
            }
          }
        }
      ]).then((rows) => {
        for (const row of rows) {
          taskCounts[String(row._id)] = {
            total: row.total || 0,
            completed: row.completed || 0
          };
        }
      }).catch(() => {})
    );
  }

  if (Milestone && typeof Milestone.aggregate === 'function') {
    lookups.push(
      Milestone.aggregate([
        { $match: { tenantId, isDeleted: false, projectId: { $in: ids } } },
        {
          $group: {
            _id: '$projectId',
            total: { $sum: 1 },
            completed: {
              $sum: {
                $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0]
              }
            }
          }
        }
      ]).then((rows) => {
        for (const row of rows) {
          milestoneCounts[String(row._id)] = {
            total: row.total || 0,
            completed: row.completed || 0
          };
        }
      }).catch(() => {})
    );
  }

  if (TimeLog && typeof TimeLog.aggregate === 'function') {
    lookups.push(
      TimeLog.aggregate([
        { $match: { tenantId, isDeleted: false, projectId: { $in: ids } } },
        {
          $group: {
            _id: '$projectId',
            totalHours: { $sum: '$hours' }
          }
        }
      ]).then((rows) => {
        for (const row of rows) {
          hoursByProject[String(row._id)] = Number(row.totalHours || 0);
        }
      }).catch(() => {})
    );
  }

  if (lookups.length) await Promise.all(lookups);

  return { taskCounts, milestoneCounts, hoursByProject };
}

async function findProjectOrThrow(req, id) {
  if (!id) throw appError('Project ID is required', 400);

  const Project = req.cms?.models?.get?.('Project');
  if (Project) {
    const project = await Project.findOne({ ...baseFilter(req), _id: id }).lean();
    if (project) {
      await assertProjectReadAccess(req, project);
      return project;
    }
  }

  if (!/^[0-9a-fA-F]{24}$/.test(String(id))) {
    if (isClientUser(req)) {
      throw appError('Project not found', 404);
    }
    let name = 'General';
    if (id === 'marketing-leads') name = 'Marketing Lead Drip';
    else if (id === 'ai-lead-actions') name = 'AI Intelligence Action';
    else if (id === 'sample_improvement') name = 'Sample Improvement';
    else if (id) name = String(id).replace(/[-_]/g, ' ');

    const pseudo = {
      _id: String(id || 'general'),
      name,
      clientId: null,
      budget: 0,
      tenantId: resolveTenantId(req),
      status: 'In Progress',
      assignedTo: []
    };
    return pseudo;
  }

  throw appError('Project not found', 404);
}

async function enrichProjects(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];

  const rawClientIds = [...new Set(items.map((item) => String(item.clientId || '')).filter(Boolean))];
  const validClientHexIds = rawClientIds.filter((cid) => /^[0-9a-fA-F]{24}$/.test(cid));

  const userIds = [
    ...new Set(
      items.flatMap((item) => {
        const assignees = Array.isArray(item.assignedTo)
          ? item.assignedTo
          : (item.assignedTo ? [item.assignedTo] : []);
        return [...assignees, item.createdBy].map((value) => String(value || '').trim());
      })
    )
  ].filter(Boolean);

  const Company = getCompanyModel(req);
  const clientMap = {};
  if (Company && validClientHexIds.length) {
    try {
      const clients = await Company.find({
        tenantId: resolveTenantId(req),
        isDeleted: false,
        mergedIntoId: null,
        _id: { $in: validClientHexIds }
      })
        .select('name')
        .lean();
      for (const client of clients) {
        clientMap[String(client._id)] = client.name;
      }
    } catch (err) {
      console.warn('[ProjectService] Client lookup warning:', err.message);
    }
  }

  const nameMap = await resolveUsernames(req, userIds);
  const designationMap = await resolveUserDesignations(req, userIds);
  const projectIds = items.map((item) => String(item._id));
  const { taskCounts, milestoneCounts, hoursByProject } = await loadProjectProgressStats(req, projectIds);

  return items.map((item) => {
    const assignees = Array.isArray(item.assignedTo)
      ? item.assignedTo.filter(Boolean)
      : (item.assignedTo ? [item.assignedTo] : []);
    const assignedNames = assignees.map((uid) => {
      const uname = nameMap[uid] || uid;
      const desig = designationMap[uid]?.designation;
      return desig ? `${uname} (${desig})` : uname;
    });
    const assignedUsername = assignedNames.join(', ') || '—';

    const rawTags = Array.isArray(item.tags) && item.tags.length
      ? item.tags
      : (item.label ? [item.label] : []);

    const pid = String(item._id);
    const taskStats = taskCounts[pid] || { total: 0, completed: 0 };
    const milestoneStats = milestoneCounts[pid] || { total: 0, completed: 0 };
    const progress = computeProjectProgressPercent(item, {
      totalTasks: taskStats.total,
      completedTasks: taskStats.completed,
      totalMilestones: milestoneStats.total,
      completedMilestones: milestoneStats.completed,
      totalHours: hoursByProject[pid] || 0
    });

    return {
      ...item,
      budget: Number(item.budget || 0),
      clientName: clientMap[String(item.clientId)] || '—',
      assignedTo: assignees,
      assignedUsername,
      assignedUsernames: assignedNames,
      taskCount: taskStats.total,
      completedTaskCount: taskStats.completed,
      milestoneCount: milestoneStats.total,
      completedMilestoneCount: milestoneStats.completed,
      progress,
      progressPercent: progress,
      priority: item.priority || 'Medium',
      tags: rawTags,
      customFields: item.customFields || {}
    };
  });
}

async function enrichProject(req, item) {
  if (!item) return item;
  const [enriched] = await enrichProjects(req, [item]);
  return enriched;
}

async function list(req) {
  const Project = getProjectModel(req);
  const { page, limit, skip, sort } = parsePagination(req.query);
  const filter = baseFilter(req);

  const { isClientUser, resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId) {
      return {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        unlinkedClient: true,
        message: 'Client email ID not found in CRM records'
      };
    }
    filter.clientId = userClientId;
  } else if (req.query?.clientId) {
    filter.clientId = String(req.query.clientId).trim();
  }

  const isDroppedQuery = req.query?.isDropped === 'true'
    || req.query?.status === 'Dropped'
    || req.query?.view === 'dropped'
    || req.query?.dropped === 'true';

  if (isDroppedQuery) {
    filter.isDropped = true;
    if (req.query?.status && req.query.status !== 'Dropped') {
      filter.status = String(req.query.status).trim();
    }
  } else if (req.query?.isDropped === 'all' || req.query?.status === 'all') {
    // Show all projects (active + dropped)
  } else {
    filter.isDropped = { $ne: true };
    if (req.query?.status) {
      filter.status = String(req.query.status).trim();
    } else {
      filter.status = { $ne: 'Dropped' };
    }
  }

  // Archive visibility: default active only; isArchived=true for archived; all for both
  const archiveRaw = String(req.query?.isArchived ?? req.query?.archived ?? '').trim().toLowerCase();
  if (archiveRaw === 'true' || archiveRaw === '1' || archiveRaw === 'archived' || archiveRaw === 'yes') {
    filter.isArchived = true;
  } else if (archiveRaw === 'all' || archiveRaw === 'any') {
    /* no archive filter — active + archived */
  } else {
    // Active only (includes explicit false / empty / omitted)
    filter.isArchived = { $ne: true };
  }

  if (req.query?.category) {
    filter.category = String(req.query.category).trim();
  }
  if (req.query?.label) {
    filter.label = String(req.query.label).trim();
  }
  if (req.query?.priority) {
    filter.priority = String(req.query.priority).trim();
  }
  if (req.query?.tag) {
    const t = String(req.query.tag).trim();
    filter.tags = t;
  }
  if (req.query?.search) {
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      const searchClause = {
        $or: [
          { name: { $regex: term, $options: 'i' } },
          { description: { $regex: term, $options: 'i' } },
          { category: { $regex: term, $options: 'i' } },
          { label: { $regex: term, $options: 'i' } },
          { tags: { $regex: term, $options: 'i' } },
          { priority: { $regex: term, $options: 'i' } }
        ]
      };
      if (filter.$or) {
        filter.$and = filter.$and || [];
        filter.$and.push({ $or: filter.$or }, searchClause);
        delete filter.$or;
      } else if (filter.$and) {
        filter.$and.push(searchClause);
      } else {
        filter.$or = searchClause.$or;
      }
    }
  }

  const scopedFilter = await applyEmployeeProjectListScope(req, filter);
  const [items, total] = await Promise.all([
    Project.find(scopedFilter).sort(sort).skip(skip).limit(limit).lean(),
    Project.countDocuments(scopedFilter)
  ]);

  return {
    items: await enrichProjects(req, items),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

async function listByClient(req, clientId) {
  req.query = { ...(req.query || {}), clientId: String(clientId) };
  return list(req);
}

async function getById(req, id) {
  const project = await findProjectOrThrow(req, id);
  const members = await listMembers(req, id);
  return {
    ...(await enrichProject(req, project)),
    members
  };
}

async function create(req, input) {
  const Project = getProjectModel(req);
  const ProjectMember = getProjectMemberModel(req);
  const Company = getCompanyModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const validStatuses = await getValidStatuses(req);
  const validPriorities = await getValidPriorities(req);

  if (!input.name) throw appError('Name is required');
  if (!input.clientId) throw appError('clientId is required');

  if (Company) {
    const client = await Company.findOne({
      tenantId,
      isDeleted: false,
      mergedIntoId: null,
      _id: String(input.clientId)
    }).lean();
    if (!client) throw appError('Client not found', 404);
  }

  const status = input.status || validStatuses[0];
  assertValidStatus(status, validStatuses);

  const priority = input.priority || 'Medium';
  assertValidPriority(priority, validPriorities);

  const rawTags = Array.isArray(input.tags)
    ? input.tags
    : (typeof input.tags === 'string'
      ? input.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : (input.label ? [input.label] : []));

  const assignees = input.assignedTo !== undefined ? parseAssignedTo(input.assignedTo) : [userId];
  const budget = input.budget !== undefined ? Math.max(0, Number(input.budget) || 0) : 0;
  const category = input.category ? String(input.category).trim() : '';
  const label = input.label ? String(input.label).trim() : (rawTags[0] || '');
  const settings = await SettingService.getAll(req).catch(() => ({}));
  const currency = input.currency
    ? String(input.currency).trim().toUpperCase()
    : SettingService.resolveDefaultCurrency(settings);
  const hoursEstimate = input.hoursEstimate !== undefined ? Math.max(0, Number(input.hoursEstimate) || 0) : 0;
  const progressCalculationMethod = ['tasks', 'time', 'manual'].includes(input.progressCalculationMethod)
    ? input.progressCalculationMethod
    : 'tasks';
  const customFields = (input.customFields && typeof input.customFields === 'object') ? input.customFields : {};
  const liveUrlRaw = input.liveUrl !== undefined ? String(input.liveUrl || '').trim() : '';
  const liveUrl = liveUrlRaw ? normalizeLiveUrl(liveUrlRaw) : '';
  if (liveUrlRaw && !isValidLiveUrl(liveUrlRaw)) {
    throw appError('Live URL must be a valid http(s) URL', 400);
  }
  if (isLiveStatus(status) && !liveUrl) {
    throw appError('Live URL is required when project status is Live', 400);
  }

  const project = await Project.create({
    tenantId,
    clientId: String(input.clientId),
    name: String(input.name).trim(),
    description: input.description ? String(input.description).trim() : '',
    category,
    label,
    tags: rawTags,
    priority,
    customFields,
    currency,
    hoursEstimate,
    progressCalculationMethod,
    status,
    liveUrl,
    budget,
    startDate: input.startDate ? new Date(input.startDate) : null,
    deadline: input.deadline ? new Date(input.deadline) : null,
    assignedTo: assignees,
    createdBy: userId,
    updatedBy: userId
  });

  const doc = project.toObject();

  if (ProjectMember) {
    const memberIds = new Set([userId, ...assignees]);
    for (const memberId of memberIds) {
      await ProjectMember.updateOne(
        { tenantId, projectId: String(doc._id), userId: memberId },
        {
          $setOnInsert: {
            tenantId,
            projectId: String(doc._id),
            userId: memberId,
            role: assignees.includes(memberId) ? 'lead' : 'member',
            createdBy: userId,
            updatedBy: userId,
            isDeleted: false
          }
        },
        { upsert: true }
      );
    }
  }

  await AuditService.log(req, {
    action: 'created',
    module: 'project',
    recordId: doc._id.toString(),
    description: `Project created: ${doc.name}`,
    metadata: { clientId: doc.clientId, status: doc.status, budget: doc.budget }
  });

  if (isLiveStatus(doc.status) && doc.liveUrl) {
    sendProjectLiveNotification(req, doc, doc.liveUrl);
  }

  return enrichProject(req, doc);
}

async function update(req, id, input) {
  const Project = getProjectModel(req);
  const ProjectMember = getProjectMemberModel(req);
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);
  const existing = await findProjectOrThrow(req, id);
  await assertProjectWriteAccess(req, existing);

  const validStatuses = await getValidStatuses(req);
  const validPriorities = await getValidPriorities(req);
  const updates = { updatedBy: userId };

  if (input.name !== undefined) {
    if (!String(input.name).trim()) throw appError('Name is required');
    updates.name = String(input.name).trim();
  }
  if (input.description !== undefined) updates.description = String(input.description).trim();
  if (input.clientId !== undefined) updates.clientId = String(input.clientId).trim();
  if (input.status !== undefined) {
    assertValidStatus(String(input.status).trim(), validStatuses);
    updates.status = String(input.status).trim();
  }
  if (input.liveUrl !== undefined) {
    const raw = String(input.liveUrl || '').trim();
    if (raw && !isValidLiveUrl(raw)) {
      throw appError('Live URL must be a valid http(s) URL', 400);
    }
    updates.liveUrl = raw ? normalizeLiveUrl(raw) : '';
  }
  if (input.priority !== undefined) {
    assertValidPriority(String(input.priority).trim(), validPriorities);
    updates.priority = String(input.priority).trim();
  }
  if (input.category !== undefined) updates.category = String(input.category).trim();
  if (input.label !== undefined) updates.label = String(input.label).trim();
  if (input.tags !== undefined) {
    updates.tags = Array.isArray(input.tags)
      ? input.tags.map((t) => String(t || '').trim()).filter(Boolean)
      : (typeof input.tags === 'string'
        ? input.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : []);
  }
  if (input.customFields !== undefined) {
    updates.customFields = (input.customFields && typeof input.customFields === 'object') ? input.customFields : {};
  }
  if (input.currency !== undefined) updates.currency = String(input.currency).trim().toUpperCase() || 'INR';
  if (input.hoursEstimate !== undefined) updates.hoursEstimate = Math.max(0, Number(input.hoursEstimate) || 0);
  if (input.progressCalculationMethod !== undefined) {
    updates.progressCalculationMethod = ['tasks', 'time', 'manual'].includes(input.progressCalculationMethod)
      ? input.progressCalculationMethod
      : 'tasks';
  }
  if (input.budget !== undefined) {
    updates.budget = Math.max(0, Number(input.budget) || 0);
  }
  if (input.startDate !== undefined) {
    updates.startDate = input.startDate ? new Date(input.startDate) : null;
  }
  if (input.deadline !== undefined) {
    updates.deadline = input.deadline ? new Date(input.deadline) : null;
  }
  if (input.assignedTo !== undefined) {
    const assignees = parseAssignedTo(input.assignedTo);
    updates.assignedTo = assignees;

    if (ProjectMember && assignees.length) {
      for (const memberId of assignees) {
        await ProjectMember.updateOne(
          { tenantId, projectId: String(id), userId: memberId },
          {
            $setOnInsert: {
              tenantId,
              projectId: String(id),
              userId: memberId,
              role: 'member',
              createdBy: userId,
              updatedBy: userId,
              isDeleted: false
            }
          },
          { upsert: true }
        );
      }
    }
  }

  if (updates.clientId) {
    const Company = getCompanyModel(req);
    const client = await Company.findOne({ ...baseFilter(req), mergedIntoId: null, _id: updates.clientId }).lean();
    if (!client) throw appError('Client not found', 404);
  }

  const effectiveStartDate = updates.startDate !== undefined ? updates.startDate : existing.startDate;
  const effectiveDeadline = updates.deadline !== undefined ? updates.deadline : existing.deadline;
  if (effectiveStartDate && effectiveDeadline && new Date(effectiveDeadline) < new Date(effectiveStartDate)) {
    throw appError('Deadline cannot be before start date');
  }

  const nextStatus = updates.status !== undefined ? updates.status : existing.status;
  const nextLiveUrl = updates.liveUrl !== undefined ? updates.liveUrl : (existing.liveUrl || '');
  if (isLiveStatus(nextStatus) && !String(nextLiveUrl || '').trim()) {
    throw appError('Live URL is required when project status is Live', 400);
  }

  const becomingLive =
    isLiveStatus(nextStatus) && !isLiveStatus(existing.status);

  const project = await Project.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'project',
    recordId: id,
    description: `Project updated: ${project.name}`
  });

  if (becomingLive && project.liveUrl) {
    // Fire-and-forget — do not block the update response on mail delivery
    sendProjectLiveNotification(req, project, project.liveUrl);
  }

  return enrichProject(req, project);
}

async function dropProject(req, id, input = {}) {
  const Project = getProjectModel(req);
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);
  const existing = await findProjectOrThrow(req, id);
  await assertProjectWriteAccess(req, existing);

  const now = new Date();
  const reason = String(input?.reason || input?.droppedReason || '').trim();
  const prev = (existing.status && existing.status !== 'Dropped')
    ? existing.status
    : (existing.previousStatus || 'In Progress');

  const project = await Project.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isDropped: true,
        status: 'Dropped',
        previousStatus: prev,
        droppedAt: now,
        droppedBy: userId,
        droppedReason: reason,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  const Task = getTaskModel(req);
  if (Task) {
    await Task.updateMany(
      { tenantId, projectId: String(id), isDeleted: false },
      { $set: { isProjectDropped: true, updatedBy: userId } }
    );
  }

  const Expense = req.cms?.models.get('Expense');
  if (Expense) {
    await Expense.updateMany(
      { tenantId, projectId: String(id), isDeleted: false },
      { $set: { isProjectDropped: true, updatedBy: userId } }
    );
  }

  const TimeLog = req.cms?.models.get('TimeLog');
  if (TimeLog) {
    await TimeLog.updateMany(
      { tenantId, projectId: String(id), isDeleted: false },
      { $set: { isProjectDropped: true, updatedBy: userId } }
    );
  }

  const Milestone = getMilestoneModel(req);
  if (Milestone) {
    await Milestone.updateMany(
      { tenantId, projectId: String(id), isDeleted: false },
      { $set: { isProjectDropped: true, updatedBy: userId } }
    );
  }

  await AuditService.log(req, {
    action: 'dropped',
    module: 'project',
    recordId: id,
    description: `Project dropped / deactivated: ${existing.name}${reason ? ` (Reason: ${reason})` : ''}`
  });

  return enrichProject(req, project);
}

async function remove(req, id, input = {}) {
  return dropProject(req, id, input);
}

async function reactivateProject(req, id) {
  const Project = getProjectModel(req);
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);
  const existing = await findProjectOrThrow(req, id);
  await assertProjectWriteAccess(req, existing);

  const restoredStatus = (existing.previousStatus && existing.previousStatus !== 'Dropped')
    ? existing.previousStatus
    : 'In Progress';

  const project = await Project.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isDropped: false,
        status: restoredStatus,
        droppedAt: null,
        droppedBy: null,
        droppedReason: '',
        isArchived: false,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  const Task = getTaskModel(req);
  if (Task && typeof Task.updateMany === 'function') {
    await Task.updateMany(
      { tenantId, projectId: String(id), isProjectDropped: true },
      { $set: { isProjectDropped: false, updatedBy: userId } }
    );
  }

  const Expense = req.cms?.models.get('Expense');
  if (Expense && typeof Expense.updateMany === 'function') {
    await Expense.updateMany(
      { tenantId, projectId: String(id), isProjectDropped: true },
      { $set: { isProjectDropped: false, updatedBy: userId } }
    );
  }

  const TimeLog = req.cms?.models.get('TimeLog');
  if (TimeLog && typeof TimeLog.updateMany === 'function') {
    await TimeLog.updateMany(
      { tenantId, projectId: String(id), isProjectDropped: true },
      { $set: { isProjectDropped: false, updatedBy: userId } }
    );
  }

  const Milestone = getMilestoneModel(req);
  if (Milestone && typeof Milestone.updateMany === 'function') {
    await Milestone.updateMany(
      { tenantId, projectId: String(id), isProjectDropped: true },
      { $set: { isProjectDropped: false, updatedBy: userId } }
    );
  }

  await AuditService.log(req, {
    action: 'reactivated',
    module: 'project',
    recordId: id,
    description: `Project reactivated: ${existing.name}`
  });

  return enrichProject(req, project);
}

async function archiveProject(req, id) {
  const Project = getProjectModel(req);
  const userId = resolveUserId(req);
  const existing = await findProjectOrThrow(req, id);
  await assertProjectWriteAccess(req, existing);

  const project = await Project.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isArchived: true,
        archivedAt: new Date(),
        archivedBy: userId,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'archived',
    module: 'project',
    recordId: id,
    description: `Project archived: ${existing.name}`
  });

  return enrichProject(req, project);
}

async function restoreProject(req, id) {
  const Project = getProjectModel(req);
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);
  const existing = await findProjectOrThrow(req, id);
  await assertProjectWriteAccess(req, existing);

  const restoredStatus = (existing.previousStatus && existing.previousStatus !== 'Dropped')
    ? existing.previousStatus
    : (existing.status === 'Dropped' ? 'In Progress' : existing.status);

  const project = await Project.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isArchived: false,
        archivedAt: null,
        archivedBy: null,
        isDropped: false,
        status: restoredStatus,
        droppedAt: null,
        droppedBy: null,
        droppedReason: '',
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  const Task = getTaskModel(req);
  if (Task && typeof Task.updateMany === 'function') {
    await Task.updateMany(
      { tenantId, projectId: String(id), isProjectDropped: true },
      { $set: { isProjectDropped: false, updatedBy: userId } }
    );
  }

  const Expense = req.cms?.models.get('Expense');
  if (Expense && typeof Expense.updateMany === 'function') {
    await Expense.updateMany(
      { tenantId, projectId: String(id), isProjectDropped: true },
      { $set: { isProjectDropped: false, updatedBy: userId } }
    );
  }

  const TimeLog = req.cms?.models.get('TimeLog');
  if (TimeLog && typeof TimeLog.updateMany === 'function') {
    await TimeLog.updateMany(
      { tenantId, projectId: String(id), isProjectDropped: true },
      { $set: { isProjectDropped: false, updatedBy: userId } }
    );
  }

  const Milestone = getMilestoneModel(req);
  if (Milestone && typeof Milestone.updateMany === 'function') {
    await Milestone.updateMany(
      { tenantId, projectId: String(id), isProjectDropped: true },
      { $set: { isProjectDropped: false, updatedBy: userId } }
    );
  }

  await AuditService.log(req, {
    action: 'restored',
    module: 'project',
    recordId: id,
    description: `Project restored from archive / dropped state: ${existing.name}`
  });

  return enrichProject(req, project);
}

async function listMembers(req, projectId) {
  const ProjectMember = getProjectMemberModel(req);
  if (!ProjectMember) return [];

  await findProjectOrThrow(req, projectId);

  const rows = await ProjectMember.find({
    ...baseFilter(req),
    projectId: String(projectId)
  })
    .sort({ createdAt: 1 })
    .lean();

  const nameMap = await resolveUsernames(
    req,
    rows.map((row) => row.userId)
  );
  const designationMap = await resolveUserDesignations(
    req,
    rows.map((row) => row.userId)
  );

  return rows.map((row) => {
    const username = nameMap[row.userId] || row.userId;
    const designation = designationMap[row.userId]?.designation || '';
    const tenantRole = designationMap[row.userId]?.role || '';
    return {
      ...row,
      hourlyRate: Number(row.hourlyRate || 0),
      username,
      designation,
      tenantRole,
      displayName: designation ? `${username} (${designation})` : username
    };
  });
}

async function addMember(req, projectId, memberInput) {
  const ProjectMember = getProjectMemberModel(req);
  if (!ProjectMember) throw appError('Project members are not available', 503);

  const project = await findProjectOrThrow(req, projectId);
  await assertProjectWriteAccess(req, project);

  const userId = resolveUserId(req);
  const isObject = memberInput && typeof memberInput === 'object';
  const memberId = String((isObject ? (memberInput.userId || memberInput.memberId) : memberInput) || '').trim();
  const role = String((isObject ? memberInput.role : 'member') || 'member').trim();
  const rawRate = isObject ? memberInput.hourlyRate : 0;
  const parsedRate = Number(rawRate);
  const hourlyRate = (Number.isFinite(parsedRate) && parsedRate >= 0) ? Math.round(parsedRate * 100) / 100 : 0;

  if (!memberId) throw appError('userId is required');

  const row = await ProjectMember.findOneAndUpdate(
    { tenantId: resolveTenantId(req), projectId: String(projectId), userId: memberId },
    {
      $set: {
        role,
        hourlyRate,
        updatedBy: userId,
        isDeleted: false,
        deletedAt: null,
        deletedBy: null
      },
      $setOnInsert: {
        tenantId: resolveTenantId(req),
        projectId: String(projectId),
        userId: memberId,
        createdBy: userId
      }
    },
    { upsert: true, new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'member_added',
    module: 'project',
    recordId: String(projectId),
    description: `Project member added: ${memberId} (hourly rate: ${hourlyRate})`
  });

  return row;
}

async function updateMember(req, projectId, memberUserId, input = {}) {
  const ProjectMember = getProjectMemberModel(req);
  if (!ProjectMember) throw appError('Project members are not available', 503);

  const project = await findProjectOrThrow(req, projectId);
  await assertProjectWriteAccess(req, project);

  const userId = resolveUserId(req);
  const memberId = String(memberUserId || '').trim();
  if (!memberId) throw appError('userId is required');

  const updates = { updatedBy: userId };
  if (input.hourlyRate !== undefined) {
    const r = Number(input.hourlyRate);
    updates.hourlyRate = (Number.isFinite(r) && r >= 0) ? Math.round(r * 100) / 100 : 0;
  }
  if (input.role !== undefined) {
    updates.role = String(input.role || 'member').trim();
  }

  const row = await ProjectMember.findOneAndUpdate(
    { tenantId: resolveTenantId(req), projectId: String(projectId), userId: memberId, isDeleted: false },
    { $set: updates },
    { new: true }
  ).lean();

  if (!row) throw appError('Project member not found', 404);

  await AuditService.log(req, {
    action: 'member_updated',
    module: 'project',
    recordId: String(projectId),
    description: `Project member updated: ${memberId}`
  });

  return row;
}

async function removeMember(req, projectId, memberUserId) {
  const ProjectMember = getProjectMemberModel(req);
  if (!ProjectMember) throw appError('Project members are not available', 503);

  const project = await findProjectOrThrow(req, projectId);
  await assertProjectWriteAccess(req, project);

  const userId = resolveUserId(req);
  await ProjectMember.findOneAndUpdate(
    {
      tenantId: resolveTenantId(req),
      projectId: String(projectId),
      userId: String(memberUserId),
      isDeleted: false
    },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        updatedBy: userId
      }
    }
  );

  await AuditService.log(req, {
    action: 'member_removed',
    module: 'project',
    recordId: String(projectId),
    description: `Project member removed: ${memberUserId}`
  });

  return { removed: true, userId: String(memberUserId) };
}

async function getOverview(req, projectId) {
  const project = await findProjectOrThrow(req, projectId);
  const enrichedProject = await enrichProject(req, project);
  const tenantId = resolveTenantId(req);

  const Task = getTaskModel(req);
  const TimeLog = req.cms?.models.get('TimeLog');
  const Expense = req.cms?.models.get('Expense');
  const Invoice = req.cms?.models.get('Invoice');
  const Milestone = req.cms?.models.get('Milestone');

  // 1. Task Breakdown for Pie Chart & Progress and Dependency Blocked Alerts
  const taskStatusCounts = { 'To Do': 0, 'In Progress': 0, 'Review': 0, 'Completed': 0, 'On Hold': 0 };
  let totalTasks = 0;
  let completedTasks = 0;
  const blockedAwaitingClientTasks = [];

  if (Task) {
    const tasks = await Task.find({ tenantId, projectId: String(projectId), isDeleted: false })
      .select('title status priority dueDate dependsOnTaskId clientFeedbackStatus clientNotifiedAt clientNotifiedEmail')
      .lean();
    totalTasks = tasks.length;
    const taskMap = new Map(tasks.map((t) => [String(t._id), t]));

    for (const t of tasks) {
      const st = t.status || 'To Do';
      taskStatusCounts[st] = (taskStatusCounts[st] || 0) + 1;
      if (st === 'Completed') completedTasks += 1;

      // Check if this task depends on another task that is completed but awaiting client reply
      const depId = t.dependsOnTaskId ? String(t.dependsOnTaskId).trim() : null;
      if (depId && depId !== 'none' && depId !== 'null') {
        const depTask = taskMap.get(depId);
        if (depTask) {
          const isDepCompleted = depTask.status === 'Completed';
          const isAwaitingReply = !depTask.clientFeedbackStatus ||
            depTask.clientFeedbackStatus === 'Not Replied' ||
            depTask.clientFeedbackStatus === 'Awaiting Reply' ||
            depTask.clientFeedbackStatus === 'Pending Review' ||
            depTask.clientFeedbackStatus === 'Pending Feedback';
          
          if (isDepCompleted && isAwaitingReply && depTask.clientFeedbackStatus !== 'Satisfied') {
            blockedAwaitingClientTasks.push({
              taskId: String(t._id),
              taskTitle: t.title,
              dependsOnTaskId: String(depTask._id),
              dependsOnTaskTitle: depTask.title,
              dependsOnTaskStatus: depTask.status,
              clientFeedbackStatus: depTask.clientFeedbackStatus || 'Not Replied',
              clientNotifiedAt: depTask.clientNotifiedAt || null,
              clientNotifiedEmail: depTask.clientNotifiedEmail || null,
              alertMessage: `Task "${t.title}" is dependent on "${depTask.title}" which is completed but client status is ⏳ Awaiting Reply. Can you talk and resend email to client?`
            });
          }
        }
      }
    }
  }

  // 2. Milestones Summary
  let totalMilestones = 0;
  let completedMilestones = 0;
  let milestoneEarnings = 0;
  if (Milestone) {
    const milestones = await Milestone.find({ tenantId, projectId: String(projectId), isDeleted: false }).select('status cost').lean();
    totalMilestones = milestones.length;
    for (const m of milestones) {
      if (m.status === 'Completed') {
        completedMilestones += 1;
        milestoneEarnings += Number(m.cost || 0);
      }
    }
  }

  // 3. Time Logs & Hours Logged for Bar Chart
  let totalHours = 0;
  let billableHours = 0;
  let billableTimeAmount = 0;
  const userHoursMap = {};
  const recentDaysHoursMap = {};

  if (TimeLog) {
    const logs = await TimeLog.find({ tenantId, projectId: String(projectId), isDeleted: false }).sort({ workDate: 1 }).lean();
    for (const log of logs) {
      const hrs = Number(log.hours || 0);
      totalHours += hrs;
      if (log.isBillable) {
        billableHours += hrs;
        billableTimeAmount += Number(log.billableAmount || 0);
      }
      const user = String(log.createdBy || 'Team');
      userHoursMap[user] = (userHoursMap[user] || 0) + hrs;

      if (log.workDate) {
        const dStr = new Date(log.workDate).toISOString().slice(0, 10);
        recentDaysHoursMap[dStr] = (recentDaysHoursMap[dStr] || 0) + hrs;
      }
    }
  }

  // Resolve usernames for hours bar graph
  const hoursUserIds = Object.keys(userHoursMap);
  const hoursNameMap = await resolveUsernames(req, hoursUserIds);
  const hoursByUser = Object.entries(userHoursMap).map(([uid, hrs]) => ({
    userId: uid,
    username: hoursNameMap[uid] || uid,
    hours: Math.round(hrs * 100) / 100
  }));

  const hoursByDate = Object.entries(recentDaysHoursMap).slice(-7).map(([date, hrs]) => ({
    date,
    hours: Math.round(hrs * 100) / 100
  }));

  // 4. Financials: Expenses, Earnings, Budget, Profit
  let expensesTotal = 0;
  if (Expense) {
    const expenses = await Expense.find({ tenantId, projectId: String(projectId), isDeleted: false, status: { $in: ['Approved', 'Submitted'] } }).select('amount').lean();
    for (const exp of expenses) {
      expensesTotal += Number(exp.amount || 0);
    }
  }
  const totalExpenses = expensesTotal + billableTimeAmount;

  let invoiceEarnings = 0;
  if (Invoice) {
    const invoices = await Invoice.find({ tenantId, projectId: String(projectId), isDeleted: false }).select('paidAmount amountPaid total status').lean();
    for (const inv of invoices) {
      if (!inv.status || inv.status === 'Paid' || inv.status === 'Partially Paid') {
        invoiceEarnings += Number(inv.paidAmount ?? inv.amountPaid ?? 0);
      }
    }
  }
  const earnings = invoiceEarnings || milestoneEarnings;
  const projectBudget = Number(project.budget || 0);
  const profit = earnings - totalExpenses;

  // 5. Progress Percentage Calculation
  let progressPct = 0;
  if (project.progressCalculationMethod === 'time' && project.hoursEstimate && project.hoursEstimate > 0) {
    progressPct = Math.min(100, Math.round((totalHours / Number(project.hoursEstimate)) * 100));
  } else if (project.progressCalculationMethod === 'manual' && project.manualProgress !== undefined && project.manualProgress !== null) {
    progressPct = Math.min(100, Math.max(0, Number(project.manualProgress) || 0));
  } else {
    // Default: task-based progress
    progressPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  }

  return {
    project: enrichedProject,
    progress: {
      percentage: progressPct,
      completedTasks,
      totalTasks,
      completedMilestones,
      totalMilestones
    },
    taskBreakdown: taskStatusCounts,
    blockedAwaitingClientTasks,
    statistics: {
      budget: projectBudget,
      earnings,
      expenses: totalExpenses,
      profit
    },
    hoursLogged: {
      totalHours: Math.round(totalHours * 100) / 100,
      billableHours: Math.round(billableHours * 100) / 100,
      billableTimeAmount: Math.round(billableTimeAmount * 100) / 100,
      byUser: hoursByUser,
      byDate: hoursByDate
    }
  };
}

async function getActivity(req, projectId) {
  await findProjectOrThrow(req, projectId);
  const tenantId = resolveTenantId(req);
  const AuditLog = req.cms?.models.get('AuditLog');
  const Task = getTaskModel(req);
  const TimeLog = req.cms?.models.get('TimeLog');
  const Milestone = req.cms?.models.get('Milestone');
  const Expense = req.cms?.models.get('Expense');

  const { page, limit, skip, sort } = parsePagination(req.query, { sortField: 'createdAt', sortOrder: -1 });

  if (!AuditLog) {
    return { items: [], pagination: { page, limit, total: 0, totalPages: 1 } };
  }

  // Collect linked record IDs
  let taskIds = [];
  if (Task) {
    const tasks = await Task.find({ tenantId, projectId: String(projectId) }).select('_id').lean();
    taskIds = tasks.map((t) => String(t._id));
  }

  let milestoneIds = [];
  if (Milestone) {
    const ms = await Milestone.find({ tenantId, projectId: String(projectId) }).select('_id').lean();
    milestoneIds = ms.map((m) => String(m._id));
  }

  let timeLogIds = [];
  if (TimeLog) {
    const tls = await TimeLog.find({ tenantId, projectId: String(projectId) }).select('_id').lean();
    timeLogIds = tls.map((tl) => String(tl._id));
  }

  let expenseIds = [];
  if (Expense) {
    const exps = await Expense.find({ tenantId, projectId: String(projectId) }).select('_id').lean();
    expenseIds = exps.map((e) => String(e._id));
  }

  const orConditions = [
    { module: 'project', recordId: String(projectId) },
    { 'metadata.projectId': String(projectId) }
  ];
  if (taskIds.length) orConditions.push({ module: 'task', recordId: { $in: taskIds } });
  if (milestoneIds.length) orConditions.push({ module: 'milestone', recordId: { $in: milestoneIds } });
  if (timeLogIds.length) orConditions.push({ module: 'time_log', recordId: { $in: timeLogIds } });
  if (expenseIds.length) orConditions.push({ module: 'expense', recordId: { $in: expenseIds } });

  const filter = {
    tenantId,
    $or: orConditions
  };

  if (req.query?.action) {
    filter.action = String(req.query.action).trim();
  }

  if (req.query?.search) {
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      filter.$and = [
        {
          $or: [
            { description: { $regex: term, $options: 'i' } },
            { action: { $regex: term, $options: 'i' } },
            { module: { $regex: term, $options: 'i' } }
          ]
        }
      ];
    }
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter)
  ]);

  const { enrichAuditUsers } = require('../utils/user.util');
  const enriched = await enrichAuditUsers(req, items);

  return {
    items: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

async function exportProjects(req, query = {}) {
  const Project = getProjectModel(req);
  let filter = baseFilter(req);

  const isDroppedQuery = query.isDropped === 'true'
    || query.status === 'Dropped'
    || query.view === 'dropped'
    || query.dropped === 'true';

  if (isDroppedQuery) {
    filter.isDropped = true;
  } else if (query.isDropped === 'all' || query.status === 'all') {
    // all
  } else {
    filter.isDropped = { $ne: true };
    if (!query.status) {
      filter.status = { $ne: 'Dropped' };
    }
  }

  if (query.status && query.status !== 'Dropped') {
    const s = toLiteralSearchTerm(String(query.status).trim());
    if (s) filter.status = new RegExp(`^${s}$`, 'i');
  }
  if (query.priority) {
    const p = toLiteralSearchTerm(String(query.priority).trim());
    if (p) filter.priority = new RegExp(`^${p}$`, 'i');
  }
  if (query.clientId) filter.clientId = String(query.clientId).trim();
  if (query.category) filter.category = String(query.category).trim();

  const archiveRaw = String(query.isArchived ?? query.archived ?? '').trim().toLowerCase();
  if (archiveRaw === 'true' || archiveRaw === '1' || archiveRaw === 'archived' || archiveRaw === 'yes') {
    filter.isArchived = true;
  } else if (archiveRaw === 'all' || archiveRaw === 'any') {
    /* both */
  } else {
    filter.isArchived = { $ne: true };
  }

  if (query.search) {
    const term = toLiteralSearchTerm(query.search);
    if (term) {
      filter.$or = [
        { name: { $regex: term, $options: 'i' } },
        { code: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } }
      ];
    }
  }

  filter = applyEmployeeProjectListScope(req, filter);

  const raw = await Project.find(filter).sort({ createdAt: -1 }).lean();
  const enriched = await enrichProjects(req, raw);

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'project',
    recordId: 'export',
    description: `Exported ${enriched.length} projects in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `projects_export_${nowStr}.json`,
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
    'Project Name',
    'Code',
    'Client Name',
    'Status',
    'Priority',
    'Billing Type',
    'Budget',
    'Currency',
    'Progress (%)',
    'Start Date',
    'Deadline',
    'Category',
    'Tags',
    'Assigned To',
    'Created At',
    'Updated At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const p of enriched) {
    const assignees = Array.isArray(p.assignedUserNames)
      ? p.assignedUserNames.join('; ')
      : (Array.isArray(p.assignedTo) ? p.assignedTo.join('; ') : (p.assignedTo || ''));
    rows.push(
      [
        p._id,
        p.name || '',
        p.code || '',
        p.clientCompany || p.clientName || '',
        p.status || '',
        p.priority || '',
        p.billingType || '',
        Number(p.budget || 0),
        p.currency || 'INR',
        Number(p.progress || p.progressPercent || 0),
        p.startDate ? new Date(p.startDate).toISOString().slice(0, 10) : '',
        p.deadline ? new Date(p.deadline).toISOString().slice(0, 10) : '',
        p.category || '',
        Array.isArray(p.tags) ? p.tags.join('; ') : (p.tags || ''),
        assignees,
        p.createdAt ? new Date(p.createdAt).toISOString() : '',
        p.updatedAt ? new Date(p.updatedAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `projects_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enriched.length
  };
}

module.exports = {
  list,
  listByClient,
  getById,
  getOverview,
  getActivity,
  create,
  update,
  remove,
  dropProject,
  reactivateProject,
  archiveProject,
  restoreProject,
  listMembers,
  addMember,
  updateMember,
  removeMember,
  getValidStatuses,
  getValidPriorities,
  findProjectOrThrow,
  exportProjects
};
