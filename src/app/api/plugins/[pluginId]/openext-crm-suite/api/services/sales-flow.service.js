'use strict';

/**
 * Sales flow: the active extension may suggest what a new opportunity or quotation starts with
 * (manifest salesFlow.opportunityPrefillRoute / quotationPrefillRoute, POST { leadId }).
 *
 * The CRM only asks and cleans the answer; the agent still reviews and saves the form.
 * Without such an extension every call answers { available: false } and the pages behave as before.
 */

const ID_RE = /^[a-f0-9]{24}$/i;
const MAX_LINES = 50;
const MAX_SECTIONS = 10;
const MAX_WARNINGS = 20;
const MAX_VALUES = 50;
const MAX_DETAILS = 30;
const MAX_PANELS = 5;
const MAX_PANEL_ITEMS = 50;

const text = (v, max) => (v === null || v === undefined ? '' : String(v)).replace(/\r\n/g, '\n').trim().slice(0, max);
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'INVALID_INPUT';
  return error;
}

/** The active extension definition when it declares a sales-flow contract, or null. */
async function activeDef(req) {
  const CrmExtensionService = require('./crm-extension.service');
  const def = await CrmExtensionService.getActive(req).catch(() => null);
  if (!def || def.isInternal !== false || !isPlainObject(def.salesFlow)) return null;
  return def;
}

/** The active extension's sales-flow contract, or null. */
async function contract(req) {
  const def = await activeDef(req);
  if (!def) return null;
  return { ...def.salesFlow, extensionName: def.name || def.id };
}

const GROUP_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Declared quotation line group keys (salesFlow.quotationLineGroups) in their declared order. */
function groupKeysOf(flow) {
  const groups = flow && flow.quotationPrefillRoute && Array.isArray(flow.quotationLineGroups) ? flow.quotationLineGroups : [];
  return groups.map((g) => String((g && g.key) || '')).filter((k) => GROUP_RE.test(k));
}

/**
 * Lines ordered by declared group order (stable within a group; ungrouped and unknown groups last).
 * Returns the same array when the contract declares no groups or no line has one.
 */
function orderByGroup(flow, lines) {
  if (!Array.isArray(lines)) return lines;
  const keys = groupKeysOf(flow);
  if (!keys.length) return lines;
  const rank = new Map(keys.map((k, i) => [k, i]));
  if (!lines.some((l) => l && rank.has(l.group))) return lines;
  return lines
    .map((line, index) => ({ line, index, r: line && rank.has(line.group) ? rank.get(line.group) : keys.length }))
    .sort((a, b) => a.r - b.r || a.index - b.index)
    .map((x) => x.line);
}

/** Print / PDF / portal: document lines in declared group order (unchanged without groups). */
async function orderLinesByGroup(req, lines) {
  const flow = await contract(req).catch(() => null);
  return orderByGroup(flow, lines);
}

/** Value of a checkbox in the extension's settings, or null when there is no key / it cannot be read. */
async function settingFlag(req, def, key) {
  if (!key || !def) return null;
  try {
    const values = await require('./crm-extension-settings.service').getValues(req, def);
    if (!values || !Object.prototype.hasOwnProperty.call(values, key)) return null;
    return values[key] === true || values[key] === 'true';
  } catch {
    return null;
  }
}

/** [{ label, ok, hint }] shown in the right column checklist. */
function cleanChecks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 40)) {
    if (out.length >= 10) break;
    if (!isPlainObject(item)) continue;
    const label = text(item.label, 120);
    if (label) out.push({ label, ok: item.ok === true, hint: text(item.hint, 200) });
  }
  return out;
}

/**
 * Notices the page shows above the form: [{ tone: warning|info, text, action?: { label, leadTab } }].
 * The action only names a lead tab of the extension; the CRM builds the link itself.
 */
function cleanNotices(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 20)) {
    if (out.length >= 5) break;
    if (!isPlainObject(item)) continue;
    const message = text(item.text, 300);
    if (!message) continue;
    const notice = { tone: item.tone === 'info' ? 'info' : 'warning', text: message };
    const action = item.action;
    if (isPlainObject(action) && text(action.label, 40) && /^[a-z][a-z0-9_-]{1,59}$/.test(String(action.leadTab || ''))) {
      notice.action = { label: text(action.label, 40), leadTab: String(action.leadTab) };
    }
    out.push(notice);
  }
  return out;
}

/** Numbers the page shows with a field group (e.g. records that exist): [{ key, label, value, group }]. */
function cleanFacts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 40)) {
    if (out.length >= 10) break;
    if (!isPlainObject(item)) continue;
    const key = text(item.key, 60);
    const label = text(item.label, 80);
    const value = Number(item.value);
    if (!/^[a-z][a-z0-9_]{1,59}$/.test(key) || !label || !Number.isFinite(value)) continue;
    out.push({ key, label, value, group: /^[a-z][a-z0-9_-]{1,59}$/.test(String(item.group || '')) ? String(item.group) : '' });
  }
  return out;
}

/**
 * Questions asked before a field takes a value (e.g. a choice that needs more data):
 * [{ field, value, title, message }]. Cancel keeps the old value.
 */
function cleanValueConfirms(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 40)) {
    if (out.length >= 10) break;
    if (!isPlainObject(item)) continue;
    const field = text(item.field, 60);
    const value = text(item.value, 200);
    const message = text(item.message, 600);
    if (!/^[a-z][a-z0-9_]{1,59}$/.test(field) || !value || !message) continue;
    out.push({ field, value, title: text(item.title, 80), message });
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const cleanDate = (v) => (DATE_RE.test(String(v || '')) && !Number.isNaN(Date.parse(v)) ? String(v) : '');

/** [{ label, value }] shown with a line or a panel item (read-only, never saved). */
function cleanDetails(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, MAX_DETAILS * 2)) {
    if (out.length >= MAX_DETAILS) break;
    if (!isPlainObject(item)) continue;
    const label = text(item.label, 80);
    const value = text(item.value, 500);
    if (label && value) out.push({ label, value });
  }
  return out;
}

/** Read-only information panels: [{ title, items: [{ title, subtitle, badge, details }] }]. */
function cleanPanels(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const panel of raw.slice(0, MAX_PANELS * 4)) {
    if (out.length >= MAX_PANELS) break;
    if (!isPlainObject(panel)) continue;
    const title = text(panel.title, 80);
    if (!title) continue;
    const items = [];
    for (const item of Array.isArray(panel.items) ? panel.items.slice(0, MAX_PANEL_ITEMS) : []) {
      if (!isPlainObject(item) || !text(item.title, 200)) continue;
      items.push({
        title: text(item.title, 200),
        subtitle: text(item.subtitle, 300),
        badge: text(item.badge, 40),
        details: cleanDetails(item.details)
      });
    }
    out.push({ title, empty: text(panel.empty, 200), note: text(panel.note, 300), items });
  }
  return out;
}

