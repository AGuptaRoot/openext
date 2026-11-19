'use strict';

/**
 * Lead workflow: when may a lead get an opportunity, and when is it Qualified.
 *
 * Two inputs:
 *  - the lead's stage (pipeline stages, setting pipeline_stages; "Qualified" = the stage named
 *    qualified, any case), and
 *  - "ready", answered by the active workspace extension when its manifest declares
 *    leadWorkflow.readinessRoute (POST { leadIds } → { leads: { <id>: { ready, reasons, summary } } }).
 *    The CRM knows nothing about what makes a lead ready — that is the extension's own rule.
 *
 * The rules apply only while the active extension declares leadWorkflow.readinessRoute; without it the
 * CRM behaves as before (Create Opportunity on Qualified leads, every open lead offered for an opportunity).
 *
 * What the two inputs change is the tenant's choice (setting lead_workflow, Settings → Qualification Match):
 *  - opportunityButton          'qualified' | 'ready' | 'qualified_or_ready'  — when Create Opportunity shows
 *  - hideReplacedCommercialRequirement  hide the Commercial Requirement tab when the extension replaces it
 *  - autoQualifyReadyLeads      move a lead to Qualified when the extension reports it ready
 *  - opportunityLeads           'all' | 'qualified_or_ready'  — leads offered (and accepted) for a new opportunity
 */

const DEFAULT_RULES = Object.freeze({
  opportunityButton: 'qualified_or_ready',
  hideReplacedCommercialRequirement: true,
  autoQualifyReadyLeads: true,
  opportunityLeads: 'qualified_or_ready',
  /** 'extension' = follow the active extension (salesFlow.requireOpportunityForQuotation), 'always', 'never'. */
  quotationNeedsOpportunity: 'extension'
});

const MAX_READINESS_BATCH = 200;

function normalizeRules(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    opportunityButton: ['qualified', 'ready', 'qualified_or_ready'].includes(src.opportunityButton) ? src.opportunityButton : DEFAULT_RULES.opportunityButton,
    hideReplacedCommercialRequirement: typeof src.hideReplacedCommercialRequirement === 'boolean' ? src.hideReplacedCommercialRequirement : DEFAULT_RULES.hideReplacedCommercialRequirement,
    autoQualifyReadyLeads: typeof src.autoQualifyReadyLeads === 'boolean' ? src.autoQualifyReadyLeads : DEFAULT_RULES.autoQualifyReadyLeads,
    opportunityLeads: ['all', 'qualified_or_ready'].includes(src.opportunityLeads) ? src.opportunityLeads : DEFAULT_RULES.opportunityLeads,
    quotationNeedsOpportunity: ['extension', 'always', 'never'].includes(src.quotationNeedsOpportunity)
      ? src.quotationNeedsOpportunity
      : DEFAULT_RULES.quotationNeedsOpportunity
  };
}

async function getRules(req) {
  const SettingService = require('./setting.service');
  const all = await SettingService.getAll(req).catch(() => ({}));
  return normalizeRules(all.lead_workflow);
}

async function getStages(req) {
  const SettingService = require('./setting.service');
  return (await SettingService.getPipelineStages(req).catch(() => [])) || [];
}

const lower = (v) => String(v || '').trim().toLowerCase();

/** Name of the Qualified stage, or '' when the pipeline has none. */
function qualifiedStageName(stages) {
  return (stages || []).find((s) => lower(s) === 'qualified') || '';
}

/** Qualified or a later stage, but never Lost / Won-style closed stages before it. */
function isQualifiedOrLater(stage, stages) {
  const list = (stages || []).map(lower);
  const at = list.indexOf('qualified');
  if (at < 0) return lower(stage) === 'qualified';
  const i = list.indexOf(lower(stage));
  return i >= at && lower(stage) !== 'lost';
}

/** The active extension's lead-workflow contract, or null. */
async function contract(req) {
  const CrmExtensionService = require('./crm-extension.service');
  const def = await CrmExtensionService.getActive(req).catch(() => null);
  if (!def || def.isInternal !== false || !def.leadWorkflow) return null;
  return def.leadWorkflow;
}

/**
 * Readiness of several leads from the active extension.
 * @returns {Promise<Map<string, { ready: boolean, reasons: string[], summary: string }>>}
 *          empty when no extension answers (then nothing is "ready").
 */
