'use strict';

const DashboardService = require('../services/dashboard.service');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] dashboard error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Dashboard operation failed',
    details: error.details || []
  });
}

async function health(_req, res) {
  try {
    res.json({
      success: true,
      data: DashboardService.getHealth(),
      message: 'Root CRM is running'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function summary(req, res) {
  try {
    const data = await DashboardService.getSummary(req);
    res.json({
      success: true,
      data,
      message: 'Dashboard loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function getWidgets(req, res) {
  try {
    const data = await DashboardService.getWidgetConfig(req);
    res.json({
      success: true,
      data,
      message: 'Dashboard widget configuration loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function saveWidgets(req, res) {
  try {
    const data = await DashboardService.saveWidgetConfig(req, req.body);
    res.json({
      success: true,
      data,
      message: 'Dashboard widget configuration saved'
    });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  health,
  summary,
  getWidgets,
  saveWidgets
};