/** With groupKeys (the contract declares line groups) a prefill line / option carries `group`: a declared key or ''. */
function groupOf(item, groupKeys) {
  if (!Array.isArray(groupKeys) || !groupKeys.length) return {};
  const group = String((item && item.group) || '');
  return { group: groupKeys.includes(group) ? group : '' };
}

function cleanLines(raw, groupKeys = null) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, MAX_LINES * 4)) {
    if (out.length >= MAX_LINES) break;
    if (!isPlainObject(item)) continue;
    const name = text(item.name, 200);
    if (!name) continue;
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    const tax = Number(item.tax);
    out.push({
      name,
      unit: text(item.unit, 60),
      ...(item.tax !== undefined && item.tax !== null && item.tax !== '' && Number.isFinite(tax) && tax >= 0 && tax <= 100 ? { tax } : {}),
      extra: isPlainObject(item.extra)
        ? Object.fromEntries(
            Object.entries(item.extra)
              .filter(([k, v]) => /^[a-z][a-z0-9_]{0,39}$/i.test(k) && ['string', 'number'].includes(typeof v))
              .slice(0, 10)
              .map(([k, v]) => [k, text(v, 200)])
          )
        : {},
      description: text(item.description, 500),
      sourceRef: /^[A-Za-z0-9:_-]{1,64}$/.test(String(item.sourceRef || '')) ? String(item.sourceRef) : '',
      selected: item.selected !== false,
      quantity: Number.isFinite(quantity) && quantity > 0 ? Math.min(quantity, 100000) : 1,
      unitPrice: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
      details: cleanDetails(item.details),
      ...groupOf(item, groupKeys)
    });
  }
  return out;
}

function cleanSections(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, MAX_SECTIONS * 4)) {
    if (out.length >= MAX_SECTIONS) break;
    if (!isPlainObject(item)) continue;
    const title = text(item.title, 80);
    const body = text(item.body, 3000);
    if (title && body) out.push({ key: text(item.key, 60), title, body });
  }
  return out;
}

/** Facts shown in a row above the quotation lines: [{ icon, label, value }]. */
function cleanSummary(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 40)) {
    if (out.length >= 10) break;
    if (!isPlainObject(item)) continue;
    const label = text(item.label, 40);
    const value = text(item.value, 120);
    if (label && value) out.push({ icon: /^[a-z_]{1,30}$/.test(String(item.icon || '')) ? item.icon : '', label, value });
  }
  return out;
}

/** Services the agent may add as a line by hand: [{ name, unit, tax, group? }]. */
function cleanLineOptions(raw, groupKeys = null) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 200)) {
    if (out.length >= 50) break;
    if (!isPlainObject(item) || !text(item.name, 200)) continue;
    const tax = Number(item.tax);
    out.push({
      name: text(item.name, 200),
      unit: text(item.unit, 60),
      ...(Number.isFinite(tax) && tax >= 0 && tax <= 100 && item.tax !== '' && item.tax !== null ? { tax } : {}),
      ...groupOf(item, groupKeys)
    });
  }
  return out;
}

/**
 * Keeps on each quotation line only the extra columns the active extension declares
 * (salesFlow.quotationLineFields): select values must be one of its options, text is cut to its length.
 * A line `group` is kept only when it is a declared salesFlow.quotationLineGroups key, else ''.
 */
async function cleanLineExtras(req, items) {
  if (!Array.isArray(items)) return items;
  const hasExtra = items.some((i) => i && i.extra && typeof i.extra === 'object' && Object.keys(i.extra).length);
  const hasGroup = items.some((i) => i && i.group);
  if (!hasExtra && !hasGroup) return items;
  const flow = await contract(req);
  const fields = (flow && Array.isArray(flow.quotationLineFields) && flow.quotationLineFields) || [];
  const groupKeys = groupKeysOf(flow);
  return items.map((item, index) => {
    if (!item || typeof item !== 'object') return item;
    if (hasGroup) {
      const group = String(item.group || '');
      item = { ...item, group: groupKeys.includes(group) ? group : '' };
    }
    if (!item.extra || typeof item.extra !== 'object') return item;
    const extra = {};
    for (const field of fields) {
      const value = text(item.extra[field.key], 200);
      if (!value) continue;
      if (field.type === 'select' && !(field.options || []).includes(value)) {
        throw badRequest(`Line item ${index + 1}: ${field.label || field.key} must be one of ${(field.options || []).join(', ')}`);
      }
      extra[field.key] = field.type === 'text' ? value.slice(0, field.maxLength || 200) : value;
    }
    return { ...item, extra };
  });
}

/**
 * A quotation as customers may see it (public portal): only printable extension columns,
 * no line references and no internal notes.
 */
async function publicQuotation(req, quotation) {
  if (!quotation) return quotation;
  const { notes, ...rest } = quotation; // eslint-disable-line no-unused-vars
  return { ...rest, lineItems: await publicLines(req, quotation.lineItems) };
}

/** Document lines as customers may see them: printable extension columns only, no line references. */
async function publicLines(req, lineItems) {
  const flow = await contract(req).catch(() => null);
  const printable = new Set(((flow && flow.quotationLineFields) || []).filter((f) => f.print).map((f) => f.key));
  const lines = (Array.isArray(lineItems) ? lineItems : []).map((line) => {
    const { sourceRef, extra, ...clean } = line || {}; // eslint-disable-line no-unused-vars
    const kept = {};
    for (const [k, v] of Object.entries(extra && typeof extra === 'object' ? extra : {})) if (printable.has(k)) kept[k] = v;
    return { ...clean, extra: kept };
  });
  // `group` is not secret; lines follow the declared group order.
  return orderByGroup(flow, lines);
}

/** "Rooms × Nights · Availability: Held" for print / PDF: the unit and the printable extra columns. */
async function printNotes(req, lineItems) {
  const flow = await contract(req).catch(() => null);
  const fields = ((flow && flow.quotationLineFields) || []).filter((f) => f.print);
  return (lineItems || []).map((line) => {
    const parts = [];
    if (line && line.unit) parts.push(String(line.unit));
    for (const f of fields) {
      const v = line && line.extra && line.extra[f.key];
      if (v) parts.push(`${f.label}: ${v}`);
    }
    return parts.join(' · ');
  });
}

function cleanWarnings(raw) {
  return Array.isArray(raw) ? raw.map((w) => text(w, 300)).filter(Boolean).slice(0, MAX_WARNINGS) : [];
}

/** Extension field values: scalars and short lists only (saved through the normal extension-data path). */
function cleanValues(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw).slice(0, MAX_VALUES)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = typeof value === 'string' ? text(value, 2000) : value;
    } else if (Array.isArray(value)) {
      out[key] = value
        .filter((v) => ['string', 'number'].includes(typeof v))
        .slice(0, 50)
        .map((v) => (typeof v === 'string' ? text(v, 200) : v));
    }
  }
  return out;
}

