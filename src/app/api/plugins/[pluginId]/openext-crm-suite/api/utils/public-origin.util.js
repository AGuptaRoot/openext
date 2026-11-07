'use strict';

const fs = require('fs');
const path = require('path');

const PLUGIN_ID = 'openext-crm-suite';

function readDotEnv() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    const values = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      values[key] = val;
    }
    return values;
  } catch {
    return {};
  }
}

function getHeader(req, name) {
  const headers = req?.headers;
  if (!headers) return '';

  const lower = String(name || '').toLowerCase();
  if (typeof headers.get === 'function') {
    return String(headers.get(name) || headers.get(lower) || '').trim();
  }

  if (typeof headers === 'object') {
    return String(headers[name] || headers[lower] || '').trim();
  }

  return '';
}

function isValidOrigin(value) {
  const text = String(value || '').trim();
  if (!text || !text.includes('://') || text.endsWith('://')) return false;
  try {
    const parsed = new URL(text);
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeOrigin(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  return isValidOrigin(text) ? text : '';
}

function readConfiguredSiteUrl() {
  const dotenv = readDotEnv();
  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.SITE_URL,
    process.env.PUBLIC_SITE_URL,
    dotenv.NEXT_PUBLIC_SITE_URL,
    dotenv.SITE_URL,
    dotenv.PUBLIC_SITE_URL
  ];

  for (const candidate of candidates) {
    const origin = normalizeOrigin(candidate);
    if (origin) return origin;
  }

  return '';
}

function originFromRequestUrl(req) {
  const rawUrl = String(req?.url || req?.originalUrl || '').trim();
  if (!rawUrl) return '';

  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname) return '';
    return normalizeOrigin(`${parsed.protocol}//${parsed.host}`);
  } catch {
    return '';
  }
}

function originFromRequestHeaders(req) {
  const forwardedProto = getHeader(req, 'x-forwarded-proto').split(',')[0].trim();
  const forwardedHost = getHeader(req, 'x-forwarded-host').split(',')[0].trim();
  const host = forwardedHost || getHeader(req, 'host');

  if (!host) {
    return normalizeOrigin(getHeader(req, 'origin'));
  }

  const proto = forwardedProto || (host.includes('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return normalizeOrigin(`${proto}://${host}`);
}

/**
 * Resolve the public site origin for client-facing links (emails, portal URLs).
 *
 * OpenNext CMS plugin requests use Web Headers (headers.get), not Express req.headers.host.
 * Prefer NEXT_PUBLIC_SITE_URL so links point at the frontend when API runs on BACKEND_URL.
 */
function resolvePublicOrigin(req) {
  const configured = readConfiguredSiteUrl();
  if (configured) return configured;

  const fromUrl = originFromRequestUrl(req);
  if (fromUrl) return fromUrl;

  return originFromRequestHeaders(req);
}

/**
 * Always return an absolute client-portal login URL suitable for emails and CRM UI.
 * Never returns a relative path like "/login".
 */
function buildClientPortalLoginUrl(req) {
  const origin =
    resolvePublicOrigin(req) ||
    normalizeOrigin(process.env.APP_URL) ||
    normalizeOrigin(process.env.BASE_URL) ||
    'http://localhost:3011';
  return `${origin.replace(/\/+$/, '')}/login`;
}

function buildPluginPortalUrl(req, relativeHtmlPath, queryString) {
  const cleanPath = String(relativeHtmlPath || '').replace(/^\/+/, '');
  const qs = String(queryString || '').replace(/^\?/, '');
  const path = `/plugins/${PLUGIN_ID}/${cleanPath}${qs ? `?${qs}` : ''}`;
  const origin = resolvePublicOrigin(req) || 'http://localhost:3011';
  return `${origin.replace(/\/+$/, '')}${path}`;
}

function buildInvoicePayPortalUrl(req, payToken) {
  const token = String(payToken || '').trim();
  if (!token) return '';
  return buildPluginPortalUrl(
    req,
    'ui/portal/invoice.html',
    `token=${encodeURIComponent(token)}`
  );
}

function buildQuotationPortalUrl(req, portalToken) {
  const token = String(portalToken || '').trim();
  if (!token) return '';
  return buildPluginPortalUrl(
    req,
    'ui/portal/quotation.html',
    `token=${encodeURIComponent(token)}`
  );
}

module.exports = {
  PLUGIN_ID,
  resolvePublicOrigin,
  buildClientPortalLoginUrl,
  buildPluginPortalUrl,
  buildInvoicePayPortalUrl,
  buildQuotationPortalUrl,
  isValidOrigin
};