async function readiness(req, leadIds, workflow) {
  const out = new Map();
  const lw = workflow === undefined ? await contract(req) : workflow;
  const ids = [...new Set((leadIds || []).map(String).filter((id) => /^[a-f0-9]{24}$/i.test(id)))];
  if (!lw || !lw.readinessRoute || !ids.length) return out;
  const { callActiveRoute } = require('../extension-runtime/runtime');
  for (let i = 0; i < ids.length; i += MAX_READINESS_BATCH) {
    try {
      const res = await callActiveRoute(req, 'POST', lw.readinessRoute, { leadIds: ids.slice(i, i + MAX_READINESS_BATCH) });
      const leads = res && res.data && res.data.leads && typeof res.data.leads === 'object' ? res.data.leads : {};
      for (const [id, info] of Object.entries(leads)) {
        if (!info || typeof info !== 'object') continue;
        out.set(String(id), {
          ready: info.ready === true,
          reasons: Array.isArray(info.reasons) ? info.reasons.map(String).slice(0, 10) : [],
          summary: String(info.summary || '').slice(0, 300)
        });
      }
    } catch (error) {
      // The extension could not answer (backend not approved, error, timeout): treat as not ready.
      console.warn('[plugin:openext-crm-suite] lead readiness unavailable:', (error && error.message) || error);
    }
  }
  return out;
}

function decide(rules, qualified, ready, hasReadiness) {
  // Without an extension that answers "ready", only the stage rule can apply.
  const button = !hasReadiness ? 'qualified' : rules.opportunityButton;
  const canCreateOpportunity = button === 'qualified' ? qualified : button === 'ready' ? ready : qualified || ready;
  // Without a readiness contract the CRM keeps its previous behaviour: any open lead may get an opportunity.
  const eligibleForOpportunity = !hasReadiness || rules.opportunityLeads === 'all' ? true : qualified || ready;
  return { canCreateOpportunity, eligibleForOpportunity };
}

/** Workflow facts for one lead (lead page). */
async function forLead(req, leadId) {
  const LeadService = require('./lead.service');
  const lead = await LeadService.getById(req, leadId);
  const [rules, stages, lw] = await Promise.all([getRules(req), getStages(req), contract(req)]);
  const hasReadiness = Boolean(lw && lw.readinessRoute);
  const info = hasReadiness ? (await readiness(req, [leadId], lw)).get(String(leadId)) : null;
  const ready = Boolean(info && info.ready);
  const qualified = isQualifiedOrLater(lead.stage, stages);
  // A lead converted into a client never gets a new opportunity, whatever the rules say.
  const converted = Boolean(lead.convertedClientId);
  const decision = decide(rules, qualified, ready, hasReadiness);
  return {
    leadId: String(leadId),
    stage: lead.stage,
    qualified,
    converted,
    hasReadiness,
    ready,
    readyReasons: info ? info.reasons : [],
    readySummary: info ? info.summary : '',
    hideCommercialRequirement: Boolean(lw && lw.replacesCommercialRequirement && rules.hideReplacedCommercialRequirement),
    canCreateOpportunity: decision.canCreateOpportunity && !converted,
    // Unchanged by "converted": the same answer decides quotations for the lead, which stay allowed.
    eligibleForOpportunity: decision.eligibleForOpportunity,
    rules
  };
}

