'use strict';

const { resolveTenantId, isClientUser, resolveClientId, resolveClientIdAsync } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function getModel(req, name) {
  return req.cms?.models.get(name) || null;
}

/**
 * Computes individual Customer Health Score (0-100) and risk factors for a client account.
 */
async function computeClientHealthScore(req, clientId) {
  const base = baseFilter(req);
  let cId = String(clientId);

  if (isClientUser(req)) {
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId || cId !== String(userClientId)) {
      const error = new Error('Client not found');
      error.status = 404;
      throw error;
    }
    cId = userClientId;
  }

  const [Ticket, CustomerFeedback, SalesOrder, Invoice] = [
    getModel(req, 'Ticket'),
    getModel(req, 'CustomerFeedback'),
    getModel(req, 'SalesOrder'),
    getModel(req, 'Invoice')
  ];

  let csatScore = 85;
  let csatAvg = 5.0;
  let feedbackCount = 0;

  if (CustomerFeedback) {
    const feedbacks = await CustomerFeedback.find({ tenantId: resolveTenantId(req), clientId: cId }).lean();
    feedbackCount = feedbacks.length;
    if (feedbackCount > 0) {
      const sum = feedbacks.reduce((acc, f) => acc + (f.rating || 5), 0);
      csatAvg = Math.round((sum / feedbackCount) * 10) / 10;
      csatScore = Math.round((csatAvg / 5) * 100);
    }
  }

  let orderScore = 50;
  let repeatOrdersCount = 0;
  let lastOrderDate = null;

  if (SalesOrder) {
    const orders = await SalesOrder.find({ ...base, clientId: cId, status: { $ne: 'Cancelled' } }).sort({ createdAt: -1 }).lean();
    repeatOrdersCount = orders.length;
    if (repeatOrdersCount > 0) {
      lastOrderDate = orders[0].createdAt;
      const orderVolumeScore = Math.min(100, repeatOrdersCount >= 3 ? 100 : repeatOrdersCount === 2 ? 80 : 65);

      const daysSinceLast = (Date.now() - new Date(lastOrderDate).getTime()) / (1000 * 3600 * 24);
      const recencyPenalty = daysSinceLast > 90 ? 20 : daysSinceLast > 60 ? 10 : 0;

      orderScore = Math.max(20, orderVolumeScore - recencyPenalty);
    }
  }

  let ticketScore = 100;
  let openTicketsCount = 0;
  let slaBreachedCount = 0;

  if (Ticket) {
    const tickets = await Ticket.find({ ...base, clientId: cId }).lean();
    const openTickets = tickets.filter((t) => !['Resolved', 'Closed'].includes(t.status));
    openTicketsCount = openTickets.length;

    const now = new Date();
    slaBreachedCount = tickets.filter((t) => t.slaBreached || (!['Resolved', 'Closed'].includes(t.status) && t.slaDueDate && new Date(t.slaDueDate) < now)).length;

    ticketScore = Math.max(0, 100 - (openTicketsCount * 15) - (slaBreachedCount * 25));
  }

  let paymentScore = 100;
  let overdueInvoicesCount = 0;

  if (Invoice) {
    const now = new Date();
    const unpaidInvoices = await Invoice.find({
      ...base,
      clientId: cId,
      status: { $nin: ['Paid', 'Cancelled'] }
    }).lean();

    overdueInvoicesCount = unpaidInvoices.filter((i) => i.dueDate && new Date(i.dueDate) < now).length;
    paymentScore = Math.max(0, 100 - (overdueInvoicesCount * 30));
  }

  const rawHealth = Math.round(
    (csatScore * 0.30) +
    (orderScore * 0.30) +
    (ticketScore * 0.30) +
    (paymentScore * 0.10)
  );

  const healthScore = Math.min(100, Math.max(0, rawHealth));

  let healthCategory = 'Healthy';
  if (healthScore < 50) {
    healthCategory = 'Critical';
  } else if (healthScore < 75) {
    healthCategory = 'At Risk';
  }

  return {
    healthScore,
    healthCategory,
    csatAvg,
    feedbackCount,
    repeatOrdersCount,
    lastOrderDate,
    openTicketsCount,
    slaBreachedCount,
    overdueInvoicesCount,
    factors: {
      csatScore,
      orderScore,
      ticketScore,
      paymentScore
    }
  };
}

/**
 * Computes Customer Success overview & health distribution metrics.
 * When requested by a client user, scopes metrics only to their own account.
 */
