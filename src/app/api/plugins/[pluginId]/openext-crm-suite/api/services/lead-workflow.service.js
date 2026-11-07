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

/**
 * Does a new quotation need an opportunity? Settings → Lead workflow decides; "Follow the workspace
 * extension" uses the active extension's salesFlow.requireOpportunityForQuotation (off without one).
 */
async function quotationNeedsOpportunity(req) {
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
  assertOpportunityAllowed,
  leadReady
};