/** Leads offered on the Create Opportunity page. */
async function opportunityCandidates(req, query = {}) {
  const LeadService = require('./lead.service');
  const [rules, stages, lw] = await Promise.all([getRules(req), getStages(req), contract(req)]);
  // LeadService.list reads its filters from req.query.
  const listReq = Object.assign(Object.create(Object.getPrototypeOf(req) || Object.prototype), req, {
    query: { ...(query.q ? { search: String(query.q).slice(0, 100) } : {}), limit: '100' }
  });
  const page = await LeadService.list(listReq);
  const items = Array.isArray(page && page.items) ? page.items : [];
  // A lead asked for by id (e.g. opened from its own page) is always evaluated, even outside the latest 100.
  const include = String(query.include || '').trim();
  if (/^[a-f0-9]{24}$/i.test(include) && !items.some((l) => String(l._id || l.id) === include)) {
    const extra = await LeadService.getById(req, include, { includeQuality: false }).catch(() => null);
    if (extra) items.unshift(extra);
  }
  const open = items.filter((l) => !l.convertedClientId && lower(l.stage) !== 'lost');
  const hasReadiness = Boolean(lw && lw.readinessRoute);
  const ready = rules.opportunityLeads === 'all' || !hasReadiness ? new Map() : await readiness(req, open.map((l) => l._id || l.id), lw);
  const leads = [];
  let hidden = 0;
  for (const lead of open) {
    const id = String(lead._id || lead.id);
    const qualified = isQualifiedOrLater(lead.stage, stages);
    const isReady = Boolean(ready.get(id) && ready.get(id).ready);
    if (hasReadiness && rules.opportunityLeads !== 'all' && !qualified && !isReady) {
      hidden += 1;
      continue;
    }
    leads.push({ ...lead, workflow: { qualified, ready: isReady } });
  }
  return { leads, hidden, rule: hasReadiness ? rules.opportunityLeads : 'all', hasReadiness };
}

/* ------------------------------------------------------------------ leads for a new quotation */

/** Stage names that close a lead without a sale (any case). Won is resolved from the pipeline. */
const CLOSED_STAGE_NAMES = new Set(['lost', 'disqualified', 'cancelled', 'canceled', 'closed']);
const OPEN_QUOTATION_STATUSES = ['Draft', 'Sent'];
const ACCEPTED_QUOTATION_STATUSES = ['Accepted', 'Converted'];
const ID_RE = /^[a-f0-9]{24}$/i;

const idOf = (ref) => String((ref && typeof ref === 'object' ? ref._id || ref.id : ref) || '').trim();
const leanOf = async (query) => (query && typeof query.lean === 'function' ? query.lean() : query);

function isClosedStage(stage) {
  return CLOSED_STAGE_NAMES.has(lower(stage));
}

function quotationError(message, code) {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}

/** The active uploaded extension's Request Type ({ key, id, name }), or null (built-in: no restriction). */
async function activeRequestType(req, def) {
  const key = String((def && def.requestTypeKey) || '').trim();
  if (!def || def.isInternal !== false || !key) return null;
  const out = { key, id: '', name: String(def.requestTypeName || '').trim() };
  try {
    const RequestType = req.cms?.models?.get?.('RequestType');
    if (RequestType) {
      const { resolveTenantId } = require('../utils/tenant.util');
      const doc = await leanOf(RequestType.findOne({ tenantId: resolveTenantId(req), key, isDeleted: { $ne: true } }));
      if (doc) {
        out.id = idOf(doc._id);
        out.name = String(doc.name || out.name || '').trim();
      }
    }
  } catch {
    /* the key alone still decides */
  }
  return out;
}

/** What the active extension asks of a lead before a new quotation. */
async function quotationContext(req) {
  const CrmExtensionService = require('./crm-extension.service');
  const SettingService = require('./setting.service');
  const def = await CrmExtensionService.getActive(req).catch(() => null);
  const uploaded = Boolean(def && def.isInternal === false);
  const lw = uploaded && def.leadWorkflow ? def.leadWorkflow : null;
  const stages = await getStages(req);
  return {
    lw,
    hasReadiness: Boolean(lw && lw.readinessRoute),
    wonStage: SettingService.resolveWonStage(stages),
    requestType: uploaded ? await activeRequestType(req, def) : null,
    oneAccepted: Boolean(uploaded && def.salesFlow && def.salesFlow.oneAcceptedQuotationPerLead === true)
  };
}

/** Request Types of leads that name only an id: Map<id, { key, name }>. */
async function requestTypesById(req, leads) {
  const ids = [...new Set(leads.filter((l) => !(l.commercialRequirement && l.commercialRequirement.requestTypeKey)).map((l) => idOf(l.requestTypeId)).filter((id) => ID_RE.test(id)))];
  const out = new Map();
  const RequestType = req.cms?.models?.get?.('RequestType');
  if (!ids.length || !RequestType) return out;
  try {
    const { resolveTenantId } = require('../utils/tenant.util');
    const rows = (await leanOf(RequestType.find({ tenantId: resolveTenantId(req), _id: { $in: ids } }))) || [];
    for (const row of rows) out.set(idOf(row._id), { key: String(row.key || ''), name: String(row.name || '') });
  } catch {
    /* unknown types are not restricted */
  }
  return out;
}

