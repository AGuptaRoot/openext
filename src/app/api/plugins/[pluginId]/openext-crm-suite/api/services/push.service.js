'use strict';

/**
 * CRM 3.59.0 — push notifications to the mobile app through Firebase Cloud Messaging (HTTP v1 API).
 * CRM 3.62.0 — also to browsers (web push through FCM): the admin adds the Firebase web app config and the
 * Web Push (VAPID) public key; a user turns browser alerts on from the notification bell, the browser gets an
 * FCM token (Firebase JS SDK + the CRM's own service worker, GET /push/sw.js) and registers it as platform
 * "web". The same sender, device table, preferences and dead-token cleanup serve phones and browsers.
 *
 * Settings → Integrations → Push notifications holds the Firebase service account of this tenant,
 * encrypted (only project_id, client_email and private_key are kept; GET shows a hint only).
 * The server signs its own Google sign-in (RS256 JWT, Node crypto — no extra package) for an access token,
 * cached per tenant until shortly before it expires.
 *
 * Every in-app notification (notification.service notify) also goes to the user's registered phones,
 * unless the user switched that alert type off. Sending never blocks or fails the action that raised it;
 * a token Firebase no longer knows is removed. Nothing about the message or the token is logged.
 */

const crypto = require('crypto');
const { resolveTenantId, resolveUserId, isClientUser } = require('../utils/tenant.util');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_DEVICES_PER_USER = 10;
const MAX_TOKEN_LENGTH = 4096;
const SLUG_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** The alert types a user can switch off (extensions may send their own slug, e.g. "booking_confirmed"). */
const PUSH_TYPES = Object.freeze([
  { type: 'lead_assigned', label: 'A lead is assigned to me' },
  { type: 'task_assigned', label: 'A task or subtask is assigned to me (Projects)' },
  { type: 'followup_due', label: 'A follow-up is due soon' },
  { type: 'followup_missed', label: 'A follow-up was missed' },
  { type: 'quotation_accepted', label: 'A quotation is accepted' },
  { type: 'payment_received', label: 'A payment is received' },
  { type: 'portal_approval', label: 'A portal access request waits for approval' },
  { type: 'booking_confirmed', label: 'A booking is confirmed (Travel)' },
  { type: 'passport_expiry', label: 'A traveller passport expires soon (Travel)' },
  { type: 'timer_reminder', label: 'My shift started and no timer is running (Projects)' },
  { type: 'shift_over', label: 'My hourly shift is over (Projects)' },
  { type: 'team_timer_alert', label: 'A team member has not started the timer (Projects, for project leads, managers and admins)' },
  { type: 'other', label: 'Other alerts' }
]);

const tokenCache = new Map(); // `${tenantId}|${client_email}` → { token, expiresAt }

function appError(message, status = 400, code) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  if (code) error.code = code;
  return error;
}

function model(req, name) {
  const Model = req && req.cms && req.cms.models && typeof req.cms.models.get === 'function' ? req.cms.models.get(name) : null;
  if (!Model) throw appError('Push notifications are not available', 503);
  return Model;
}

const settle = async (q) => (q && typeof q.lean === 'function' ? q.lean() : q);
const text = (v, max) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function cleanType(value) {
  const t = String(value || '').trim().toLowerCase();
  return SLUG_RE.test(t) ? t : 'other';
}

/* --------------------------------------------------------------- settings */

