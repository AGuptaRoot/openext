'use strict';

/**
 * Check Availability (T3): what a provider said about one requirement, recorded by hand before quoting.
 * Every check is a new row (history); the newest is the requirement's current availability.
 * "Available" does not mean booked.
 *
 * GET  /requirements/:id/availability   history newest first (by checked_at, then entry time), the
 *                                       requirement, its pricing and the dialog's settings; prices only
 *                                       for users with crm.finance.read
 * POST /requirements/:id/availability   a new check (Complete requirements only); optional evidence file
 * PUT  /availability/:id                correct a check: its author, within 15 minutes of entering it
 * GET  /availability/:id/evidence       the evidence file (audited)
 * GET  /providers?service_key=&q=       providers named in earlier checks (≤ 20, for the datalist)
 *
 * Evidence: images are shrunk in the browser; PDFs over 700 KB are refused (the CRM caps request
 * bodies at 1 MB). Stored as a private file (recordType "availability", recordId = requirement id).
 * Audits never carry prices.
 */

const { readServices } = require('../services/catalog.js');
const { refreshStatuses } = require('../services/requirement-status.js');
const { cleanCheck, summarize, priceKeys, DEFAULT_TZ } = require('../services/availability.js');
const { cleanTimeZone } = require('../services/traveller-rules.js');
const store = require('../services/requirement-store.js');

const { ID_RE, REC_RE, str } = store;
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const PDF_MAX = 700 * 1024;
const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

const canSeePrices = (sdk) => Boolean(sdk.permissions && typeof sdk.permissions.has === 'function' && sdk.permissions.has('crm.finance.read'));
const canWrite = (sdk) => Boolean(sdk.permissions && typeof sdk.permissions.has === 'function' && sdk.permissions.has('crm.leads.write'));
const userOf = (req, sdk) => (req && req.user) || (sdk && sdk.user) || {};

async function timeZoneOf(sdk) {
  try {
    return cleanTimeZone(await sdk.settings.get('timezone'));
  } catch {
    return DEFAULT_TZ;
  }
}

/** The requirement (not removed) and its lead (must exist and be readable). */
async function loadRequirement(sdk, rawId) {
  const id = str(rawId);
  const row = REC_RE.test(id) ? await sdk.models.TravelRequirement.findById(id) : null;
  if (!row || row.removed === true) throw sdk.error(404, 'Requirement not found', 'NOT_FOUND');
  const lead = ID_RE.test(str(row.lead_id)) ? await sdk.crm.leads.findById(str(row.lead_id)) : null;
  if (!lead) throw sdk.error(404, 'Lead not found', 'NOT_FOUND');
  return row;
}

function editable(check, req, sdk, now = Date.now()) {
  const at = Date.parse(str(check.createdAt));
  const me = str(userOf(req, sdk).id);
  return Boolean(me && str(check.checked_by) === me && Number.isFinite(at) && now - at <= EDIT_WINDOW_MS);
}

/** One check for the dialog's history. */
function present(check, req, sdk, now = new Date()) {
  return {
    ...summarize(check, now, { withPrices: canSeePrices(sdk) }),
    channel: str(check.channel),
    contact_person: str(check.contact_person),
    notes: str(check.notes),
    evidence_name: str(check.evidence_name),
    checked_by: str(check.checked_by),
    checked_by_name: str(check.checked_by_name),
    created_at: str(check.createdAt),
    editable: canWrite(sdk) && editable(check, req, sdk, now.getTime())
  };
}

async function serviceFor(sdk, row) {
  const services = await readServices(sdk);
  const service = services.find((s) => s.key === str(row.service_key)) || null;
  return { services, service };
}

