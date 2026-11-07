'use strict';

const TimeLogService = require('../services/time-log.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid time log ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] time-log error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Time log operation failed',
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const result = await TimeLogService.list(req);
    res.json({ success: true, data: result.items, pagination: result.pagination, message: 'Time logs loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const log = await TimeLogService.getById(req, req.params.id);
    res.json({ success: true, data: log, message: 'Time log loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const log = await TimeLogService.create(req, req.validatedBody);
    res.status(201).json({ success: true, data: log, message: 'Time logged' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const log = await TimeLogService.update(req, req.params.id, req.validatedBody);
    res.json({ success: true, data: log, message: 'Time log updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const result = await TimeLogService.remove(req, req.params.id);
    res.json({ success: true, data: result, message: 'Time log deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listByTask(req, res) {
  try {
    const result = await TimeLogService.listByTask(req, req.params.id);
    res.json({ success: true, data: result.items, pagination: result.pagination, message: 'Task time logs loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function taskSummary(req, res) {
  try {
    const summary = await TimeLogService.sumHoursForTask(req, req.params.id);
    res.json({ success: true, data: summary, message: 'Task time summary loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to fetch active check-in session for the logged-in user.
 * 
 * Usecase: Returns current active timer session for live display in UI.
 */
async function getActiveCheckIn(req, res) {
  try {
    const active = await TimeLogService.getActiveCheckIn(req);
    res.json({ success: true, data: active, message: active ? 'Active session loaded' : 'No active session' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to start a check-in session.
 * 
 * Usecase: Initiates a new running time tracking timer for a task.
 */
async function checkIn(req, res) {
  try {
    const log = await TimeLogService.checkIn(req, req.validatedBody || req.body);
    res.status(201).json({ success: true, data: log, message: 'Checked in successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to stop an active check-in session (check-out).
 * 
 * Usecase: Stops running timer, computes total hours elapsed, and marks time log completed.
 */
async function checkOut(req, res) {
  try {
    const log = await TimeLogService.checkOut(req, req.validatedBody || req.body);
    res.json({ success: true, data: log, message: 'Checked out successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function submit(req, res) {
  try {
    const log = await TimeLogService.submitForApproval(req, req.params.id);
    res.json({ success: true, data: log, message: 'Time log submitted for approval' });
  } catch (error) {
    sendError(res, error);
  }
}

async function approve(req, res) {
  try {
    const log = await TimeLogService.approve(req, req.params.id);
    res.json({ success: true, data: log, message: 'Time log approved' });
  } catch (error) {
    sendError(res, error);
  }
}

async function reject(req, res) {
  try {
    const body = req.validatedBody || req.body || {};
    const log = await TimeLogService.reject(req, req.params.id, body.reason || body.rejectionReason);
    res.json({ success: true, data: log, message: 'Time log rejected' });
  } catch (error) {
    sendError(res, error);
  }
}

async function bulkApprove(req, res) {
  try {
    const body = req.validatedBody || req.body || {};
    const result = await TimeLogService.bulkApprove(req, body.ids);
    res.json({ success: true, data: result, message: `${result.count} time logs approved` });
  } catch (error) {
    sendError(res, error);
  }
}

async function lockLogs(req, res) {
  try {
    const body = req.validatedBody || req.body || {};
    const result = await TimeLogService.lockTimeLogs(req, body);
    res.json({ success: true, data: result, message: `${result.count} time logs locked` });
  } catch (error) {
    sendError(res, error);
  }
}

async function unlockLogs(req, res) {
  try {
    const body = req.validatedBody || req.body || {};
    const result = await TimeLogService.unlockTimeLogs(req, body);
    res.json({ success: true, data: result, message: `${result.count} time logs unlocked` });
  } catch (error) {
    sendError(res, error);
  }
}

async function getWeeklyTimesheet(req, res) {
  try {
    const timesheet = await TimeLogService.getWeeklyTimesheet(req, req.query);
    res.json({ success: true, data: timesheet, message: 'Weekly timesheet loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportTimeLogs(req, res) {
  try {
    const result = await TimeLogService.exportTimeLogs(req, req.query || {});
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
  exportTimeLogs,
  get,
  create,
  update,
  remove,
  submit,
  approve,
  reject,
  bulkApprove,
  lockLogs,
  unlockLogs,
  getWeeklyTimesheet,
  listByTask,
  taskSummary,
  getActiveCheckIn,
  checkIn,
  checkOut
};
