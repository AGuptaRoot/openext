'use strict';

/**
 * Client-detail extension endpoint.
 *
 * `extension-data` is the read-through of the source lead's extension bag
 * for extension-contributed client sections.
 */

const ClientExtensionService = require('../services/client-extension.service');

function sendError(res, error) {
  const status = error.status || 500;
  const body = {
    success: false,
    error: error.message || 'Request failed'
  };
  if (error.code) body.code = error.code;
  res.status(status).json(body);
}

/** GET /clients/:id/extension-data */
async function getExtensionData(req, res) {
  try {
    const data = await ClientExtensionService.getExtensionData(req, req.params.id);
    res.json({ success: true, data, message: 'Client extension data loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  getExtensionData
};