async function call(req, route, body) {
  const { callActiveRoute } = require('../extension-runtime/runtime');
  try {
    const res = await callActiveRoute(req, 'POST', route, body);
    if (!res || res.available === false) return null;
    return isPlainObject(res.data) ? res.data : {};
  } catch (error) {
    // Never block the page: the agent can still fill the form by hand.
    console.warn('[plugin:openext-crm-suite] sales-flow prefill unavailable:', (error && error.message) || error);
    return { failed: true, message: Number(error && error.status) < 500 ? text(error.message, 300) : '' };
  }
}

const LINK_TYPES = ['lead', 'client'];

/**
 * salesFlow.opportunityForm with linkTypes resolved: when the extension setting named by
 * leadOnlySetting is on, only "lead" is allowed. null without a form.
 */
async function resolveOpportunityForm(req, def) {
  const raw = def && def.salesFlow && def.salesFlow.opportunityForm;
  if (!isPlainObject(raw)) return null;
  let linkTypes = Array.isArray(raw.linkTypes) ? raw.linkTypes.filter((t) => LINK_TYPES.includes(t)) : [];
  if (!linkTypes.length) linkTypes = [...LINK_TYPES];
  const leadOnlySetting = text(raw.leadOnlySetting, 60);
  const leadOnly = leadOnlySetting ? (await settingFlag(req, def, leadOnlySetting)) === true : false;
  if (leadOnly) linkTypes = ['lead'];
  const form = {
    title: text(raw.title, 60),
    subtitle: text(raw.subtitle, 200),
    linkTypes,
    leadOnly,
    needsLead: raw.needsLead === true,
    emptyText: text(raw.emptyText, 120),
    savedRoute: text(raw.savedRoute, 200)
  };
  // startStage: the stage is set by the CRM; the page shows it read-only (labels as the pipeline names them).
  const start = startStageOf(def);
  if (start) {
    const pipeline = await extensionPipeline(req, def);
    const base = stageOf(def, pipeline, start.stage);
    const ready = stageOf(def, pipeline, start.readyStage);
    if (base) form.startStage = { stage: base.label, readyStage: ready ? ready.label : '', locked: true };
  }
  return form;
}

/** Link types allowed for a new opportunity under the active contract (["lead", "client"] without a form). */
async function opportunityLinkTypes(req) {
  const form = await resolveOpportunityForm(req, await activeDef(req));
  return form ? form.linkTypes : [...LINK_TYPES];
}

/** salesFlow.opportunityForm.startStage as declared ({ stage, readyStage } stage ids), or null. */
function startStageOf(def) {
  const form = def && def.salesFlow && def.salesFlow.opportunityForm;
  const raw = isPlainObject(form) && isPlainObject(form.startStage) ? form.startStage : null;
  const stage = raw ? text(raw.stage, 80) : '';
  return stage ? { stage, readyStage: text(raw.readyStage, 80) } : null;
}

/** The extension's own pipeline (by its pipelineKey), else the tenant's active pipeline; null when none loads. */
async function extensionPipeline(req, def) {
  try {
    const OpportunityPipeline = req.cms?.models?.get?.('OpportunityPipeline');
    if (OpportunityPipeline && def.pipelineKey) {
      const { resolveTenantId } = require('../utils/tenant.util');
      const q = OpportunityPipeline.findOne({ tenantId: resolveTenantId(req), isDeleted: false, pipelineKey: def.pipelineKey });
      const found = q && typeof q.lean === 'function' ? await q.lean() : await q;
      if (found) return found;
    }
    return (await require('./opportunity-pipeline.service').ensureDefaultPipeline(req)) || null;
  } catch {
    return null;
  }
}

/**
 * A manifest stage id as the tenant's pipeline holds it: matched by id, else by the manifest label
 * (a tenant may have renamed it; the id stays). Falls back to the manifest stage itself. null when unknown.
 */
function stageOf(def, pipeline, stageId) {
  if (!stageId) return null;
  const declared = (Array.isArray(def.pipelineStages) ? def.pipelineStages : []).find((s) => s && String(s.id) === stageId) || null;
  const stages = pipeline && Array.isArray(pipeline.stages) ? pipeline.stages : [];
  const lowerLabel = declared ? String(declared.label || '').trim().toLowerCase() : '';
  const hit =
    stages.find((s) => s && String(s.id) === stageId) ||
    (lowerLabel ? stages.find((s) => s && String(s.label || '').trim().toLowerCase() === lowerLabel) : null) ||
    declared;
  if (!hit || !text(hit.label, 80)) return null;
  const probability = Number(hit.probability);
  return {
    label: text(hit.label, 80),
    type: String(hit.type || 'OPEN').toUpperCase(),
    probability: Number.isFinite(probability) ? probability : 50
  };
}

/**
 * salesFlow.opportunityForm.startStage: the stage a new opportunity opens in is set by the CRM, never
 * picked by the user — `readyStage` when the lead is ready by the extension's lead workflow readiness
 * (leadWorkflow.readinessRoute), else `stage`. Without the contract → { locked: false }.
 * @returns {Promise<{ locked: boolean, stage?, stageType?, probability?, pipelineId?, startStage?, readyStage?, ready?, reasons? }>}
 */
async function opportunityStartStage(req, leadId) {
  const def = await activeDef(req);
  const start = startStageOf(def);
  if (!start) return { locked: false };
  const pipeline = await extensionPipeline(req, def);
  const base = stageOf(def, pipeline, start.stage);
  if (!base) return { locked: false };
  const readyMeta = stageOf(def, pipeline, start.readyStage);
  let ready = false;
  let reasons = [];
  const id = text(leadId, 24);
  if (readyMeta && ID_RE.test(id)) {
    const facts = await require('./lead-workflow.service').forLead(req, id).catch(() => null);
    ready = Boolean(facts && facts.ready);
    reasons = facts && Array.isArray(facts.readyReasons) ? facts.readyReasons.map((r) => text(r, 200)).filter(Boolean).slice(0, 20) : [];
  }
  const chosen = ready ? readyMeta : base;
  return {
    locked: true,
    stage: chosen.label,
    stageType: chosen.type,
    probability: chosen.probability,
    pipelineId: pipeline && pipeline._id ? String(pipeline._id) : null,
    startStage: base.label,
    readyStage: readyMeta ? readyMeta.label : '',
    ready,
    reasons
  };
}

/** salesFlow.quotationForm; totalPer is left out when its showSetting is off. null without a form. */
async function resolveQuotationForm(req, def) {
  const raw = def && def.salesFlow && def.salesFlow.quotationForm;
  if (!isPlainObject(raw)) return null;
  const form = { emptyText: text(raw.emptyText, 120), savedRoute: text(raw.savedRoute, 200) };
  if (text(raw.acceptedRoute, 200)) form.acceptedRoute = text(raw.acceptedRoute, 200);
  const per = raw.totalPer;
  if (isPlainObject(per) && text(per.label, 40) && text(per.countField, 64)) {
    const showSetting = text(per.showSetting, 60);
    const shown = showSetting ? (await settingFlag(req, def, showSetting)) !== false : true;
    if (shown) form.totalPer = { label: text(per.label, 40), countField: text(per.countField, 64) };
  }
  return form;
}