async function getHealthSummary(req) {
  const Client = getModel(req, 'Company') || getModel(req, 'Client');
  const base = baseFilter(req);
  const clientUser = isClientUser(req);
  let userClientId = null;
  if (clientUser) {
    userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId) {
      return {
        totalAccounts: 0,
        healthyCount: 0,
        atRiskCount: 0,
        criticalCount: 0,
        healthyPercent: 0,
        totalOpenTickets: 0,
        totalSlaBreached: 0,
        avgCsat: 0,
        totalFeedbacks: 0,
        unlinkedClient: true
      };
    }
  }
  const queryClientId = req.query?.clientId || req.query?.client || req.query?.companyId;
  const targetClientId = clientUser ? userClientId : (queryClientId ? String(queryClientId).trim() : null);

  let clients = [];
  if (Client) {
    const clientFilter = targetClientId ? { ...base, _id: targetClientId } : base;
    clients = await Client.find(clientFilter).select('_id name companyName').lean();
  }

  const Ticket = getModel(req, 'Ticket');
  const CustomerFeedback = getModel(req, 'CustomerFeedback');

  let totalOpenTickets = 0;
  let totalSlaBreached = 0;
  if (Ticket) {
    const ticketFilter = targetClientId
      ? { ...base, clientId: targetClientId, status: { $nin: ['Resolved', 'Closed'] } }
      : { ...base, status: { $nin: ['Resolved', 'Closed'] } };
    totalOpenTickets = await Ticket.countDocuments(ticketFilter);

    const now = new Date();
    const slaFilter = targetClientId
      ? {
          ...base,
          clientId: targetClientId,
          $or: [
            { slaBreached: true },
            { status: { $nin: ['Resolved', 'Closed'] }, slaDueDate: { $lt: now } }
          ]
        }
      : {
          ...base,
          $or: [
            { slaBreached: true },
            { status: { $nin: ['Resolved', 'Closed'] }, slaDueDate: { $lt: now } }
          ]
        };
    totalSlaBreached = await Ticket.countDocuments(slaFilter);
  }

  let avgCsat = 5.0;
  let totalFeedbacks = 0;
  if (CustomerFeedback) {
    const feedbackFilter = targetClientId
      ? { tenantId: resolveTenantId(req), clientId: targetClientId }
      : { tenantId: resolveTenantId(req) };
    const feedbacks = await CustomerFeedback.find(feedbackFilter).lean();
    totalFeedbacks = feedbacks.length;
    if (totalFeedbacks > 0) {
      const sum = feedbacks.reduce((acc, f) => acc + (f.rating || 5), 0);
      avgCsat = Math.round((sum / totalFeedbacks) * 10) / 10;
    }
  }

  let healthyCount = 0;
  let atRiskCount = 0;
  let criticalCount = 0;

  for (const c of clients) {
    const health = await computeClientHealthScore(req, c._id);
    if (health.healthCategory === 'Healthy') healthyCount++;
    else if (health.healthCategory === 'At Risk') atRiskCount++;
    else criticalCount++;
  }

  const totalAccounts = clients.length;
  const healthyPercent = totalAccounts > 0 ? Math.round((healthyCount / totalAccounts) * 100) : 100;

  return {
    totalAccounts,
    healthyCount,
    atRiskCount,
    criticalCount,
    healthyPercent,
    totalOpenTickets,
    totalSlaBreached,
    avgCsat,
    totalFeedbacks
  };
}

/**
 * Lists accounts with computed health scores and risk indicators.
 * Restricts to the client's own account when accessed by a client user.
 */
