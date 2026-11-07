'use strict';

const { resolveTenantId } = require('./tenant.util');

/**
 * Customer snapshot (CRM 3.35.0): the customer / contact details a record had when it was created.
 *
 * Contact / Client / Lead master = current data. A quotation, invoice, proforma, sales order or opportunity
 * keeps the snapshot taken at its creation, so a later change of the master (e.g. the Contact's Company
 * Name) never rewrites what the old record shows. Records created before 3.35.0 have no snapshot and are
 * left untouched; they keep showing the current master data.
 */

function str(value, max = 200) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function getModel(req, ...names) {
  for (const name of names) {
    const model = req?.cms?.models?.get?.(name) || req?.storage?.db?.models?.[name];
    if (model) return model;
  }
  return null;
}

async function findOneLean(model, filter) {
  if (!model || typeof model.findOne !== 'function') return null;
  const q = model.findOne(filter);
  return q && typeof q.lean === 'function' ? q.lean() : q;
}

function tenantClause(req) {
  const tenantId = resolveTenantId(req);
  return tenantId === 'default' ? { $in: ['default', null, undefined, ''] } : tenantId;
}

/**
 * The snapshot for a client and / or lead: the client when there is one (the billed customer), else the
 * lead (its company and contact as entered for that enquiry). Never throws: null when nothing is found.
 */
async function captureCustomerSnapshot(req, { clientId, leadId } = {}) {
  const cid = str(clientId, 64);
  const lid = str(leadId, 64);
  if (!cid && !lid) return null;
  try {
    const tenantId = tenantClause(req);
    const [client, lead] = await Promise.all([
      cid ? findOneLean(getModel(req, 'Company', 'Client'), { tenantId, _id: cid }) : null,
      lid ? findOneLean(getModel(req, 'Lead'), { tenantId, _id: lid }) : null
    ]);
    if (client) {
      return {
        type: 'client',
        name: str(client.name || client.companyName),
        company: str(client.name || client.companyName),
        contactName: str(lead?.name || client.billingAddress?.contactPerson, 120),
        contactId: str(lead?.contactId, 64),
        email: str(client.email || client.officialEmail || lead?.email, 120),
        phone: str(client.phone || lead?.phone, 20),
        capturedAt: new Date()
      };
    }
    if (lead) {
      return {
        type: 'lead',
        name: str(lead.company || lead.contactName || lead.name),
        company: str(lead.company),
        contactName: str(lead.name || lead.contactName, 120),
        contactId: str(lead.contactId, 64),
        email: str(lead.email, 120),
        phone: str(lead.phone, 20),
        capturedAt: new Date()
      };
    }
  } catch {
    // Best effort: a record is never refused because its snapshot could not be read.
  }
  return null;
}

/** `data` with `customerSnapshot` captured from its clientId / leadId (a snapshot already given is kept). */
async function withCustomerSnapshot(req, data) {
  if (!data || typeof data !== 'object' || data.customerSnapshot) return data;
  const snapshot = await captureCustomerSnapshot(req, { clientId: data.clientId, leadId: data.leadId });
  return snapshot ? { ...data, customerSnapshot: snapshot } : data;
}

/** The snapshot of a stored record, or null (records from before 3.35.0). */
function snapshotOf(row) {
  const s = row && row.customerSnapshot;
  return s && typeof s === 'object' && str(s.name) ? s : null;
}

module.exports = { captureCustomerSnapshot, withCustomerSnapshot, snapshotOf };
