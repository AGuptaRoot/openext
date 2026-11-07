'use strict';

const PersonContactService = require('../services/person-contact.service');

function sendError(res, error) {
  const status = error.status || 500;
  const payload = {
    success: false,
    error: error.message || 'Request failed'
  };
  if (error.code) payload.code = error.code;
  if (error.duplicates) payload.duplicates = error.duplicates;
  res.status(status).json(payload);
}

async function list(req, res) {
  try {
    const result = await PersonContactService.list(req);
    res.json({ success: true, data: result.data, meta: result.meta, message: 'Contacts loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function getById(req, res) {
  try {
    const data = await PersonContactService.getById(req, req.params.id);
    res.json({ success: true, data, message: 'Contact loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const data = await PersonContactService.create(req, req.body || {});
    res.status(201).json({ success: true, data, message: 'Contact created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const data = await PersonContactService.update(req, req.params.id, req.body || {});
    res.json({ success: true, data, message: 'Contact updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const data = await PersonContactService.remove(req, req.params.id);
    res.json({ success: true, data, message: 'Contact deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function checkDuplicates(req, res) {
  try {
    const duplicates = await PersonContactService.findDuplicates(req, {
      email: req.query.email || req.body?.email,
      phone: req.query.phone || req.body?.phone,
      pan: req.query.pan || req.body?.pan,
      excludeId: req.query.excludeId || req.body?.excludeId
    });
    res.json({
      success: true,
      data: { duplicates, isDuplicate: duplicates.length > 0 },
      message: duplicates.length ? 'Duplicate contacts found' : 'No duplicates'
    });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  getById,
  create,
  update,
  remove,
  checkDuplicates
};
