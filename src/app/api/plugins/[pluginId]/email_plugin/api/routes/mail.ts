const EmailService = require('../services/EmailService');
const SettingsService = require('../services/SettingsService');
const { canAccess } = require('../utils/permissions');

module.exports = (app) => {
  app.post('/mail/send', async (req, res) => {
    if (!canAccess(req, 'email.send')) {
      return res.status(403).json({ message: 'Missing permission: email.send' });
    }

    const settings = await SettingsService.getPublicConfig(req.cms);
    if (!settings.isConfigured) {
      return res.status(400).json({
        message: 'SMTP is not configured. Open SMTP Settings and save your mail server credentials first.',
      });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const sentBy = req.user && typeof req.user.email === 'string' ? req.user.email : '';

    try {
      const result = await EmailService.sendMail(req.cms, payload, sentBy);
      res.status(201).json({
        success: true,
        message: 'Email sent successfully',
        messageId: result.messageId,
        logId: result.logId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send email';
      res.status(400).json({ message });
    }
  });

  app.get('/mail/logs', async (req, res) => {
    if (!canAccess(req, 'email.read')) {
      return res.status(403).json({ message: 'Missing permission: email.read' });
    }

    const logs = await EmailService.listLogs(req.cms, req.query.limit);
    res.json({ logs });
  });

  app.delete('/mail/logs/:id', async (req, res) => {
    if (!canAccess(req, 'email.configure')) {
      return res.status(403).json({ message: 'Missing permission: email.configure' });
    }

    const deleted = await EmailService.deleteLog(req.cms, req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: 'Log entry not found' });
    }

    res.json({ message: 'Log entry deleted' });
  });
};
