'use strict';

const ActivityLocationLogService = require('../services/activity-location-log.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] activity error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Activity operation failed',
    details: error.details || []
  });
}

async function getActivityById(req, res) {
  try {
    const activity = await ActivityLocationLogService.getActivityById(req, req.params.id);
    res.json({
      success: true,
      data: activity,
      locationReport: activity?.locationReport || null,
      message: 'Activity loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function createLocationLog(req, res) {
  try {
    const log = await ActivityLocationLogService.createLocationLog(
      req,
      req.params.id,
      req.validatedBody || req.body || {}
    );
    res.status(201).json({
      success: true,
      data: log,
      locationReport: log,
      message: 'Location logged successfully'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function listLocationLogs(req, res) {
  try {
    const logs = await ActivityLocationLogService.listLocationLogs(req, req.params.id);
    res.json({ success: true, data: logs, message: 'Location logs loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateGoalLocation(req, res) {
  try {
    const activity = await ActivityLocationLogService.updateGoalLocation(
      req,
      req.params.id,
      req.validatedBody || req.body || {}
    );
    res.json({ success: true, data: activity, message: 'Goal location updated successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateActivity(req, res) {
  try {
    const activity = await ActivityLocationLogService.updateActivity(
      req,
      req.params.id,
      req.validatedBody || req.body || {}
    );
    res.json({ success: true, data: activity, message: 'Activity updated successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  getActivityById,
  createLocationLog,
  listLocationLogs,
  updateGoalLocation,
  updateActivity
};
