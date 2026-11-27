'use strict';

/**
 * CRM 3.59.0 — the CRM's own alerts (the bell + a phone push through notification.service → push.service):
 *
 *   leadAssigned(req, lead, previousAssignee)       → the new owner (not when you assign to yourself)
 *   leadsAssigned(req, leadIds, assignedTo)         → one summary alert for a bulk assignment
 *   quotationAccepted(req, quotation)               → its creator and the lead's owner
 *   paymentReceived(req, { payment, invoice })      → the invoice / quotation creator and the lead's owner
 *   portalApprovalNeeded(req, { access, client, lead }) → the tenant's CRM / Sales Managers
 *   followUpSweep(cms)                              → hourly: follow-ups due within the hour, and missed ones
 *
 * Every helper is best-effort: it never throws and never slows the action (alerts are sent after it).
 * The person who did the action is not alerted about it. Messages hold names, numbers and amounts that
 * the user may see in the CRM anyway — never document numbers (PAN, Aadhaar, passport) or passwords.
 */

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');

const ID_RE = /^[a-f0-9]{24}$/i;
const text = (v, max = 120) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max);
const settle = async (q) => (q && typeof q.lean === 'function' ? q.lean() : q);

function model(req, name) {
  return req && req.cms && req.cms.models && typeof req.cms.models.get === 'function' ? req.cms.models.get(name) : null;
}

/** Recipients: real user ids, without the person who did the action, max 20. */
function recipients(req, ids) {
  const actor = String(resolveUserId(req) || '');
  return [...new Set((ids || []).map((v) => String(v || '').trim()).filter((v) => ID_RE.test(v) && v !== actor))].slice(0, 20);
}

async function send(req, userIds, alert) {
  const to = recipients(req, userIds);
  if (!to.length) return { sent: 0 };
  try {
    return await require('./notification.service').notify(req, { ...alert, userIds: to });
  } catch {
    return { sent: 0 };
  }
}

async function leadOf(req, leadId) {
  const id = String(leadId || '');
  const Lead = model(req, 'Lead');
  if (!Lead || !ID_RE.test(id)) return null;
  const q = Lead.findOne({ _id: id, tenantId: resolveTenantId(req) });
  return settle(q && typeof q.select === 'function' ? q.select('_id name company assignedTo') : q).catch(() => null);
}

function leadLabel(lead) {
  if (!lead) return '';
  const name = text(lead.name, 80);
  const company = text(lead.company, 80);
  return company && company.toLowerCase() !== name.toLowerCase() ? `${name} – ${company}` : name || company;
}

/* ------------------------------------------------------------------ leads */

async function leadAssigned(req, lead, previousAssignee = '') {
  try {
    const to = String((lead && lead.assignedTo) || '');
    if (!to || to === String(previousAssignee || '')) return { sent: 0 };
    return await send(req, [to], {
      type: 'lead_assigned',
      title: 'New lead assigned to you',
      message: leadLabel(lead),
      link: `/leads/${lead._id}`,
      linkLabel: 'Open lead',
      key: `lead_assigned:${lead._id}:${to}:${Date.now()}`
    });
  } catch {
    return { sent: 0 };
  }
}

/**
 * CRM 3.64.7: a task (or subtask) is assigned to someone → "New task assigned to you" in their alerts and on
 * their phones / browsers (type task_assigned, switchable on My Alerts). Not when the assignee is unchanged,
 * nor to the person who made the change (assigning yourself sends nothing).
 */
