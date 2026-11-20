'use strict';

/**
 * CRM 3.56.0: the client portal login link (Settings → Client portal → Login URL).
 * loadPortalLoginUrl(req) reads the setting once per request and keeps it on the request, so the
 * synchronous buildClientPortalLoginUrl(req) (emails, invite results) uses it. Empty → the server's site
 * address + /login, as before.
 */

const REQ_KEY = '__crmPortalLoginUrl';
const MAX_LEN = 300;

function badUrl() {
  const error = new Error('Login URL must be a full web address, for example https://your-site.com/login');
  error.status = 400;
  error.statusCode = 400;
  error.code = 'PORTAL_LOGIN_URL_INVALID';
  return error;
}

/** '' stays ''. Otherwise an http(s) address without credentials, query or hash; the trailing / dropped. */
function cleanPortalLoginUrl(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return '';
  if (text.length > MAX_LEN) throw badUrl();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw badUrl();
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw badUrl();
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

async function loadPortalLoginUrl(req) {
  if (!req || typeof req !== 'object') return '';
  if (typeof req[REQ_KEY] === 'string') return req[REQ_KEY];
  let url = '';
  try {
    const SettingService = require('../services/setting.service');
    const raw = await SettingService.readRawSettingValue(req, 'client_portal_login_url');
    url = cleanPortalLoginUrl(raw);
  } catch {
    url = '';
  }
  req[REQ_KEY] = url;
  return url;
}

function configuredPortalLoginUrl(req) {
  return req && typeof req[REQ_KEY] === 'string' ? req[REQ_KEY] : '';
}

module.exports = { cleanPortalLoginUrl, loadPortalLoginUrl, configuredPortalLoginUrl };
