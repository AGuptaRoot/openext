'use strict';

const InvoiceTemplateService = require('../services/invoice-template.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] invoice template error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Invoice template operation failed',
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const data = await InvoiceTemplateService.listTemplates(req);
    res.json({
      success: true,
      data,
      message: 'Invoice templates loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const doc = await InvoiceTemplateService.getTemplateById(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Invoice template loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const doc = await InvoiceTemplateService.createTemplate(req, req.validatedBody || req.body);
    res.status(201).json({ success: true, data: doc, message: 'Invoice template created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const doc = await InvoiceTemplateService.updateTemplate(req, req.params.id, req.validatedBody || req.body);
    res.json({ success: true, data: doc, message: 'Invoice template updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const result = await InvoiceTemplateService.deleteTemplate(req, req.params.id);
    res.json({ success: true, data: result, message: 'Invoice template deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function saveAsTemplate(req, res) {
  try {
    const doc = await InvoiceTemplateService.saveAsTemplate(req, req.params.id, req.body);
    res.status(201).json({ success: true, data: doc, message: 'Invoice saved as template' });
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
  saveAsTemplate
};
