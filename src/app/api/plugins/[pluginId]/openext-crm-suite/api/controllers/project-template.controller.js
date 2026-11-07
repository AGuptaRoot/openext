'use strict';

const ProjectTemplateService = require('../services/project-template.service');

function sendError(res, error) {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] project template error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Project template operation failed'
  });
}

async function list(req, res) {
  try {
    const templates = await ProjectTemplateService.listTemplates(req);
    res.json({ success: true, data: templates, message: 'Project templates loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const template = await ProjectTemplateService.getTemplateById(req, req.params.id);
    res.json({ success: true, data: template, message: 'Project template loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const template = await ProjectTemplateService.createTemplate(req, req.body || {});
    res.status(201).json({ success: true, data: template, message: 'Project template created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const template = await ProjectTemplateService.updateTemplate(req, req.params.id, req.body || {});
    res.json({ success: true, data: template, message: 'Project template updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const result = await ProjectTemplateService.deleteTemplate(req, req.params.id);
    res.json({ success: true, data: result, message: 'Project template deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function instantiate(req, res) {
  try {
    const result = await ProjectTemplateService.createProjectFromTemplate(req, req.params.id, req.body || {});
    res.status(201).json({ success: true, data: result, message: 'Project created from template successfully' });
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
  instantiate
};
