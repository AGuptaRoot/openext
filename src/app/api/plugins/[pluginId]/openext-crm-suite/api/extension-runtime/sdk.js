'use strict';

/**
 * The extension SDK: the only object an extension's backend code receives
 * (`handler(req, sdk)` and `index.register(sdk)`).
 *
 *   sdk.extension          { id, version }
 *   sdk.user               { id, name, email }
 *   sdk.permissions.has(key)
 *   sdk.models.<Name>      tenant-locked repository (find, findOne, findById, count, create, updateById, deleteById)
 *   sdk.settings           getAll(), get(key), set(patch)  → the extension's own settings
 *   sdk.crm.<records>      read-only, tenant-scoped, permission-checked: leads, clients, contacts, opportunities, tickets
 *   sdk.values.get(recordType, id)  this extension's declared field values on a core record
 *   sdk.values.set(recordType, id, patch)  save them (CRM 3.34.0; the CRM's checks and permissions apply)
 *   sdk.crm.leads.createForClient(clientId, { title })  a new enquiry for a client (CRM 3.34.0, crm.leads.write)
 *   sdk.crm.leads.hasQuotation(leadId)  true when the lead (or one of its opportunities) has any quotation
 *                                      (CRM 3.47.0; a lead this user can see; yes / no only)
 *   sdk.crm.opportunities.createForLead(leadId, { title, clientId })  the lead's open opportunity or a new one (3.34.0;
 *                                                     clientId 3.44.0: the client the deal is for)
 *   sdk.access.leadIds()   leads this user may see (null = all) — for the extension's own lead-keyed records
 *   sdk.access.portal()    the client-portal login (kind, clientId, leadIds), or null for staff
 *   sdk.finance.quotationPayment(id)  paid / balance / Unpaid|Partially Paid|Paid from verified payments
 *   sdk.audit(action, description, metadata)
 *   sdk.notify({ userIds, title, message, link, linkLabel, key })  in-app alert to CRM users of this tenant,
 *                          once per user and key (CRM 3.33.0); link: /ext/<id>/… or a core record page
 *   sdk.logger             info / warn / error
 *   sdk.http.request(url, options)   HTTPS to network.allowedHosts only
 *   sdk.error(status, message, code) build an error the runtime maps to a response
 *   sdk.crypto             encrypt(text) / decrypt(text) / hash(text) — CRM-held key, bound to tenant + extension
 *   sdk.files              save / info / read / remove private encrypted files   (capability "files.private")
 *   sdk.ai.readImage       read an image with the CRM's OCR vision model → JSON  (capability "ai.vision")
 *   sdk.workflow.leadLocked(leadId) whether a Won / converted lead is read-only (salesFlow.lockWonLead)
 *   sdk.workflow.leadReady(leadId)  tell the CRM a lead meets the extension's rules; the CRM applies
 *                          its lead workflow settings (e.g. move to Qualified) → { stageChanged, stage }
 *   sdk.workflow.opportunityStage(opportunityId, stageId, reason?)  move a deal forward to one of the
 *                          extension's own open pipeline stages → { moved, stage }
 *
 * Every value crossing into the CRM is cloned as JSON and every query is
 * sanitised (values.js). Tenant and extension scope are injected by the SDK
 * and cannot be overridden by the caller.
 */

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { requestHasPermission } = require('../utils/extension-permission.util');
const { createRepository } = require('./models');
const {
  OBJECT_ID_RE,
  runtimeError,
  cloneJson,
  sanitizeFilter,
  sanitizeSort,
  clampLimit,
  clampSkip
} = require('./values');

const AUDIT_ACTIONS = new Set(['created', 'updated', 'deleted', 'viewed', 'exported', 'sent', 'approved', 'rejected']);
const HTTP_TIMEOUT_MS = 10000;
const HTTP_MAX_BYTES = 2 * 1024 * 1024;

