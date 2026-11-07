'use strict';

const ProjectService = require('../services/project.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid project ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] project error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Project operation failed',
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const result = await ProjectService.list(req);
    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      unlinkedClient: Boolean(result.unlinkedClient),
      message: result.message || 'Projects loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const project = await ProjectService.getById(req, req.params.id);
    res.json({ success: true, data: project, message: 'Project loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const project = await ProjectService.create(req, req.validatedBody);
    res.status(201).json({ success: true, data: project, message: 'Project created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const project = await ProjectService.update(req, req.params.id, req.validatedBody);
    res.json({ success: true, data: project, message: 'Project updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const project = await ProjectService.dropProject(req, req.params.id, req.body || {});
    res.json({ success: true, data: project, message: 'Project dropped successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function drop(req, res) {
  try {
    const project = await ProjectService.dropProject(req, req.params.id, req.body || {});
    res.json({ success: true, data: project, message: 'Project dropped successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function reactivate(req, res) {
  try {
    const project = await ProjectService.reactivateProject(req, req.params.id);
    res.json({ success: true, data: project, message: 'Project reactivated successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listMembers(req, res) {
  try {
    const members = await ProjectService.listMembers(req, req.params.id);
    res.json({ success: true, data: members, message: 'Project members loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addMember(req, res) {
  try {
    const member = await ProjectService.addMember(req, req.params.id, req.validatedBody || req.body);
    res.status(201).json({ success: true, data: member, message: 'Member added' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateMember(req, res) {
  try {
    const member = await ProjectService.updateMember(req, req.params.id, req.params.userId, req.validatedBody || req.body);
    res.json({ success: true, data: member, message: 'Member updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function removeMember(req, res) {
  try {
    const result = await ProjectService.removeMember(req, req.params.id, req.params.userId);
    res.json({ success: true, data: result, message: 'Member removed' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listTasks(req, res) {
  try {
    const TaskService = require('../services/task.service');
    const result = await TaskService.listByProject(req, req.params.id);
    res.json({ success: true, data: result.items, pagination: result.pagination, message: 'Project tasks loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function getOverview(req, res) {
  try {
    const overview = await ProjectService.getOverview(req, req.params.id);
    res.json({ success: true, data: overview, message: 'Project overview loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function getActivity(req, res) {
  try {
    const result = await ProjectService.getActivity(req, req.params.id);
    res.json({ success: true, data: result.items, pagination: result.pagination, message: 'Project activity loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listCategories(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const categories = await SettingService.getProjectCategories(req);
    res.json({ success: true, data: categories, message: 'Project categories loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addCategory(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const categoryName = req.body?.name || req.body?.category;
    const categories = await SettingService.addProjectCategory(req, categoryName);
    res.status(201).json({ success: true, data: categories, message: 'Project category created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listStatuses(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const statuses = await SettingService.getProjectStatuses(req);
    res.json({ success: true, data: statuses, message: 'Project statuses loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addStatus(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const statusName = req.body?.name || req.body?.status;
    const statuses = await SettingService.addProjectStatus(req, statusName);
    res.status(201).json({ success: true, data: statuses, message: 'Project status created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listPriorities(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const priorities = await SettingService.getProjectPriorities(req);
    res.json({ success: true, data: priorities, message: 'Project priorities loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addPriority(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const priorityName = req.body?.name || req.body?.priority;
    const priorities = await SettingService.addProjectPriority(req, priorityName);
    res.status(201).json({ success: true, data: priorities, message: 'Project priority created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listTags(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const tags = await SettingService.getProjectTags(req);
    res.json({ success: true, data: tags, message: 'Project tags loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addTag(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const tagName = req.body?.name || req.body?.tag || req.body?.label;
    const tags = await SettingService.addProjectTag(req, tagName);
    res.status(201).json({ success: true, data: tags, message: 'Project tag created' });
  } catch (error) {
    sendError(res, error);
  }
}

const listLabels = listTags;
const addLabel = addTag;

async function listCustomFields(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const fields = await SettingService.getProjectCustomFields(req);
    res.json({ success: true, data: fields, message: 'Project custom fields loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addCustomField(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const fields = await SettingService.addProjectCustomField(req, req.body);
    res.status(201).json({ success: true, data: fields, message: 'Project custom field created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function archive(req, res) {
  try {
    const project = await ProjectService.archiveProject(req, req.params.id);
    res.json({ success: true, data: project, message: 'Project archived' });
  } catch (error) {
    sendError(res, error);
  }
}

async function restore(req, res) {
  try {
    const project = await ProjectService.restoreProject(req, req.params.id);
    res.json({ success: true, data: project, message: 'Project restored' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listDocuments(req, res) {
  try {
    const ProjectAttachmentService = require('../services/project-attachment.service');
    const documents = await ProjectAttachmentService.listDocuments(req, req.params.id, req.query || {});
    res.json({ success: true, data: documents, message: 'Project documents loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function uploadDocument(req, res) {
  try {
    const ProjectAttachmentService = require('../services/project-attachment.service');
    const doc = await ProjectAttachmentService.uploadDocument(req, req.params.id, req.body || {});
    res.status(201).json({ success: true, data: doc, message: 'Document uploaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function createDocument(req, res) {
  try {
    const ProjectAttachmentService = require('../services/project-attachment.service');
    const doc = await ProjectAttachmentService.createDocument(req, req.params.id, req.body || {});
    res.status(201).json({ success: true, data: doc, message: 'Document created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function deleteDocument(req, res) {
  try {
    const ProjectAttachmentService = require('../services/project-attachment.service');
    const result = await ProjectAttachmentService.deleteDocument(req, req.params.id, req.params.documentId);
    res.json({ success: true, data: result, message: 'Document deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportProjects(req, res) {
  try {
    const result = await ProjectService.exportProjects(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(result.content);
    } else {
      res.status(200).send(result.content);
    }
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  exportProjects,
  get,
  getOverview,
  getActivity,
  create,
  update,
  remove,
  drop,
  reactivate,
  archive,
  restore,
  listDocuments,
  uploadDocument,
  createDocument,
  deleteDocument,
  listMembers,
  addMember,
  updateMember,
  removeMember,
  listTasks,
  listCategories,
  addCategory,
  listLabels,
  addLabel,
  listStatuses,
  addStatus,
  listPriorities,
  addPriority,
  listTags,
  addTag,
  listCustomFields,
  addCustomField
};
