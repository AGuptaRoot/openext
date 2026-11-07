'use strict';

const TaskTemplateService = require('../services/task-template.service');

function sendError(res, error) {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] task template error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Task template operation failed'
  });
}

async function list(req, res) {
  try {
    const templates = await TaskTemplateService.listTemplates(req);
    res.json({ success: true, data: templates, message: 'Task templates loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const template = await TaskTemplateService.getTemplateById(req, req.params.id);
    res.json({ success: true, data: template, message: 'Task template loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const template = await TaskTemplateService.createTemplate(req, req.validatedBody || req.body || {});
    res.status(201).json({ success: true, data: template, message: 'Task template created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const template = await TaskTemplateService.updateTemplate(req, req.params.id, req.validatedBody || req.body || {});
    res.json({ success: true, data: template, message: 'Task template updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const result = await TaskTemplateService.deleteTemplate(req, req.params.id);
    res.json({ success: true, data: result, message: 'Task template deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function instantiate(req, res) {
  try {
    const result = await TaskTemplateService.instantiateTemplate(req, req.params.id, req.validatedBody || req.body || {});
    res.status(201).json({ success: true, data: result, message: 'Task created from template successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function saveAsTemplate(req, res) {
  try {
    const template = await TaskTemplateService.saveTaskAsTemplate(req, req.params.id, req.body || {});
    res.status(201).json({ success: true, data: template, message: 'Task saved as template successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  get,
  create,
  update,
  remove,
  instantiate,
  saveAsTemplate
};