/** salesFlow.quotationLineGroups as declared ([{ key, title, fields }]); [] without quotation prefill. */
function lineGroups(flow) {
  if (!flow || !flow.quotationPrefillRoute || !Array.isArray(flow.quotationLineGroups)) return [];
  return flow.quotationLineGroups
    .filter((g) => isPlainObject(g) && GROUP_RE.test(String(g.key || '')))
    .map((g) => ({
      key: g.key,
      title: text(g.title, 40),
      fields: Array.isArray(g.fields) ? g.fields.map((f) => String(f)) : [],
      ...(g.icon ? { icon: text(g.icon, 20) } : {})
    }));
}

/** What the create pages need to know before a lead is chosen. */
async function config(req) {
  const [def, requireOpportunityForQuotation] = await Promise.all([
    activeDef(req),
    require('./lead-workflow.service').quotationNeedsOpportunity(req).catch(() => false)
  ]);
  if (!def) return { available: false, requireOpportunityForQuotation };
  const flow = { ...def.salesFlow, extensionName: def.name || def.id };
  const [opportunityForm, quotationForm] = await Promise.all([resolveOpportunityForm(req, def), resolveQuotationForm(req, def)]);
  return {
    available: true,
    requireOpportunityForQuotation,
    opportunityPrefill: Boolean(flow.opportunityPrefillRoute),
    quotationPrefill: Boolean(flow.quotationPrefillRoute),
    hideOpportunityLines: Boolean(flow.opportunityPrefillRoute && flow.hideOpportunityLines),
    lockQuotationLines: Boolean(flow.quotationPrefillRoute && flow.lockQuotationLines),
    fixedLines: Boolean(flow.fixedLines),
    hideQuotationSections: Boolean(flow.hideQuotationSections),
    requirementLink: isPlainObject(flow.requirementLink) ? { label: text(flow.requirementLink.label, 40), leadTab: text(flow.requirementLink.leadTab, 60) } : null,
    terms: isPlainObject(flow.terms)
      ? Object.fromEntries(Object.entries(flow.terms).filter(([k, v]) => /^[a-zA-Z]{1,30}$/.test(k) && typeof v === 'string').map(([k, v]) => [k, text(v, 40)]))
      : null,
    hideShipping: Boolean(flow.hideShipping),
    invoicePrint: invoicePrintOf(flow),
    lockOpportunityContact: Boolean(flow.lockOpportunityContact),
    invoiceFromQuotation: Boolean(flow.invoiceFromQuotation),
    hideRecurringInvoices: Boolean(flow.hideRecurringInvoices),
    hideInvoiceTemplates: Boolean(flow.hideInvoiceTemplates),
    hideInvoiceWriteOff: Boolean(flow.hideInvoiceWriteOff),
    lockOpportunityOnAccept: Boolean(flow.lockOpportunityOnAccept),
    lockConvertedLead: Boolean(flow.lockConvertedLead),
    completeOpportunitiesOnConversion: Boolean(flow.completeOpportunitiesOnConversion),
    clientQuotationStartsWithLead: Boolean(flow.clientQuotationStartsWithLead),
    bookingAfterAdvance: Boolean(flow.bookingAfterAdvance),
    lockWonLead: Boolean(flow.lockWonLead),
    // 3.34.0: a quotation for a client goes through the extension (eligible clients, a picker, a start step).
    clientQuotation: isPlainObject(flow.clientQuotation) ? { notEligibleText: text(flow.clientQuotation.notEligibleText, 200) } : null,
    // 3.32.0: the quotation pages ask POST /sales-flow/quotation-dates for Issue Date / Valid Till limits.
    quotationDates: Boolean(flow.quotationDatesRoute),
    quotationLineFields: flow.quotationPrefillRoute && Array.isArray(flow.quotationLineFields) ? flow.quotationLineFields : [],
    quotationPageTitle: flow.quotationPageTitle || '',
    quotationPageSubtitle: flow.quotationPageSubtitle || '',
    quotationSummaryTitle: flow.quotationSummaryTitle || '',
    quotationLinesTitle: flow.quotationLinesTitle || '',
    quotationLinesSubtitle: flow.quotationLinesSubtitle || '',
    quotationAddLineLabel: flow.quotationAddLineLabel || '',
    // 3.18.0 sales forms: present before a lead is chosen so the pages can show the extension layout.
    opportunityForm,
    quotationForm,
    quotationLineGroups: lineGroups(flow),
    extensionName: text(flow.extensionName, 80)
  };
}

function unavailable(reason, message) {
  return message ? { available: false, reason, message } : { available: false, reason };
}

/** What a new opportunity for this lead starts with. */
async function opportunityPrefill(req, body = {}) {
  const leadId = text(body.leadId, 24);
  if (!ID_RE.test(leadId)) throw badRequest('leadId is required');
  const flow = await contract(req);
  if (!flow || !flow.opportunityPrefillRoute) return unavailable('none');
  const LeadService = require('./lead.service');
  await LeadService.getById(req, leadId, { includeQuality: false });
  const data = await call(req, flow.opportunityPrefillRoute, { leadId });
  if (!data) return unavailable('none');
  if (data.failed) return unavailable('failed', data.message);
  const dealValue = Number(data.dealValue);
  return {
    available: true,
    leadId,
    title: text(data.title, 200),
    dealValue: data.dealValue !== null && data.dealValue !== undefined && data.dealValue !== '' && Number.isFinite(dealValue) && dealValue >= 0 ? dealValue : null,
    panels: cleanPanels(data.panels),
    expectedCloseDate: /^\d{4}-\d{2}-\d{2}$/.test(String(data.expectedCloseDate || '')) ? data.expectedCloseDate : '',
    description: text(data.description, 2000),
    lines: cleanLines(data.lines),
    values: cleanValues(data.values),
    warnings: cleanWarnings(data.warnings),
    checks: cleanChecks(data.checks),
    notices: cleanNotices(data.notices),
    facts: cleanFacts(data.facts),
    valueConfirms: cleanValueConfirms(data.valueConfirms)
  };
}