/** True when the lead clearly belongs to another Request Type than the active one. Unknown → false. */
function isOtherRequestType(lead, active, typesById) {
  if (!active) return false;
  const typeId = idOf(lead.requestTypeId);
  const known = typesById && typesById.get(typeId);
  const key = String((lead.commercialRequirement && lead.commercialRequirement.requestTypeKey) || (known && known.key) || '').trim();
  if (key) return lower(key) !== lower(active.key);
  if (typeId && active.id && known) return typeId !== active.id;
  const name = String(lead.requestType || '').trim();
  if (name && active.name) return lower(name) !== lower(active.name);
  return false;
}

/** Why a lead is closed for a new quotation ('' when open). */
function closedReason(lead, wonStage) {
  if (lead.convertedClientId) return 'converted';
  const stage = lower(lead.stage);
  if (stage && (stage === lower(wonStage) || stage === 'won')) return 'won';
  if (isClosedStage(lead.stage)) return 'closed';
  return '';
}

/**
 * The Draft / Sent / Accepted quotations of several leads (on the lead or on one of its opportunities):
 * one Opportunity query and one Estimate query. Map<leadId, { open: [...], accepted: [...] }>.
 */
async function quotationsOfLeads(req, leadIds) {
  const out = new Map(leadIds.map((id) => [id, { open: [], accepted: [] }]));
  const Estimate = req.cms?.models?.get?.('Estimate');
  if (!leadIds.length || !Estimate) return out;
  const { resolveTenantId } = require('../utils/tenant.util');
  const tenantId = resolveTenantId(req);
  const oppLead = new Map();
  const Opportunity = req.cms?.models?.get?.('Opportunity');
  if (Opportunity) {
    try {
      const q = Opportunity.find({ tenantId, leadId: { $in: leadIds }, isDeleted: { $ne: true } });
      const rows = (await leanOf(q && typeof q.select === 'function' ? q.select('_id leadId') : q)) || [];
      for (const row of rows) oppLead.set(idOf(row._id), idOf(row.leadId));
    } catch {
      /* quotations on the lead itself still count */
    }
  }
  const oppIds = [...oppLead.keys()];
  const or = [{ leadId: { $in: leadIds } }];
  if (oppIds.length) or.push({ opportunityId: { $in: oppIds } }, { dealId: { $in: oppIds } });
  const q = Estimate.find({
    tenantId,
    isDeleted: false,
    status: { $in: [...OPEN_QUOTATION_STATUSES, ...ACCEPTED_QUOTATION_STATUSES] },
    $or: or
  });
  const rows = (await leanOf(q && typeof q.select === 'function' ? q.select('_id quotationNo status leadId opportunityId dealId isLatestVersion') : q)) || [];
  for (const row of rows) {
    let leadId = idOf(row.leadId);
    if (!out.has(leadId)) leadId = oppLead.get(idOf(row.opportunityId)) || oppLead.get(idOf(row.dealId)) || '';
    const bucket = out.get(leadId);
    if (!bucket) continue;
    const item = { id: idOf(row._id), quotationNo: String(row.quotationNo || ''), status: String(row.status || '') };
    if (ACCEPTED_QUOTATION_STATUSES.includes(item.status)) bucket.accepted.push(item);
    else if (row.isLatestVersion !== false) bucket.open.push(item);
  }
  return out;
}

function leadSummary(lead) {
  return {
    _id: idOf(lead._id || lead.id),
    name: String(lead.name || lead.contactName || ''),
    company: String(lead.company || ''),
    email: String(lead.email || ''),
    phone: String(lead.phone || ''),
    stage: String(lead.stage || '')
  };
}

const BLOCK_MESSAGES = {
  converted: 'This lead is already converted into a client.',
  won: 'This lead is Won.',
  closed: 'This lead is closed. Reopen it before making a quotation.',
  otherType: 'This lead is for another request type.',
  accepted: 'This lead already has an accepted quotation.',
  notReady: 'This lead is not ready for a quotation.'
};

/**
 * Leads offered on the Create Quotation page: open leads of the active extension's Request Type, without
 * an accepted quotation (salesFlow.oneAcceptedQuotationPerLead) and, when the extension answers
 * leadWorkflow.readinessRoute, ready. Visibility follows LeadService.list (sales reps: their leads).
 */