/** { data, name, mimeType } of an evidence upload, or null; 400 / 413 when unusable. */
function cleanEvidence(sdk, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const src = typeof raw === 'string' ? { data: raw } : raw && typeof raw === 'object' ? raw : {};
  const data = typeof src.data === 'string' ? src.data : '';
  const m = data.match(/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) throw sdk.error(400, 'Evidence must be a PDF, JPG, PNG or WEBP file', 'INVALID_FILE');
  let mimeType = m[1].toLowerCase();
  if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
  if (!FILE_TYPES.includes(mimeType)) throw sdk.error(400, 'Evidence must be a PDF, JPG, PNG or WEBP file', 'INVALID_FILE_TYPE');
  const bytes = Math.floor((m[2].replace(/\s+/g, '').length * 3) / 4);
  if (mimeType === 'application/pdf' && bytes > PDF_MAX) {
    throw sdk.error(413, 'The PDF is larger than 700 KB — attach a smaller PDF or a photo of it', 'FILE_TOO_LARGE');
  }
  return { data, name: str(src.name).replace(/[^\w .()-]/g, '').slice(0, 120) || 'evidence', mimeType };
}

/* ------------------------------------------------------------------ routes */

exports.list = async (req, sdk) => {
  const row = await loadRequirement(sdk, req.params && req.params.id);
  const [{ services, service }, days, timeZone] = await Promise.all([serviceFor(sdk, row), sdk.settings.get('availability_default_validity_days'), timeZoneOf(sdk)]);
  await refreshStatuses(sdk, [row], services);
  const checks = store.sortChecks(await store.checksFor(sdk, [row._id]));
  const now = new Date();
  const n = Number(days);
  return {
    requirement: {
      id: str(row._id),
      lead_id: str(row.lead_id),
      service_key: str(row.service_key),
      service_name: (service && service.name) || str(row.service_name) || str(row.service_key),
      label: str(row.label) || (service && service.name) || str(row.service_name),
      status: str(row.status) || 'Draft',
      values: row.values && typeof row.values === 'object' ? row.values : {},
      fields: service ? (service.fields || []).filter((f) => f.enabled !== false).map((f) => ({ key: f.key, label: f.label, type: f.type })) : []
    },
    pricing: (service && service.pricing) || 'per_unit',
    priceKeys: priceKeys(service && service.pricing),
    checks: checks.map((c) => present(c, req, sdk, now)),
    latest: checks.length ? summarize(checks[0], now, { withPrices: canSeePrices(sdk) }) : null,
    settings: { validityDays: Number.isInteger(n) && n >= 1 && n <= 30 ? n : 3, timezone: timeZone },
    can: { write: canWrite(sdk), prices: canSeePrices(sdk) }
  };
};

exports.create = async (req, sdk) => {
  const row = await loadRequirement(sdk, req.params && req.params.id);
  await require('../services/lead-access.js').assertLeadOpen(sdk, row.lead_id);
  const { services, service } = await serviceFor(sdk, row);
  await refreshStatuses(sdk, [row], services);
  if (row.status !== 'Complete') throw sdk.error(400, 'Complete the requirement first', 'REQUIREMENT_NOT_COMPLETE');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const clean = cleanCheck(body, { pricing: service && service.pricing, timeZone: await timeZoneOf(sdk) });
  const evidence = cleanEvidence(sdk, body.evidence);
  const user = userOf(req, sdk);
  let file = null;
  if (evidence) file = await sdk.files.save({ data: evidence.data, name: evidence.name, mimeType: evidence.mimeType, recordType: 'availability', recordId: str(row._id) });
  let check;
  try {
    check = await sdk.models.AvailabilityCheck.create({
      ...clean,
      lead_id: str(row.lead_id),
      requirement_id: str(row._id),
      service_key: str(row.service_key),
      evidence_file_id: file ? str(file.id) : '',
      evidence_name: file ? str(file.name || evidence.name) : '',
      checked_by: str(user.id),
      checked_by_name: str(user.name) || str(user.email)
    });
  } catch (error) {
    if (file) await sdk.files.remove(file.id).catch(() => {});
    throw error;
  }
  const label = str(row.label) || (service && service.name) || str(row.service_key);
  await sdk.audit('created', `Availability checked for "${label}" (lead ${str(row.lead_id)}): ${clean.status} from ${clean.provider}`, {
    event: 'availability.checked',
    leadId: str(row.lead_id),
    requirementId: str(row._id),
    checkId: str(check._id),
    serviceKey: str(row.service_key),
    status: clean.status,
    provider: clean.provider,
    validUntil: clean.valid_until,
    evidence: Boolean(file)
  });
  return { check: present(check, req, sdk), availability: summarize(check, new Date(), { withPrices: canSeePrices(sdk) }) };
};