function dueText(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : `due ${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
}

async function taskAssigned(req, task, previousAssignee = '', { project = null, subtask = null } = {}) {
  try {
    const to = String((subtask ? subtask.assignedTo : task && task.assignedTo) || '').trim();
    if (!task || !task._id || !to || to === String(previousAssignee || '').trim()) return { sent: 0 };
    const taskTitle = text(task.title, 100) || 'Task';
    const projectName = text(project && project.name, 80);
    return await send(req, [to], {
      type: 'task_assigned',
      title: subtask ? 'New subtask assigned to you' : 'New task assigned to you',
      message: [subtask ? `${text(subtask.title, 100)} (in ${taskTitle})` : taskTitle, projectName, dueText(task.dueDate)].filter(Boolean).join(' – '),
      link: `/tasks/${task._id}`,
      linkLabel: 'Open task',
      key: `task_assigned:${task._id}:${subtask ? `${subtask._id}:` : ''}${to}:${Date.now()}`
    });
  } catch {
    return { sent: 0 };
  }
}

async function leadsAssigned(req, leadIds, assignedTo) {
  try {
    const ids = (leadIds || []).map(String).filter((id) => ID_RE.test(id));
    if (!assignedTo || !ids.length) return { sent: 0 };
    if (ids.length === 1) return leadAssigned(req, (await leadOf(req, ids[0])) || { _id: ids[0], assignedTo });
    return await send(req, [assignedTo], {
      type: 'lead_assigned',
      title: `${ids.length} leads assigned to you`,
      message: 'Open My Leads to see them.',
      link: '/leads',
      linkLabel: 'My leads',
      key: `leads_assigned:${assignedTo}:${Date.now()}`
    });
  } catch {
    return { sent: 0 };
  }
}

/* ------------------------------------------------------------ quotations */

async function quotationAccepted(req, quotation) {
  try {
    if (!quotation || !quotation._id) return { sent: 0 };
    const lead = quotation.leadId ? await leadOf(req, quotation.leadId) : null;
    const who = text(quotation.clientName || quotation.client?.name || leadLabel(lead), 100);
    const no = text(quotation.quotationNo || quotation.estimateNo || quotation.number || '', 40);
    return await send(req, [quotation.createdBy, lead && lead.assignedTo], {
      type: 'quotation_accepted',
      title: 'Quotation accepted',
      message: [no, who].filter(Boolean).join(' – '),
      link: `/quotations/${quotation._id}`,
      linkLabel: 'Open quotation',
      key: `quotation_accepted:${quotation._id}`
    });
  } catch {
    return { sent: 0 };
  }
}

/* -------------------------------------------------------------- payments */

function money(amount, currency) {
  const n = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: String(currency || 'INR'), maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency || ''} ${n.toFixed(2)}`.trim();
  }
}

async function paymentReceived(req, { payment, invoice } = {}) {
  try {
    if (!payment || !invoice) return { sent: 0 };
    const quotationId = String(invoice.quotationId || invoice.convertedQuotationId || '');
    const Estimate = model(req, 'Estimate');
    const quotation = Estimate && ID_RE.test(quotationId) ? await settle(Estimate.findOne({ _id: quotationId, tenantId: resolveTenantId(req) })).catch(() => null) : null;
    const leadId = String(invoice.leadId || (quotation && quotation.leadId) || '');
    const lead = leadId ? await leadOf(req, leadId) : null;
    const Company = model(req, 'Company');
    const client = Company && ID_RE.test(String(invoice.clientId || '')) ? await settle(Company.findOne({ _id: String(invoice.clientId), tenantId: resolveTenantId(req) })).catch(() => null) : null;
    const who = text((client && client.name) || leadLabel(lead), 100);
    return await send(req, [invoice.createdBy, quotation && quotation.createdBy, lead && lead.assignedTo], {
      type: 'payment_received',
      title: 'Payment received',
      message: [`${money(payment.amount, payment.currency || invoice.currency)} on ${text(invoice.invoiceNo, 40)}`, who].filter(Boolean).join(' – '),
      link: `/invoices/${invoice._id}`,
      linkLabel: 'Open invoice',
      key: `payment_received:${payment._id}`
    });
  } catch {
    return { sent: 0 };
  }
}

/* ---------------------------------------------------------------- portal */