/** What a new quotation for this lead (or the opportunity's lead) starts with. */
async function quotationPrefill(req, body = {}) {
  let leadId = text(body.leadId, 24);
  const opportunityId = text(body.opportunityId, 24);
  if (!leadId && !opportunityId) throw badRequest('leadId or opportunityId is required');
  if (leadId && !ID_RE.test(leadId)) throw badRequest('leadId is not valid');
  if (opportunityId && !ID_RE.test(opportunityId)) throw badRequest('opportunityId is not valid');
  const flow = await contract(req);
  if (!flow || !flow.quotationPrefillRoute) return unavailable('none');
  if (opportunityId) {
    const OpportunityService = require('./opportunity.service');
    const opportunity = await OpportunityService.getById(req, opportunityId);
    const ref = opportunity && opportunity.leadId;
    const oppLead = text(ref && typeof ref === 'object' ? ref._id : ref, 24);
    if (leadId && oppLead && leadId !== oppLead) throw badRequest('This opportunity belongs to a different lead');
    leadId = leadId || oppLead;
    if (!ID_RE.test(leadId)) return unavailable('no_lead');
  } else {
    const LeadService = require('./lead.service');
    await LeadService.getById(req, leadId, { includeQuality: false });
  }
  // Since 3.18.0 the extension also learns the opportunity ('' when none); old extensions ignore it.
  const data = await call(req, flow.quotationPrefillRoute, { leadId, opportunityId: opportunityId || '' });
  if (!data) return unavailable('none');
  if (data.failed) return unavailable('failed', data.message);
  const groupKeys = groupKeysOf(flow);
  return {
    available: true,
    leadId,
    title: text(data.title, 200),
    description: text(data.description, 2000),
    summary: cleanSummary(data.summary),
    panels: cleanPanels(data.panels),
    lineOptions: cleanLineOptions(data.lineOptions, groupKeys),
    lineNote: text(data.lineNote, 300),
    lines: cleanLines(data.lines, groupKeys),
    sections: cleanSections(data.sections),
    warnings: cleanWarnings(data.warnings),
    values: cleanValues(data.values),
    validTill: cleanDate(data.validTill),
    validTillMax: cleanDate(data.validTillMax),
    checks: cleanChecks(data.checks),
    notices: cleanNotices(data.notices)
  };
}

/** salesFlow.invoicePrint cleaned ({ layout: 'service', title, summaryTitle, linesTitle, footer }), or null. */
function invoicePrintOf(flow) {
  const ip = flow && flow.invoicePrint;
  if (!isPlainObject(ip) || ip.layout !== 'service') return null;
  return { layout: 'service', title: text(ip.title, 40), summaryTitle: text(ip.summaryTitle, 40), linesTitle: text(ip.linesTitle, 40), footer: text(ip.footer, 200) };
}

/**
 * The service-invoice PDF of the active extension (salesFlow.invoicePrint), or null (the standard PDF):
 * the print switches, the wording (salesFlow.terms) and the extension's read-only summary of the invoice's
 * quotation (salesFlow.invoicePrefillRoute, e.g. booking number, destination, dates, travellers).
 * The summary is asked as the workspace (system identity, read-only) so a public pay-link download prints
 * the same; when the extension cannot answer the PDF is printed without it. Never throws.
 */
async function invoicePrintContext(req, invoice) {
  try {
    const flow = await contract(req);
    const print = invoicePrintOf(flow);
    if (!print) return null;
    const terms = isPlainObject(flow.terms) ? flow.terms : {};
    let summary = [];
    const quotationId = text(invoice && invoice.quotationId, 24);
    if (flow.invoicePrefillRoute && ID_RE.test(quotationId)) {
      try {
        const { callActiveRoute } = require('../extension-runtime/runtime');
        const res = await callActiveRoute(req, 'POST', flow.invoicePrefillRoute, { quotationId, leadId: '', opportunityId: text(invoice.opportunityId, 24) }, { system: true });
        if (res && res.available !== false && isPlainObject(res.data)) summary = cleanSummary(res.data.summary);
      } catch (error) {
        console.warn('[plugin:openext-crm-suite] invoice print summary unavailable:', text(error && error.message, 200));
      }
    }
    return { ...print, linesTitle: print.linesTitle || text(terms.lines, 40), subtotalLabel: text(terms.subtotal, 40), summary };
  } catch {
    return null;
  }
}

/**
 * What the invoice page shows for a quotation before it is invoiced (read-only): the CRM's own facts
 * (lead, opportunity, primary contact) and the extension's (salesFlow.invoicePrefillRoute, e.g. booking,
 * destination, dates, travellers). Never changes anything.
 */
async function invoicePrefill(req, body = {}) {
  const quotationId = text(body.quotationId, 24);
  if (!ID_RE.test(quotationId)) throw badRequest('quotationId is required');
  const QuotationService = require('./quotation.service');
  const quotation = await QuotationService.getById(req, quotationId);
  const summary = [];
  const leadId = text(quotation.leadId && typeof quotation.leadId === 'object' ? quotation.leadId._id : quotation.leadId, 24);
  const opportunityId = text(quotation.opportunityId || quotation.dealId, 24);
  let contact = '';
  if (ID_RE.test(leadId)) {
    try {
      const lead = await require('./lead.service').getById(req, leadId, { includeQuality: false });
      summary.push({ icon: 'group', label: 'Lead', value: text(lead.name || lead.company, 120) });
      contact = text(lead.contactName || lead.name, 120);
    } catch {
      /* not visible to this user */
    }
  }
  if (ID_RE.test(opportunityId)) {
    try {
      const opportunity = await require('./opportunity.service').getById(req, opportunityId);
      summary.push({ icon: 'event', label: 'Opportunity', value: text(opportunity.title, 120) });
      if (opportunity.contactPerson) contact = text(opportunity.contactPerson, 120);
    } catch {
      /* not visible to this user */
    }
  }
  if (contact) summary.push({ icon: 'group', label: 'Primary contact', value: contact });

  const flow = await contract(req);
  let extensionSummary = [];
  if (flow && flow.invoicePrefillRoute) {
    const data = await call(req, flow.invoicePrefillRoute, { quotationId, leadId: ID_RE.test(leadId) ? leadId : '', opportunityId: ID_RE.test(opportunityId) ? opportunityId : '' });
    if (data && !data.failed) extensionSummary = cleanSummary(data.summary);
  }
  return { available: true, quotationId, summary: [...summary, ...extensionSummary].filter((s) => s.value).slice(0, 12) };
}

/**
 * salesFlow.fixedLines: a quotation's lines are rebuilt from the extension's prefill on every save —
 * service, description, quantity, unit, columns and group come from the source records; only the
 * rate, tax and "included" choice come from the user. A line the source does not offer is dropped.
 * Without fixed lines (or when the extension cannot be reached) the lines are returned unchanged.
 */
async function enforceFixedQuotationLines(req, items, ref = {}) {
  if (!Array.isArray(items) || !items.length) return items;
  const flow = await contract(req);
  if (!flow || !flow.fixedLines || !flow.lockQuotationLines || !flow.quotationPrefillRoute) return items;
  const leadId = text(ref.leadId, 24);
  const opportunityId = text(ref.opportunityId, 24);
  if (!ID_RE.test(leadId) && !ID_RE.test(opportunityId)) return items;
  let prefill;
  try {
    prefill = await quotationPrefill(req, { ...(ID_RE.test(leadId) ? { leadId } : {}), opportunityId: ID_RE.test(opportunityId) ? opportunityId : '' });
  } catch {
    return items;
  }
  if (!prefill || !prefill.available) return items;
  const bySource = new Map();
  const unsourced = [];
  for (const line of prefill.lines || []) {
    if (line.sourceRef) bySource.set(line.sourceRef, line);
    else unsourced.push(line);
  }
  const used = new Set();
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    let source = item.sourceRef ? bySource.get(String(item.sourceRef)) : null;
    if (!source && !item.sourceRef) {
      source = unsourced.find((l) => !used.has(l) && l.name === text(item.name, 200)) || null;
    }
    if (!source || used.has(source)) continue;
    used.add(source);
    const tax = Number(item.tax);
    out.push({
      ...item,
      name: source.name,
      description: source.description || source.name,
      qty: source.quantity,
      unit: source.unit || '',
      extra: { ...(source.extra || {}) },
      group: source.group || '',
      sourceRef: source.sourceRef || '',
      rate: Math.max(0, Number(item.rate) || 0),
      tax: Number.isFinite(tax) && tax >= 0 && tax <= 100 ? tax : source.tax !== undefined ? source.tax : 0
    });
  }
  if (!out.length) {
    throw badRequest('These lines do not come from the lead\'s requirements. Reload the page to load them again.');
  }
  return out;
}

