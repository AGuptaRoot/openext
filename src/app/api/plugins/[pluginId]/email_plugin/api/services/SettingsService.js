function getEmailConfigModel(cms) {
    const existing = cms.models.get('EmailConfig');
    if (existing)
        return existing;
    const { schema } = require('../models/EmailConfig');
    return cms.models.register('EmailConfig', schema);
}
function sanitizeForClient(doc) {
    const host = doc.host || '';
    const port = typeof doc.port === 'number' ? doc.port : 587;
    const user = doc.user || '';
    const password = doc.password || '';
    const fromEmail = doc.fromEmail || '';
    const recipientEmail = doc.recipientEmail || '';
    return {
        host,
        port,
        secure: Boolean(doc.secure),
        fromName: doc.fromName || '',
        fromEmail,
        recipientEmail,
        replyTo: doc.replyTo || '',
        hasCredentials: Boolean(user && password),
        isConfigured: Boolean(host && port && user && password && fromEmail),
        userPreview: user ? `${user.slice(0, 2)}…${user.slice(-(Math.min(user.length, 8)))}` : '',
    };
}
async function getOrCreateDoc(cms) {
    const EmailConfig = getEmailConfigModel(cms);
    let doc = await EmailConfig.findOne({});
    if (!doc) {
        doc = await EmailConfig.create({});
    }
    return doc;
}
module.exports = {
    async getPublicConfig(cms) {
        const doc = await getOrCreateDoc(cms);
        return sanitizeForClient(doc.toObject());
    },
    async getFullConfig(cms) {
        const doc = await getOrCreateDoc(cms);
        const plain = doc.toObject();
        return {
            ...sanitizeForClient(plain),
            user: plain.user || '',
            password: plain.password || '',
        };
    },
    async updateConfig(cms, payload) {
        const doc = await getOrCreateDoc(cms);
        const current = doc.toObject();
        const updates = {};
        if (typeof payload.host === 'string')
            updates.host = payload.host.trim();
        if (typeof payload.port === 'number' && Number.isFinite(payload.port)) {
            updates.port = payload.port;
        }
        else if (typeof payload.port === 'string' && payload.port.trim()) {
            const parsed = parseInt(payload.port.trim(), 10);
            if (Number.isFinite(parsed))
                updates.port = parsed;
        }
        if (typeof payload.secure === 'boolean')
            updates.secure = payload.secure;
        if (typeof payload.fromName === 'string')
            updates.fromName = payload.fromName.trim();
        if (typeof payload.fromEmail === 'string')
            updates.fromEmail = payload.fromEmail.trim();
        if (typeof payload.recipientEmail === 'string')
            updates.recipientEmail = payload.recipientEmail.trim();
        if (typeof payload.replyTo === 'string')
            updates.replyTo = payload.replyTo.trim();
        if (typeof payload.user === 'string' && payload.user.trim()) {
            updates.user = payload.user.trim();
        }
        if (typeof payload.password === 'string' && payload.password.trim()) {
            updates.password = payload.password.trim();
        }
        const nextHost = updates.host ?? current.host ?? '';
        const nextPort = updates.port ?? current.port ?? 587;
        const nextUser = updates.user ?? current.user ?? '';
        const nextPassword = updates.password ?? current.password ?? '';
        const nextFromEmail = updates.fromEmail ?? current.fromEmail ?? '';
        if (!nextHost) {
            throw new Error('SMTP host is required.');
        }
        if (!nextPort || nextPort < 1 || nextPort > 65535) {
            throw new Error('SMTP port must be between 1 and 65535.');
        }
        if (!nextUser || !nextPassword) {
            throw new Error('SMTP username and password are required.');
        }
        if (!nextFromEmail) {
            throw new Error('From email address is required.');
        }
        Object.assign(doc, updates);
        await doc.save();
        return sanitizeForClient(doc.toObject());
    },
};
