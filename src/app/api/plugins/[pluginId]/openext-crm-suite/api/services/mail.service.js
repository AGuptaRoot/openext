'use strict';

function resolveMongoose() {
  try {
    return require('mongoose');
  } catch {
    const path = require('path');
    const candidates = [
      '../../node_modules/mongoose',
      '../../../node_modules/mongoose',
      '../../../../node_modules/mongoose',
      'C:/Users/AdarshGupta/Documents/OpenExt/openNext gitlab/node_modules/mongoose'
    ];
    for (const cand of candidates) {
      try {
        return require(path.resolve(__dirname, cand));
      } catch {
        /* continue searching next candidate */
      }
    }
  }
  return null;
}

const mongoose = resolveMongoose();
const SettingService = require('./setting.service');
const PrintHtmlService = require('./print-html.service');
const FinanceDocumentUtil = require('../utils/finance-document.util');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function renderTemplate(template, variables) {
  return String(template || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => {
    const value = variables[key];
    return value == null ? '' : String(value);
  });
}

function truthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function resolveNodemailer() {
  try {
    return require('nodemailer');
  } catch {}
  const path = require('path');
  const candidates = [
    path.resolve(process.cwd(), 'node_modules/nodemailer'),
    path.resolve(process.cwd(), '../node_modules/nodemailer'),
    path.resolve(__dirname, '../../node_modules/nodemailer'),
    path.resolve(__dirname, '../../../node_modules/nodemailer'),
    path.resolve(__dirname, '../../../../node_modules/nodemailer'),
    'c:/Users/AdarshGupta/Documents/OpenExt/openNext gitlab/node_modules/nodemailer',
    'c:/Users/AdarshGupta/Documents/ARProject/backend/node_modules/nodemailer'
  ];
  for (const cand of candidates) {
    try {
      return require(cand);
    } catch {}
  }
  return null;
}

// The CMS of the last request that carried one: background senders (cron, webhooks) reuse it.
let lastCms = null;

async function getUserDbConnection(req) {
  if (req?.cms?.database?.user) lastCms = req.cms;
  const cms = req?.cms?.database?.user ? req.cms : lastCms;
  if (cms?.database?.user) {
    try {
      const conn = await cms.database.user();
      if (conn) return conn;
    } catch {
      /* continue */
    }
  }
  return (typeof mongoose !== 'undefined' && mongoose?.connection) ? mongoose.connection : null;
}

const EMAIL_PLUGIN_IDS = ['email_plugin', 'email-plugin'];

/** A schema-less model on an existing table (MySQL adapter or mongoose) under a CRM-only name. */
function probeModel(userDb, modelName, collection) {
  if (!userDb || typeof userDb.model !== 'function' || !mongoose) return null;
  try {
    if (userDb.models?.[modelName]) return userDb.models[modelName];
    return userDb.model(modelName, new mongoose.Schema({}, { strict: false, collection }));
  } catch {
    return null;
  }
}

/** The host's Plugin model; the host's model name is never registered with a schema of ours. */
function getPluginModel(userDb) {
  if (userDb?.models?.Plugin) return userDb.models.Plugin;
  return probeModel(userDb, '__crm_probe_plugins', 'plugins');
}

/** Runs a query that may return a mongoose Query, an adapter thenable or a plain value. */
async function settle(query) {
  if (!query) return null;
  const leaned = typeof query.lean === 'function' ? query.lean() : query;
  if (leaned && typeof leaned.then === 'function') return await leaned;
  if (leaned && typeof leaned.exec === 'function') return await leaned.exec();
  return leaned || null;
}

/**
 * Safe findOne + lean for CMS / mongoose models.
 * OpenNext Plugin models often return a thenable from `.lean()` that has no `.catch`,
 * so `Model.findOne().lean().catch(...)` throws "catch is not a function".
 */
async function safeLeanFindOne(Model, filter = {}) {
  if (!Model || typeof Model.findOne !== 'function') return null;
  try {
    return (await settle(Model.findOne(filter))) || null;
  } catch {
    return null;
  }
}