/**
 * salesFlow.fixedLines on an opportunity whose lines came from the extension: an edit may change each
 * line's price and tax only; the service, description and quantity stay as they are, and no line is
 * added or removed.
 */
async function enforceFixedOpportunityLines(req, existing, incoming) {
  if (!Array.isArray(incoming)) return incoming;
  const flow = await contract(req);
  if (!flow || !flow.fixedLines || !flow.hideOpportunityLines) return incoming;
  if (!existing || !existing.leadId) return incoming;
  const current = Array.isArray(existing.products) ? existing.products : [];
  if (!current.length) return incoming;
  return current.map((line, index) => {
    const next = incoming[index];
    const same = next && String(next.productName || '').trim() === String(line.productName || '').trim();
    const unitPrice = same ? Number(next.unitPrice) : NaN;
    const tax = same ? Number(next.tax) : NaN;
    return {
      ...line,
      unitPrice: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : Number(line.unitPrice) || 0,
      tax: Number.isFinite(tax) && tax >= 0 && tax <= 100 ? tax : Number(line.tax) || 0
    };
  });
}

/* --------------------------------------------- 3.18.0: saved hooks (record saved → extension) */

/** Calls the extension's savedRoute. Never throws for an extension failure. */
async function notifySaved(req, route, body, what, options) {
  const { callActiveRoute } = require('../extension-runtime/runtime');
  try {
    const res = await callActiveRoute(req, 'POST', route, body, options);
    if (!res || res.available === false) return { ok: false, message: 'The extension is not available' };
    const data = res.data;
    if (isPlainObject(data) && data.ok === false) {
      return { ok: false, message: text(data.message, 300) || 'The extension did not accept the update' };
    }
    return { ok: true };
  } catch (error) {
    // No record data in the log: only which hook failed and the error's status.
    console.warn(`[plugin:openext-crm-suite] sales-flow ${what} hook failed (status ${Number(error && error.status) || 500})`);
    const status = Number(error && error.status);
    return { ok: false, message: status && status < 500 ? text(error.message, 300) : 'The extension could not be reached' };
  }
}

const idOf = (ref) => text(ref && typeof ref === 'object' ? ref._id : ref, 24);
const dateOf = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * A quotation was accepted (by the client, on the portal link, or by a payment): call the active
 * extension's salesFlow.quotationForm.acceptedRoute. It runs as the system (the client who accepted
 * holds no staff permissions), only for this declared route. Never throws.
 * @returns {{ ok: boolean, skipped?: boolean, message?: string }}
 */
async function quotationAccepted(req, quotation) {
  const def = await activeDef(req);
  const form = def && def.salesFlow && def.salesFlow.quotationForm;
  const route = isPlainObject(form) ? text(form.acceptedRoute, 200) : '';
  const quotationId = idOf(quotation);
  if (!route || !ID_RE.test(quotationId)) return { ok: true, skipped: true };
  return notifySaved(req, route, {
    quotationId,
    quotationNo: text(quotation.quotationNo, 80),
    status: text(quotation.status, 40),
    leadId: idOf(quotation.leadId),
    opportunityId: idOf(quotation.opportunityId || quotation.dealId),
    clientId: idOf(quotation.clientId)
  }, 'quotation-accepted', { system: true });
}

/** POST /sales-flow/opportunity-saved { opportunityId } → { ok } | { ok: false, message } | { ok: true, skipped: true } */
async function opportunitySaved(req, body = {}) {
  const opportunityId = text(body && body.opportunityId, 24);
  if (!ID_RE.test(opportunityId)) throw badRequest('opportunityId is not valid');
  const def = await activeDef(req);
  const form = def && def.salesFlow && def.salesFlow.opportunityForm;
  const route = isPlainObject(form) ? text(form.savedRoute, 200) : '';
  if (!route) return { ok: true, skipped: true };
  const opportunity = await require('./opportunity.service').getById(req, opportunityId);
  const { values } = await require('./crm-extension-values.service').getValues(req, 'opportunity', opportunityId);
  return notifySaved(req, route, {
    opportunityId,
    leadId: idOf(opportunity.leadId),
    title: text(opportunity.title, 200),
    stage: text(opportunity.stage, 80),
    expectedCloseDate: dateOf(opportunity.expectedCloseDate),
    value: num(opportunity.estimatedDealValue != null ? opportunity.estimatedDealValue : opportunity.expectedRevenue),
    currency: text(opportunity.currency, 10),
    values: values || {}
  }, 'opportunity-saved');
}

/** POST /sales-flow/quotation-saved { quotationId } → { ok } | { ok: false, message } | { ok: true, skipped: true } */
async function quotationSaved(req, body = {}) {
  const quotationId = text(body && body.quotationId, 24);
  if (!ID_RE.test(quotationId)) throw badRequest('quotationId is not valid');
  const def = await activeDef(req);
  const form = def && def.salesFlow && def.salesFlow.quotationForm;
  const route = isPlainObject(form) ? text(form.savedRoute, 200) : '';
  if (!route) return { ok: true, skipped: true };
  const quotation = await require('./quotation.service').getById(req, quotationId);
  const { values } = await require('./crm-extension-values.service').getValues(req, 'quotation', quotationId);
  return notifySaved(req, route, {
    quotationId,
    quotationNo: text(quotation.quotationNo, 80),
    version: Number(quotation.version) || 1,
    status: text(quotation.status, 40),
    leadId: idOf(quotation.leadId),
    opportunityId: idOf(quotation.opportunityId || quotation.dealId),
    grandTotal: num(quotation.grandTotal),
    currency: text(quotation.currency, 10),
    issueDate: dateOf(quotation.issueDate),
    expiryDate: dateOf(quotation.expiryDate),
    values: values || {},
    lines: (Array.isArray(quotation.lineItems) ? quotation.lineItems : []).slice(0, 200).map((line) => ({
      name: text(line && (line.name || line.description), 200),
      group: text(line && line.group, 40),
      quantity: num(line && (line.qty !== undefined ? line.qty : line.quantity)),
      unitPrice: num(line && (line.rate !== undefined ? line.rate : line.unitPrice)),
      unit: text(line && line.unit, 60),
      selected: !(line && line.selected === false),
      sourceRef: text(line && line.sourceRef, 64)
    }))
  }, 'quotation-saved');
}

