'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');
const ProjectService = require('./project.service');
const MilestoneService = require('./milestone.service');
const TaskService = require('./task.service');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getTemplateModel(req) {
  const ProjectTemplate = req.cms?.models.get('ProjectTemplate');
  if (!ProjectTemplate) throw appError('ProjectTemplate model is not registered', 500);
  return ProjectTemplate;
}

function getMilestoneModel(req) {
  const Milestone = req.cms?.models.get('Milestone');
  if (!Milestone) throw appError('Milestone model is not registered', 500);
  return Milestone;
}

async function listTemplates(req) {
  const tenantId = resolveTenantId(req);
  const ProjectTemplate = getTemplateModel(req);

  const items = await ProjectTemplate.find({ tenantId, isDeleted: false })
    .sort({ createdAt: -1 })
    .lean();

  return items;
}

async function getTemplateById(req, id) {
  const tenantId = resolveTenantId(req);
  const ProjectTemplate = getTemplateModel(req);

  const template = await ProjectTemplate.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!template) throw appError('Project template not found', 404);
  return template;
}

async function createTemplate(req, payload = {}) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const ProjectTemplate = getTemplateModel(req);

  const name = String(payload.name || '').trim();
  if (!name) throw appError('Template name is required', 400);

  const docData = {
    tenantId,
    name,
    description: String(payload.description || '').trim(),
    category: String(payload.category || '').trim(),
    priority: String(payload.priority || 'Medium').trim(),
    currency: String(payload.currency || 'INR').trim(),
    hoursEstimate: Number(payload.hoursEstimate) || 0,
    milestones: Array.isArray(payload.milestones) ? payload.milestones : [],
    tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
    createdBy: userId,
    updatedBy: userId
  };

  const created = await ProjectTemplate.create(docData);
  const result = created.toObject ? created.toObject() : created;

  await AuditService.log(req, {
    action: 'created',
    module: 'project',
    recordId: result._id,
    description: `Created project template "${result.name}" with ${result.milestones.length} milestones and ${result.tasks.length} tasks`,
    metadata: { templateId: result._id, milestoneCount: result.milestones.length, taskCount: result.tasks.length }
  });

  return result;
}

async function updateTemplate(req, id, payload = {}) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const ProjectTemplate = getTemplateModel(req);

  const existing = await getTemplateById(req, id);

  const updates = {
    updatedBy: userId
  };

  if (payload.name !== undefined) {
    const name = String(payload.name).trim();
    if (!name) throw appError('Template name cannot be empty', 400);
    updates.name = name;
  }
  if (payload.description !== undefined) updates.description = String(payload.description).trim();
  if (payload.category !== undefined) updates.category = String(payload.category).trim();
  if (payload.priority !== undefined) updates.priority = String(payload.priority).trim();
  if (payload.currency !== undefined) updates.currency = String(payload.currency).trim();
  if (payload.hoursEstimate !== undefined) updates.hoursEstimate = Number(payload.hoursEstimate) || 0;
  if (Array.isArray(payload.milestones)) updates.milestones = payload.milestones;
  if (Array.isArray(payload.tasks)) updates.tasks = payload.tasks;

  const updated = await ProjectTemplate.findOneAndUpdate(
    { _id: id, tenantId, isDeleted: false },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'project',
    recordId: id,
    description: `Updated project template "${updated.name}"`
  });

  return updated;
}

async function deleteTemplate(req, id) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const ProjectTemplate = getTemplateModel(req);

  const existing = await getTemplateById(req, id);

  await ProjectTemplate.findOneAndUpdate(
    { _id: id, tenantId, isDeleted: false },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId
      }
    }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'project',
    recordId: id,
    description: `Deleted project template "${existing.name}"`
  });

  return { success: true, message: 'Project template deleted' };
}

async function createProjectFromTemplate(req, templateId, input = {}) {
  const template = await getTemplateById(req, templateId);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const Milestone = getMilestoneModel(req);

  const clientId = input.clientId;
  if (!clientId) throw appError('Client ID is required to instantiate project', 400);

  const projectName = String(input.name || template.name).trim();
  const startDate = input.startDate ? new Date(input.startDate) : new Date();
  const deadline = input.deadline
    ? new Date(input.deadline)
    : new Date(startDate.getTime() + (template.milestones.length ? Math.max(...template.milestones.map((m) => m.dueDayOffset || 14)) : 30) * 86400000);

  // 1. Create Project
  const project = await ProjectService.create(req, {
    clientId,
    name: projectName,
    description: input.description || template.description || '',
    category: input.category || template.category || '',
    priority: input.priority || template.priority || 'Medium',
    currency: input.currency || template.currency || 'INR',
    budget: Number(input.budget) || 0,
    hoursEstimate: Number(input.hoursEstimate || template.hoursEstimate || 0),
    startDate,
    deadline,
    assignedTo: Array.isArray(input.assignedTo) ? input.assignedTo : [],
    status: input.status || 'Not Started'
  });

  const createdMilestones = [];
  const milestoneIdMap = new Map(); // template index -> created milestone id

  // 2. Create Milestones
  for (let i = 0; i < (template.milestones || []).length; i++) {
    const tm = template.milestones[i];
    const msDueDate = new Date(startDate.getTime() + (Number(tm.dueDayOffset) || 14) * 86400000);
    const milestoneTitle = String(tm.title || tm.name || `Milestone ${i + 1}`).trim();
    const ms = await MilestoneService.create(req, {
      projectId: String(project._id),
      title: milestoneTitle,
      summary: String(tm.summary || tm.description || '').trim(),
      cost: Number(tm.cost || 0),
      status: tm.status || 'Pending',
      startDate: startDate,
      endDate: msDueDate
    });
    const createdMs = ms.toObject ? ms.toObject() : { ...ms };
    if (!createdMs.name) createdMs.name = milestoneTitle;
    createdMilestones.push(createdMs);
    milestoneIdMap.set(i, String(createdMs._id));
  }

  // 3. Create Tasks
  const createdTasks = [];
  for (const tt of template.tasks || []) {
    const taskStartDate = new Date(startDate.getTime() + (Number(tt.dayOffset) || 0) * 86400000);
    const taskDueDate = new Date(startDate.getTime() + (Number(tt.dueDayOffset) || 7) * 86400000);
    const assignedMilestoneId = tt.milestoneIndex !== undefined && tt.milestoneIndex !== null
      ? milestoneIdMap.get(Number(tt.milestoneIndex)) || null
      : null;

    const task = await TaskService.create(req, {
      projectId: String(project._id),
      milestoneId: assignedMilestoneId,
      title: tt.title || 'Task',
      description: tt.description || '',
      priority: tt.priority || 'Medium',
      hoursEstimate: Number(tt.hoursEstimate) || 0,
      startDate: taskStartDate,
      deadline: taskDueDate,
      status: 'To Do',
      assignedTo: Array.isArray(input.assignedTo) && input.assignedTo.length ? [input.assignedTo[0]] : []
    });
    createdTasks.push(task);
  }

  await AuditService.log(req, {
    action: 'created',
    module: 'project',
    recordId: project._id,
    description: `Created project "${project.name}" from template "${template.name}" with ${createdMilestones.length} milestones and ${createdTasks.length} tasks`,
    metadata: { templateId, projectId: project._id, milestones: createdMilestones.length, tasks: createdTasks.length }
  });

  return {
    project,
    milestones: createdMilestones,
    tasks: createdTasks
  };
}

module.exports = {
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  createProjectFromTemplate
};
