'use strict';

/**
 * Client → Travellers tab (2.14.0) and the passport alert job.
 *
 * GET  /clients/:client_id/travellers   every traveller of the client: the travellers of the leads it was
 *                                      converted from (and of its opportunities' leads), one row per person
 *                                      (a person copied onto several leads shows once) → { travellers, count }.
 *                                      Travellers stay on their leads: conversion copies nothing, so there is
 *                                      nothing to duplicate. A sales agent sees the travellers of their own
 *                                      leads only. No document numbers.
 * POST /passport-alerts/sweep          the daily "Passport Expiry Alert" job (manifest `schedules`, run by the
 *                                      CRM as the system) → { sent, checked }
 */

const store = require('../services/traveller-store.js');
const alerts = require('../services/passport-alerts.js');
const rules = require('../services/traveller-rules.js');
const leadAccess = require('../services/lead-access.js');

const { str, ID_RE } = store;
const MAX_ROWS = 500;

/** Leads of a client: converted into it, and the leads of its opportunities. */
async function clientLeadIds(sdk, clientId) {
  const leads = await sdk.crm.leads.find({ convertedClientId: clientId }, { limit: 100 });
  const ids = leads.map((l) => str(l._id)).filter((id) => ID_RE.test(id));
  try {
    const opportunities = await sdk.crm.opportunities.find({ clientId }, { limit: 100 });
    for (const o of opportunities) if (ID_RE.test(str(o.leadId)) && !ids.includes(str(o.leadId))) ids.push(str(o.leadId));
  } catch {
    /* no opportunity read permission: the converted leads only */
  }
  return { ids, leads };
}

async function contactNames(sdk, ids) {
  const out = new Map();
  const list = [...new Set(ids.map(str).filter((id) => ID_RE.test(id)))].slice(0, 200);
  for (const id of list) {
    const c = await store.contactSummary(sdk, id);
    if (c) out.set(id, c.name);
  }
  return out;
}

exports.forClient = async (req, sdk) => {
  const clientId = str(req.params && req.params.client_id);
  if (!ID_RE.test(clientId)) throw sdk.error(400, 'client_id is not valid', 'INVALID_INPUT');
  const { ids } = await clientLeadIds(sdk, clientId);
  if (!ids.length) return { travellers: [], count: 0 };
  const where = await leadAccess.withVisibleLeads(sdk, { lead_id: { $in: ids } });
  const rows = await sdk.models.Traveller.find(where, { limit: MAX_ROWS, sort: { updatedAt: -1 } });
  // One row per person: the most recently changed record of a profile.
  const people = new Map();
  for (const row of rows) {
    const key = store.profileOf(row) || str(row._id);
    if (!people.has(key)) people.set(key, row);
  }
  const today = rules.todayIso(undefined, await store.timeZone(sdk));
  const contacts = await contactNames(sdk, [...people.values()].map((r) => r.contact_id));
  const travellers = [...people.values()]
    .map((row) => {
      const expiry = str(row.passport_expiry_date).slice(0, 10);
      const age = rules.ageInfo({ dob: str(row.dob).slice(0, 10), yearOfBirth: row.year_of_birth }, today);
      return {
        id: str(row._id),
        name: alerts.fullName(row),
        contact: contacts.get(str(row.contact_id)) || '',
        relation: str(row.relation),
        ageCategory: age.ageCategory || str(row.age_category),
        nationality: str(row.nationality),
        passportStatus: alerts.passportStatus(expiry, today),
        passportExpiry: rules.isValidDate(expiry) ? expiry : '',
        link: alerts.travellerLink(row)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { travellers, count: travellers.length };
};

exports.sweep = async (req, sdk) => alerts.sweep(sdk);