exports.update = async (req, sdk) => {
  const id = str(req.params && req.params.id);
  const check = REC_RE.test(id) ? await sdk.models.AvailabilityCheck.findById(id) : null;
  if (!check) throw sdk.error(404, 'Availability check not found', 'NOT_FOUND');
  const row = await loadRequirement(sdk, check.requirement_id);
  await require('../services/lead-access.js').assertLeadOpen(sdk, row.lead_id);
  if (!editable(check, req, sdk)) {
    throw sdk.error(409, 'This check can no longer be changed (only by its author, within 15 minutes) — add a new check instead', 'CHECK_LOCKED');
  }
  const { service } = await serviceFor(sdk, row);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // checked_at must stay sensible against "now"; a correction keeps the original moment unless sent.
  const clean = cleanCheck({ ...body, checked_at: body.checked_at || check.checked_at }, { pricing: service && service.pricing, timeZone: await timeZoneOf(sdk) });
  const evidence = cleanEvidence(sdk, body.evidence);
  const patch = { ...clean };
  // Prices stay as stored unless a user who may see them (crm.finance.read) sends new ones: a
  // correction by someone without finance access (no price inputs) never wipes them.
  const sentPrices = body.prices && typeof body.prices === 'object' && Object.keys(body.prices).length > 0;
  if (!canSeePrices(sdk) || !sentPrices) {
    patch.prices = check.prices && typeof check.prices === 'object' ? check.prices : {};
    patch.currency = str(check.currency) || clean.currency;
  }
  let file = null;
  if (evidence) {
    file = await sdk.files.save({ data: evidence.data, name: evidence.name, mimeType: evidence.mimeType, recordType: 'availability', recordId: str(row._id) });
    patch.evidence_file_id = str(file.id);
    patch.evidence_name = str(file.name || evidence.name);
  }
  const updated = await sdk.models.AvailabilityCheck.updateById(check._id, patch);
  if (file && str(check.evidence_file_id)) await sdk.files.remove(str(check.evidence_file_id)).catch(() => {});
  await sdk.audit('updated', `Availability check corrected for "${str(row.label) || str(row.service_key)}" (lead ${str(row.lead_id)}): ${clean.status} from ${clean.provider}`, {
    event: 'availability.corrected',
    leadId: str(row.lead_id),
    requirementId: str(row._id),
    checkId: str(check._id),
    status: clean.status,
    provider: clean.provider
  });
  return { check: present(updated || { ...check, ...patch }, req, sdk), availability: summarize(updated || { ...check, ...patch }, new Date(), { withPrices: canSeePrices(sdk) }) };
};

exports.evidence = async (req, sdk) => {
  const id = str(req.params && req.params.id);
  const check = REC_RE.test(id) ? await sdk.models.AvailabilityCheck.findById(id) : null;
  if (!check || !str(check.evidence_file_id)) throw sdk.error(404, 'No evidence file for this check', 'NOT_FOUND');
  const row = await loadRequirement(sdk, check.requirement_id);
  const file = await sdk.files.read(str(check.evidence_file_id));
  if (!file || str(file.recordType) !== 'availability' || str(file.recordId) !== str(row._id)) {
    throw sdk.error(404, 'No evidence file for this check', 'NOT_FOUND');
  }
  await sdk.audit('viewed', `Availability evidence opened (lead ${str(row.lead_id)})`, { leadId: str(row.lead_id), requirementId: str(row._id), checkId: str(check._id) });
  return { dataUrl: file.dataUrl, name: file.name, mimeType: file.mimeType, size: file.size };
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.providers = async (req, sdk) => {
  const query = (req && req.query) || {};
  const serviceKey = str(query.service_key).slice(0, 63);
  const q = str(query.q).slice(0, 60);
  const filter = {};
  if (serviceKey) filter.service_key = serviceKey;
  if (q) filter.provider = { $regex: escapeRegex(q), $options: 'i' };
  const rows = await sdk.models.AvailabilityCheck.find(filter, { limit: 500, sort: { createdAt: -1 } });
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const name = str(r.provider);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length >= 20) break;
  }
  return { providers: out };
};