async function listAccountHealth(req) {
  const Client = getModel(req, 'Company') || getModel(req, 'Client');
  const { page, limit, skip } = parsePagination(req.query);
  const base = baseFilter(req);
  const clientUser = isClientUser(req);
  const resolvedId = clientUser ? ((await resolveClientIdAsync(req)) || resolveClientId(req)) : null;
  const isUnlinkedClient = clientUser && !resolvedId;
  const userClientId = clientUser ? (resolvedId || '__UNLINKED_CLIENT__') : null;

  if (!Client || isUnlinkedClient) {
    return {
      items: [],
      pagination: { page, limit, total: 0, totalPages: 1 },
      unlinkedClient: isUnlinkedClient,
      message: isUnlinkedClient ? 'Client email ID not found in CRM records' : undefined
    };
  }

  const filter = { ...base };
  if (clientUser) {
    filter._id = userClientId;
  } else {
    const queryClientId = req.query?.clientId || req.query?.client || req.query?.companyId;
    if (queryClientId) filter._id = String(queryClientId).trim();
  }

  if (req.query?.search) {
    const s = String(req.query.search).trim();
    const searchClause = {
      $or: [
        { name: { $regex: s, $options: 'i' } },
        { companyName: { $regex: s, $options: 'i' } }
      ]
    };
    if (clientUser || filter._id) {
      filter.$and = [{ _id: filter._id }, searchClause];
      delete filter._id;
    } else {
      filter.$or = searchClause.$or;
    }
  }

  const [clients, total] = await Promise.all([
    Client.find(filter).skip(skip).limit(limit).lean(),
    Client.countDocuments(filter)
  ]);

  const items = [];
  for (const c of clients) {
    const health = await computeClientHealthScore(req, c._id);
    items.push({
      _id: c._id,
      name: c.name || c.companyName || 'Unnamed Client',
      companyName: c.companyName || c.name || '—',
      contactPerson: c.contactPerson || '—',
      email: c.email || '—',
      phone: c.phone || c.mobile || '—',
      ...health
    });
  }

  if (req.query?.category) {
    const cat = String(req.query.category).trim();
    const filteredItems = items.filter((i) => i.healthCategory.toLowerCase() === cat.toLowerCase());
    return {
      items: filteredItems,
      pagination: { page, limit, total: filteredItems.length, totalPages: Math.ceil(filteredItems.length / limit) || 1 },
      unlinkedClient: false
    };
  }

  items.sort((a, b) => a.healthScore - b.healthScore);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    unlinkedClient: false
  };
}

async function exportCustomerSuccess(req, query = {}) {
  const Client = getModel(req, 'Company') || getModel(req, 'Client');
  const base = baseFilter(req);
  const clientUser = isClientUser(req);
  const nowStr = new Date().toISOString().slice(0, 10);
  let userClientId = null;
  if (clientUser) {
    userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId) {
      return {
        contentType: 'text/csv; charset=utf-8',
        format: 'csv',
        filename: `customer_success_export_${nowStr}.csv`,
        content: '',
        data: '',
        count: 0
      };
    }
  }
  const AuditService = require('./audit.service');

  if (!Client) {
    return {
      contentType: 'text/csv; charset=utf-8',
      format: 'csv',
      filename: `customer_success_export_${nowStr}.csv`,
      content: '',
      data: '',
      count: 0
    };
  }

  const filter = { ...base };
  if (clientUser) {
    filter._id = userClientId;
  }
  if (query.search) {
    const s = String(query.search).trim();
    filter.$or = [
      { name: { $regex: s, $options: 'i' } },
      { companyName: { $regex: s, $options: 'i' } }
    ];
  }

  const clients = await Client.find(filter).lean();
  let items = [];
  for (const c of clients) {
    const health = await computeClientHealthScore(req, c._id);
    items.push({
      _id: c._id,
      name: c.name || c.companyName || 'Unnamed Client',
      companyName: c.companyName || c.name || '—',
      contactPerson: c.contactPerson || '—',
      email: c.email || '—',
      phone: c.phone || c.mobile || '—',
      ...health
    });
  }

  if (query.category) {
    const cat = String(query.category).trim();
    items = items.filter((i) => i.healthCategory.toLowerCase() === cat.toLowerCase());
  }

  items.sort((a, b) => a.healthScore - b.healthScore);

  const format = String(query.format || 'csv').trim().toLowerCase();

  await AuditService.log(req, {
    action: 'exported',
    module: 'customer_success',
    recordId: 'export',
    description: `Exported ${items.length} customer success records in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `customer_success_export_${nowStr}.json`,
      content: JSON.stringify(items, null, 2),
      data: items,
      count: items.length
    };
  }

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const headers = [
    'ID',
    'Company / Client Name',
    'Contact Person',
    'Email',
    'Phone',
    'Health Score (0-100)',
    'Health Category',
    'CSAT Rating',
    'Repeat Orders Count',
    'Open Tickets Count',
    'SLA Breached Count',
    'Overdue Invoices Count',
    'Risk Factors'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const item of items) {
    const riskStr = Array.isArray(item.riskFactors)
      ? item.riskFactors.map((r) => r.label || r).join('; ')
      : '';
    rows.push(
      [
        item._id,
        item.companyName || item.name || '',
        item.contactPerson || '',
        item.email || '',
        item.phone || '',
        item.healthScore || 0,
        item.healthCategory || 'Healthy',
        item.csatAvg || 5.0,
        item.repeatOrdersCount || 0,
        item.openTicketsCount || 0,
        item.slaBreachedCount || 0,
        item.overdueInvoicesCount || 0,
        riskStr
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `customer_success_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: items.length
  };
}

module.exports = {
  computeClientHealthScore,
  getHealthSummary,
  listAccountHealth,
  exportCustomerSuccess
};
