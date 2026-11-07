'use strict';

/**
 * Won lead lock (CRM 3.34.0, manifest salesFlow.lockWonLead): once a lead is Won (its stage is the
 * pipeline's Won stage) or converted into a client, nobody changes it any more — details, activities,
 * notes, follow-ups, products, contracts, photo, extension field values, new opportunities or
 * quotations from it. Its data stays readable. Without the switch nothing is locked.
 *
 * System steps of the CRM (an accepted quotation marking the lead Won and converting it) call the
 * services directly and are not affected; the HTTP guard covers user requests.
 */

const ID_RE = /^[a-f0-9]{24}$/i;

function lockedError() {
  const error = new Error('This lead is Won and locked: its details can be viewed but not changed.');
  error.status = 409;
  error.code = 'LEAD_LOCKED';
  return error;
}

async function lockOn(req) {
  try {
    const flow = await require('../services/sales-flow.service').contract(req);
    return Boolean(flow && flow.lockWonLead);
  } catch {
    return false;
  }
}

/** The pipeline's Won stage name for this tenant. */
async function wonStage(req) {
  const SettingService = require('../services/setting.service');
  try {
    return SettingService.resolveWonStage(await SettingService.getPipelineStages(req));
  } catch {
    return 'Won';
  }
}

/** True when a lead document is Won or converted. */
function isWonLead(lead, won = 'Won') {
  if (!lead) return false;
  if (lead.convertedClientId) return true;
  const stage = String(lead.stage || '').trim().toLowerCase();
  return Boolean(stage) && (stage === String(won || 'Won').trim().toLowerCase() || stage === 'won');
}

async function findLead(req, leadId) {
  const id = String(leadId || '').trim();
  if (!ID_RE.test(id)) return null;
  const Lead = req.cms?.models?.get?.('Lead');
  if (!Lead) return null;
  const { resolveTenantId } = require('./tenant.util');
  const q = Lead.findOne({ tenantId: resolveTenantId(req), _id: id, isDeleted: { $ne: true } });
  return q && typeof q.lean === 'function' ? q.lean() : q;
}

/** Whether the lead is locked (switch on and the lead Won / converted). */
async function isLocked(req, leadId) {
  if (!(await lockOn(req))) return false;
  const lead = await findLead(req, leadId);
  return isWonLead(lead, await wonStage(req));
}

/** 409 LEAD_LOCKED when the lead is locked. */
async function assertEditable(req, leadId) {
  if (await isLocked(req, leadId)) throw lockedError();
}

// Lead paths a user may still post to: converting a Won lead into a client.
const ALLOWED_TAILS = [/^\/convert\/?$/];
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The lead a write request is about ('' when none): /leads/:id…, /activities/:id… (an activity's lead). */
async function leadOfRequest(req) {
  const path = String(req.path || req.url || '').split('?')[0].replace(/^\/api(?=\/)/, '');
  let m = /^\/leads\/([a-f0-9]{24})(\/.*)?$/i.exec(path);
  if (m) return ALLOWED_TAILS.some((re) => re.test(m[2] || '')) ? '' : m[1];
  m = /^\/activities\/([a-f0-9]{24})(\/.*)?$/i.exec(path);
  if (m) {
    const LeadEvent = req.cms?.models?.get?.('LeadEvent');
    if (!LeadEvent) return '';
    const { resolveTenantId } = require('./tenant.util');
    const q = LeadEvent.findOne({ tenantId: resolveTenantId(req), _id: m[1] });
    const event = q && typeof q.lean === 'function' ? await q.lean() : await q;
    return event ? String(event.leadId || '') : '';
  }
  m = /^\/crm-extension-data\/values\/lead\/([a-f0-9]{24})\/?$/i.exec(path);
  if (m) return m[1];
  m = /^\/contracts\/from-lead\/([a-f0-9]{24})\/?$/i.exec(path);
  if (m) return m[1];
  return '';
}

/** Middleware: refuses user writes to a locked lead (409 LEAD_LOCKED). */
async function guard(req, res, next) {
  try {
    if (WRITE_METHODS.has(String(req.method || '').toUpperCase())) {
      const leadId = await leadOfRequest(req);
      if (leadId && (await isLocked(req, leadId))) {
        const error = lockedError();
        res.status(409).json({ success: false, error: error.message, code: error.code });
        return;
      }
    }
  } catch {
    /* the lock never breaks a request it cannot judge */
  }
  await next();
}

module.exports = { isWonLead, isLocked, assertEditable, guard, leadOfRequest, lockedError };
