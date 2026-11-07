'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');
const TaskService = require('./task.service');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getTemplateModel(req) {
  const TaskTemplate = req.cms?.models.get('TaskTemplate');
  if (!TaskTemplate) throw appError('TaskTemplate model is not registered', 500);
  return TaskTemplate;
}

async function listTemplates(req) {
  const tenantId = resolveTenantId(req);
  const TaskTemplate = getTemplateModel(req);

  const filter = { tenantId, isDeleted: false };
  if (req.query?.category) {
    filter.category = String(req.query.category).trim();
  }
  if (req.query?.search) {
    const term = String(req.query.search).trim();
    filter.$or = [
      { title: { $regex: term, $options: 'i' } },
      { description: { $regex: term, $options: 'i' } }
    ];
  }

  const items = await TaskTemplate.find(filter)
    .sort({ createdAt: -1 })
    .lean();

  return items;
}

async function getTemplateById(req, id) {
  const tenantId = resolveTenantId(req);
  const TaskTemplate = getTemplateModel(req);

  const template = await TaskTemplate.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!template) throw appError('Task template not found', 404);
  return template;
}

async function createTemplate(req, payload = {}) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const TaskTemplate = getTemplateModel(req);

  const title = String(payload.title || '').trim();
  if (!title) throw appError('Template title is required', 400);

  const docData = {
    tenantId,
    title,
    description: String(payload.description || '').trim(),
    category: String(payload.category || '').trim(),
    priority: String(payload.priority || 'Medium').trim(),
    hoursEstimate: Number(payload.hoursEstimate) || 0,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    subtasks: Array.isArray(payload.subtasks)
      ? payload.subtasks.map((st) => ({
          title: String(st.title || '').trim(),
          description: String(st.description || '').trim()
        })).filter((st) => Boolean(st.title))
      : [],
    createdBy: userId,
    updatedBy: userId
  };

  const created = await TaskTemplate.create(docData);
  const result = created.toObject ? created.toObject() : created;

  await AuditService.log(req, {
    action: 'created',
    module: 'task',
    recordId: String(result._id),
    description: `Created task template "${result.title}" with ${(result.subtasks || []).length} subtasks`,
    metadata: { templateId: String(result._id), subtaskCount: (result.subtasks || []).length }
  });

  return result;
}

async function updateTemplate(req, id, payload = {}) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const TaskTemplate = getTemplateModel(req);

  await getTemplateById(req, id);

  const updates = {
    updatedBy: userId
  };

  if (payload.title !== undefined) {
    const title = String(payload.title).trim();
    if (!title) throw appError('Template title cannot be empty', 400);
    updates.title = title;
  }
  if (payload.description !== undefined) updates.description = String(payload.description).trim();
  if (payload.category !== undefined) updates.category = String(payload.category).trim();
  if (payload.priority !== undefined) updates.priority = String(payload.priority).trim();
  if (payload.hoursEstimate !== undefined) updates.hoursEstimate = Math.max(0, Number(payload.hoursEstimate) || 0);
  if (payload.tags !== undefined) updates.tags = Array.isArray(payload.tags) ? payload.tags : [];
  if (payload.subtasks !== undefined) {
    updates.subtasks = Array.isArray(payload.subtasks)
      ? payload.subtasks.map((st) => ({
          title: String(st.title || '').trim(),
          description: String(st.description || '').trim()
        })).filter((st) => Boolean(st.title))
      : [];
  }

  const updated = await TaskTemplate.findOneAndUpdate(
    { _id: id, tenantId, isDeleted: false },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'task',
    recordId: String(id),
    description: `Updated task template "${updated.title}"`,
    metadata: { templateId: String(id) }
  });

  return updated;
}

async function deleteTemplate(req, id) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const TaskTemplate = getTemplateModel(req);

  const existing = await getTemplateById(req, id);

  await TaskTemplate.findOneAndUpdate(
    { _id: id, tenantId },
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
    action: 'deleted',
    module: 'task',
    recordId: String(id),
    description: `Deleted task template "${existing.title}"`,
    metadata: { templateId: String(id) }
  });

  return { success: true, message: 'Task template deleted successfully' };
}

async function instantiateTemplate(req, id, options = {}) {
  const template = await getTemplateById(req, id);

  const projectId = String(options.projectId || '').trim();
  if (!projectId) throw appError('projectId is required to instantiate template', 400);

  const taskPayload = {
    projectId,
    milestoneId: options.milestoneId || null,
    title: options.title ? String(options.title).trim() : template.title,
    description: options.description !== undefined ? String(options.description).trim() : template.description,
    priority: options.priority || template.priority || 'Medium',
    category: options.category !== undefined ? String(options.category).trim() : template.category,
    hoursEstimate: options.hoursEstimate !== undefined ? Number(options.hoursEstimate) : template.hoursEstimate,
    tags: Array.isArray(options.tags) ? options.tags : template.tags || [],
    assignedTo: options.assignedTo !== undefined ? String(options.assignedTo).trim() : '',
    dueDate: options.dueDate || null,
    status: options.status || 'To Do',
    notifyClientOnCompletion: Boolean(options.notifyClientOnCompletion)
  };

  const createdTask = await TaskService.create(req, taskPayload);

  const subtasksCreated = [];
  if (Array.isArray(template.subtasks) && template.subtasks.length) {
    for (const st of template.subtasks) {
      if (!st.title) continue;
      const createdSubtask = await TaskService.addSubtask(req, createdTask._id, {
        title: st.title,
        description: st.description || '',
        assignedTo: options.assignedTo || ''
      });
      subtasksCreated.push(createdSubtask);
    }
  }

  await AuditService.log(req, {
    action: 'instantiated_from_template',
    module: 'task',
    recordId: String(createdTask._id),
    description: `Created task "${createdTask.title}" from template "${template.title}" with ${subtasksCreated.length} subtasks`,
    metadata: {
      templateId: String(template._id),
      taskId: String(createdTask._id),
      projectId,
      subtaskCount: subtasksCreated.length
    }
  });

  const refreshedTask = await TaskService.getById(req, createdTask._id);
  return refreshedTask || createdTask;
}

async function saveTaskAsTemplate(req, taskId, options = {}) {
  const task = await TaskService.getById(req, taskId);
  if (!task) throw appError('Task not found', 404);

  const title = options.title ? String(options.title).trim() : `${task.title} (Template)`;
  const description = options.description !== undefined ? String(options.description).trim() : (task.description || '');
  const category = options.category !== undefined ? String(options.category).trim() : (task.category || '');
  const priority = options.priority || task.priority || 'Medium';
  const hoursEstimate = options.hoursEstimate !== undefined ? Number(options.hoursEstimate) : (task.hoursEstimate || 0);
  const tags = Array.isArray(options.tags) ? options.tags : (task.tags || []);

  const subtasks = (Array.isArray(task.subtasks) ? task.subtasks : []).map((st) => ({
    title: st.title,
    description: st.description || ''
  })).filter((st) => Boolean(st.title));

  const template = await createTemplate(req, {
    title,
    description,
    category,
    priority,
    hoursEstimate,
    tags,
    subtasks
  });

  return template;
}

module.exports = {
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  instantiateTemplate,
  saveTaskAsTemplate
};
