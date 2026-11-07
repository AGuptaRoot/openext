'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const ProjectService = require('./project.service');
const AuditService = require('./audit.service');
const {
  assertProjectReadAccess,
  assertProjectWriteAccess
} = require('../utils/project-access.util');

function getMilestoneModel(req) {
  const Milestone = req.cms?.models.get('Milestone');
  if (!Milestone) throw new Error('Milestone model is not registered');
  return Milestone;
}

function getProjectModel(req) {
  const Project = req.cms?.models.get('Project');
  if (!Project) throw new Error('Project model is not registered');
  return Project;
}

function getTaskModel(req) {
  return req.cms?.models.get('Task') || null;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

async function findMilestoneOrThrow(req, id) {
  const milestone = await getMilestoneModel(req).findOne({ ...baseFilter(req), _id: id }).lean();
  if (!milestone) throw appError('Milestone not found', 404);

  const project = await ProjectService.findProjectOrThrow(req, milestone.projectId);
  await assertProjectReadAccess(req, project);
  return { milestone, project };
}

async function enrichMilestones(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];

  const Task = getTaskModel(req);
  const milestoneIds = items.map((m) => String(m._id));
  const taskStats = {};

  if (Task && milestoneIds.length) {
    try {
      const counts = await Task.aggregate([
        {
          $match: {
            tenantId: resolveTenantId(req),
            isDeleted: false,
            milestoneId: { $in: milestoneIds }
          }
        },
        {
          $group: {
            _id: '$milestoneId',
            totalTasks: { $sum: 1 },
            completedTasks: {
              $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] }
            }
          }
        }
      ]);

      for (const row of counts) {
        taskStats[String(row._id)] = {
          totalTasks: row.totalTasks,
          completedTasks: row.completedTasks,
          progress: row.totalTasks > 0 ? Math.round((row.completedTasks / row.totalTasks) * 100) : 0
        };
      }
    } catch (err) {
      console.warn('[MilestoneService] Task aggregate warning:', err.message);
    }
  }

  return items.map((item) => {
    const stats = taskStats[String(item._id)] || { totalTasks: 0, completedTasks: 0, progress: item.status === 'Completed' ? 100 : 0 };
    return {
      ...item,
      cost: Number(item.cost || 0),
      totalTasks: stats.totalTasks,
      completedTasks: stats.completedTasks,
      progress: stats.progress
    };
  });
}

