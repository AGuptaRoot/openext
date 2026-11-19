'use strict';

const GstSettingsService = require('../services/gst-settings.service');
const { checkGstin } = require('../lib/gstin');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] gst settings error:', error?.message || error);
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'GST settings operation failed' : error.message,
    details: error.details || []
  });
}

/** GST settings are the agency's own: never for client-portal logins (they hold crm.finance.read). */
function assertStaff(req) {
  if (require('../utils/tenant.util').isClientUser(req)) {
    const error = new Error('GST settings are not available in the client portal');
    error.status = 403;
    throw error;
  }
}

async function get(req, res) {
  try {
    assertStaff(req);
    const [settings, extension] = await Promise.all([
      GstSettingsService.get(req),
      GstSettingsService.extensionInfo(req)
    ]);
    res.json({ success: true, data: { settings, extension } });
  } catch (error) {
    sendError(res, error);
  }
}

async function save(req, res) {
  try {
    const result = await GstSettingsService.save(req, req.body && typeof req.body === 'object' ? req.body : {});
    res.json({ success: true, data: result, message: 'GST settings saved' });
  } catch (error) {
    sendError(res, error);
  }
}

async function validateGstin(req, res) {
  try {
    assertStaff(req);
    const value = req.body && typeof req.body === 'object' ? req.body.gstin : '';
    res.json({ success: true, data: await checkGstin(value) });
  } catch (error) {
    sendError(res, error);
  }
}

async function seedServices(req, res) {
  try {
    const result = await GstSettingsService.seedServices(req);
    res.json({ success: true, data: result, message: result.message });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = { get, save, validateGstin, seedServices };
