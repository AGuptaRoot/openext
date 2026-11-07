'use strict';

/**
 * Controller for CRM workspace extension data:
 *   - Declared field values on core records (lead, client, opportunity, ticket)
 *   - Extension settings form data
 *
 * OWNER: Step 2 (see documentation/crm-upload-plan/AGY-STEP-2-declarations.md).
 * Shared Contract: documentation/crm-upload-plan/00-CONTRACTS.md §3 & §5.
 */

const CrmExtensionValuesService = require('../services/crm-extension-values.service');
const CrmExtensionSettingsService = require('../services/crm-extension-settings.service');
const CrmExtensionService = require('../services/crm-extension.service');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) {
    console.error('[plugin:openext-crm-suite] crm-extension-data error:', error);
  }
  res.status(status).json({
    success: false,
    error: error.message || 'CRM extension data operation failed',
    code: error.code || undefined,
    details: Array.isArray(error.details) ? error.details : undefined
  });
}

/**
 * GET /crm-extension-data/values/:record/:recordId
 * Returns { success: true, data: { extensionId, values } }
 */
async function getValues(req, res) {
  try {
    const data = await CrmExtensionValuesService.getValues(req, req.params.record, req.params.recordId);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * PUT /crm-extension-data/values/:record/:recordId
 * Body: { values: object } or raw object
 * Returns { success: true, data: { extensionId, values } }
 */
async function setValues(req, res) {
  try {
    const values = req.body && typeof req.body === 'object' && 'values' in req.body
      ? req.body.values
      : req.body;
    const data = await CrmExtensionValuesService.setValues(req, req.params.record, req.params.recordId, values);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * GET /crm-extension-data/settings
 * Returns { success: true, data: { extensionId, tab, fields, values } }
 */
async function getSettings(req, res) {
  try {
    const def = await CrmExtensionService.getActive(req);
    const extensionId = def?.id || '';
    // The full definition keeps the tab under declarations.settings.tab (settingsTab is the /me shape).
    const tab = def?.declarations?.settings?.tab || def?.declarations?.settingsTab || null;
    const fields = def?.declarations?.settings?.fields || [];
    const values = await CrmExtensionSettingsService.getValues(req, def);
    res.json({
      success: true,
      data: {
        extensionId,
        tab,
        fields,
        values
      }
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * PUT /crm-extension-data/settings
 * Body: { values: object } or raw object
 * Returns { success: true, data: { extensionId, values } }
 */
async function setSettings(req, res) {
  try {
    const def = await CrmExtensionService.getActive(req);
    const patch = req.body && typeof req.body === 'object' && 'values' in req.body
      ? req.body.values
      : req.body;
    const values = await CrmExtensionSettingsService.setValues(req, def, patch);
    res.json({
      success: true,
      data: {
        extensionId: def?.id || '',
        values
      }
    });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  getValues,
  setValues,
  getSettings,
  setSettings
};