async function quotationCandidates(req, query = {}) {
  const { isClientUser } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    const error = new Error('Not available on the client portal.');
    error.status = 403;
    throw error;
  }
  const LeadService = require('./lead.service');
  const ctx = await quotationContext(req);
  const listReq = Object.assign(Object.create(Object.getPrototypeOf(req) || Object.prototype), req, {
    query: { ...(query.q ? { search: String(query.q).slice(0, 100) } : {}), limit: '100' }
  });
  const page = await LeadService.list(listReq);
  const items = Array.isArray(page && page.items) ? [...page.items] : [];
  const include = String(query.include || '').trim();
  let includeFound = !include || items.some((l) => idOf(l._id || l.id) === include);
  if (ID_RE.test(include) && !includeFound) {
    const extra = await LeadService.getById(req, include, { includeQuality: false }).catch(() => null);
    if (extra) {
      items.unshift(extra);
      includeFound = true;
    }
  }

  const hidden = { closed: 0, accepted: 0, otherType: 0 };
  const blocked = new Map();
  const typesById = await requestTypesById(req, items);
  const open = [];
  for (const lead of items) {
    const id = idOf(lead._id || lead.id);
    const closed = closedReason(lead, ctx.wonStage);
    if (closed) {
      hidden.closed += 1;
      blocked.set(id, closed);
    } else if (isOtherRequestType(lead, ctx.requestType, typesById)) {
      hidden.otherType += 1;
      blocked.set(id, 'otherType');
    } else open.push(lead);
  }

  const quotes = await quotationsOfLeads(req, open.map((l) => idOf(l._id || l.id)));
  const remaining = [];
  for (const lead of open) {
    const id = idOf(lead._id || lead.id);
    if (ctx.oneAccepted && quotes.get(id) && quotes.get(id).accepted.length) {
      hidden.accepted += 1;
      blocked.set(id, 'accepted');
    } else remaining.push(lead);
  }

  const ready = ctx.hasReadiness ? await readiness(req, remaining.map((l) => idOf(l._id || l.id)), ctx.lw) : new Map();
  const leads = [];
  const notReady = [];
  for (const lead of remaining) {
    const id = idOf(lead._id || lead.id);
    const info = ready.get(id);
    if (ctx.hasReadiness && !(info && info.ready)) {
      notReady.push({ ...leadSummary(lead), reasons: info ? info.reasons : [], summary: info ? info.summary : '' });
      blocked.set(id, 'notReady');
      continue;
    }
    const row = { ...leadSummary(lead), openQuotations: (quotes.get(id) && quotes.get(id).open) || [] };
    if (!row.email) row.noEmail = true;
    leads.push(row);
  }

  const result = { leads, notReady, hidden, hasReadiness: ctx.hasReadiness };
  if (include) {
    const reason = !includeFound ? 'notFound' : blocked.get(include) || '';
    const lead = items.find((l) => idOf(l._id || l.id) === include);
    const nr = notReady.find((l) => l._id === include);
    result.included = {
      _id: include,
      allowed: !reason,
      reason,
      message: reason === 'notFound' ? 'This lead was not found or is not visible to you.' : BLOCK_MESSAGES[reason] || '',
      reasons: nr ? nr.reasons : [],
      name: lead ? String(lead.name || lead.contactName || '') : ''
    };
  }
  return result;
}

/**
 * Server-side rules for a NEW quotation made straight from a lead (no opportunity, not a client enquiry):
 * closed lead → 409 LEAD_CLOSED; another Request Type → 409 LEAD_OTHER_REQUEST_TYPE; not ready (the
 * extension answers leadWorkflow.readinessRoute) → 409 LEAD_NOT_READY. The accepted-quotation rule is
 * checked by the caller (quotation.service assertLeadNotAccepted). Revisions and conversions never call it.
 */
