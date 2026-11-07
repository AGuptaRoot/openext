const SettingsService = require('../services/SettingsService');
const RazorpayService = require('../services/RazorpayService');
const { canAccess } = require('../utils/permissions');

function canCreateOrder(req) {
  return canAccess(req, 'payments.create_order') || canAccess(req, 'payments.integrate');
}

function canVerify(req) {
  return canAccess(req, 'payments.verify') || canAccess(req, 'payments.integrate');
}

module.exports = (app) => {
  app.get('/public-config', async (req, res) => {
    try {
      const data = await SettingsService.getPublicConfig(req.cms);
      return res.json({ success: true, data });
    } catch (error) {
      req.cms.logger.error(
        '[razorpay] GET /public-config failed:',
        SettingsService.sanitizeErrorMessage(error)
      );
      return res.status(500).json({
        success: false,
        message: SettingsService.sanitizeErrorMessage(error),
      });
    }
  });

  app.get('/status', async (req, res) => {
    if (!canAccess(req, 'payments.read') && !canAccess(req, 'payments.integrate')) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    try {
      const data = await SettingsService.getPublicConfig(req.cms);
      return res.json({ success: true, data });
    } catch (error) {
      req.cms.logger.error(
        '[razorpay] GET /status failed:',
        SettingsService.sanitizeErrorMessage(error)
      );
      return res.status(500).json({
        success: false,
        message: SettingsService.sanitizeErrorMessage(error),
      });
    }
  });

  app.post('/orders', async (req, res) => {
    if (!canCreateOrder(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = await RazorpayService.createOrder(req.cms, body);
      return res.json({ success: true, data: result });
    } catch (error) {
      req.cms.logger.error(
        '[razorpay] POST /orders failed:',
        SettingsService.sanitizeErrorMessage(error)
      );
      return res.status(400).json({
        success: false,
        message: SettingsService.sanitizeErrorMessage(error),
      });
    }
  });

  app.post('/verify', async (req, res) => {
    if (!canVerify(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = await RazorpayService.verifyPayment(req.cms, body);
      return res.json({ success: true, data: result });
    } catch (error) {
      req.cms.logger.error(
        '[razorpay] POST /verify failed:',
        SettingsService.sanitizeErrorMessage(error)
      );
      return res.status(400).json({
        success: false,
        message: SettingsService.sanitizeErrorMessage(error),
      });
    }
  });

  /** Documented entry point for other plugins */
  app.post('/integration/orders', async (req, res) => {
    if (!canCreateOrder(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const sourcePlugin = String(
        body.sourcePlugin || req.headers['x-cms-plugin-id'] || ''
      ).trim();
      const notes = { ...(body.notes || {}) };
      if (sourcePlugin) notes.sourcePlugin = sourcePlugin;

      const result = await RazorpayService.createOrder(req.cms, {
        amount: body.amount,
        currency: body.currency,
        receipt: body.receipt,
        notes,
        partialPayment: body.partialPayment,
      });
      return res.json({ success: true, data: result });
    } catch (error) {
      req.cms.logger.error(
        '[razorpay] POST /integration/orders failed:',
        SettingsService.sanitizeErrorMessage(error)
      );
      return res.status(400).json({
        success: false,
        message: SettingsService.sanitizeErrorMessage(error),
      });
    }
  });

  app.post('/integration/verify', async (req, res) => {
    if (!canVerify(req)) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const result = await RazorpayService.verifyPayment(req.cms, body);
      return res.json({ success: true, data: result });
    } catch (error) {
      req.cms.logger.error(
        '[razorpay] POST /integration/verify failed:',
        SettingsService.sanitizeErrorMessage(error)
      );
      return res.status(400).json({
        success: false,
        message: SettingsService.sanitizeErrorMessage(error),
      });
    }
  });
};
