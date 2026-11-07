'use strict';

const { requirePermission } = require('../middleware/permission.middleware');
const PrivateS3 = require('../utils/private-s3.util');

/**
 * Where private documents (passport / Aadhaar images, tickets, vouchers…) are stored — admin only.
 * Never returns keys: mode, source, bucket name, region and folder.
 * Mounted at /api/plugins/openext-crm-suite/private-storage
 */
module.exports = function registerPrivateStorageRoutes(app) {
  app.get('/private-storage/status', requirePermission('crm.settings.manage'), async (req, res) => {
    try {
      PrivateS3.clearCache();
      res.json({ success: true, data: await PrivateS3.status(req) });
    } catch {
      res.status(500).json({ success: false, error: 'Storage status could not be read' });
    }
  });
};