/** The service account JSON → { project_id, client_email, private_key } or a 400. */
function parseServiceAccount(raw) {
  let json = raw;
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw);
    } catch {
      throw appError('Paste the whole service account JSON file from Firebase (it is not valid JSON)', 400, 'FCM_KEY_INVALID');
    }
  }
  const sa = json && typeof json === 'object' ? json : {};
  const projectId = text(sa.project_id, 100);
  const clientEmail = text(sa.client_email, 200);
  const privateKey = String(sa.private_key || '');
  if (sa.type && sa.type !== 'service_account') throw appError('This is not a service account key (type must be "service_account")', 400, 'FCM_KEY_INVALID');
  if (!/^[a-z0-9-]{4,100}$/.test(projectId)) throw appError('The service account has no valid project_id', 400, 'FCM_KEY_INVALID');
  if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(clientEmail)) throw appError('The service account has no valid client_email', 400, 'FCM_KEY_INVALID');
  if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(privateKey) || privateKey.length > 8000) {
    throw appError('The service account has no valid private_key', 400, 'FCM_KEY_INVALID');
  }
  try {
    crypto.createPrivateKey(privateKey);
  } catch {
    throw appError('The private_key of the service account cannot be read', 400, 'FCM_KEY_INVALID');
  }
  return { project_id: projectId, client_email: clientEmail, private_key: privateKey };
}

/** Firebase web app config keys (public values: they identify the app, they are not secrets). */
const WEB_CONFIG_KEYS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId', 'measurementId'];

/**
 * The web app config pasted by the admin: JSON, or the `const firebaseConfig = { … }` snippet from
 * Firebase → Project settings → Your apps → Web app. → { apiKey, authDomain?, projectId, storageBucket?,
 * messagingSenderId, appId }
 */
function parseWebConfig(raw) {
  let src = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.length > 4000) throw appError('The web app config is too large', 400, 'FCM_WEB_CONFIG_INVALID');
    try {
      src = JSON.parse(s);
    } catch {
      // The JavaScript snippet: read each key: "value" pair (nothing is run).
      src = {};
      for (const key of WEB_CONFIG_KEYS) {
        const m = s.match(new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"'\\n]{1,300})["']`));
        if (m) src[key] = m[1];
      }
    }
  }
  const c = src && typeof src === 'object' ? src : {};
  const out = {};
  for (const key of WEB_CONFIG_KEYS) {
    const v = text(c[key], 300);
    if (v) out[key] = v;
  }
  if (!/^AIza[0-9A-Za-z_-]{30,45}$/.test(out.apiKey || '')) throw appError('The web app config has no valid apiKey', 400, 'FCM_WEB_CONFIG_INVALID');
  if (!/^[a-z0-9-]{4,100}$/.test(out.projectId || '')) throw appError('The web app config has no valid projectId', 400, 'FCM_WEB_CONFIG_INVALID');
  if (!/^\d{5,20}$/.test(out.messagingSenderId || '')) throw appError('The web app config has no valid messagingSenderId', 400, 'FCM_WEB_CONFIG_INVALID');
  if (!/^1:\d{5,20}:web:[0-9a-f]{6,40}$/.test(out.appId || '')) throw appError('The web app config has no valid appId (a "web" app, like 1:123…:web:abc…)', 400, 'FCM_WEB_CONFIG_INVALID');
  if (out.authDomain && !/^[a-z0-9.-]{3,200}$/i.test(out.authDomain)) delete out.authDomain;
  if (out.storageBucket && !/^[a-z0-9._-]{3,200}$/i.test(out.storageBucket)) delete out.storageBucket;
  if (out.measurementId && !/^G-[A-Z0-9]{4,20}$/.test(out.measurementId)) delete out.measurementId;
  return out;
}

/** The Web Push certificate public key (Firebase → Cloud Messaging → Web configuration → Key pair). */
function parseVapidKey(raw) {
  const key = String(raw || '').trim();
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(key)) {
    throw appError('The Web Push key must be the public key of the key pair (about 87 letters, digits, - and _)', 400, 'FCM_VAPID_INVALID');
  }
  return key;
}

async function readWebSetup(req) {
  const SettingService = require('./setting.service');
  const rawConfig = String((await SettingService.readRawSettingValue(req, 'fcm_web_config')) || '').trim();
  const vapidKey = String((await SettingService.readRawSettingValue(req, 'fcm_vapid_key')) || '').trim();
  let config = null;
  if (rawConfig) {
    try {
      config = parseWebConfig(rawConfig);
    } catch {
      config = null;
    }
  }
  return { config, vapidKey: /^[A-Za-z0-9_-]{80,100}$/.test(vapidKey) ? vapidKey : '' };
}

