'use strict';

const MilestoneService = require('../services/milestone.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid milestone ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] milestone error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Milestone operation failed',
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const result = await MilestoneService.list(req);
    res.json({ success: true, data: result.items, pagination: result.pagination, message: 'Milestones loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listByProject(req, res) {
  try {
    const items = await MilestoneService.listByProject(req, req.params.projectId);
    res.json({ success: true, data: items, message: 'Project milestones loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const milestone = await MilestoneService.getById(req, req.params.id);
    res.json({ success: true, data: milestone, message: 'Milestone loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const input = {
      ...req.validatedBody,
      projectId: req.params.projectId || req.validatedBody.projectId
    };
    const milestone = await MilestoneService.create(req, input);
    res.status(201).json({ success: true, data: milestone, message: 'Milestone created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const milestone = await MilestoneService.update(req, req.params.id, req.validatedBody);
    res.json({ success: true, data: milestone, message: 'Milestone updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    await MilestoneService.remove(req, req.params.id);
    res.json({ success: true, data: { deleted: true, id: req.params.id }, message: 'Milestone deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  listByProject,
  get,
  create,
  update,
  remove
};