async function safeLeanFind(Model, filter = {}) {
  if (!Model || typeof Model.find !== 'function') return [];
  try {
    const rows = await settle(Model.find(filter));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** A stored row as a plain document: MySQL rows can keep their fields in a `doc` JSON column. */
function plainRow(row) {
  if (!row || typeof row !== 'object') return null;
  const base = typeof row.toObject === 'function' ? row.toObject() : row;
  let doc = base.doc;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      doc = null;
    }
  }
  if (!doc || typeof doc !== 'object') return base;
  const merged = { ...doc };
  for (const [key, value] of Object.entries(base)) {
    if (key !== 'doc' && value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

function truthyFlag(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function pluginSummary(row) {
  const p = plainRow(row);
  if (!p) return null;
  return {
    pluginId: String(p.pluginId || 'email_plugin'),
    isActive: truthyFlag(p.isActive),
    name: p.name || 'Email Service'
  };
}

/**
 * The installed Email Service plugin ('email_plugin', or the older 'email-plugin'): the host's Plugin
 * model first, then the plugins table directly. An active record wins over an inactive one.
 */
async function findEmailPluginRecord(req, userDb) {
  const found = [];
  const Plugin = getPluginModel(userDb);
  for (const pluginId of EMAIL_PLUGIN_IDS) {
    const row = await safeLeanFindOne(Plugin, { pluginId });
    if (row) found.push(pluginSummary(row));
  }

  if (!found.length && typeof userDb?.collection === 'function') {
    for (const pluginId of EMAIL_PLUGIN_IDS) {
      try {
        const coll = userDb.collection('plugins');
        const row = coll && typeof coll.findOne === 'function' ? await coll.findOne({ pluginId }) : null;
        if (row) found.push(pluginSummary(row));
      } catch {
        /* next source */
      }
    }
  }

  if (!found.length && typeof userDb?.query === 'function') {
    try {
      const [rows] = await userDb.query('SELECT * FROM plugins');
      for (const row of rows || []) {
        const p = pluginSummary(row);
        if (p && EMAIL_PLUGIN_IDS.includes(p.pluginId)) found.push(p);
      }
    } catch {
      /* no SQL access */
    }
  }

  const list = found.filter(Boolean);
  return list.find((p) => p.isActive) || list[0] || null;
}

/**
 * Normalizes email configuration object extracted from mongoose model or database row.
 */
function normalizeConfigDoc(doc) {
  const parsed = plainRow(doc);
  if (!parsed) return null;
  return {
    host: String(parsed.host || '').trim(),
    port: typeof parsed.port === 'number' ? parsed.port : Number(parsed.port || 587),
    secure: truthyFlag(parsed.secure),
    user: String(parsed.user || '').trim(),
    password: String(parsed.password || '').trim(),
    fromName: String(parsed.fromName || '').trim(),
    fromEmail: String(parsed.fromEmail || '').trim(),
    recipientEmail: String(parsed.recipientEmail || '').trim(),
    replyTo: String(parsed.replyTo || '').trim()
  };
}

const SMTP_FIELDS = [
  ['host', 'SMTP host'],
  ['user', 'username'],
  ['password', 'password'],
  ['fromEmail', 'from email']
];

/** The SMTP fields a send needs that the config lacks (labels only, never values). */
function missingSmtpFields(config) {
  return SMTP_FIELDS.filter(([key]) => !(config && config[key])).map(([, label]) => label);
}

/**
 * The Email Service plugin's saved SMTP settings. The plugin registers 'EmailConfig' as
 * `<pluginId>_EmailConfig` (table `<pluginid>_emailconfigs`). Every row is read and the first complete
 * one wins, so an empty row created by the settings page never hides the saved one.
 */
async function findEmailConfigRecord(req, userDb, pluginId = 'email_plugin') {
  const ids = [pluginId, ...EMAIL_PLUGIN_IDS.filter((id) => id !== pluginId)];
  const rows = [];
  for (const id of ids) {
    const registered = userDb?.models?.[`${id}_EmailConfig`];
    if (registered) rows.push(...(await safeLeanFind(registered, {})));
  }
  if (!rows.length) {
    const table = `${String(pluginId).toLowerCase()}_emailconfigs`;
    rows.push(...(await safeLeanFind(probeModel(userDb, `__crm_probe_${table}`, table), {})));
    if (!rows.length && typeof userDb?.collection === 'function') {
      try {
        const coll = userDb.collection(table);
        const cursor = coll && typeof coll.find === 'function' ? coll.find({}) : null;
        const list = cursor && typeof cursor.toArray === 'function' ? await cursor.toArray() : await cursor;
        if (Array.isArray(list)) rows.push(...list);
      } catch {
        /* next source */
      }
    }
    if (!rows.length && typeof userDb?.query === 'function') {
      try {
        const [found] = await userDb.query(`SELECT * FROM \`${table.replace(/`/g, '')}\``);
        if (Array.isArray(found)) rows.push(...found);
      } catch {
        /* no SQL access */
      }
    }
  }
  const configs = rows.map(normalizeConfigDoc).filter(Boolean);
  return (
    configs.find((c) => !missingSmtpFields(c).length) ||
    configs.find((c) => c.host || c.user || c.fromEmail) ||
    configs[0] ||
    null
  );
}

/**
 * Whether the Email Service plugin can send and, if not, why, in words an admin can act on
 * (never a setting value).
 * @returns {Promise<{ ok: boolean, plugin, config, reason: string, message: string }>}
 */
async function inspectEmailPlugin(req, userDb) {
  const plugin = await findEmailPluginRecord(req, userDb);
  if (!plugin) {
    return { ok: false, plugin: null, config: null, reason: 'not_installed', message: 'the Email Service plugin (email_plugin) was not found in OpenExt. Install it in Plugin Manager.' };
  }
  if (!plugin.isActive) {
    return { ok: false, plugin, config: null, reason: 'inactive', message: `the Email Service plugin (${plugin.pluginId}) is installed but disabled. Enable it in Plugin Manager.` };
  }
  const config = await findEmailConfigRecord(req, userDb, plugin.pluginId);
  if (!config) {
    return { ok: false, plugin, config: null, reason: 'not_configured', message: 'no SMTP settings were found. Save them in Email Service → SMTP Settings.' };
  }
  const missing = missingSmtpFields(config);
  if (missing.length) {
    return { ok: false, plugin, config, reason: 'incomplete', message: `the SMTP settings are missing: ${missing.join(', ')}. Complete them in Email Service → SMTP Settings.` };
  }
  return { ok: true, plugin, config, reason: 'ready', message: 'ready' };
}

/**
 * Writes email dispatch audit log to the active email plugin's log table/model.
 */
async function writeEmailLogRecord(req, userDb, pluginId, entry) {
  // Try CMS models first
  if (req?.cms?.models?.get) {
    const candidateNames = ['EmailLog', `${pluginId}_EmailLog`, 'email_plugin_EmailLog', 'email-plugin_EmailLog'];
    for (const name of candidateNames) {
      try {
        const LogModel = req.cms.models.get(name);
        if (LogModel && typeof LogModel.create === 'function') {
          return await LogModel.create(entry);
        }
      } catch {}
    }
  }

  // Try registered userDb models
  const modelNames = [
    `${pluginId}_EmailLog`,
    'email_plugin_EmailLog',
    'email-plugin_EmailLog'
  ];
  for (const name of modelNames) {
    if (userDb?.models?.[name] && typeof userDb.models[name].create === 'function') {
      try {
        return await userDb.models[name].create(entry);
      } catch {}
    }
  }

  // Try creating model on userDb
  if (userDb && typeof userDb.model === 'function') {
    const collName = `${(pluginId || 'email_plugin').replace(/-/g, '_')}_emaillogs`;
    const modelName = `${pluginId || 'email_plugin'}_EmailLog`;
    try {
      let Model = userDb.models?.[modelName];
      if (!Model) {
        const schema = new mongoose.Schema(
          {
            to: { type: String, required: true, trim: true },
            subject: { type: String, required: true, trim: true },
            status: { type: String, enum: ['sent', 'failed'], required: true },
            error: { type: String, default: '' },
            bodyPreview: { type: String, default: '' },
            sentBy: { type: String, default: '' }
          },
          { timestamps: true, collection: collName }
        );
        Model = userDb.model(modelName, schema);
      }
      return await Model.create(entry);
    } catch {}
  }

  // Direct collection insert
  if (typeof userDb?.collection === 'function') {
    try {
      const coll = userDb.collection(`${(pluginId || 'email_plugin').replace(/-/g, '_')}_emaillogs`);
      if (coll && typeof coll.insertOne === 'function') {
        return await coll.insertOne(entry);
      }
    } catch {}
  }

  // Direct SQL insert if available
  if (typeof userDb?.query === 'function') {
    try {
      const id = require('crypto').randomBytes(12).toString('hex');
      const now = new Date();
      const docStr = JSON.stringify(entry);
      const tbl = `${(pluginId || 'email_plugin').replace(/-/g, '_')}_emaillogs`;
      await userDb.query(
        `INSERT INTO \`${tbl}\` (_id, doc, createdAt, updatedAt) VALUES (?, ?, ?, ?)`,
        [id, docStr, now, now]
      );
    } catch {}
  }
}

/**
 * Safely tests the SMTP handshake with the mail server without sending an email.
 */
async function verifySmtpConnection(config, timeoutMs = 7000) {
  if (!config || !config.host || !config.user || !config.password) {
    return { ok: false, message: 'SMTP credentials missing' };
  }
  const nodemailer = resolveNodemailer();
  if (!nodemailer) {
    return { ok: false, message: 'Nodemailer transport is not available' };
  }
  const transport = nodemailer.createTransport({
    host: config.host,
    port: Number(config.port || 587),
    secure: Boolean(config.secure),
    auth: {
      user: config.user,
      pass: config.password
    },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs
  });
  try {
    await transport.verify();
    return { ok: true, message: 'SMTP connection verified successfully.' };
  } catch (error) {
    return { ok: false, message: error?.message || 'SMTP verification failed' };
  } finally {
    try { transport.close(); } catch {}
  }
}

function previewBody(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function buildFromAddress(config, fallbackName) {
  const email = String(config.fromEmail || '').trim();
  const name = String(config.fromName || fallbackName || '').trim();
  if (!name) return email;
  return `"${name.replace(/"/g, '\\"')}" <${email}>`;
}

/**
 * Resolves CRM email settings for subjects and intros.
 * 
 * @param {Object} req Express request object
 * @returns {Promise<Object>} Resolved mail configuration
 */
async function resolveMailConfig(req) {
  const settings = await SettingService.get(req);
  return {
    enabled: settings.email_notifications_enabled !== false,
    fromName: settings.email_from_name || 'Root CRM',
    quotationSubject: settings.quotation_email_subject || 'Quotation {{docNo}} from {{companyName}}',
    quotationIntro: settings.quotation_email_intro || 'Please find your quotation details below.',
    invoiceSubject: settings.invoice_email_subject || 'Invoice {{docNo}} from {{companyName}}',
    invoiceIntro: settings.invoice_email_intro || 'Please find your invoice details below.'
  };
}

/**
 * Dispatches mail directly via email_plugin / email-plugin SMTP configuration in database,
 * using process nodemailer and logging to email log.
 * Falls back to process.env.MAIL_WEBHOOK_URL or dev log.
 * 
 * @param {Object} req Express request object
 * @param {Object} options Mail object ({ to, subject, html, text, attachments })
 * @returns {Promise<Object>} Response metadata
 */
async function sendViaEmailPlugin(req, options = {}) {
  const { to, subject, html, text, attachments } = options;
  const plainText = text || (html ? String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
  const userDb = await getUserDbConnection(req);

  // 1. The Email Service plugin (email_plugin), when installed, enabled and configured
  const inspection = await inspectEmailPlugin(req, userDb);
  const { plugin, config } = inspection;

  if (inspection.ok) {
    if (config) {
      const nodemailer = resolveNodemailer();
      if (!nodemailer) {
        throw appError('Nodemailer transport is not available in the CMS server environment', 500);
      }

      const recipient = String(to || config.recipientEmail || '').trim();
      if (!isValidEmail(recipient)) {
        throw appError('Invalid recipient email address', 400);
      }

      const port = typeof config.port === 'number' ? config.port : Number(config.port || 587);
      const transport = nodemailer.createTransport({
        host: String(config.host).trim(),
        port,
        secure: Boolean(config.secure),
        auth: {
          user: String(config.user).trim(),
          pass: String(config.password).trim()
        }
      });

      const sentBy = req?.user?.email || req?.user?.username || req?.user?.id || 'CRM System';

      try {
        const crmMailConfig = await resolveMailConfig(req);
        await transport.sendMail({
          from: buildFromAddress(config, crmMailConfig.fromName),
          to: recipient,
          subject,
          html,
          text: plainText,
          replyTo: config.replyTo || undefined,
          attachments: Array.isArray(attachments) && attachments.length > 0 ? attachments : undefined
        });

        try {
          await writeEmailLogRecord(req, userDb, plugin.pluginId, {
            to: recipient,
            subject,
            status: 'sent',
            bodyPreview: previewBody(html),
            sentBy
          });
        } catch (logErr) {
          console.warn('[plugin:openext-crm-suite] Failed to write to email log:', logErr?.message || logErr);
        }

        return { sent: true, to: recipient, subject };
      } catch (sendError) {
        const errorMessage = sendError instanceof Error ? sendError.message : String(sendError);
        try {
          await writeEmailLogRecord(req, userDb, plugin.pluginId, {
            to: recipient,
            subject,
            status: 'failed',
            error: errorMessage,
            bodyPreview: previewBody(html),
            sentBy
          });
        } catch {
          /* ignore log error */
        }
        throw appError(`Email transport failed: ${errorMessage}`, 502);
      } finally {
        try {
          transport.close();
        } catch {
          /* ignore transport close error */
        }
      }
    }
  }

  // 2. Fallback: Check process.env.MAIL_WEBHOOK_URL
  const endpoint = process.env.MAIL_WEBHOOK_URL;
  if (endpoint) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.MAIL_WEBHOOK_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.MAIL_WEBHOOK_TOKEN}`;
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to, subject, html, text: plainText })
    });
    if (!response.ok) {
      throw appError(`Mail webhook failed with status ${response.status}`, 502);
    }
    return { sent: true, to, subject, via: 'webhook' };
  }

  // 3. No mail transport: say exactly which check failed (flags only in the log, no values)
  console.warn('[plugin:openext-crm-suite] email not sent:', inspection.reason, {
    connection: Boolean(userDb),
    plugin: plugin ? plugin.pluginId : null,
    active: Boolean(plugin && plugin.isActive),
    missing: config ? missingSmtpFields(config) : null
  });
  const error = appError(`Cannot send email: ${inspection.message}`, 400);
  error.code = `EMAIL_${inspection.reason.toUpperCase()}`;
  throw error;
}

async function buildFinancePayload(req, type, doc) {
  if (type === 'quotation') {
    return FinanceDocumentUtil.buildQuotationPayload(req, doc);
  }
  return FinanceDocumentUtil.buildInvoicePayload(req, doc);
}

/**
 * Sends a Quotation or Invoice email to a customer via direct email-plugin SMTP config.
 * Attaches a generated PDF document for instant download.
 * 
 * @param {Object} req Express request object
 * @param {string} type Document type ('quotation' or 'invoice')
 * @param {Object} doc Mongoose document
 * @param {Object} options Options including payUrl
 * @returns {Promise<Object>} Mail delivery result
 */
async function sendFinanceDocumentEmail(req, type, doc, options = {}) {
  const config = await resolveMailConfig(req);
  if (!config.enabled) {
    return { sent: false, skipped: true, reason: 'email_disabled' };
  }

  const payload = await buildFinancePayload(req, type, doc);
  // The current email receives it; the document itself shows its creation-time snapshot.
  const recipient = String(payload.recipientEmail || payload.client?.email || '').trim();
  if (!isValidEmail(recipient)) {
    throw appError(
      `No valid recipient email on the ${type === 'quotation' ? 'lead/client' : 'client'}. Add an email before sending.`,
      409
    );
  }

  const docNo = type === 'quotation' ? doc.quotationNo : doc.invoiceNo;
  const subjectTemplate =
    type === 'quotation' ? config.quotationSubject : config.invoiceSubject;
  const intro = type === 'quotation' ? config.quotationIntro : config.invoiceIntro;
  const templateVars = {
    docNo: docNo || '',
    companyName: payload.company?.name || 'Company',
    clientName: payload.client?.name || 'Customer',
    type: type === 'quotation' ? 'Quotation' : 'Invoice'
  };

  const subject = renderTemplate(subjectTemplate, templateVars).trim() || `${templateVars.type} ${docNo}`;
  const html = PrintHtmlService.renderFinanceEmailHtml(payload, {
    intro,
    payUrl: options.payUrl || '',
    portalUrl: options.portalUrl || options.payUrl || '',
    clientPortalUrl: options.clientPortalUrl || ''
  });

  // Generate and attach PDF copy
  const attachments = [];
  try {
    const { generateFinanceDocumentPdf } = require('../utils/pdf-generator.util');
    const pdfBuffer = generateFinanceDocumentPdf(payload);
    const pdfFilename = `${type === 'quotation' ? 'Quotation' : 'Invoice'}-${docNo || 'doc'}.pdf`;
    attachments.push({
      filename: pdfFilename,
      content: pdfBuffer,
      contentType: 'application/pdf'
    });
  } catch (pdfErr) {
    console.warn('[plugin:openext-crm-suite] PDF attachment generation skipped:', pdfErr.message);
  }

  await sendViaEmailPlugin(req, {
    to: recipient,
    subject,
    html,
    attachments
  });

  return { sent: true, to: recipient, subject, hasAttachment: attachments.length > 0 };
}

/**
 * Transmits a test email via direct email-plugin SMTP config.
 * 
 * @param {Object} req Express request object
 * @param {string} toAddress Test recipient email
 * @returns {Promise<Object>} Mail delivery result
 */
async function sendTestEmail(req, toAddress) {
  const config = await resolveMailConfig(req);
  const to = String(toAddress || '').trim();
  if (!isValidEmail(to)) {
    throw appError('A valid test recipient email is required', 400);
  }

  const companyName = config.fromName || 'Root CRM';
  const subject = `${companyName} — CRM test email`;
  const html = `<p>This is a test email from <strong>${PrintHtmlService.escapeHtml(companyName)}</strong>.</p><p>Direct Email Integration via Email Service Plugin configuration is working perfectly.</p>`;

  await sendViaEmailPlugin(req, {
    to,
    subject,
    html
  });

  return { sent: true, to };
}

/**
 * Checks connectivity and configuration status of email-plugin in database.
 * 
 * Usecase: Diagnostic API status check for CRM Settings UI.
 * 
 * @param {Object} req Express request object
 * @returns {Promise<Object>} Status of Email Service Plugin
 */
async function getEmailPluginStatus(req) {
  try {
    const userDb = await getUserDbConnection(req);
    const inspection = await inspectEmailPlugin(req, userDb);
    const plugin = inspection.plugin;

    if (!plugin) {
      return {
        installed: false,
        active: false,
        configured: false,
        connected: false,
        settings: null,
        message: 'email_plugin is not installed'
      };
    }

    const isActive = Boolean(plugin.isActive);
    const config = inspection.config || (await findEmailConfigRecord(req, userDb, plugin.pluginId || 'email_plugin'));

    const isConfigured = Boolean(config && !missingSmtpFields(config).length);

    let connected = false;
    let connectionMessage = '';

    if (isActive && isConfigured) {
      try {
        const connCheck = await verifySmtpConnection(config);
        connected = connCheck.ok;
        connectionMessage = connCheck.message;
      } catch (checkErr) {
        connected = false;
        connectionMessage = checkErr?.message || 'Connection check failed';
      }
    }

    let message = 'Email Service Plugin is active and SMTP connection verified';
    if (!isActive) {
      message = 'Email Service Plugin is installed but inactive';
    } else if (!isConfigured) {
      message = config
        ? `Email Service Plugin is active but the SMTP settings are missing: ${missingSmtpFields(config).join(', ')}`
        : 'Email Service Plugin is active but no SMTP settings were found';
    } else if (!connected) {
      message = `Email Service Plugin is active, but SMTP connection failed: ${connectionMessage}`;
    }

    return {
      installed: true,
      active: isActive,
      configured: isConfigured,
      connected,
      connectionMessage,
      settings: config
        ? {
            host: config.host || '',
            port: config.port || 587,
            secure: Boolean(config.secure),
            user: config.user ? `${config.user.slice(0, 2)}…` : '',
            fromName: config.fromName || '',
            fromEmail: config.fromEmail || '',
            recipientEmail: config.recipientEmail || ''
          }
        : null,
      message
    };
  } catch (error) {
    return {
      installed: false,
      active: false,
      configured: false,
      connected: false,
      settings: null,
      message: `Error checking email plugin status: ${error.message || error}`
    };
  }
}

module.exports = {
  resolveMailConfig,
  sendViaEmailPlugin,
  sendFinanceDocumentEmail,
  sendTestEmail,
  getEmailPluginStatus,
  inspectEmailPlugin,
  findEmailPluginRecord,
  findEmailConfigRecord,
  verifySmtpConnection,
  isValidEmail
};