function hintOf(sa) {
  const [name, domain] = String(sa.client_email || '').split('@');
  return `${String(name || '').slice(0, 10)}…@${String(domain || '').split('.')[0] || ''}… · ${sa.project_id}`;
}

async function readServiceAccount(req) {
  const SettingService = require('./setting.service');
  const { decryptCredential } = require('../utils/credential.util');
  const stored = String((await SettingService.readRawSettingValue(req, 'fcm_service_account')) || '').trim();
  if (!stored) return null;
  try {
    const parsed = JSON.parse(decryptCredential(stored));
    return parsed && parsed.project_id && parsed.client_email && parsed.private_key ? parsed : null;
  } catch {
    return null;
  }
}

/** GET /settings/integrations/fcm — status only, never the key. */
async function getIntegration(req) {
  const SettingService = require('./setting.service');
  const stored = String((await SettingService.readRawSettingValue(req, 'fcm_service_account')) || '').trim();
  const hint = String((await SettingService.readRawSettingValue(req, 'fcm_service_account_hint')) || '').trim();
  const sa = stored ? await readServiceAccount(req) : null;
  const web = await readWebSetup(req);
  const webReady = Boolean(sa && web.config && web.vapidKey);
  return {
    configured: Boolean(sa),
    web: {
      configured: Boolean(web.config && web.vapidKey),
      ready: webReady,
      projectId: web.config ? web.config.projectId : '',
      appId: web.config ? web.config.appId : '',
      vapidSet: Boolean(web.vapidKey),
      projectMatches: !sa || !web.config || web.config.projectId === sa.project_id,
      message: webReady
        ? 'Browser alerts are available: each user turns them on in Settings → Integrations → My browser alerts.'
        : web.config || web.vapidKey
          ? 'Add both the web app config and the Web Push key (and the service account) to turn browser alerts on.'
          : 'Optional: add the Firebase web app config and the Web Push key to send alerts to browsers too.'
    },
    hint: sa ? hint : '',
    projectId: sa ? sa.project_id : '',
    message: sa
      ? 'Push notifications are on: the Firebase service account is stored encrypted.'
      : stored
        ? 'A key is stored but cannot be read. Paste the service account JSON again and Save.'
        : 'Paste the Firebase service account JSON to send push notifications to the mobile app.',
    types: PUSH_TYPES
  };
}

