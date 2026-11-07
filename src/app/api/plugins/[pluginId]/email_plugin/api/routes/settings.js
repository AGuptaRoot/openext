const SettingsService = require('../services/SettingsService');
const EmailService = require('../services/EmailService');
const { canAccess } = require('../utils/permissions');
module.exports = (app) => {
    app.get('/settings', async (req, res) => {
        if (!canAccess(req, 'email.read')) {
            return res.status(403).json({ message: 'Missing permission: email.read' });
        }
        const settings = await SettingsService.getPublicConfig(req.cms);
        res.json({ settings });
    });
    app.put('/settings', async (req, res) => {
        if (!canAccess(req, 'email.configure')) {
            return res.status(403).json({ message: 'Missing permission: email.configure' });
        }
        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        try {
            const settings = await SettingsService.updateConfig(req.cms, payload);
            const connection = await EmailService.testConnection(req.cms);
            res.json({
                settings,
                connection,
                message: connection.ok
                    ? 'SMTP settings saved and connection verified'
                    : 'Settings saved, but SMTP connection test failed',
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to save settings';
            res.status(400).json({ message });
        }
    });
    app.post('/settings/test', async (req, res) => {
        if (!canAccess(req, 'email.configure')) {
            return res.status(403).json({ message: 'Missing permission: email.configure' });
        }
        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        let config = null;
        if (payload.useSaved !== false) {
            config = await SettingsService.getFullConfig(req.cms);
        }
        if (payload.host ||
            payload.port ||
            payload.user ||
            payload.password ||
            payload.fromEmail ||
            payload.recipientEmail ||
            typeof payload.secure === 'boolean') {
            config = {
                ...(config || {}),
                host: typeof payload.host === 'string' ? payload.host.trim() : config?.host || '',
                port: typeof payload.port === 'number'
                    ? payload.port
                    : typeof payload.port === 'string' && payload.port.trim()
                        ? parseInt(payload.port.trim(), 10)
                        : config?.port || 587,
                secure: typeof payload.secure === 'boolean' ? payload.secure : Boolean(config?.secure),
                user: typeof payload.user === 'string' && payload.user.trim()
                    ? payload.user.trim()
                    : config?.user || '',
                password: typeof payload.password === 'string' && payload.password.trim()
                    ? payload.password.trim()
                    : config?.password || '',
                fromName: typeof payload.fromName === 'string' ? payload.fromName.trim() : config?.fromName || '',
                fromEmail: typeof payload.fromEmail === 'string'
                    ? payload.fromEmail.trim()
                    : config?.fromEmail || '',
                recipientEmail: typeof payload.recipientEmail === 'string'
                    ? payload.recipientEmail.trim()
                    : config?.recipientEmail || '',
                replyTo: typeof payload.replyTo === 'string' ? payload.replyTo.trim() : config?.replyTo || '',
            };
        }
        const connection = await EmailService.testConnection(req.cms, config || undefined);
        res.json({ connection });
    });
};
