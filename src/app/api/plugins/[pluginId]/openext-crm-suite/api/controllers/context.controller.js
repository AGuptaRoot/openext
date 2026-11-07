'use strict';

const ContextService = require('../services/context.service');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) {
    console.error('[plugin:openext-crm-suite] context error:', error);
  }
  res.status(status).json({
    success: false,
    error: error.message || 'Context operation failed',
    details: error.details || []
  });
}

async function me(req, res) {
  try {
    res.json({
      success: true,
      data: await ContextService.getMe(req),
      message: 'User context loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function permissions(req, res) {
  try {
    res.json({
      success: true,
      data: ContextService.getPermissionsPayload(req),
      message: 'Permissions loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function assignableUsers(req, res) {
  try {
    const search = req.query?.search ? String(req.query.search) : '';
    const users = await ContextService.getAssignableUsers(req, search);
    res.json({
      success: true,
      data: users,
      message: 'Assignable users loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  me,
  permissions,
  assignableUsers
};