/** PUT /settings/integrations/fcm { serviceAccount } | { clearKey: true } */
async function updateIntegration(req, input = {}) {
  const SettingService = require('./setting.service');
  const AuditService = require('./audit.service');
  const { encryptCredential } = require('../utils/credential.util');
  const body = input && typeof input === 'object' ? input : {};
  if (body.clearKey === true) {
    await SettingService.upsertSettingValue(req, 'fcm_service_account', '');
    await SettingService.upsertSettingValue(req, 'fcm_service_account_hint', '');
    tokenCache.delete(`${resolveTenantId(req)}|`);
    for (const key of [...tokenCache.keys()]) if (key.startsWith(`${resolveTenantId(req)}|`)) tokenCache.delete(key);
    await AuditService.log(req, { action: 'updated', module: 'settings', description: 'Push notifications (FCM) key removed' });
    return getIntegration(req);
  }
  // CRM 3.62.0: web push setup (public values, kept as they are).
  if (body.clearWeb === true) {
    await SettingService.upsertSettingValue(req, 'fcm_web_config', '');
    await SettingService.upsertSettingValue(req, 'fcm_vapid_key', '');
    await AuditService.log(req, { action: 'updated', module: 'settings', description: 'Browser push (FCM web) settings removed' });
    return getIntegration(req);
  }
  const hasWeb = body.webConfig !== undefined || body.vapidKey !== undefined;
  if (hasWeb) {
    const current = await readWebSetup(req);
    const config = body.webConfig !== undefined && body.webConfig !== '' ? parseWebConfig(body.webConfig) : current.config;
    const vapidKey = body.vapidKey !== undefined && body.vapidKey !== '' ? parseVapidKey(body.vapidKey) : current.vapidKey;
    const sa = await readServiceAccount(req);
    if (config && sa && config.projectId !== sa.project_id) {
      throw appError(`The web app is in Firebase project "${config.projectId}" but the service account is for "${sa.project_id}". Use the same project.`, 400, 'FCM_WEB_CONFIG_INVALID');
    }
    await SettingService.upsertSettingValue(req, 'fcm_web_config', config ? JSON.stringify(config) : '');
    await SettingService.upsertSettingValue(req, 'fcm_vapid_key', vapidKey || '');
    await AuditService.log(req, { action: 'updated', module: 'settings', description: 'Browser push (FCM web) settings saved', metadata: { projectId: config ? config.projectId : '' } });
    if (body.serviceAccount === undefined || body.serviceAccount === null || body.serviceAccount === '') return getIntegration(req);
  }
  if (body.serviceAccount === undefined || body.serviceAccount === null || body.serviceAccount === '') {
    throw appError('Paste the service account JSON, or send clearKey: true', 400, 'FCM_KEY_INVALID');
  }
  const raw = typeof body.serviceAccount === 'string' ? body.serviceAccount : JSON.stringify(body.serviceAccount);
  if (raw.length > 20000) throw appError('The service account JSON is too large', 400, 'FCM_KEY_INVALID');
  const sa = parseServiceAccount(body.serviceAccount);
  let encrypted;
  try {
    encrypted = encryptCredential(JSON.stringify(sa));
  } catch (error) {
    throw appError(String((error && error.message) || 'Could not encrypt the key. Set CREDENTIAL_ENCRYPTION_KEY or JWT_SECRET on the server.'), 503);
  }
  await SettingService.upsertSettingValue(req, 'fcm_service_account', encrypted);
  await SettingService.upsertSettingValue(req, 'fcm_service_account_hint', hintOf(sa));
  for (const key of [...tokenCache.keys()]) if (key.startsWith(`${resolveTenantId(req)}|`)) tokenCache.delete(key);
  await AuditService.log(req, { action: 'updated', module: 'settings', description: 'Push notifications (FCM) key saved', metadata: { projectId: sa.project_id } });
  return getIntegration(req);
}

/* ------------------------------------------------------------ Google token */

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function signedAssertion(sa, nowSec) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: sa.client_email, scope: FCM_SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 };
  const unsigned = `${b64url(header)}.${b64url(claims)}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  return `${unsigned}.${signature}`;
}

async function timedFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function accessToken(req, sa) {
  const cacheKey = `${resolveTenantId(req)}|${sa.client_email}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  const nowSec = Math.floor(Date.now() / 1000);
  const res = await timedFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(sa, nowSec) }).toString()
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.access_token) {
    throw appError('Firebase refused the service account (check that the key is current and Cloud Messaging is enabled)', 502, 'FCM_AUTH_FAILED');
  }
  tokenCache.set(cacheKey, { token: payload.access_token, expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000 });
  return payload.access_token;
}

/* ----------------------------------------------------------------- devices */

function assertStaff(req) {
  if (isClientUser(req)) throw appError('Push notifications are for CRM staff only', 403, 'FORBIDDEN');
  const userId = String(resolveUserId(req) || '');
  if (!userId || userId === 'system') throw appError('Sign in to register a device', 401);
  return userId;
}

function presentDevice(row) {
  return {
    id: String(row._id),
    platform: row.platform,
    appVersion: text(row.appVersion, 40),
    deviceName: text(row.deviceName, 80),
    lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null
  };
}