async function assertQuotationLeadAllowed(req, lead, { assertNotAccepted } = {}) {
  if (!lead) return;
  const id = idOf(lead._id || lead.id);
  const ctx = await quotationContext(req);
  if (!lead.convertedClientId && isClosedStage(lead.stage)) {
    throw quotationError(`This lead is closed (${String(lead.stage).trim()}). Reopen it before making a quotation.`, 'LEAD_CLOSED');
  }
  if (ctx.requestType && isOtherRequestType(lead, ctx.requestType, await requestTypesById(req, [lead]))) {
    const theirs = String((lead.commercialRequirement && lead.commercialRequirement.requestTypeKey) || lead.requestType || '').trim();
    throw quotationError(
      `This lead is for another request type${theirs ? ` (${theirs})` : ''}. Quotations here are for ${ctx.requestType.name || ctx.requestType.key}.`,
      'LEAD_OTHER_REQUEST_TYPE'
    );
  }
  if (typeof assertNotAccepted === 'function') await assertNotAccepted();
  if (ctx.hasReadiness) {
    const info = (await readiness(req, [id], ctx.lw)).get(id);
    if (!(info && info.ready)) {
      const reasons = info && info.reasons.length ? `: ${info.reasons.map((r) => r.replace(/[.\s]+$/, '')).join('; ')}.` : '.';
      throw quotationError(`This lead is not ready for a quotation${reasons}`, 'LEAD_NOT_READY');
    }
  }
}

/**
 * Does a new quotation need an opportunity? Settings → Lead workflow decides; "Follow the workspace
 * extension" uses the active extension's salesFlow.requireOpportunityForQuotation (off without one).
 */
async function quotationNeedsOpportunity(req) {
  // The active extension hides Opportunities: quotations are made from leads, whatever the setting says.
  const CrmExtension = require('./crm-extension.service');
  if (await CrmExtension.opportunitiesHidden(req)) return false;
  const rules = await getRules(req);
  if (rules.quotationNeedsOpportunity === 'always') return true;
  if (rules.quotationNeedsOpportunity === 'never') return false;
  const CrmExtensionService = require('./crm-extension.service');
  const def = await CrmExtensionService.getActive(req).catch(() => null);
  return Boolean(def && def.isInternal === false && def.salesFlow && def.salesFlow.requireOpportunityForQuotation === true);
}

/** Server-side check for a new opportunity (or quotation) with a leadId. */
async function assertOpportunityAllowed(req, leadId, what = 'opportunity') {
  const rules = await getRules(req);
  if (rules.opportunityLeads === 'all' || !leadId) return;
  // Without an extension that answers "ready" any open lead is allowed (the CRM's old behaviour).
  const lw = await contract(req);
  if (!lw || !lw.readinessRoute) return;
  const facts = await forLead(req, leadId);
  if (!facts.eligibleForOpportunity) {
    const why = facts.hasReadiness && facts.readyReasons.length ? ` Still needed: ${facts.readyReasons.join('; ')}.` : '';
    const error = new Error(`This lead is not ready for a${what === 'opportunity' ? 'n opportunity' : ' quotation'}: it must be Qualified${facts.hasReadiness ? ' or meet the workspace extension\'s requirements' : ''}.${why}`);
    error.status = 400;
    error.code = 'LEAD_NOT_READY';
    throw error;
  }
}

/**
 * The extension reports a lead as ready (sdk.workflow.leadReady). When the tenant allows it,
 * a lead before Qualified moves to Qualified. Never moves a lead backwards or a closed lead.
 * @returns {{ stageChanged: boolean, stage: string }}
 */
async function leadReady(req, leadId) {
  const LeadService = require('./lead.service');
  const rules = await getRules(req);
  const lead = await LeadService.getById(req, leadId);
  if (!rules.autoQualifyReadyLeads || lead.convertedClientId) return { stageChanged: false, stage: lead.stage };
  const stages = await getStages(req);
  const target = qualifiedStageName(stages);
  const list = stages.map(lower);
  const at = list.indexOf(lower(target));
  const current = list.indexOf(lower(lead.stage));
  if (!target || at < 0 || (current >= at && current !== -1) || lower(lead.stage) === 'lost') {
    return { stageChanged: false, stage: lead.stage };
  }
  await LeadService.changeStage(req, String(leadId), target, { system: true });
  return { stageChanged: true, stage: target };
}

module.exports = {
  quotationNeedsOpportunity,
  DEFAULT_RULES,
  normalizeRules,
  getRules,
  isQualifiedOrLater,
  qualifiedStageName,
  readiness,
  forLead,
  opportunityCandidates,
  quotationCandidates,
  assertQuotationLeadAllowed,
  isClosedStage,
  assertOpportunityAllowed,
  leadReady
};