/**
 * Revise: the new quotation version starts with a copy of the old version's declared quotation values
 * (only keys the active extension declares for record "quotation"). Never fails the revision.
 */
async function copyQuotationValues(req, fromDoc, toDoc) {
  try {
    const CrmExtensionService = require('./crm-extension.service');
    const def = await CrmExtensionService.getActive(req).catch(() => null);
    const groups = def && def.isInternal === false && def.manifestVersion === 2 && def.declarations && def.declarations.fields
      ? def.declarations.fields.quotation
      : null;
    if (!Array.isArray(groups) || !groups.length || !fromDoc || !toDoc) return false;
    const keys = new Set(groups.flatMap((g) => (g && Array.isArray(g.fields) ? g.fields : [])).map((f) => f && f.key).filter(Boolean));
    const RecordValues = require('../extension-runtime/record-values');
    const stored = await RecordValues.read(req, def.id, 'quotation', fromDoc);
    const copy = {};
    for (const [key, value] of Object.entries(stored || {})) if (keys.has(key) && value !== undefined) copy[key] = value;
    if (!Object.keys(copy).length) return false;
    await RecordValues.write(req, def.id, 'quotation', toDoc, copy);
    return true;
  } catch (error) {
    console.warn('[plugin:openext-crm-suite] quotation revision: declared values were not copied (status ' + (Number(error && error.status) || 500) + ')');
    return false;
  }
}

/** The active extension's switches for record rules (no shipping, contact locked); {} without one. */
async function recordRules(req) {
  const flow = await contract(req).catch(() => null);
  return {
    hideShipping: Boolean(flow && flow.hideShipping),
    lockOpportunityContact: Boolean(flow && flow.lockOpportunityContact),
    invoiceFromQuotation: Boolean(flow && flow.invoiceFromQuotation),
    lockOpportunityOnAccept: Boolean(flow && flow.lockOpportunityOnAccept),
    lockConvertedLead: Boolean(flow && flow.lockConvertedLead),
    completeOpportunitiesOnConversion: Boolean(flow && flow.completeOpportunitiesOnConversion),
    lockWonLead: Boolean(flow && flow.lockWonLead)
  };
}

/**
 * After a verified payment on a quotation (its payment request or tax invoice): tell the active extension
 * (salesFlow.quotationForm.paidRoute), e.g. to start a booking once the payment rule allows it.
 * Never throws — the payment stands.
 */
async function quotationPaid(req, quotationId) {
  try {
    const id = String(quotationId || '').trim();
    if (!ID_RE.test(id)) return { ok: true, skipped: true };
    const def = await activeDef(req);
    const form = def && def.salesFlow && def.salesFlow.quotationForm;
    const route = isPlainObject(form) ? text(form.paidRoute, 200) : '';
    if (!route) return { ok: true, skipped: true };
    const Estimate = req.cms?.models?.get?.('Estimate');
    const found = Estimate ? Estimate.findOne({ tenantId: require('../utils/tenant.util').resolveTenantId(req), _id: id, isDeleted: { $ne: true } }) : null;
    const quotation = found && typeof found.lean === 'function' ? await found.lean() : await found;
    if (!quotation) return { ok: true, skipped: true };
    return await notifySaved(req, route, {
      quotationId: id,
      quotationNo: text(quotation.quotationNo, 80),
      status: text(quotation.status, 40),
      leadId: idOf(quotation.leadId),
      opportunityId: idOf(quotation.opportunityId || quotation.dealId),
      clientId: idOf(quotation.clientId)
    }, 'quotation-paid', { system: true });
  } catch (err) {
    console.warn('[plugin:openext-crm-suite] quotation paid hook failed:', err?.message || err);
    return { ok: false };
  }
}

/* ------------------------------------- 3.32.0: commercial dates of a quotation (Issue Date, Valid Till) */

/**
 * The active extension's limits for a quotation's dates (salesFlow.quotationDatesRoute), e.g. a travel
 * quotation is not valid after the trip starts: { issueDateMin?, validTillMax?, validTillMaxLabel? }
 * (days "YYYY-MM-DD"). `leadValues` lets the extension judge values that are about to be saved.
 * {} when the extension has no such route; also {} when it cannot answer (an extension failure never
 * blocks the save).
 */
async function quotationDateRules(req, { leadId = '', opportunityId = '', leadValues } = {}) {
  const flow = await contract(req).catch(() => null);
  const route = flow && text(flow.quotationDatesRoute, 200);
  const lead = text(leadId, 24);
  const opp = text(opportunityId, 24);
  if (!route || (!ID_RE.test(lead) && !ID_RE.test(opp))) return {};
  const { callActiveRoute } = require('../extension-runtime/runtime');
  try {
    const body = { leadId: ID_RE.test(lead) ? lead : '', opportunityId: ID_RE.test(opp) ? opp : '' };
    if (isPlainObject(leadValues)) body.leadValues = leadValues;
    const res = await callActiveRoute(req, 'POST', route, body, { system: true });
    const data = res && res.available !== false && isPlainObject(res.data) ? res.data : {};
    const out = {};
    if (cleanDate(data.issueDateMin)) out.issueDateMin = cleanDate(data.issueDateMin);
    if (cleanDate(data.validTillMax)) {
      out.validTillMax = cleanDate(data.validTillMax);
      out.validTillMaxLabel = text(data.validTillMaxLabel, 60) || 'the latest allowed date';
    }
    return out;
  } catch (error) {
    console.warn(`[plugin:openext-crm-suite] sales-flow quotation dates unavailable (status ${Number(error && error.status) || 500})`);
    return {};
  }
}

/**
 * Problems with a quotation's Issue Date / Valid Till (days "YYYY-MM-DD"), as
 * [{ field: 'issueDate' | 'validTill', message }]. Always: Valid Till not before Issue Date. With the
 * extension's rules: Issue Date not before issueDateMin (checkIssueMin: a new quotation, or a changed
 * issue date) and Valid Till not after validTillMax.
 */
function quotationDateProblems({ issueDate, validTill, rules = {}, checkIssueMin = false }) {
  const { prettyDay } = require('../utils/date-only.util');
  const out = [];
  if (checkIssueMin && rules.issueDateMin && issueDate && issueDate < rules.issueDateMin) {
    out.push({ field: 'issueDate', message: `Issue Date cannot be before ${prettyDay(rules.issueDateMin)}.` });
  }
  if (issueDate && validTill && validTill < issueDate) {
    out.push({ field: 'validTill', message: 'Valid Till cannot be before Issue Date.' });
  }
  if (rules.validTillMax && validTill && validTill > rules.validTillMax) {
    out.push({ field: 'validTill', message: `Valid Till cannot be after ${rules.validTillMaxLabel || 'the latest allowed date'} (${prettyDay(rules.validTillMax)}).` });
  }
  return out;
}

