'use strict';

/**
 * Record actions of the active extension (services/extension-action.service.js).
 *
 * POST /extension-actions/:actionId { recordId }   run a "route" action → { message, navigate }
 */

const ExtensionActionService = require('../services/extension-action.service');

module.exports = function registerExtensionActionRoutes(app) {
  app.post('/extension-actions/:actionId', async (req, res) => {
    try {
      res.json({ success: true, data: await ExtensionActionService.run(req, req.params.actionId, req.body || {}) });
    } catch (error) {
      const status = Number(error && error.status) || 500;
      if (status >= 500) console.error('[plugin:openext-crm-suite] extension action:', error);
      res.status(status).json({
        success: false,
        error: status >= 500 && status !== 503 ? 'The action failed' : String((error && error.message) || 'The action failed'),
        code: (error && error.code) || undefined
      });
    }
  });
};
