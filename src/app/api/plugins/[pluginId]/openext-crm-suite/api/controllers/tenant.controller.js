'use strict';

const TenantService = require('../services/tenant.service');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] tenant error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Tenant operation failed',
    details: error.details || []
  });
}

async function context(req, res) {
  try {
    res.json({ success: true, data: TenantService.getContext(req), message: 'Tenant context loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function roles(req, res) {
  try {
    const rolesList = await TenantService.listRoles(req);
    res.json({ success: true, data: rolesList, roles: rolesList, message: 'Tenant roles loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function members(req, res) {
  try {
    res.json({ success: true, data: await TenantService.listMembers(req), message: 'Tenant members loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function candidates(req, res) {
  try {
    const search = req.query?.search ? String(req.query.search) : '';
    res.json({ success: true, data: await TenantService.listCandidates(req, search), message: 'User candidates loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addMember(req, res) {
  try {
    const member = await TenantService.addMember(req, req.validatedBody);
    res.status(201).json({ success: true, data: member, message: 'Tenant member added' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateMember(req, res) {
  try {
    const member = await TenantService.updateMember(req, req.params.userId, req.validatedBody);
    res.json({ success: true, data: member, message: 'Tenant membership updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function rolePermissions(req, res) {
  try {
    const matrix = await TenantService.getRolePermissionsMatrix(req);
    res.json({ success: true, data: matrix, message: 'Tenant role permissions loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateRolePermissions(req, res) {
  try {
    const matrix = await TenantService.updateRolePermissions(req, req.body);
    res.json({ success: true, data: matrix, message: 'Tenant role permissions matrix updated successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to create a custom tenant role.
 * 
 * Usecase: Handles request to create a user-defined custom role with initial permissions.
 */
async function createCustomRole(req, res) {
  try {
    const matrix = await TenantService.createCustomRole(req, req.body);
    res.status(201).json({ success: true, data: matrix, message: 'Custom role created successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to delete a custom tenant role.
 * 
 * Usecase: Handles request to delete a custom role from the tenant workspace.
 */
async function deleteCustomRole(req, res) {
  try {
    const matrix = await TenantService.deleteCustomRole(req, req.params.roleKey);
    res.json({ success: true, data: matrix, message: 'Custom role deleted successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportMembers(req, res) {
  try {
    const result = await TenantService.exportMembers(req, req.query || {});
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
  context,
  roles,
  members,
  exportMembers,
  candidates,
  addMember,
  updateMember,
  rolePermissions,
  updateRolePermissions,
  createCustomRole,
  deleteCustomRole
};