async function managers(req) {
  const Membership = model(req, 'TenantMembership');
  if (!Membership) return [];
  const rows = await settle(
    Membership.find({ tenantId: resolveTenantId(req), role: { $in: ['crm-manager', 'sales-manager'] }, status: { $ne: 'inactive' } })
  ).catch(() => []);
  return (rows || []).map((r) => String(r.userId || '')).filter(Boolean).slice(0, 20);
}

async function portalApprovalNeeded(req, { access, client, lead } = {}) {
  try {
    if (!access || !access._id) return { sent: 0 };
    const person = text(access.contactName || access.email, 80);
    const forWhom = text((client && (client.name || client.companyName)) || leadLabel(lead), 80);
    const link = client && client._id ? `/clients/${client._id}?tab=portal` : lead && lead._id ? `/leads/${lead._id}` : '';
    return await send(req, await managers(req), {
      type: 'portal_approval',
      title: 'Portal access waits for your approval',
      message: [person, forWhom].filter(Boolean).join(' for '),
      link,
      linkLabel: 'Review',
      key: `portal_approval:${access._id}`
    });
  } catch {
    return { sent: 0 };
  }
}

/* ------------------------------------------------------------- follow-ups */

function timeIn(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short', timeZone }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** One tenant: alerts for Open lead activities due within the next hour, and for those missed in the last day. */
async function followUpsForTenant(cms, tenantId, now = new Date()) {
  const req = { cms, tenantId, headers: {}, user: null };
  const LeadEvent = model(req, 'LeadEvent');
  if (!LeadEvent) return { due: 0, missed: 0 };
  // CRM 3.69.0: the active extension hides activities → no follow-up alerts or push for them.
  if (await require('./crm-extension.service').hidesModule(req, 'activities')) return { due: 0, missed: 0 };
  const soon = new Date(now.getTime() + 60 * 60 * 1000);
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  let q = LeadEvent.find({ tenantId, isDeleted: { $ne: true }, status: 'Open', eventDate: { $gte: since, $lte: soon } });
  if (q && typeof q.limit === 'function') q = q.limit(500);
  const rows = (await settle(q)) || [];
  const settings = await require('./setting.service').getAll(req).catch(() => ({}));
  const timeZone = String((settings && (settings.timezone || settings.time_zone)) || 'Asia/Kolkata');
  const out = { due: 0, missed: 0 };
  for (const row of rows) {
    const to = String(row.assignedTo || row.createdBy || '');
    if (!ID_RE.test(to)) continue;
    const at = new Date(row.eventDate);
    const missed = at.getTime() < now.getTime();
    const lead = await leadOf(req, row.leadId);
    const r = await send(req, [to], {
      type: missed ? 'followup_missed' : 'followup_due',
      title: missed ? 'Follow-up missed' : 'Follow-up due soon',
      message: [text(row.title, 100), leadLabel(lead), timeIn(at, timeZone)].filter(Boolean).join(' – '),
      link: ID_RE.test(String(row.leadId || '')) ? `/leads/${row.leadId}` : '/leads',
      linkLabel: 'Open lead',
      key: `${missed ? 'followup_missed' : 'followup_due'}:${row._id}`
    });
    if (r && r.sent) out[missed ? 'missed' : 'due'] += r.sent;
  }
  return out;
}

async function followUpSweep(cms) {
  const { tenantIds } = require('./extension-schedule.service');
  const total = { tenants: 0, due: 0, missed: 0 };
  for (const tenantId of await tenantIds(cms)) {
    try {
      const r = await followUpsForTenant(cms, tenantId);
      total.tenants += 1;
      total.due += r.due;
      total.missed += r.missed;
    } catch {
      /* one tenant never stops the others */
    }
  }
  return total;
}

module.exports = {
  taskAssigned,
  leadAssigned,
  leadsAssigned,
  quotationAccepted,
  paymentReceived,
  portalApprovalNeeded,
  followUpsForTenant,
  followUpSweep,
  _internal: { recipients, leadLabel, money }
};
