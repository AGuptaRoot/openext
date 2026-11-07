'use strict';

const { resolveTenantId } = require('./tenant.util');
const { snapshotOf } = require('./customer-snapshot.util');

function baseFilter(req) {
  const tenantId = resolveTenantId(req);
  const tenantFilter = tenantId === 'default'
    ? { $in: ['default', null, undefined, ''] }
    : tenantId;
  return { tenantId: tenantFilter, isDeleted: { $ne: true } };
}

/**
 * Resolve display labels and profile photos/avatars for clientId / leadId pairs on finance/sales documents.
 */
async function buildCustomerLabelMaps(req, rows) {
  const clientIds = new Set();
  const leadIds = new Set();

  for (const row of rows || []) {
    const clientId = String(row?.clientId || '').trim();
    const leadId = String(row?.leadId || '').trim();
    if (clientId) clientIds.add(clientId);
    if (leadId) leadIds.add(leadId);
  }

  const Company = req.cms?.models?.get?.('Company') || req.cms?.models?.get?.('Client') || req.storage?.db?.models?.Company || req.storage?.db?.models?.Client;
  const Lead = req.cms?.models?.get?.('Lead') || req.storage?.db?.models?.Lead;

  const executeQuery = async (model, filter, fields) => {
    if (!model || typeof model.find !== 'function') return [];
    try {
      const q = model.find(filter);
      let res = q;
      if (q && typeof q.select === 'function') {
        res = q.select(fields);
      }
      if (res && typeof res.lean === 'function') {
        res = await res.lean();
      } else if (res && typeof res.then === 'function') {
        res = await res;
      }
      return Array.isArray(res) ? res : (res ? [res] : []);
    } catch {
      return [];
    }
  };

  const [rawClients, rawLeads] = await Promise.all([
    clientIds.size && Company
      ? executeQuery(Company, { ...baseFilter(req), _id: { $in: [...clientIds] } }, 'name avatarUrl photoUrl email officialEmail companyName')
      : [],
    leadIds.size && Lead
      ? executeQuery(Lead, { ...baseFilter(req), _id: { $in: [...leadIds] } }, 'name photoUrl avatarUrl email company contactName')
      : []
  ]);

  const clients = Array.isArray(rawClients) ? rawClients : [];
  const leads = Array.isArray(rawLeads) ? rawLeads : [];

  const clientMap = Object.fromEntries(
    clients.map((row) => [
      String(row._id),
      {
        name: row.name || row.companyName || '',
        avatarUrl: row.avatarUrl || row.photoUrl || '',
        email: row.email || row.officialEmail || '',
        type: 'client'
      }
    ])
  );

  const leadMap = Object.fromEntries(
    leads.map((row) => [
      String(row._id),
      {
        name: row.company || row.contactName || row.name || row.companyName || '',
        avatarUrl: row.photoUrl || row.avatarUrl || '',
        email: row.email || '',
        type: 'lead'
      }
    ])
  );

  const clientNames = Object.fromEntries(clients.map((row) => [String(row._id), row.name || row.companyName]));
  const leadNames = Object.fromEntries(
    leads.map((row) => [String(row._id), row.company || row.contactName || row.name || row.companyName || ''])
  );

  return { clientNames, leadNames, clientMap, leadMap };
}

function resolveCustomerLabel(row, maps) {
  const clientId = String(row?.clientId || '').trim();
  const leadId = String(row?.leadId || '').trim();
  // The record's own snapshot (3.35.0): what the customer was called when the record was created.
  const snap = snapshotOf(row);
  if (snap) return snap.type === 'lead' && !clientId ? `${snap.name} (Lead)` : snap.name;

  if (clientId && maps?.clientNames?.[clientId]) {
    return maps.clientNames[clientId];
  }
  if (leadId && maps?.leadNames?.[leadId]) {
    return `${maps.leadNames[leadId]} (Lead)`;
  }
  if (clientId) {
    return `Customer (${clientId.slice(-6)})`;
  }
  if (leadId) {
    return `Lead (${leadId.slice(-6)})`;
  }
  return '—';
}

function resolveCustomerAvatar(row, maps) {
  const clientId = String(row?.clientId || '').trim();
  const leadId = String(row?.leadId || '').trim();

  if (clientId && maps?.clientMap?.[clientId]?.avatarUrl) {
    return maps.clientMap[clientId].avatarUrl;
  }
  if (leadId && maps?.leadMap?.[leadId]?.avatarUrl) {
    return maps.leadMap[leadId].avatarUrl;
  }
  return row?.customerAvatarUrl || row?.clientAvatarUrl || '';
}

function resolveCustomerEmail(row, maps) {
  const clientId = String(row?.clientId || '').trim();
  const leadId = String(row?.leadId || '').trim();
  const snap = snapshotOf(row);
  if (snap && snap.email) return snap.email;

  if (clientId && maps?.clientMap?.[clientId]?.email) {
    return maps.clientMap[clientId].email;
  }
  if (leadId && maps?.leadMap?.[leadId]?.email) {
    return maps.leadMap[leadId].email;
  }
  return row?.customerEmail || '';
}

async function enrichWithCustomerLabel(req, rows) {
  const items = Array.isArray(rows) ? rows : rows ? [rows] : [];
  if (!items.length) return rows;

  const maps = await buildCustomerLabelMaps(req, items);
  const enriched = items.map((row) => {
    const label = resolveCustomerLabel(row, maps);
    const avatarUrl = resolveCustomerAvatar(row, maps);
    const email = resolveCustomerEmail(row, maps);

    return {
      ...row,
      customerLabel: label,
      customerName: label,
      clientName: label,
      customerAvatarUrl: avatarUrl,
      clientAvatarUrl: avatarUrl,
      customerEmail: email
    };
  });

  return Array.isArray(rows) ? enriched : enriched[0];
}

module.exports = {
  buildCustomerLabelMaps,
  resolveCustomerLabel,
  resolveCustomerAvatar,
  resolveCustomerEmail,
  enrichWithCustomerLabel
};