/** Core records an extension may read, with the permission each one needs. */
const CORE_READ = {
  leads: { model: 'Lead', permission: 'crm.leads.read' },
  clients: { model: 'Company', permission: 'crm.clients.read' },
  // The Contacts module (people; a contact lists the leads it belongs to in leadIds).
  contacts: { model: 'PersonContact', permission: 'crm.contacts.read' },
  opportunities: { model: 'Opportunity', permission: 'crm.opportunities.read' },
  tickets: { model: 'Ticket', permission: 'crm.tickets.read' },
  // Quotations (read-only): never the portal token or the internal notes.
  quotations: { model: 'Estimate', permission: 'crm.finance.read', hidden: ['portalToken', 'notes'] },
  // Invoices (read-only, CRM 3.28.0): never the portal token or the internal notes.
  invoices: { model: 'Invoice', permission: 'crm.finance.read', hidden: ['portalToken', 'notes'] }
};
/** Record types for sdk.values, mapped to their sdk.crm reader. */
const RECORD_READ = { lead: 'leads', client: 'clients', opportunity: 'opportunities', ticket: 'tickets', quotation: 'quotations' };
const CORE_FIELD_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+){0,4}$/;
const CORE_HIDDEN_FIELDS = ['tenantId', '__v'];

function makeLogger(cms, extensionId) {
  const base = cms?.logger || console;
  const tag = `[crm-ext:${extensionId}]`;
  const clip = (args) => args.map((a) => (typeof a === 'string' ? a.slice(0, 2000) : a));
  return Object.freeze({
    info: (...args) => (base.info || base.log).call(base, tag, ...clip(args)),
    warn: (...args) => (base.warn || base.log).call(base, tag, ...clip(args)),
    error: (...args) => (base.error || base.log).call(base, tag, ...clip(args))
  });
}

/**
 * Record access the CRM screens apply, for the records an extension reads:
 *   leads          a sales agent sees the leads assigned to (or created by) them
 *   opportunities  a sales agent sees their deals and the deals on their leads
 *   quotations     a sales rep sees the quotations they created (finance managers see all)
 * `listScope` narrows find / count; `canSee` checks one record (null → hidden, like a 404).
 */
function recordAccess(req, key) {
  const access = require('../utils/sales-access.util');
  const getLeadModel = (r) => r.cms?.models?.get?.('Lead');
  if (key === 'leads' && access.isSalesAgentScoped(req)) {
    return {
      listScope: async () => access.salesAgentLeadScope(req),
      canSee: async (doc) => access.userOwnsLead(req, doc)
    };
  }
  if (key === 'opportunities' && access.isSalesAgentScoped(req)) {
    return {
      listScope: async () => access.buildSalesAgentOpportunityListScope(req, getLeadModel),
      canSee: async (doc) => {
        try {
          await access.assertSalesAgentOpportunityAccessAsync(req, doc, getLeadModel);
          return true;
        } catch {
          return false;
        }
      }
    };
  }
  if (key === 'quotations' && access.isFinanceCreatorScoped(req)) {
    const userId = resolveUserId(req);
    return {
      listScope: async () => ({ createdBy: userId }),
      canSee: async (doc) => String(doc?.createdBy || '') === userId
    };
  }
  return null;
}

