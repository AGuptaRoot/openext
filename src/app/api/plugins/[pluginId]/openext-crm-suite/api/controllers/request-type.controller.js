'use strict';

const RequestTypeService = require('../services/request-type.service');
const {
  validateRequestTypeCreate,
  validateRequestTypeUpdate
} = require('../validation/request-type.schema');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) {
    console.error('[plugin:openext-crm-suite] request-type error:', error);
  }
  res.status(status).json({
    success: false,
    error: error.message || 'Request type operation failed',
    code: error.code || undefined,
    leadCount: error.leadCount,
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const includeDisabled = String(req.query.includeDisabled || 'true') !== 'false';
    const enabledOnly = String(req.query.enabledOnly || '').toLowerCase() === 'true';
    const data = enabledOnly
      ? await RequestTypeService.listEnabled(req)
      : await RequestTypeService.list(req, { includeDisabled });
    res.json({ success: true, data, message: 'Request types loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function getById(req, res) {
  try {
    const data = await RequestTypeService.getById(req, req.params.id);
    res.json({ success: true, data, message: 'Request type loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const validated = validateRequestTypeCreate(req.body);
    if (!validated.ok) {
      res.status(400).json({ success: false, error: validated.errors[0], details: validated.errors });
      return;
    }
    const data = await RequestTypeService.create(req, validated.value);
    res.status(201).json({ success: true, data, message: 'Request type created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const validated = validateRequestTypeUpdate(req.body);
    if (!validated.ok) {
      res.status(400).json({ success: false, error: validated.errors[0], details: validated.errors });
      return;
    }
    const data = await RequestTypeService.update(req, req.params.id, validated.value);
    res.json({ success: true, data, message: 'Request type updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const data = await RequestTypeService.remove(req, req.params.id);
    res.json({ success: true, data, message: 'Request type deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addFieldOption(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const data = await RequestTypeService.addFieldOption(
      req,
      req.params.id,
      req.params.fieldKey,
      body
    );
    res.json({ success: true, data, message: 'Option added to request type catalog' });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = { list, getById, create, update, remove, addFieldOption };
