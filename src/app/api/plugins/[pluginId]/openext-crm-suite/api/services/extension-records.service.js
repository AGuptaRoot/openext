'use strict';

/**
 * Core records an extension may create for the signed-in user (CRM 3.34.0, through the SDK). Every step
 * goes through the CRM's own services, so their permission, tenant, duplicate and workflow rules apply.
 *
 *   createLeadForClient(req, clientId, { title })     a new enquiry (lead) for an existing client: its
 *                                                       primary contact (else the client) is the lead contact
 *   createOpportunityForLead(req, leadId, { title })   the lead's open opportunity, or a new one built from
 *                                                       the active extension's opportunity prefill
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
  return { id: String(lead._id), title: text(lead.title, 200), stage: text(lead.stage, 80) };
}

async function createOpportunityForLead(req, leadId, { title = '' } = {}) {
  const id = text(leadId, 24);
  if (!ID_RE.test(id)) throw badRequest('A lead is required');
  const OpportunityService = require('./opportunity.service');
  const Opportunity = req.cms?.models?.get?.('Opportunity');
  if (Opportunity) {
    const { resolveTenantId } = require('../utils/tenant.util');
    const q = Opportunity.find({ tenantId: resolveTenantId(req), leadId: id, isDeleted: { $ne: true } });
    const rows = (q && typeof q.lean === 'function' ? await q.lean() : await q) || [];
    const open = rows.find((o) => !o.acceptedQuotationId && !['WON', 'LOST'].includes(String(o.stageType || '').toUpperCase()));
    if (open) return { id: String(open._id), title: text(open.title, 200), created: false };
  }
  const SalesFlow = require('./sales-flow.service');
  const prefill = await SalesFlow.opportunityPrefill(req, { leadId: id }).catch(() => ({ available: false }));
  const closeDate = prefill.available && prefill.expectedCloseDate ? prefill.expectedCloseDate : '';
  const created = await OpportunityService.create(req, {
    leadId: id,
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

module.exports = { createLeadForClient, createOpportunityForLead };