function coreReader(req, key, tenantId) {
  const spec = CORE_READ[key];
  const ensure = () => {
    if (!requestHasPermission(req, spec.permission)) {
      throw runtimeError(403, `Reading ${key} needs ${spec.permission}`, 'FORBIDDEN');
    }
    const Model = req.cms?.models?.get?.(spec.model);
    if (!Model) throw runtimeError(500, `${spec.model} model is not available`, 'MODEL_UNAVAILABLE');
    return Model;
  };
  const scope = { tenantId, isDeleted: { $ne: true } };
  // Hidden fields are never returned, and can't be filtered or sorted on (no guessing them by query).
  const hidden = spec.hidden || [];
  const visible = (f) => CORE_FIELD_RE.test(f) && f !== 'tenantId' && !hidden.some((h) => f === h || f.startsWith(`${h}.`));
  const clean = (doc) => {
    if (!doc) return null;
    const copy = cloneJson(doc, 512 * 1024, key);
    for (const hidden of CORE_HIDDEN_FIELDS) delete copy[hidden];
    for (const hidden of spec.hidden || []) delete copy[hidden];
    return copy;
  };
  const lean = async (q) => (q && typeof q.lean === 'function' ? q.lean() : q);
  const access = recordAccess(req, key);
  const { mergeScopeIntoFilter } = require('../utils/sales-access.util');
  const scoped = async (where) => (access ? mergeScopeIntoFilter({ ...where, ...scope }, await access.listScope()) : { ...where, ...scope });
  const seen = async (doc) => (doc && (!access || (await access.canSee(doc))) ? doc : null);
  return Object.freeze({
    async findById(id) {
      const Model = ensure();
      if (!OBJECT_ID_RE.test(String(id || ''))) return null;
      return clean(await seen(await lean(Model.findOne({ _id: String(id), ...scope }))));
    },
    async find(filter = {}, options = {}) {
      const Model = ensure();
      const where = sanitizeFilter(filter, visible);
      let q = Model.find(await scoped(where));
      const sort = sanitizeSort(options.sort, visible);
      if (sort && typeof q.sort === 'function') q = q.sort(sort);
      if (typeof q.skip === 'function') q = q.skip(clampSkip(options.skip));
      if (typeof q.limit === 'function') q = q.limit(clampLimit(options.limit, 50, 100));
      return ((await lean(q)) || []).map(clean);
    },
    async count(filter = {}) {
      const Model = ensure();
      const where = sanitizeFilter(filter, visible);
      return Model.countDocuments(await scoped(where));
    },
    /** Up to 100 records by id in one query (ids that are not valid ObjectIds are skipped). */
    async findByIds(ids) {
      const Model = ensure();
      const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => OBJECT_ID_RE.test(id)))];
      if (list.length > 100) throw runtimeError(400, `${key}.findByIds: at most 100 ids at a time`, 'TOO_MANY_RECORDS');
      if (!list.length) return [];
      const rows = (await lean(Model.find({ _id: { $in: list }, ...scope }))) || [];
      const kept = [];
      for (const row of rows) if (await seen(row)) kept.push(row);
      return kept.map(clean);
    }
  });
}

/**
 * sdk.finance.quotationPayment(quotationId): how much of a quotation is paid, from the CRM's verified
 * payment records — { total, paid, balance, currency, status: 'Unpaid'|'Partially Paid'|'Paid',
 * invoiceId, invoiceStatus, stage, isAdvanceFlow, advanceRequired, advancePaid, advanceSatisfied, fullyPaid,
 * bookingRule: 'advance'|'full', bookingEligible, bookingReason } — or null when the quotation is not in this workspace or not the portal
 * login's own. Read-only.
 */
function makeFinance(req, tenantId) {
  return Object.freeze({
    /**
     * CRM 3.29.0 — money of a set of quotations for reports (needs crm.finance.read): verified payments
     * only, an advance moved onto the tax invoice counted once, invoiced / outstanding from tax invoices.
     * { quotationIds (≤ 5000), from?, to? (ISO days), bucket?: 'day'|'week'|'month' }
     * → { totals: { invoiced, received, advanceReceived, outstanding, invoiceCount, outstandingCount },
     *     quotations: { <id>: { total, paid, advancePaid, status, stage, paymentGroup, invoiceId, invoiceStatus,
     *     invoiceTotal, invoiceBalance, overdue, currency } }, series: [{ bucket, invoiced, received, outstanding }], bucket }
     */
    async summary(options = {}) {
      if (req.crmSystemHook !== true && !requestHasPermission(req, 'crm.finance.read')) {
        throw runtimeError(403, 'finance.summary needs crm.finance.read', 'FORBIDDEN');
      }
      const src = options && typeof options === 'object' ? options : {};
      const out = await require('../services/report-finance.service').summarize(req, {
        quotationIds: Array.isArray(src.quotationIds) ? src.quotationIds.slice(0, 5000) : [],
        from: src.from,
        to: src.to,
        bucket: src.bucket
      });
      return cloneJson(out, 8 * 1024 * 1024, 'finance.summary');
    },
    async quotationPayment(quotationId) {
      const id = String(quotationId || '');
      if (!OBJECT_ID_RE.test(id)) return null;
      const Estimate = req.cms?.models?.get?.('Estimate');
      if (!Estimate) return null;
      const q = Estimate.findOne({ tenantId, _id: id, isDeleted: { $ne: true } });
      const quotation = q && typeof q.lean === 'function' ? await q.lean() : await q;
      if (!quotation) return null;
      if (req.crmSystemHook !== true) {
        const { resolvePortalIdentity, portalOwnsRecord } = require('../utils/portal-identity.util');
        const identity = await resolvePortalIdentity(req);
        if (identity && identity.kind !== 'staff' && !portalOwnsRecord(identity, quotation)) return null;
      }
      const Proforma = require('../services/proforma.service');
      let settings = {};
      try {
        settings = await require('../services/setting.service').getAll(req);
      } catch {
        settings = {};
      }
      const state = await Proforma.quotationPaymentState(req, quotation, { settings });
      const booking = Proforma.bookingEligibility(state, settings);
      return Object.freeze({
        total: state.total,
        paid: state.paid,
        balance: state.balance,
        currency: state.currency,
        status: state.status,
        invoiceId: state.invoiceId,
        invoiceStatus: state.invoiceStatus,
        invoiceNo: state.invoiceNo || '',
        // CRM 3.28.0: the advance and the central booking rule (Settings → General).
        stage: state.stage,
        isAdvanceFlow: state.isAdvanceFlow,
        advanceRequired: state.advanceRequired,
        advancePaid: state.advancePaid,
        advanceSatisfied: state.advanceSatisfied,
        fullyPaid: booking.fullyPaid,
        bookingRule: booking.rule,
        bookingEligible: booking.eligible,
        bookingReason: booking.reason
      });
    }
  });
}

