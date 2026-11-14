'use strict';

/**
 * Core records an extension may create for the signed-in user (CRM 3.34.0, through the SDK). Every step
 * goes through the CRM's own services, so their permission, tenant, duplicate and workflow rules apply.
 *
 *   createLeadForClient(req, clientId, { title })     a new enquiry (lead) for an existing client: its
 *                                                       primary contact (else the client) is the lead contact
 *   createOpportunityForLead(req, leadId, { title, clientId })  the lead's open opportunity, or a new one built
 *                                                       from the active extension's opportunity prefill;
 *                                                       clientId (3.44.0): the client the deal is for (a
 *                                                       quotation made for a client stays that client's)
 */

const { resolveUserId } = require('../utils/tenant.util');

const text = (v, max) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const ID_RE = /^[a-f0-9]{24}$/i;

function badRequest(message, code = 'INVALID_INPUT') {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

async function createLeadForClient(req, clientId, { title = '' } = {}) {
  const id = text(clientId, 24);
  if (!ID_RE.test(id)) throw badRequest('A client is required');
  const ClientService = require('./client.service');
  const LeadService = require('./lead.service');
  const client = await ClientService.getById(req, id, { includeQuality: false });
  const contacts = await ClientService.listContacts(req, id).catch(() => []);
  const primary = (contacts || [])[0] || null;
  const name = text(primary && primary.name, 120) || text(client.name, 120);
  const email = text(primary && primary.email, 160) || text(client.email, 160);
  const phone = text(primary && (primary.phone || primary.mobile), 40) || text(client.phone, 40);
  if (!email || !phone) {
    throw badRequest('Add an email and a mobile number to this client (or its primary contact) first.', 'CLIENT_CONTACT_MISSING');
  }
  const lead = await LeadService.create(req, {
    title: text(title, 200),
    name,
    email,
    phone,
    company: text(client.name, 200) || name,
    contactId: text(primary && primary.personContactId, 24),
    assignedTo: String(resolveUserId(req) || ''),
    // The client's own contact: another enquiry of the same person is expected.
    allowExactDuplicate: true,
    allowSimilarCompany: true,
    confirmDifferentCompany: true
  });
  await markEnquiryForClient(req, String(lead._id), id);
  return { id: String(lead._id), title: text(lead.title, 200), stage: text(lead.stage, 80) };
}

/**
 * CRM 3.45.0: records that an open, not converted lead is an enquiry of an existing client (only when it
 * has no client yet; never moves one to another client). Returns true when the lead is that client's.
 */
async function markEnquiryForClient(req, leadId, clientId) {
  const Lead = req.cms?.models?.get?.('Lead');
  const lid = text(leadId, 24);
  const cid = text(clientId, 24);
  if (!Lead || !ID_RE.test(lid) || !ID_RE.test(cid)) return false;
  const { resolveTenantId } = require('../utils/tenant.util');
  const tenantId = resolveTenantId(req);
  await Lead.updateOne(
    { tenantId, _id: lid, isDeleted: { $ne: true }, convertedClientId: null, forClientId: null },
    { $set: { forClientId: cid } }
  );
  const q = Lead.findOne({ tenantId, _id: lid });
  const row = q && typeof q.lean === 'function' ? await q.lean() : await q;
  return Boolean(row && String(row.forClientId || '') === cid);
}

async function createOpportunityForLead(req, leadId, { title = '', clientId = '' } = {}) {
  const id = text(leadId, 24);
  if (!ID_RE.test(id)) throw badRequest('A lead is required');
  const forClient = text(clientId, 24);
  if (forClient && !ID_RE.test(forClient)) throw badRequest('clientId is not valid');
  if (forClient) await require('./client.service').getById(req, forClient, { includeQuality: false });
  const OpportunityService = require('./opportunity.service');
  const Opportunity = req.cms?.models?.get?.('Opportunity');
  if (Opportunity) {
    const { resolveTenantId } = require('../utils/tenant.util');
    const q = Opportunity.find({ tenantId: resolveTenantId(req), leadId: id, isDeleted: { $ne: true } });
    const rows = (q && typeof q.lean === 'function' ? await q.lean() : await q) || [];
    const open = rows.find((o) => !o.acceptedQuotationId && !['WON', 'LOST'].includes(String(o.stageType || '').toUpperCase()));
    if (open) {
      const has = open.clientId ? String(open.clientId._id || open.clientId) : '';
      if (forClient && has && has !== forClient) throw badRequest('The lead’s open opportunity belongs to another client', 'OPPORTUNITY_MISMATCH');
      // Fills an empty client only (never replaces one).
      if (forClient && !has) {
        const { resolveTenantId } = require('../utils/tenant.util');
        await Opportunity.updateOne({ _id: open._id, tenantId: resolveTenantId(req) }, { $set: { clientId: forClient } });
      }
      return { id: String(open._id), title: text(open.title, 200), created: false };
    }
  }
  const SalesFlow = require('./sales-flow.service');
  const prefill = await SalesFlow.opportunityPrefill(req, { leadId: id }).catch(() => ({ available: false }));
  const closeDate = prefill.available && prefill.expectedCloseDate ? prefill.expectedCloseDate : '';
  const created = await OpportunityService.create(req, {
    leadId: id,
    ...(forClient ? { clientId: forClient } : {}),
    title: text(title, 200) || (prefill.available && prefill.title) || 'Opportunity',
    ...(closeDate ? { expectedCloseDate: closeDate } : {}),
    ...(prefill.available && prefill.dealValue !== null && prefill.dealValue !== undefined ? { estimatedDealValue: prefill.dealValue } : {}),
    products: []
  });
  const oppId = String(created._id);
  // The extension's own values for the opportunity (trip details …), then its saved hook.
  if (prefill.available && prefill.values && Object.keys(prefill.values).length) {
    const Values = require('./crm-extension-values.service');
    await Values.setValues(req, 'opportunity', oppId, prefill.values).catch(() => null);
  }
  return { id: oppId, title: text(created.title, 200), created: true };
}

/**
 * CRM 3.47.0 — does this lead have any quotation (made on the lead, or on one of its opportunities)?
 * Yes / no only, counted over the whole tenant: a sales rep's own view of quotations (only the ones they
 * created) must not hide a colleague's quotation from a business rule. Deleted quotations do not count.
 */
async function leadHasQuotation(req, leadId) {
  const id = text(leadId, 24);
  if (!ID_RE.test(id)) return false;
  const { resolveTenantId } = require('../utils/tenant.util');
  const tenantId = resolveTenantId(req);
  const Estimate = req.cms?.models?.get?.('Estimate');
  if (!Estimate) return false;
  const Opportunity = req.cms?.models?.get?.('Opportunity');
  let opportunityIds = [];
  if (Opportunity) {
    const q = Opportunity.find({ tenantId, leadId: id, isDeleted: { $ne: true } });
    const rows = await (q && typeof q.select === 'function' ? q.select('_id').lean() : q);
    opportunityIds = (Array.isArray(rows) ? rows : []).map((r) => String(r._id));
  }
  const or = [{ leadId: id }];
  if (opportunityIds.length) or.push({ opportunityId: { $in: opportunityIds } }, { dealId: { $in: opportunityIds } });
  const count = await Estimate.countDocuments({ tenantId, isDeleted: { $ne: true }, $or: or });
  return count > 0;
}

module.exports = { createLeadForClient, createOpportunityForLead, markEnquiryForClient, leadHasQuotation };