/** 400 INVALID_QUOTATION_DATES with field-level details when the dates break a rule. */
function assertQuotationDates(input) {
  const problems = quotationDateProblems(input);
  if (!problems.length) return;
  const error = new Error(problems.map((p) => p.message).join(' '));
  error.status = 400;
  error.code = 'INVALID_QUOTATION_DATES';
  error.details = problems.map((p) => p.message);
  error.fields = Object.fromEntries(problems.map((p) => [p.field, p.message]));
  throw error;
}

/**
 * Lead values are about to change: Draft quotations of the lead whose Valid Till would break the
 * extension's rule with the new values (e.g. the trip's new start date). Sent / Accepted quotations are
 * history: never judged or changed here. [] without a quotationDatesRoute.
 */
async function draftQuotationDateErrors(req, leadId, leadValues) {
  const flow = await contract(req).catch(() => null);
  if (!flow || !flow.quotationDatesRoute || !ID_RE.test(String(leadId || ''))) return [];
  const Estimate = req.cms?.models?.get?.('Estimate');
  if (!Estimate) return [];
  const { resolveTenantId } = require('../utils/tenant.util');
  const { dayOf, prettyDay } = require('../utils/date-only.util');
  const query = Estimate.find({ tenantId: resolveTenantId(req), leadId: String(leadId), status: 'Draft', isDeleted: { $ne: true } });
  const limited = query && typeof query.limit === 'function' ? query.limit(50) : query;
  const drafts = (limited && typeof limited.lean === 'function' ? await limited.lean() : await limited) || [];
  const errors = [];
  const byOpportunity = new Map();
  for (const q of drafts) {
    const opp = idOf(q.opportunityId || q.dealId);
    if (!byOpportunity.has(opp)) byOpportunity.set(opp, await quotationDateRules(req, { leadId, opportunityId: opp, leadValues }));
    const rules = byOpportunity.get(opp);
    const validTill = dayOf(q.expiryDate);
    if (rules.validTillMax && validTill && validTill > rules.validTillMax) {
      const no = text(q.quotationNo, 40);
      errors.push(`Draft quotation${no ? ` ${no}` : ''} is valid till ${prettyDay(validTill)}, after the new ${rules.validTillMaxLabel || 'limit'} (${prettyDay(rules.validTillMax)}). Change its Valid Till first.`);
    }
  }
  return errors.slice(0, 10);
}

/* ----------------------------- 3.34.0: quotation for a client through the extension (clientQuotation) */

function clientQuotationContract(flow) {
  const cq = flow && isPlainObject(flow.clientQuotation) ? flow.clientQuotation : null;
  if (!cq) {
    const error = new Error('Quotations for clients are not offered by the active extension');
    error.status = 404;
    throw error;
  }
  return cq;
}

const routeFor = (path, id) => String(path).replace(/:[a-z][a-z0-9_]*/i, encodeURIComponent(id));

async function callRoute(req, method, path, body) {
  const { callActiveRoute } = require('../extension-runtime/runtime');
  const res = await callActiveRoute(req, method, path, body);
  return res && res.available !== false && isPlainObject(res.data) ? res.data : {};
}

/** GET: the clients a quotation may be made for now → { clientIds }. */
async function clientQuotationEligible(req) {
  const cq = clientQuotationContract(await contract(req));
  const data = await callRoute(req, 'GET', cq.eligibleRoute);
  const ids = (Array.isArray(data.clientIds) ? data.clientIds : []).map((v) => text(v, 24)).filter((v) => ID_RE.test(v));
  return { clientIds: [...new Set(ids)].slice(0, 2000) };
}

/** GET: what the user picks before the quotation (e.g. who travels), cleaned. */
async function clientQuotationPicker(req, clientId) {
  const id = text(clientId, 24);
  if (!ID_RE.test(id)) throw badRequest('clientId is not valid');
  const cq = clientQuotationContract(await contract(req));
  const data = await callRoute(req, 'GET', routeFor(cq.pickerRoute, id));
  const items = (Array.isArray(data.items) ? data.items : []).slice(0, 200).map((i) => ({
    id: text(i && i.id, 60),
    label: text(i && i.label, 120),
    detail: text(i && i.detail, 200),
    checked: Boolean(i && i.checked),
    disabled: Boolean(i && i.disabled),
    hint: text(i && i.hint, 200)
  })).filter((i) => i.id && i.label);
  const min = Number.isInteger(Number(data.min)) ? Math.max(0, Math.min(50, Number(data.min))) : 1;
  const emptyLink = isPlainObject(data.emptyLink) && /^\/[\w/?=&%.-]{1,200}$/.test(String(data.emptyLink.link || '')) && !String(data.emptyLink.link).includes('//')
    ? { label: text(data.emptyLink.label, 60) || 'Open', link: String(data.emptyLink.link) }
    : null;
  return {
    eligible: data.eligible !== false,
    message: text(data.message, 300),
    title: text(data.title, 80) || 'Choose',
    intro: text(data.intro, 300),
    submitLabel: text(data.submitLabel, 40) || 'Continue',
    min,
    items,
    emptyText: text(data.emptyText, 200),
    ...(emptyLink ? { emptyLink } : {})
  };
}

/** POST: the extension prepares the quotation's lead / opportunity → { leadId, opportunityId }. */
async function clientQuotationStart(req, clientId, body = {}) {
  const id = text(clientId, 24);
  if (!ID_RE.test(id)) throw badRequest('clientId is not valid');
  const cq = clientQuotationContract(await contract(req));
  const selected = (Array.isArray(body.selected) ? body.selected : []).map((v) => text(v, 60)).filter(Boolean).slice(0, 200);
  const data = await callRoute(req, 'POST', routeFor(cq.startRoute, id), { selected });
  const leadId = text(data.leadId, 24);
  const opportunityId = text(data.opportunityId, 24);
  if (!ID_RE.test(opportunityId) && !ID_RE.test(leadId)) {
    const error = new Error(text(data.message, 300) || 'The quotation could not be prepared');
    error.status = 409;
    throw error;
  }
  return { leadId: ID_RE.test(leadId) ? leadId : '', opportunityId: ID_RE.test(opportunityId) ? opportunityId : '' };
}

module.exports = { clientQuotationEligible, clientQuotationPicker, clientQuotationStart, quotationDateRules, quotationDateProblems, assertQuotationDates, draftQuotationDateErrors, quotationPaid, invoicePrefill, invoicePrintContext, invoicePrintOf, recordRules, cleanNotices, enforceFixedQuotationLines, enforceFixedOpportunityLines, cleanFacts, cleanValueConfirms, config, opportunityLinkTypes, opportunityStartStage, opportunitySaved, quotationSaved, quotationAccepted, copyQuotationValues, orderLinesByGroup, orderByGroup, cleanChecks, opportunityPrefill, quotationPrefill, cleanLineExtras, printNotes, publicQuotation, publicLines, cleanSummary, cleanLineOptions, cleanLines, cleanSections, cleanValues, cleanWarnings, cleanPanels, contract };