/**
 * sdk.access.leadIds(): the leads this user may see, for an extension's own records keyed by lead
 * (bookings, travellers). null = every lead in the workspace; otherwise up to 500 ids (newest first).
 */
function makeAccess(req, tenantId) {
  const portalIdentity = async () => {
    const { resolvePortalIdentity } = require('../utils/portal-identity.util');
    const identity = await resolvePortalIdentity(req);
    return identity && identity.kind !== 'staff' ? identity : null;
  };
  return Object.freeze({
    /**
     * The client-portal login behind this request, or null for staff (and CRM hooks):
     * { kind: 'client', clientId, leadIds } | { kind: 'lead', leadIds } | { kind: 'none', leadIds: [] }.
     */
    async portal() {
      if (req.crmSystemHook === true) return null;
      const identity = await portalIdentity();
      if (!identity) return null;
      return Object.freeze({
        kind: identity.kind,
        clientId: identity.clientId ? String(identity.clientId) : null,
        leadIds: Object.freeze((identity.leadIds || []).map(String))
      });
    },
    async leadIds() {
      const access = require('../utils/sales-access.util');
      // A client-portal login sees only its own leads — never "all".
      if (req.crmSystemHook !== true) {
        const identity = await portalIdentity();
        if (identity) return (identity.leadIds || []).map(String).slice(0, 500);
      }
      if (!access.isSalesAgentScoped(req)) return null;
      const Lead = req.cms?.models?.get?.('Lead');
      if (!Lead) return [];
      let q = Lead.find(access.mergeScopeIntoFilter({ tenantId, isDeleted: { $ne: true } }, access.salesAgentLeadScope(req)));
      if (q && typeof q.select === 'function') q = q.select('_id');
      if (q && typeof q.sort === 'function') q = q.sort({ createdAt: -1 });
      if (q && typeof q.limit === 'function') q = q.limit(500);
      const rows = (q && typeof q.lean === 'function' ? await q.lean() : await q) || [];
      return rows.map((row) => String(row._id));
    }
  });
}

