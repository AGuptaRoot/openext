'use strict';

const CrmExtensionService = require('../services/crm-extension.service');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) {
    console.error('[plugin:openext-crm-suite] crm-extension error:', error);
  }
  res.status(status).json({
    success: false,
    error: error.message || 'CRM extension operation failed',
    code: error.code || undefined,
    details: Array.isArray(error.details) ? error.details : undefined,
    warnings: Array.isArray(error.warnings) ? error.warnings : undefined
  });
}

/** GET /crm-extensions — registry with the active flag (admin). */
async function list(req, res) {
  try {
    const data = await CrmExtensionService.list(req);
    res.json({ success: true, data, message: 'CRM extensions loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

/** GET /crm-extensions/active — the active extension for any CRM user. */
async function getActive(req, res) {
  try {
    const data = await CrmExtensionService.getActiveFeaturePayload(req);
    res.json({ success: true, data, message: 'Active CRM extension loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

/** POST /crm-extensions/:id/enable — switch the workspace to this extension. */
async function enable(req, res) {
  try {
    const data = await CrmExtensionService.enable(req, req.params.id);
    res.json({ success: true, data, message: `${data.name} enabled` });
  } catch (error) {
    sendError(res, error);
  }
}

/** POST /crm-extensions/:id/disable — fall back to the default extension. */
async function disable(req, res) {
  try {
    const data = await CrmExtensionService.disable(req, req.params.id);
    res.json({ success: true, data, message: `${data.name} is now active` });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * POST /crm-extensions/validate — check a package without installing it.
 * Body: { fileName, contentBase64 }. Always 200 with { ok, errors, warnings, definition }.
 */
async function validatePackage(req, res) {
  try {
    const data = CrmExtensionService.toClientValidation(
      await CrmExtensionService.validatePackage(req, req.body || {})
    );
    res.json({
      success: true,
      data,
      message: data.ok ? 'Package is valid' : 'Package has validation errors'
    });
  } catch (error) {
    sendError(res, error);
  }
}

/** POST /crm-extensions/install — validate and store; installed as Disabled. */
async function installPackage(req, res) {
  try {
    const data = await CrmExtensionService.installPackage(req, req.body || {});
    res.status(201).json({
      success: true,
      data,
      message: data.replacedVersion
        ? `${data.name} updated to v${data.version}`
        : `${data.name} v${data.version} installed`
    });
  } catch (error) {
    sendError(res, error);
  }
}

/** DELETE /crm-extensions/:id — remove an uploaded, inactive extension. */
async function uninstall(req, res) {
  try {
    const data = await CrmExtensionService.uninstall(req, req.params.id);
    res.json({ success: true, data, message: `${data.name} uninstalled` });
  } catch (error) {
    sendError(res, error);
  }
}

/** POST /crm-extensions/:id/approve-backend — body { checksum } of the reviewed upload. */
async function approveBackend(req, res) {
  try {
    const data = await CrmExtensionService.approveBackend(req, req.params.id, req.body || {});
    res.json({ success: true, data, message: `Backend of ${data.name} approved` });
  } catch (error) {
    sendError(res, error);
  }
}

/** POST /crm-extensions/:id/revoke-backend */
async function revokeBackend(req, res) {
  try {
    const data = await CrmExtensionService.revokeBackend(req, req.params.id);
    res.json({ success: true, data, message: `Backend of ${data.name} stopped` });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  approveBackend,
  revokeBackend,
  list,
  getActive,
  enable,
  disable,
  validatePackage,
  installPackage,
  uninstall
};
