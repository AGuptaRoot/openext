'use strict';

const WorkReportService = require('../services/work-report.service');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] work-report error:', error?.message || error);
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'The work report could not be loaded' : error.message,
    code: error.code || undefined,
    details: error.details || []
  });
}

async function listEmployees(req, res) {
  try {
    const data = await WorkReportService.listEmployees(req, req.query || {});
    res.json({ success: true, data, message: 'Work report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function getEmployeeReport(req, res) {
  try {
    const data = await WorkReportService.getEmployeeReport(req, req.params.userId, req.query || {});
    res.json({ success: true, data, message: 'Employee report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportEmployeeReport(req, res) {
  try {
    const file = await WorkReportService.exportEmployeeReport(req, req.params.userId, req.query || {});
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.buffer);
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = { listEmployees, getEmployeeReport, exportEmployeeReport };