function makeHttp(def) {
  const allowed = new Set(((def.network && def.network.allowedHosts) || []).map((h) => String(h).toLowerCase()));
  return Object.freeze({
    async request(url, options = {}) {
      let target;
      try {
        target = new URL(String(url));
      } catch {
        throw runtimeError(400, 'sdk.http: invalid URL', 'HTTP_INVALID_URL');
      }
      if (target.protocol !== 'https:') throw runtimeError(400, 'sdk.http: only https URLs are allowed', 'HTTP_BLOCKED');
      if (!allowed.has(target.hostname.toLowerCase())) {
        throw runtimeError(403, `sdk.http: ${target.hostname} is not in network.allowedHosts`, 'HTTP_BLOCKED');
      }
      if (target.username || target.password || (target.port && target.port !== '443')) {
        throw runtimeError(400, 'sdk.http: credentials or non-standard ports are not allowed in URLs', 'HTTP_BLOCKED');
      }
      const method = String(options.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw runtimeError(400, 'sdk.http: method not allowed', 'HTTP_BLOCKED');
      const headers = {};
      for (const [k, v] of Object.entries(cloneJson(options.headers || {}, 16 * 1024, 'headers') || {})) {
        if (!/^(host|cookie|connection|content-length|transfer-encoding)$/i.test(k)) headers[k] = String(v);
      }
      let body;
      if (options.body !== undefined) {
        body = typeof options.body === 'string' ? options.body : JSON.stringify(cloneJson(options.body, 512 * 1024, 'body'));
        if (typeof options.body !== 'string' && !Object.keys(headers).some((h) => /^content-type$/i.test(h))) {
          headers['content-type'] = 'application/json';
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(Number(options.timeoutMs) || HTTP_TIMEOUT_MS, HTTP_TIMEOUT_MS));
      try {
        const response = await fetch(target, { method, headers, body, redirect: 'error', signal: controller.signal });
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > HTTP_MAX_BYTES) throw runtimeError(502, 'sdk.http: response is larger than 2 MB', 'HTTP_TOO_LARGE');
        const contentType = response.headers.get('content-type') || '';
        const text = buffer.toString('utf8');
        let data = text;
        if (/json/i.test(contentType)) {
          try { data = JSON.parse(text); } catch { data = text; }
        }
        return { status: response.status, ok: response.ok, contentType, data };
      } catch (error) {
        if (error && error.isRuntimeError) throw error;
        throw runtimeError(502, `sdk.http: ${error && error.name === 'AbortError' ? 'request timed out' : (error && error.message) || 'request failed'}`, 'HTTP_FAILED');
      } finally {
        clearTimeout(timer);
      }
    }
  });
}

/**
 * @param {object} req  CRM request (tenant and permissions resolved)
 * @param {object} def  active extension definition (uploaded, manifestVersion 2)
 */
function createSdk(req, def) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req) || 'system';
  const logger = makeLogger(req.cms, def.id);

  const models = {};
  for (const modelDef of (def.backend && def.backend.models) || []) {
    models[modelDef.name] = createRepository(req, def.id, modelDef, { tenantId, userId });
  }

  const getAllSettings = async () => {
    const SettingsService = require('../services/crm-extension-settings.service');
    return SettingsService.getValues(req, def);
  };
  const settings = Object.freeze({
    async getAll() {
      const SettingsService = require('../services/crm-extension-settings.service');
      return SettingsService.getValues(req, def);
    },
    async get(key) {
      const all = await getAllSettings();
      return all[String(key)];
    },
    async set(patch) {
      const SettingsService = require('../services/crm-extension-settings.service');
      return SettingsService.setValues(req, def, cloneJson(patch, 64 * 1024, 'settings'));
    }
  });

  const crm = {};
  for (const key of Object.keys(CORE_READ)) crm[key] = coreReader(req, key, tenantId);
  // CRM 3.34.0: the few core records an extension may create for the user (CRM services and rules apply).
  const needWrite = (key, what) => {
    if (!requestHasPermission(req, key)) throw runtimeError(403, `${what} needs the ${key} permission`, 'FORBIDDEN');
  };
  crm.leads = Object.freeze({
    ...crm.leads,
    /** A new enquiry (lead) for an existing client → { id, title, stage }. */
    async createForClient(clientId, input = {}) {
      needWrite('crm.leads.write', 'crm.leads.createForClient');
      const clean = cloneJson(input || {}, 8 * 1024, 'lead') || {};
      return cloneJson(await require('../services/extension-records.service').createLeadForClient(req, String(clientId || ''), clean), 16 * 1024, 'lead');
    },
    /** CRM 3.47.0: true when the lead, or one of its opportunities, has any quotation (yes / no only). */
    async hasQuotation(leadId) {
      const lead = await crm.leads.findById(String(leadId || ''));
      if (!lead) return false;
      return Boolean(await require('../services/extension-records.service').leadHasQuotation(req, String(lead._id || lead.id || leadId)));
    }
  });
  crm.opportunities = Object.freeze({
    ...crm.opportunities,
    /** The lead's open opportunity, or a new one from the extension's opportunity prefill → { id, title, created }. */
    async createForLead(leadId, input = {}) {
      needWrite('crm.opportunities.write', 'crm.opportunities.createForLead');
      const clean = cloneJson(input || {}, 8 * 1024, 'opportunity') || {};
      return cloneJson(await require('../services/extension-records.service').createOpportunityForLead(req, String(leadId || ''), clean), 16 * 1024, 'opportunity');
    }
  });

  // Declared field values this extension keeps for a core record (its own table).
  // The record is read through sdk.crm first, so its permission and tenant checks apply.
  const values = Object.freeze({
    async get(recordType, recordId) {
      const key = RECORD_READ[String(recordType || '')];
      if (!key) throw runtimeError(400, `values.get: unknown record type "${recordType}"`, 'INVALID_RECORD_TYPE');
      const doc = await crm[key].findById(recordId);
      if (!doc) return {};
      const RecordValues = require('./record-values');
      return cloneJson(await RecordValues.read(req, def.id, String(recordType), doc), 512 * 1024, 'values') || {};
    },
    /**
     * CRM 3.34.0: save this extension's declared values on a record the user may change, with the CRM's
     * checks (types, options, date rules, the extension's own values check) → the record's values.
     */
    async set(recordType, recordId, patch) {
      const type = String(recordType || '');
      if (!RECORD_READ[type]) throw runtimeError(400, `values.set: unknown record type "${recordType}"`, 'INVALID_RECORD_TYPE');
      const clean = cloneJson(patch || {}, 256 * 1024, 'values') || {};
      const Values = require('../services/crm-extension-values.service');
      const res = await Values.setValues(req, type, String(recordId || ''), clean);
      return cloneJson((res && res.values) || {}, 512 * 1024, 'values') || {};
    },
    /** Values of up to 100 records of one type in two queries: { <id>: values } (unknown / unreadable ids left out). */
    async getMany(recordType, recordIds) {
      const key = RECORD_READ[String(recordType || '')];
      if (!key) throw runtimeError(400, `values.getMany: unknown record type "${recordType}"`, 'INVALID_RECORD_TYPE');
      const ids = [...new Set((Array.isArray(recordIds) ? recordIds : []).map(String).filter((id) => OBJECT_ID_RE.test(id)))];
      if (ids.length > 100) throw runtimeError(400, 'values.getMany: at most 100 records at a time', 'TOO_MANY_RECORDS');
      if (!ids.length) return {};
      const docs = await crm[key].findByIds(ids);
      const RecordValues = require('./record-values');
      const map = await RecordValues.readMany(req, def.id, String(recordType), docs);
      const out = {};
      for (const [id, v] of map) out[id] = v;
      return cloneJson(out, 4 * 1024 * 1024, 'values') || {};
    }
  });

  // Optional services, only for packages that declare them in capabilities.
  const capabilities = new Set(Array.isArray(def.capabilities) ? def.capabilities : []);
  const needs = (capability, name) => () => {
    throw runtimeError(403, `${name} needs the "${capability}" capability in crm-extension.json`, 'CAPABILITY_REQUIRED');
  };
  const files = capabilities.has('files.private')
    ? require('./private-files').createFilesApi(req, def, { tenantId, userId })
    : Object.freeze({ save: needs('files.private', 'sdk.files'), info: needs('files.private', 'sdk.files'), read: needs('files.private', 'sdk.files'), remove: needs('files.private', 'sdk.files') });
  const ai = capabilities.has('ai.vision')
    ? require('./ai-vision').createAiApi(req)
    : Object.freeze({ readImage: needs('ai.vision', 'sdk.ai') });
  const documents = capabilities.has('documents.pdf')
    ? require('./documents').createDocumentsApi(req, def, { tenantId, userId })
    : Object.freeze({ pdf: needs('documents.pdf', 'sdk.documents') });
  // Gap-free numbers per tenant and extension (e.g. booking numbers), on the CRM's atomic counters.
  const sequence = Object.freeze({
    async next(name) {
      const key = String(name || '');
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw runtimeError(400, 'sequence.next: name must be lowercase letters, digits or _', 'INVALID_SEQUENCE');
      const SettingService = require('../services/setting.service');
      return SettingService.incrementCounter(req, `x_${String(def.id).replace(/[^a-z0-9_]/gi, '_')}__seq_${key}`);
    }
  });

  const user = req.user || {};
  return Object.freeze({
    extension: Object.freeze({ id: def.id, version: def.version }),
    tenantId,
    user: Object.freeze({
      id: userId,
      name: String(user.name || user.username || ''),
      email: String(user.email || '')
    }),
    permissions: Object.freeze({ has: (key) => requestHasPermission(req, String(key || ''), def) }),
    models: Object.freeze(models),
    settings,
    crm: Object.freeze(crm),
    access: makeAccess(req, tenantId),
    finance: makeFinance(req, tenantId),
    values,
    logger,
    http: makeHttp(def),
    crypto: require('./data-protection').createCryptoApi(tenantId, def.id),
    workflow: Object.freeze({
      /** CRM 3.34.0: true when the lead is Won / converted and the active extension locks such leads. */
      async leadLocked(leadId) {
        const id = String(leadId || '');
        if (!OBJECT_ID_RE.test(id)) return false;
        return require('../utils/lead-lock.util').isLocked(req, id);
      },
      async leadReady(leadId) {
        const id = String(leadId || '');
        if (!OBJECT_ID_RE.test(id)) throw runtimeError(400, 'workflow.leadReady: a lead id is required', 'INVALID_LEAD');
        if (!requestHasPermission(req, 'crm.leads.write')) return { stageChanged: false, stage: '' };
        return require('../services/lead-workflow.service').leadReady(req, id);
      },
      /**
       * CRM 3.28.0: move a deal of this extension's pipeline forward to one of its open stages
       * (pipelineStages id). Never backwards, never Won / Lost, never after an accepted quotation.
       */
      async opportunityStage(opportunityId, stageId, reason) {
        const id = String(opportunityId || '');
        if (!OBJECT_ID_RE.test(id)) throw runtimeError(400, 'workflow.opportunityStage: an opportunity id is required', 'INVALID_OPPORTUNITY');
        if (!/^[a-z][a-z0-9_-]{0,59}$/i.test(String(stageId || ''))) {
          throw runtimeError(400, 'workflow.opportunityStage: a stage id is required', 'INVALID_STAGE');
        }
        return require('../services/opportunity.service').advanceToExtensionStage(req, id, {
          extensionId: def.id,
          stageId: String(stageId),
          reason: typeof reason === 'string' ? reason : ''
        });
      }
    }),
    files,
    ai,
    documents,
    sequence,
    /** CRM 3.33.0: an in-app notification (the bell) for users of this tenant; a repeat of `key` is skipped. */
    async notify(input) {
      const clean = cloneJson(input || {}, 8 * 1024, 'notification');
      return require('../services/notification.service').notify(req, clean || {}, { extensionId: def.id });
    },
    async audit(action, description, metadata) {
      try {
        const AuditService = require('../services/audit.service');
        const safeAction = AUDIT_ACTIONS.has(String(action)) ? String(action) : 'updated';
        await AuditService.log(req, {
          action: safeAction,
          module: 'settings',
          recordId: tenantId,
          description: `[${def.id}] ${String(description || '').slice(0, 300)}`,
          metadata: { extensionId: def.id, extensionVersion: def.version, ...(cloneJson(metadata || {}, 16 * 1024, 'audit metadata') || {}) }
        });
      } catch (error) {
        logger.warn('audit failed:', error && error.message);
      }
    },
    error(status, message, code) {
      const n = Number(status);
      return runtimeError(n >= 400 && n < 600 ? n : 500, String(message || 'Extension error').slice(0, 300), code ? String(code).slice(0, 60) : undefined);
    }
  });
}

module.exports = { createSdk, CORE_READ };
