'use strict';

/**
 * When is a travel lead "ready"? (CRM lead workflow contract, manifest leadWorkflow.)
 *
 * Settings → Travel decide the rule:
 *   ready_all_services_complete  true  → every service chosen in Required Services has at least one
 *                                        Complete requirement (instance); false → at least one Complete
 *   ready_min_travellers         1     → at least this many travellers on the lead
 *   ready_requires_availability  false → on: every Complete requirement also needs a current (not
 *                                        expired) Available / Held / On Request availability check
 *
 * Requirement instances (T2): removed ones never count; those of services no longer ticked in Required
 * Services are ignored (they come back when the service is ticked again).
 * Everything is read in full (chunks of leads, paged rows, batched lead values), whatever the count.
 *
 * The CRM decides what "ready" changes (Settings → Qualification Match): the Create
 * Opportunity button, moving the lead to Qualified, the leads offered for a new opportunity.
 */

const { readServices } = require('./catalog.js');
const { refreshStatuses } = require('./requirement-status.js');
const store = require('./requirement-store.js');
const { summarize } = require('./availability.js');

const { ID_RE, str } = store;
const GOOD_CHECK = new Set(['Available', 'Held', 'On Request']);

async function rules(sdk) {
  const [all, min, availability] = await Promise.all([
    sdk.settings.get('ready_all_services_complete'),
    sdk.settings.get('ready_min_travellers'),
    sdk.settings.get('ready_requires_availability')
  ]);
  // A cleared setting (null / '') means the default, 1 - not 0.
  const n = min === null || min === undefined || min === '' ? NaN : Number(min);
  return {
    allServicesComplete: all !== false,
    minTravellers: Number.isInteger(n) && n >= 0 ? Math.min(n, 500) : 1,
    requiresAvailability: availability === true
  };
}

/** Leads that exist and may be read, with their values. */
async function readableLeads(sdk, ids) {
  const { values, checked } = await store.leadValues(sdk, ids);
  if (checked) return values; // getMany only answers for readable, existing records
  const out = new Map();
  await Promise.all([...values.entries()].map(async ([id, v]) => {
    try {
      if (await sdk.crm.leads.findById(id)) out.set(id, v);
    } catch {
      /* not readable */
    }
  }));
  return out;
}

/** Travellers per lead (≤ 50 leads per query, paged). */
async function travellerCounts(sdk, ids) {
  const counts = new Map();
  for (const part of store.chunks(ids, 50)) {
    const rows = await store.findAll(sdk.models.Traveller, part.length === 1 ? { lead_id: part[0] } : { lead_id: { $in: part } });
    for (const r of rows) counts.set(str(r.lead_id), (counts.get(str(r.lead_id)) || 0) + 1);
  }
  return counts;
}

/**
 * @param {string[]} leadIds
 * @returns {Promise<Object<string, { ready: boolean, reasons: string[], summary: string }>>}
 *          leads the user cannot open are left out
 */
async function readinessFor(sdk, leadIds) {
  const ids = [...new Set((leadIds || []).map(String).filter((id) => ID_RE.test(id)))].slice(0, 200);
  if (!ids.length) return {};
  const [rule, services, saved, leads] = await Promise.all([rules(sdk), readServices(sdk), store.rowsForLeads(sdk, ids), readableLeads(sdk, ids)]);
  const rows = store.live(saved);
  // Statuses are rechecked against the current forms (a form may have changed since the save).
  await refreshStatuses(sdk, rows, services);
  const active = new Map(services.filter((s) => s.enabled !== false).map((s) => [s.key, s.name]));
  const readable = ids.filter((id) => leads.has(id));
  const [travellers, checks] = await Promise.all([
    travellerCounts(sdk, readable),
    rule.requiresAvailability ? store.latestChecks(sdk, rows.filter((r) => r.status === 'Complete' && r._id).map((r) => r._id)) : new Map()
  ]);
  const byLead = new Map();
  for (const row of rows) {
    const id = str(row.lead_id);
    if (!byLead.has(id)) byLead.set(id, []);
    byLead.get(id).push(row);
  }
  const now = new Date();

  const out = {};
  for (const id of readable) {
    const values = leads.get(id) || {};
    const count = travellers.get(id) || 0;
    const selected = (Array.isArray(values.required_services) ? values.required_services.map(String) : []).filter((k) => active.has(k));
    const complete = (byLead.get(id) || []).filter((r) => r.status === 'Complete' && selected.includes(str(r.service_key)));
    const completeKeys = selected.filter((k) => complete.some((r) => str(r.service_key) === k));
    const reasons = [];
    if (!selected.length) {
      reasons.push('Choose the services the customer needs (Required Services)');
    } else if (rule.allServicesComplete && completeKeys.length < selected.length) {
      const missing = selected.filter((k) => !completeKeys.includes(k)).map((k) => active.get(k));
      reasons.push(`Complete the Travel Requirement for ${missing.join(', ')}`);
    } else if (!rule.allServicesComplete && !completeKeys.length) {
      reasons.push('Complete the Travel Requirement for at least one service');
    }
    if (rule.requiresAvailability && complete.length) {
      const unchecked = complete.filter((r) => {
        const s = summarize(checks.get(str(r._id)), now);
        return !s || s.expired || !GOOD_CHECK.has(s.status);
      });
      if (unchecked.length) {
        const names = unchecked.slice(0, 5).map((r) => str(r.label) || active.get(str(r.service_key)) || str(r.service_key));
        reasons.push(`Check availability for ${names.join(', ')}${unchecked.length > 5 ? ` and ${unchecked.length - 5} more` : ''}`);
      }
    }
    if (count < rule.minTravellers) {
      reasons.push(`Add at least ${rule.minTravellers} traveller${rule.minTravellers === 1 ? '' : 's'} (${count} so far)`);
    }
    out[id] = {
      ready: reasons.length === 0,
      reasons,
      summary: `${completeKeys.length} of ${selected.length} service${selected.length === 1 ? '' : 's'} complete · ${count} traveller${count === 1 ? '' : 's'}`
    };
  }
  return out;
}

/**
 * After a change that may make a lead ready: tell the CRM, which applies its own
 * workflow settings (e.g. move the lead to Qualified). Never fails the caller's save.
 * @returns {Promise<{ ready: boolean, stageChanged: boolean, stage: string }>}
 */
async function notifyIfReady(sdk, leadId) {
  try {
    const info = (await readinessFor(sdk, [leadId]))[String(leadId)];
    if (!info || !info.ready) return { ready: false, stageChanged: false, stage: '' };
    if (!sdk.workflow || typeof sdk.workflow.leadReady !== 'function') return { ready: true, stageChanged: false, stage: '' };
    const result = await sdk.workflow.leadReady(String(leadId));
    return { ready: true, stageChanged: Boolean(result && result.stageChanged), stage: String((result && result.stage) || '') };
  } catch (error) {
    if (sdk.logger) sdk.logger.warn('lead readiness check failed:', error && error.message);
    return { ready: false, stageChanged: false, stage: '' };
  }
}

module.exports = { rules, readinessFor, notifyIfReady };
