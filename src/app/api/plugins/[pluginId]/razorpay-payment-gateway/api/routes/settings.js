const SettingsService = require('../services/SettingsService');
const { canAccess } = require('../utils/permissions');

function settingsActor(req) {
  const user = req.user || {};
  return {
    userId: user.id || user._id || user.userId || '',
  };
}

module.exports = (app) => {
  app.get('/settings', async (req, res) => {
    if (!canAccess(req, 'payments.read') && !canAccess(req, 'payments.configure')) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    try {
      const data = await SettingsService.getSettingsForAdmin(req.cms);
      return res.json({ success: true, data });
    } catch (error) {
      req.cms.logger.error(
        '[razorpay] GET /settings failed:',
        SettingsService.sanitizeErrorMessage(error)
      );
      return res.status(500).json({
        success: false,
        message: SettingsService.sanitizeErrorMessage(error),
      });
    }
  });

  app.put('/settings', async (req, res) => {
    if (!canAccess(req, 'payments.configure')) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    try {
      const payload = req.body && typeof req.body === 'object' ? req.body : {};
      const data = await SettingsService.updateSettings(req.cms, payload, settingsActor(req));
      return res.json({
        success: true,
        data,
        message: 'Razorpay settings saved.',
      });
    } catch (error) {
      req.cms.logger.error(
        '[razorpay] PUT /settings failed:',
        SettingsService.sanitizeErrorMessage(error)
      );
      return res.status(400).json({
        success: false,
        message: SettingsService.sanitizeErrorMessage(error),
      });
    }
  });

  app.post('/settings/test', async (req, res) => {
    if (!canAccess(req, 'payments.configure')) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    try {
      const result = await SettingsService.testConnection(req.cms);
      return res.json({ success: true, ...result });
    } catch (error) {
      req.cms.logger.error(
        '[razorpay] POST /settings/test failed:',
        SettingsService.sanitizeErrorMessage(error)
      );
      return res.status(400).json({
        success: false,
        message: SettingsService.sanitizeErrorMessage(error),
      });
    }
  });
};