/** POST /devices/register { token, platform, appVersion?, deviceName? } */
async function registerDevice(req, input = {}) {
  const userId = assertStaff(req);
  const tenantId = resolveTenantId(req);
  const { encryptCredential } = require('../utils/credential.util');
  const body = input && typeof input === 'object' ? input : {};
  const token = String(body.token || '').trim();
  const platform = String(body.platform || '').trim().toLowerCase();
  if (!token || token.length < 20 || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    throw appError('token must be the FCM registration token from the app', 400, 'INVALID_INPUT');
  }
  if (!['android', 'ios', 'web'].includes(platform)) throw appError('platform must be "android", "ios" or "web"', 400, 'INVALID_INPUT');
  const Device = model(req, 'CrmPushDevice');
  const tokenHash = hashToken(token);
  const values = {
    userId,
    token: encryptCredential(token),
    platform,
    appVersion: text(body.appVersion, 40),
    deviceName: text(body.deviceName, 80),
    lastSeenAt: new Date()
  };
  const existing = await settle(Device.findOne({ tenantId, tokenHash }));
  let row;
  if (existing) {
    // Same phone, maybe another person now: the token moves to the signed-in user.
    row = await settle(Device.findOneAndUpdate({ _id: existing._id, tenantId }, { $set: values }, { new: true }));
  } else {
    const count = typeof Device.countDocuments === 'function' ? await Device.countDocuments({ tenantId, userId }) : 0;
    if (count >= MAX_DEVICES_PER_USER) {
      // Keep the newest: the oldest device of this user makes room.
      const oldest = await settle(Device.findOne({ tenantId, userId }).sort({ lastSeenAt: 1 }));
      if (oldest) await Device.deleteOne({ _id: oldest._id, tenantId });
    }
    row = await Device.create({ tenantId, tokenHash, ...values });
    row = row && typeof row.toObject === 'function' ? row.toObject() : row;
  }
  return presentDevice(row || { ...values, _id: existing && existing._id });
}

/**
 * CRM 3.64.8 — POST /devices/status { token } → { registered, deviceName?, lastSeenAt? }: is this browser's token
 * saved on the server for the signed-in user (this workspace)? The My Alerts switch asks this, so it never says
 * "On" while the server has nothing to send to. The token is only hashed here, never stored or returned.
 */
async function deviceStatus(req, input = {}) {
  const userId = assertStaff(req);
  const token = String((input && input.token) || '').trim();
  if (!token || token.length < 20 || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) return { registered: false };
  const Device = model(req, 'CrmPushDevice');
  const row = await settle(Device.findOne({ tenantId: resolveTenantId(req), tokenHash: hashToken(token) }));
  if (!row || String(row.userId) !== String(userId)) return { registered: false };
  return { registered: true, deviceName: text(row.deviceName, 80), lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null };
}

/** POST /devices/unregister { token } — on logout. Only the signed-in user's own token. */
async function unregisterDevice(req, input = {}) {
  const userId = assertStaff(req);
  const token = String((input && input.token) || '').trim();
  if (!token) throw appError('token is required', 400, 'INVALID_INPUT');
  const Device = model(req, 'CrmPushDevice');
  const res = await Device.deleteOne({ tenantId: resolveTenantId(req), tokenHash: hashToken(token), userId });
  return { removed: Number(res && res.deletedCount) || 0 };
}

/** GET /devices — the signed-in user's phones (never the tokens). */
async function listDevices(req) {
  const userId = assertStaff(req);
  const Device = model(req, 'CrmPushDevice');
  let q = Device.find({ tenantId: resolveTenantId(req), userId });
  if (q && typeof q.sort === 'function') q = q.sort({ lastSeenAt: -1 });
  return ((await settle(q)) || []).map(presentDevice);
}

/** DELETE /devices/:id — remove one of my phones. */
async function removeDevice(req, id) {
  const userId = assertStaff(req);
  if (!/^[a-f0-9]{24}$/i.test(String(id || ''))) throw appError('Device not found', 404, 'NOT_FOUND');
  const Device = model(req, 'CrmPushDevice');
  const res = await Device.deleteOne({ _id: String(id), tenantId: resolveTenantId(req), userId });
  if (!(Number(res && res.deletedCount) > 0)) throw appError('Device not found', 404, 'NOT_FOUND');
  return { removed: 1 };
}

/* ------------------------------------------------------------- preferences */