async function list(req) {
  const Milestone = getMilestoneModel(req);
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
    const Project = req.cms?.models.get('Project');
    let clientProjectIds = [];
    if (Project) {
      const clientProjects = await Project.find({
        tenantId: resolveTenantId(req),
        isDeleted: false,
        clientId: userClientId
      }).select('_id').lean();
      clientProjectIds = clientProjects.map((p) => String(p._id));
    }
    if (req.query?.projectId) {
      const reqPid = String(req.query.projectId).trim();
      if (clientProjectIds.includes(reqPid)) {
        filter.projectId = reqPid;
      } else {
        filter.projectId = '__NON_EXISTENT_PROJECT__';
      }
    } else {
      filter.projectId = { $in: clientProjectIds };
    }
  } else if (req.query?.projectId) {
    filter.projectId = String(req.query.projectId).trim();
  }
  if (req.query?.status) {
    filter.status = String(req.query.status).trim();
  }
  if (req.query?.search) {
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      filter.$or = [
        { title: { $regex: term, $options: 'i' } },
        { summary: { $regex: term, $options: 'i' } }
      ];
    }
  }

  const [items, total] = await Promise.all([
    Milestone.find(filter).sort(sort || { createdAt: -1 }).skip(skip).limit(limit).lean(),
    Milestone.countDocuments(filter)
  ]);

  return {
    items: await enrichMilestones(req, items),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

async function listByProject(req, projectId) {
  const project = await ProjectService.findProjectOrThrow(req, projectId);
  await assertProjectReadAccess(req, project);

  const Milestone = getMilestoneModel(req);
  const items = await Milestone.find({
    ...baseFilter(req),
    projectId: String(projectId)
  })
    .sort({ createdAt: -1 })
    .lean();

  return enrichMilestones(req, items);
}

async function getById(req, id) {
  const { milestone } = await findMilestoneOrThrow(req, id);
  const [enriched] = await enrichMilestones(req, [milestone]);
  return enriched;
}

function normalizeMilestoneStatus(val) {
  if (!val) return 'Pending';
  const s = String(val).trim().toLowerCase();
  if (s === 'in progress' || s === 'in_progress' || s === 'in-progress') return 'In Progress';
  if (s === 'completed' || s === 'complete' || s === 'done') return 'Completed';
  if (s === 'cancelled' || s === 'canceled') return 'Cancelled';
  return 'Pending';
}

async function create(req, input) {
  const Milestone = getMilestoneModel(req);
  const Project = getProjectModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const title = String(input.title || input.name || '').trim();
  if (!title) throw appError('Milestone Title is required');
  if (!input.projectId) throw appError('Project ID is required');

  const project = await ProjectService.findProjectOrThrow(req, input.projectId);
  if (project?.isArchived) {
    throw appError('Cannot create milestones for an archived project. Please restore the project first.', 400);
  }
  await assertProjectWriteAccess(req, project);

  const cost = Math.max(0, Number(input.cost) || 0);
  const addCostToBudget = Boolean(input.addCostToBudget);
  const status = normalizeMilestoneStatus(input.status);

  const milestone = await Milestone.create({
    tenantId,
    projectId: String(input.projectId),
    title,
    summary: String(input.summary || '').trim(),
    cost,
    status,
    addCostToBudget,
    startDate: input.startDate ? new Date(input.startDate) : null,
    endDate: input.endDate ? new Date(input.endDate) : null,
    createdBy: userId,
    updatedBy: userId
  });

  const doc = milestone.toObject();

  // If "Add Cost To Project Budget" is enabled, increment Project's budget
  if (addCostToBudget && cost > 0) {
    await Project.updateOne(
      { tenantId, _id: String(input.projectId) },
      { $inc: { budget: cost } }
    );
  }

  await AuditService.log(req, {
    action: 'created',
    module: 'milestone',
    recordId: doc._id.toString(),
    description: `Milestone created: ${doc.title}`,
    metadata: { projectId: doc.projectId, cost: doc.cost, addCostToBudget: doc.addCostToBudget }
  });

  const [enriched] = await enrichMilestones(req, [doc]);
  return enriched;
}

async function update(req, id, input) {
  const Milestone = getMilestoneModel(req);
  const Project = getProjectModel(req);
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);

  const { milestone: existing, project } = await findMilestoneOrThrow(req, id);
  if (project?.isArchived) {
    throw appError('Cannot update milestones for an archived project. Please restore the project first.', 400);
  }
  await assertProjectWriteAccess(req, project);

  const updates = { updatedBy: userId };

  if (input.title !== undefined || input.name !== undefined) {
    const titleVal = String(input.title !== undefined ? input.title : input.name).trim();
    if (!titleVal) throw appError('Milestone Title is required');
    updates.title = titleVal;
  }
  if (input.summary !== undefined) updates.summary = String(input.summary).trim();
  if (input.status !== undefined) updates.status = normalizeMilestoneStatus(input.status);
  if (input.cost !== undefined) updates.cost = Math.max(0, Number(input.cost) || 0);
  if (input.addCostToBudget !== undefined) updates.addCostToBudget = Boolean(input.addCostToBudget);
  if (input.startDate !== undefined) updates.startDate = input.startDate ? new Date(input.startDate) : null;
  if (input.endDate !== undefined) updates.endDate = input.endDate ? new Date(input.endDate) : null;

  // Handle budget delta adjustments
  const prevContributed = existing.addCostToBudget ? (Number(existing.cost) || 0) : 0;
  const newContributed = (updates.addCostToBudget !== undefined ? updates.addCostToBudget : existing.addCostToBudget)
    ? (updates.cost !== undefined ? updates.cost : Number(existing.cost) || 0)
    : 0;

  const budgetDelta = newContributed - prevContributed;
  if (budgetDelta !== 0) {
    await Project.updateOne(
      { tenantId, _id: existing.projectId },
      { $inc: { budget: budgetDelta } }
    );
  }

  const doc = await Milestone.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'milestone',
    recordId: id,
    description: `Milestone updated: ${doc.title}`
  });

  const [enriched] = await enrichMilestones(req, [doc]);
  return enriched;
}

async function remove(req, id) {
  const Milestone = getMilestoneModel(req);
  const Project = getProjectModel(req);
  const userId = resolveUserId(req);
  const tenantId = resolveTenantId(req);

  const { milestone: existing, project } = await findMilestoneOrThrow(req, id);
  if (String(existing.status || '').toLowerCase() === 'completed') {
    throw appError('Cannot delete a completed milestone.', 400);
  }
  if (project?.isArchived) {
    throw appError('Cannot delete milestones from an archived project. Please restore the project first.', 400);
  }
  await assertProjectWriteAccess(req, project);

  // If cost was added to budget, deduct it on removal
  if (existing.addCostToBudget && existing.cost > 0) {
    await Project.updateOne(
      { tenantId, _id: existing.projectId },
      { $inc: { budget: -existing.cost } }
    );
  }

  const doc = await Milestone.findOneAndUpdate(
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

  await AuditService.log(req, {
    action: 'deleted',
    module: 'milestone',
    recordId: id,
    description: `Milestone deleted: ${existing.title}`
  });

  return doc;
}

module.exports = {
  list,
  listByProject,
  getById,
  create,
  update,
  remove,
  findMilestoneOrThrow
};
