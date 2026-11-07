const SettingsService = require('./SettingsService');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getEmailLogModel(cms) {
  const existing = cms.models.get('EmailLog');
  if (existing) return existing;
  const { schema } = require('../models/EmailLog');
  return cms.models.register('EmailLog', schema);
}

function loadNodemailer() {
  try {
    return require('nodemailer');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'nodemailer is not installed';
    throw new Error(
      `${message}. Run "npm install nodemailer" in the CMS project or set PLUGIN_ALLOW_NATIVE_DEPS=true before upload.`
    );
  }
}

function normalizeConfig(config) {
  return {
    host: config.host || '',
    port: typeof config.port === 'number' ? config.port : parseInt(String(config.port || 587), 10),
    secure: Boolean(config.secure),
    user: config.user || '',
    password: config.password || '',
    fromName: config.fromName || '',
    fromEmail: config.fromEmail || '',
    recipientEmail: config.recipientEmail || '',
    replyTo: config.replyTo || '',
  };
}

function buildFromAddress(config) {
  const email = config.fromEmail.trim();
  const name = config.fromName.trim();
  if (name) {
    return `"${name.replace(/"/g, '\\"')}" <${email}>`;
  }
  return email;
}

function createTransport(config) {
  const nodemailer = loadNodemailer();
  const normalized = normalizeConfig(config);

  if (!normalized.host || !normalized.user || !normalized.password) {
    throw new Error('SMTP is not fully configured.');
  }

  return nodemailer.createTransport({
    host: normalized.host,
    port: normalized.port,
    secure: normalized.secure,
    auth: {
      user: normalized.user,
      pass: normalized.password,
    },
  });
}

function validateEmail(value, label) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  if (!EMAIL_PATTERN.test(trimmed)) {
    throw new Error(`${label} is not a valid email address.`);
  }
  return trimmed;
}

function previewBody(text, html) {
  const source = typeof text === 'string' && text.trim() ? text : typeof html === 'string' ? html : '';
  const plain = source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.slice(0, 200);
}

async function writeLog(cms, entry) {
  const EmailLog = getEmailLogModel(cms);
  return EmailLog.create(entry);
}

module.exports = {
  async testConnection(cms, configOverride) {
    const config = configOverride || (await SettingsService.getFullConfig(cms));
    const transport = createTransport(config);

    try {
      await transport.verify();
      return { ok: true, message: 'SMTP connection verified successfully.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SMTP verification failed';
      return { ok: false, message };
    } finally {
      transport.close();
    }
  },

  async sendMail(cms, payload, sentBy) {
    const config = await SettingsService.getFullConfig(cms);
    const to = validateEmail(payload.to || config.recipientEmail, 'Recipient email');
    const subject = String(payload.subject || '').trim();
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const html = typeof payload.html === 'string' ? payload.html.trim() : '';

    if (!subject) {
      throw new Error('Subject is required.');
    }
    if (!text && !html) {
      throw new Error('Email body is required (plain text or HTML).');
    }

    const transport = createTransport(config);
    const mailOptions = {
      from: buildFromAddress(config),
      to,
      subject,
      text: text || undefined,
      html: html || undefined,
    };

    if (config.replyTo) {
      mailOptions.replyTo = config.replyTo.trim();
    }

    try {
      const info = await transport.sendMail(mailOptions);
      const log = await writeLog(cms, {
        to,
        subject,
        status: 'sent',
        bodyPreview: previewBody(text, html),
        sentBy: sentBy || '',
      });

      return {
        success: true,
        messageId: info.messageId || '',
        logId: String(log._id),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send email';
      await writeLog(cms, {
        to,
        subject,
        status: 'failed',
        error: message,
        bodyPreview: previewBody(text, html),
        sentBy: sentBy || '',
      });
      throw new Error(message);
    } finally {
      transport.close();
    }
  },

  async listLogs(cms, limit) {
    const EmailLog = getEmailLogModel(cms);
    const max = Math.min(Math.max(parseInt(String(limit || 50), 10) || 50, 1), 200);
    const logs = await EmailLog.find({}).sort({ createdAt: -1 }).limit(max).lean();

    return logs.map((log) => ({
      id: String(log._id),
      to: log.to,
      subject: log.subject,
      status: log.status,
      error: log.error || '',
      bodyPreview: log.bodyPreview || '',
      sentBy: log.sentBy || '',
      createdAt: log.createdAt,
    }));
  },

  async deleteLog(cms, logId) {
    const EmailLog = getEmailLogModel(cms);
    const deleted = await EmailLog.findByIdAndDelete(logId);
    return Boolean(deleted);
  },
};