async function getPreferences(req) {
  const userId = assertStaff(req);
  const Pref = model(req, 'CrmPushPreference');
  const row = await settle(Pref.findOne({ tenantId: resolveTenantId(req), userId }));
  const off = new Set(Array.isArray(row && row.off) ? row.off : []);
  return { types: PUSH_TYPES.map((t) => ({ ...t, enabled: !off.has(t.type) })) };
}

/** PUT /devices/preferences { off: ["followup_due", …] } or { types: [{ type, enabled }] } */
async function setPreferences(req, input = {}) {
  const userId = assertStaff(req);
  const body = input && typeof input === 'object' ? input : {};
  let off = [];
  if (Array.isArray(body.off)) off = body.off;
  else if (Array.isArray(body.types)) off = body.types.filter((t) => t && t.enabled === false).map((t) => t.type);
  else throw appError('Send off: [types] or types: [{ type, enabled }]', 400, 'INVALID_INPUT');
  const clean = [...new Set(off.map((t) => String(t || '').trim().toLowerCase()).filter((t) => SLUG_RE.test(t)))].slice(0, 40);
  const Pref = model(req, 'CrmPushPreference');
  await settle(Pref.findOneAndUpdate({ tenantId: resolveTenantId(req), userId }, { $set: { off: clean } }, { upsert: true, new: true }));
  return getPreferences(req);
}

/* ----------------------------------------------------------------- sending */

/** One message to one token → 'sent' | 'gone' (token unknown to Firebase) | 'failed'. */
async function sendOne(sa, bearer, token, message) {
  const res = await timedFetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, ...message } })
  });
  if (res.ok) return 'sent';
  const payload = await res.json().catch(() => ({}));
  const details = JSON.stringify((payload && payload.error) || {});
  if (res.status === 404 || /UNREGISTERED|registration-token-not-registered/i.test(details)) return 'gone';
  if (res.status === 400 && /INVALID_ARGUMENT/.test(details) && /token/i.test(details)) return 'gone';
  return 'failed';
}

function buildMessage(req, alert) {
  const data = {
    type: cleanType(alert.type),
    link: text(alert.link, 300),
    notificationId: text(alert.notificationId, 40),
    tenantId: String(resolveTenantId(req) || ''),
    source: text(alert.source, 80)
  };
  return {
    notification: { title: text(alert.title, 120), body: text(alert.message, 500) },
    data,
    android: { priority: 'high', notification: { sound: 'default', tag: data.notificationId || undefined } },
    apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
    // CRM 3.62.0: browsers. The CRM service worker shows it and opens data.link on click.
    webpush: { headers: { Urgency: 'high', TTL: '86400' }, notification: { title: text(alert.title, 120), body: text(alert.message, 500), tag: data.notificationId || undefined } }
  };
}

/**
 * GET /devices/web-config — what a signed-in staff browser needs to turn on browser alerts:
 * { enabled, config, vapidKey } (public Firebase values only; never the service account).
 */
async function getWebClientConfig(req) {
  assertStaff(req);
  const sa = await readServiceAccount(req);
  const web = await readWebSetup(req);
  const enabled = Boolean(sa && web.config && web.vapidKey && web.config.projectId === sa.project_id);
  return enabled ? { enabled, config: web.config, vapidKey: web.vapidKey } : { enabled: false, config: null, vapidKey: '' };
}

/** GET /push/sw.js — the CRM's service worker for browser alerts (no data in it; same for every tenant). */
function serviceWorkerSource() {
  const fs = require('fs');
  const path = require('path');
  return fs.readFileSync(path.join(__dirname, '..', 'push', 'crm-push-sw.js'), 'utf8');
}

/**
 * Sends one alert to these users' phones. Never throws.
 * @param alerts [{ userId, title, message, link, type, notificationId, source }]
 * @returns {{ sent, failed, removed, skipped }}
 */
async function sendAlerts(req, alerts = []) {
  const out = { sent: 0, failed: 0, removed: 0, skipped: 0 };
  try {
    const list = (Array.isArray(alerts) ? alerts : []).filter((a) => a && a.userId && a.title);
    if (!list.length) return out;
    const sa = await readServiceAccount(req);
    if (!sa) {
      out.skipped = list.length;
      return out;
    }
    const tenantId = resolveTenantId(req);
    const Device = req.cms.models.get('CrmPushDevice');
    const Pref = req.cms.models.get('CrmPushPreference');
    if (!Device) return out;
    const { decryptCredential } = require('../utils/credential.util');
    const userIds = [...new Set(list.map((a) => String(a.userId)))];
    const prefs = Pref ? ((await settle(Pref.find({ tenantId, userId: { $in: userIds } }))) || []) : [];
    const offBy = new Map(prefs.map((p) => [String(p.userId), new Set(Array.isArray(p.off) ? p.off : [])]));
    const devices = (await settle(Device.find({ tenantId, userId: { $in: userIds } }))) || [];
    if (!devices.length) {
      out.skipped = list.length;
      return out;
    }
    const bearer = await accessToken(req, sa);
    for (const alert of list) {
      if ((offBy.get(String(alert.userId)) || new Set()).has(cleanType(alert.type))) {
        out.skipped += 1;
        continue;
      }
      const message = buildMessage(req, alert);
      for (const device of devices.filter((d) => String(d.userId) === String(alert.userId))) {
        let token = '';
        try {
          token = decryptCredential(device.token);
        } catch {
          token = '';
        }
        if (!token) continue;
        let result = 'failed';
        try {
          result = await sendOne(sa, bearer, token, message);
        } catch {
          result = 'failed';
        }
        if (result === 'sent') out.sent += 1;
        else if (result === 'gone') {
          await Device.deleteOne({ _id: device._id, tenantId }).catch(() => null);
          out.removed += 1;
        } else out.failed += 1;
      }
    }
  } catch (error) {
    out.failed += 1;
    // The reason only (no tokens, no message text).
    console.warn(`[plugin:openext-crm-suite] push not sent (${(error && error.code) || 'error'})`);
  }
  return out;
}

/** POST /devices/test — a test push to my own phones; also checks the Firebase key. */
async function sendTest(req) {
  const userId = assertStaff(req);
  const sa = await readServiceAccount(req);
  if (!sa) throw appError('Push notifications are not set up yet: an admin adds the Firebase service account in Settings → Integrations.', 503, 'FCM_NOT_CONFIGURED');
  await accessToken(req, sa); // 502 FCM_AUTH_FAILED when Firebase refuses the key
  const devices = await listDevices(req);
  // 3.64.8: the right place to turn alerts on (My Alerts, every staff user) and the names of the devices.
  if (!devices.length) {
    return {
      keyOk: true,
      devices: 0,
      sent: 0,
      message: 'The Firebase key works, but no device is registered for you. Open My Alerts → Turn on in this browser (or sign in on the CRM mobile app), then send the test again.'
    };
  }
  const result = await sendAlerts(req, [{ userId, title: 'Test notification', message: 'Push notifications work on this device.', type: 'other', link: '' }]);
  const names = [...new Set(devices.map((d) => d.deviceName || (d.platform === 'web' ? 'Browser' : 'Phone')))].slice(0, 5).join(', ');
  const message = result.sent
    ? `Sent to ${result.sent} device${result.sent === 1 ? '' : 's'}: ${names}.`
    : result.removed
      ? 'Firebase no longer knows your saved device, so it was removed. Open My Alerts → Turn on in this browser again, then send the test.'
      : 'The key works, but no device accepted the message. Open My Alerts → Turn off, then Turn on, and test again.';
  return { keyOk: true, devices: devices.length, ...result, message };
}

module.exports = {
  PUSH_TYPES,
  cleanType,
  parseServiceAccount,
  parseWebConfig,
  parseVapidKey,
  getWebClientConfig,
  serviceWorkerSource,
  getIntegration,
  updateIntegration,
  registerDevice,
  unregisterDevice,
  deviceStatus,
  listDevices,
  removeDevice,
  getPreferences,
  setPreferences,
  sendAlerts,
  sendTest,
  _internal: { signedAssertion, buildMessage, hashToken, tokenCache }
};
