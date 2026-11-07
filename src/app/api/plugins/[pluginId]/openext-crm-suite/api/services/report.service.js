const { resolveTenantId, isClientUser, resolveClientId, resolveClientIdAsync, isUnlinkedClientUserAsync } = require('../utils/tenant.util');
const {
  hasPermission,
  applySalesAgentLeadListScope
} = require('../utils/sales-access.util');
const {
  applyEmployeeProjectListScope,
  applyEmployeeTaskListScope,
  isEmployeeScoped
} = require('../utils/project-access.util');
const SettingService = require('./setting.service');
const { applyExpenseListScope } = require('../utils/expense-access.util');
const { resolveUsernames } = require('../utils/user.util');
const {
  isMissedActivity,
  activityDisplayStatus
} = require('../utils/lead-event.constants');

function getModel(req, name) {
  return req.cms?.models.get(name) || null;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundHours(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function parseDateRange(query = {}) {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const defaultTo = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  let from = query.from ? new Date(String(query.from)) : defaultFrom;
  let to = query.to ? new Date(String(query.to)) : defaultTo;

  if (Number.isNaN(from.getTime())) from = defaultFrom;
  if (Number.isNaN(to.getTime())) to = defaultTo;

  to.setHours(23, 59, 59, 999);
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }

  return { from, to };
}

function parseClientId(query = {}) {
  return query.clientId ? String(query.clientId).trim() : '';
}

async function resolveReportClientId(req, query = {}) {
  if (isClientUser(req)) {
    const cid = (await resolveClientIdAsync(req)) || resolveClientId(req);
    return cid || '__UNLINKED_CLIENT_NO_MATCH__';
  }
  return query.clientId ? String(query.clientId).trim() : '';
}

async function getClientProjectIds(req, clientId) {
  if (!clientId || clientId === '__UNLINKED_CLIENT_NO_MATCH__') return [];
  const Project = getModel(req, 'Project');
  if (!Project) return [];

  let projectFilter = { ...baseFilter(req), clientId: String(clientId) };
  projectFilter = await applyEmployeeProjectListScope(req, projectFilter);
  const projects = await Project.find(projectFilter).select('_id').lean();
  return projects.map((project) => String(project._id));
}

async function buildLeadFilter(req, range) {
  if (isClientUser(req)) {
    return { ...baseFilter(req), _id: '__UNLINKED_CLIENT_NO_MATCH__' };
  }
  let filter = {
    ...baseFilter(req),
    createdAt: { $gte: range.from, $lte: range.to }
  };
  filter = applySalesAgentLeadListScope(req, filter);
  return filter;
}

async function getSalesReport(req, query = {}) {
  const range = parseDateRange(query);
  const clientId = await resolveReportClientId(req, query);
  const canFinance = hasPermission(req, 'crm.finance.read');
  const settings = await SettingService.getAll(req).catch(() => ({}));
  const defaultCurrency = settings.default_currency || 'INR';

  if (isClientUser(req) && clientId === '__UNLINKED_CLIENT_NO_MATCH__') {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      defaultCurrency,
      pipeline: [],
      totalLeads: 0,
      wonLeads: 0,
      conversionRate: 0,
      leadsByPeriod: [],
      quotations: { draft: 0, sent: 0, accepted: 0, rejected: 0 },
      paymentsTotal: 0,
      outstanding: { unpaid: 0, overdue: 0, unpaidCount: 0 },
      topClients: [],
      unlinkedClient: true,
      message: 'Client email ID not found in CRM records'
    };
  }

  const stages = await SettingService.getPipelineStages(req);
  const wonStage = SettingService.resolveWonStage(stages);

  const Lead = getModel(req, 'Lead');
  let totalLeads = 0;
  let wonLeads = 0;
  let pipeline = [];
  let leadsByPeriod = [];

  if (Lead && hasPermission(req, 'crm.leads.read')) {
    const leadFilter = await buildLeadFilter(req, range);

    const [pipelineRows, periodRows, total, won] = await Promise.all([
      Lead.aggregate([
        { $match: leadFilter },
        { $group: { _id: '$stage', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Lead.aggregate([
        { $match: leadFilter },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]),
      Lead.countDocuments(leadFilter),
      Lead.countDocuments({ ...leadFilter, stage: wonStage })
    ]);

    totalLeads = total;
    wonLeads = won;
    pipeline = pipelineRows.map((row) => ({
      stage: row._id || '—',
      count: row.count || 0
    }));
    leadsByPeriod = periodRows.map((row) => ({
      period: row._id,
      count: row.count || 0
    }));
  }

  const conversionRate =
    totalLeads > 0 ? roundMoney((wonLeads / totalLeads) * 100) : 0;

  let quotations = null;
  let paymentsTotal = 0;
  let outstanding = null;
  let topClients = [];

  if (canFinance) {
    const Estimate = getModel(req, 'Estimate');
    if (Estimate) {
      const quoteFilter = {
        ...baseFilter(req),
        createdAt: { $gte: range.from, $lte: range.to }
      };
      if (clientId) quoteFilter.clientId = clientId;
      const [draft, sent, accepted, rejected] = await Promise.all([
        Estimate.countDocuments({ ...quoteFilter, status: 'Draft' }),
        Estimate.countDocuments({ ...quoteFilter, status: 'Sent' }),
        Estimate.countDocuments({ ...quoteFilter, status: 'Accepted' }),
        Estimate.countDocuments({ ...quoteFilter, status: 'Rejected' })
      ]);
      quotations = { draft, sent, accepted, rejected };
    }

    const Payment = getModel(req, 'Payment');
    if (Payment) {
      const paymentFilter = {
        ...baseFilter(req),
        paymentDate: { $gte: range.from, $lte: range.to }
      };
      if (clientId) paymentFilter.clientId = clientId;

      const paymentRows = await Payment.find(paymentFilter)
        .select('amount clientId')
        .lean();

      paymentsTotal = roundMoney(
        paymentRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0)
      );

      const clientTotals = {};
      for (const row of paymentRows) {
        const key = String(row.clientId || '');
        if (!key) continue;
        clientTotals[key] = (clientTotals[key] || 0) + (Number(row.amount) || 0);
      }

      const Company = getModel(req, 'Company');
      const sortedClientIds = Object.entries(clientTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      if (Company && sortedClientIds.length) {
        const clients = await Company.find({
          ...baseFilter(req),
          _id: { $in: sortedClientIds.map(([id]) => id) }
        })
          .select('name')
          .lean();
        const nameMap = Object.fromEntries(clients.map((c) => [String(c._id), c.name]));
        topClients = sortedClientIds.map(([clientId, amount]) => ({
          clientId,
          name: nameMap[clientId] || clientId,
          amount: roundMoney(amount)
        }));
      }
    }

    const Invoice = getModel(req, 'Invoice');
    if (Invoice) {
      const invoiceFilter = {
        ...baseFilter(req),
        // A proforma is a payment request, not a receivable or taxable supply.
        documentType: { $in: ['tax', null] },
        balanceDue: { $gt: 0 },
        status: { $nin: ['Cancelled', 'Draft'] }
      };
      if (clientId) invoiceFilter.clientId = clientId;

      const unpaidRows = await Invoice.find(invoiceFilter)
        .select('balanceDue dueDate')
        .lean();

      const now = new Date();
      let unpaid = 0;
      let overdue = 0;
      for (const row of unpaidRows) {
        const balance = Number(row.balanceDue) || 0;
        unpaid += balance;
        if (row.dueDate && new Date(row.dueDate) < now) {
          overdue += balance;
        }
      }
      outstanding = {
        unpaid: roundMoney(unpaid),
        overdue: roundMoney(overdue),
        unpaidCount: unpaidRows.length
      };
    }
  }

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    clientId: clientId || undefined,
    defaultCurrency,
    pipeline,
    totalLeads,
    wonLeads,
    conversionRate,
    leadsByPeriod,
    quotations,
    paymentsTotal: canFinance ? paymentsTotal : undefined,
    outstanding: canFinance ? outstanding : undefined,
    topClients: canFinance ? topClients : undefined
  };
}

async function getProjectsReport(req, query = {}) {
  const range = parseDateRange(query);
  const canTime = hasPermission(req, 'crm.time.read');
  const clientId = await resolveReportClientId(req, query);

  if (isClientUser(req) && clientId === '__UNLINKED_CLIENT_NO_MATCH__') {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      byStatus: [],
      projects: [],
      overdueTasks: [],
      hoursByAssignee: [],
      unlinkedClient: true,
      message: 'Client email ID not found in CRM records'
    };
  }

  if (!hasPermission(req, 'crm.projects.read')) {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      byStatus: [],
      projects: [],
      overdueTasks: [],
      hoursByAssignee: []
    };
  }

  let projectFilter = { ...baseFilter(req) };
  if (clientId) projectFilter.clientId = clientId;
  projectFilter = await applyEmployeeProjectListScope(req, projectFilter);

  const Project = getModel(req, 'Project');
  const Task = getModel(req, 'Task');
  const TimeLog = getModel(req, 'TimeLog');
  const Company = getModel(req, 'Company');

  if (!Project) {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      byStatus: [],
      projects: [],
      overdueTasks: [],
      hoursByAssignee: []
    };
  }

  const projects = await Project.find(projectFilter).sort({ updatedAt: -1 }).lean();
  const projectIds = projects.map((p) => String(p._id));

  const clientIds = [...new Set(projects.map((p) => String(p.clientId)).filter(Boolean))];
  const clientMap = {};
  if (Company && clientIds.length) {
    const clients = await Company.find({
      ...baseFilter(req),
      _id: { $in: clientIds }
    })
      .select('name')
      .lean();
    for (const client of clients) {
      clientMap[String(client._id)] = client.name;
    }
  }

  const statusCounts = {};
  for (const project of projects) {
    const status = project.status || '—';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }
  const byStatus = Object.entries(statusCounts)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  const taskStats = {};
  const overdueTasks = [];
  const now = new Date();

  if (Task && projectIds.length) {
    let taskFilter = {
      ...baseFilter(req),
      projectId: { $in: projectIds }
    };
    taskFilter = await applyEmployeeTaskListScope(req, taskFilter);

    const tasks = await Task.find(taskFilter).lean();
    for (const task of tasks) {
      const pid = String(task.projectId);
      if (!taskStats[pid]) {
        taskStats[pid] = { total: 0, completed: 0, overdue: 0 };
      }
      taskStats[pid].total += 1;
      if (task.status === 'Completed') taskStats[pid].completed += 1;

      const isOverdue =
        task.status !== 'Completed' &&
        task.dueDate &&
        new Date(task.dueDate) < now;

      if (isOverdue) {
        taskStats[pid].overdue += 1;
        overdueTasks.push({
          id: String(task._id),
          title: task.title,
          projectId: pid,
          projectName: projects.find((p) => String(p._id) === pid)?.name || pid,
          assignedTo: task.assignedTo || '',
          dueDate: task.dueDate
        });
      }
    }
  }

  const hoursByProject = {};
  const hoursByAssignee = {};

  if (canTime && TimeLog && Task && projectIds.length) {
    const tasks = await Task.find({
      ...baseFilter(req),
      projectId: { $in: projectIds }
    })
      .select('_id projectId assignedTo')
      .lean();
    const taskToProject = Object.fromEntries(
      tasks.map((t) => [String(t._id), String(t.projectId)])
    );
    const taskToAssignee = Object.fromEntries(
      tasks.map((t) => [String(t._id), String(t.assignedTo || '')])
    );
    const taskIds = tasks.map((t) => String(t._id));

    let logFilter = {
      ...baseFilter(req),
      taskId: { $in: taskIds },
      workDate: { $gte: range.from, $lte: range.to }
    };

    if (isEmployeeScoped(req)) {
      const userId = require('../utils/tenant.util').resolveUserId(req);
      logFilter = { ...logFilter, createdBy: userId };
    }

    const logs = await TimeLog.find(logFilter).select('taskId hours billableAmount createdBy').lean();
    for (const log of logs) {
      const pid = taskToProject[String(log.taskId)];
      if (!pid) continue;
      if (!hoursByProject[pid]) {
        hoursByProject[pid] = { hours: 0, billableAmount: 0 };
      }
      hoursByProject[pid].hours += Number(log.hours) || 0;
      hoursByProject[pid].billableAmount += Number(log.billableAmount) || 0;

      const assignee = taskToAssignee[String(log.taskId)] || String(log.createdBy || '');
      if (assignee) {
        if (!hoursByAssignee[assignee]) {
          hoursByAssignee[assignee] = { hours: 0, billableAmount: 0 };
        }
        hoursByAssignee[assignee].hours += Number(log.hours) || 0;
        hoursByAssignee[assignee].billableAmount += Number(log.billableAmount) || 0;
      }
    }
  }

  const projectRows = projects.map((project) => {
    const pid = String(project._id);
    const stats = taskStats[pid] || { total: 0, completed: 0, overdue: 0 };
    const hours = hoursByProject[pid] || { hours: 0, billableAmount: 0 };
    const completionPct =
      stats.total > 0 ? roundMoney((stats.completed / stats.total) * 100) : 0;

    let deadlineStatus = 'ok';
    if (project.deadline) {
      const deadline = new Date(project.deadline);
      const daysLeft = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));
      if (project.status !== 'Completed' && project.status !== 'Cancelled') {
        if (daysLeft < 0) deadlineStatus = 'overdue';
        else if (daysLeft <= 7) deadlineStatus = 'due_soon';
      }
    }

    return {
      id: pid,
      name: project.name,
      clientId: String(project.clientId),
      clientName: clientMap[String(project.clientId)] || '—',
      status: project.status,
      deadline: project.deadline,
      deadlineStatus,
      tasksTotal: stats.total,
      tasksCompleted: stats.completed,
      completionPct,
      overdueTasks: stats.overdue,
      hoursLogged: canTime ? roundHours(hours.hours) : undefined,
      billableAmount: canTime ? roundMoney(hours.billableAmount) : undefined
    };
  });

  overdueTasks.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  const assigneeUserIds = [
    ...Object.keys(hoursByAssignee),
    ...overdueTasks.map((t) => String(t.assignedTo || '').trim()).filter(Boolean)
  ];
  const usernameMap = assigneeUserIds.length
    ? await resolveUsernames(req, assigneeUserIds)
    : {};

  for (const task of overdueTasks) {
    const assigneeId = String(task.assignedTo || '').trim();
    if (!assigneeId) {
      task.assignedTo = '';
      task.assignedToName = 'Unassigned';
      continue;
    }
    task.assignedToId = assigneeId;
    task.assignedToName = usernameMap[assigneeId] || assigneeId;
    task.assignedTo = task.assignedToName;
  }

  const assigneeRows = Object.entries(hoursByAssignee)
    .map(([userId, totals]) => ({
      userId,
      name: usernameMap[userId] || userId,
      hours: roundHours(totals.hours),
      billableAmount: roundMoney(totals.billableAmount)
    }))
    .sort((a, b) => b.hours - a.hours);

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    clientId: clientId || undefined,
    byStatus,
    projects: projectRows,
    overdueTasks: overdueTasks.slice(0, 50),
    hoursByAssignee: canTime ? assigneeRows : undefined
  };
}

function resolveLostStage(stages) {
  const list = Array.isArray(stages)
    ? stages.map((stage) => String(stage).trim()).filter(Boolean)
    : [];
  return list.find((stage) => stage.toLowerCase() === 'lost') || 'Lost';
}

function escapeCsvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function rowsToCsv(columns, rows) {
  const header = columns.map((col) => escapeCsvCell(col.label)).join(',');
  const lines = rows.map((row) =>
    columns.map((col) => escapeCsvCell(row[col.key])).join(',')
  );
  return [header, ...lines].join('\r\n');
}

async function getLeadConversionReport(req, query = {}) {
  const range = parseDateRange(query);
  const clientId = await resolveReportClientId(req, query);
  if (isClientUser(req)) {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      totalLeads: 0,
      wonLeads: 0,
      lostLeads: 0,
      convertedLeads: 0,
      winRate: 0,
      conversionRate: 0,
      byStage: [],
      conversionsByPeriod: [],
      unlinkedClient: clientId === '__UNLINKED_CLIENT_NO_MATCH__' ? true : undefined
    };
  }
  const stages = await SettingService.getPipelineStages(req);
  const wonStage = SettingService.resolveWonStage(stages);
  const lostStage = resolveLostStage(stages);

  const Lead = getModel(req, 'Lead');
  if (!Lead || !hasPermission(req, 'crm.leads.read')) {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      totalLeads: 0,
      wonLeads: 0,
      lostLeads: 0,
      convertedLeads: 0,
      winRate: 0,
      conversionRate: 0,
      byStage: [],
      conversionsByPeriod: []
    };
  }

  const leadFilter = await buildLeadFilter(req, range);
  const convertedFilter = {
    ...baseFilter(req),
    convertedClientId: { $ne: null },
    convertedAt: { $gte: range.from, $lte: range.to }
  };
  if (clientId) convertedFilter.convertedClientId = clientId;
  const scopedConverted = applySalesAgentLeadListScope(req, convertedFilter);

  const [totalLeads, wonLeads, lostLeads, convertedLeads, byStageRows, periodRows] =
    await Promise.all([
      Lead.countDocuments(leadFilter),
      Lead.countDocuments({ ...leadFilter, stage: wonStage }),
      Lead.countDocuments({ ...leadFilter, stage: lostStage }),
      Lead.countDocuments(scopedConverted),
      Lead.aggregate([
        { $match: leadFilter },
        { $group: { _id: '$stage', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Lead.aggregate([
        { $match: scopedConverted },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$convertedAt' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ])
    ]);

  const winRate = totalLeads > 0 ? roundMoney((wonLeads / totalLeads) * 100) : 0;
  const conversionRate =
    totalLeads > 0 ? roundMoney((convertedLeads / totalLeads) * 100) : 0;

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    clientId: clientId || undefined,
    totalLeads,
    wonLeads,
    lostLeads,
    convertedLeads,
    winRate,
    conversionRate,
    byStage: byStageRows.map((row) => ({ stage: row._id || '—', count: row.count || 0 })),
    conversionsByPeriod: periodRows.map((row) => ({
      period: row._id,
      count: row.count || 0
    }))
  };
}

async function getInvoiceAgeingReport(req, query = {}) {
  const clientId = await resolveReportClientId(req, query);
  const settings = await SettingService.getAll(req).catch(() => ({}));
  const defaultCurrency = settings.default_currency || 'INR';

  if (isClientUser(req) && clientId === '__UNLINKED_CLIENT_NO_MATCH__') {
    return {
      defaultCurrency,
      buckets: [],
      invoices: [],
      totalOutstanding: 0,
      unlinkedClient: true,
      message: 'Client email ID not found in CRM records'
    };
  }

  if (!hasPermission(req, 'crm.finance.read')) {
    return {
      defaultCurrency,
      buckets: [],
      invoices: [],
      totalOutstanding: 0
    };
  }

  const Invoice = getModel(req, 'Invoice');
  const Company = getModel(req, 'Company');
  if (!Invoice) {
    return { defaultCurrency, buckets: [], invoices: [], totalOutstanding: 0 };
  }

  const invoiceFilter = {
    ...baseFilter(req),
    // Ageing is about money owed on supplies made; a proforma is neither.
    documentType: { $in: ['tax', null] },
    balanceDue: { $gt: 0 },
    status: { $nin: ['Cancelled', 'Draft'] }
  };
  if (clientId) invoiceFilter.clientId = clientId;

  const rows = await Invoice.find(invoiceFilter)
    .select('invoiceNo clientId balanceDue dueDate status')
    .lean();

  const clientIds = [...new Set(rows.map((r) => String(r.clientId)).filter(Boolean))];
  const clientMap = {};
  if (Company && clientIds.length) {
    const clients = await Company.find({ ...baseFilter(req), _id: { $in: clientIds } })
      .select('name')
      .lean();
    for (const client of clients) {
      clientMap[String(client._id)] = client.name;
    }
  }

  const now = new Date();
  const bucketDefs = [
    { key: 'current', label: 'Current (not overdue)', match: (days) => days <= 0 },
    { key: '1-30', label: '1–30 days overdue', match: (days) => days >= 1 && days <= 30 },
    { key: '31-60', label: '31–60 days overdue', match: (days) => days >= 31 && days <= 60 },
    { key: '61-90', label: '61–90 days overdue', match: (days) => days >= 61 && days <= 90 },
    { key: '90+', label: '90+ days overdue', match: (days) => days > 90 }
  ];

  const bucketTotals = Object.fromEntries(bucketDefs.map((b) => [b.key, { count: 0, amount: 0 }]));
  const invoiceRows = [];
  let totalOutstanding = 0;

  for (const row of rows) {
    const balance = Number(row.balanceDue) || 0;
    totalOutstanding += balance;
    const dueDate = row.dueDate ? new Date(row.dueDate) : null;
    const daysOverdue = dueDate
      ? Math.floor((now - dueDate) / (1000 * 60 * 60 * 24))
      : 0;

    const bucket = bucketDefs.find((b) => b.match(daysOverdue)) || bucketDefs[0];
    bucketTotals[bucket.key].count += 1;
    bucketTotals[bucket.key].amount += balance;

    invoiceRows.push({
      id: String(row._id),
      invoiceNo: row.invoiceNo,
      clientName: clientMap[String(row.clientId)] || row.clientId,
      balanceDue: roundMoney(balance),
      dueDate: row.dueDate,
      daysOverdue,
      bucket: bucket.key,
      status: row.status
    });
  }

  invoiceRows.sort((a, b) => b.daysOverdue - a.daysOverdue);

  const buckets = bucketDefs.map((def) => ({
    key: def.key,
    label: def.label,
    count: bucketTotals[def.key].count,
    amount: roundMoney(bucketTotals[def.key].amount)
  }));

  return {
    defaultCurrency,
    clientId: clientId || undefined,
    buckets,
    invoices: invoiceRows.slice(0, 100),
    totalOutstanding: roundMoney(totalOutstanding)
  };
}

async function getTimeReport(req, query = {}) {
  const range = parseDateRange(query);
  const clientId = await resolveReportClientId(req, query);
  const settings = await SettingService.getAll(req).catch(() => ({}));
  const defaultCurrency = settings.default_currency || 'INR';

  if (isClientUser(req) && clientId === '__UNLINKED_CLIENT_NO_MATCH__') {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      defaultCurrency,
      totalHours: 0,
      billableHours: 0,
      nonBillableHours: 0,
      billableAmount: 0,
      byPeriod: [],
      byProject: [],
      byUser: [],
      unlinkedClient: true,
      message: 'Client email ID not found in CRM records'
    };
  }

  if (!hasPermission(req, 'crm.time.read')) {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      defaultCurrency,
      totalHours: 0,
      billableHours: 0,
      nonBillableHours: 0,
      billableAmount: 0,
      byPeriod: [],
      byProject: [],
      byUser: []
    };
  }

  const TimeLog = getModel(req, 'TimeLog');
  const Task = getModel(req, 'Task');
  const Project = getModel(req, 'Project');

  const scopedProjectIds = clientId ? await getClientProjectIds(req, clientId) : null;
  if (clientId && (!scopedProjectIds || !scopedProjectIds.length)) {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      clientId,
      defaultCurrency,
      totalHours: 0,
      billableHours: 0,
      nonBillableHours: 0,
      billableAmount: 0,
      byPeriod: [],
      byProject: [],
      byUser: []
    };
  }

  if (!TimeLog) {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      defaultCurrency,
      totalHours: 0,
      billableHours: 0,
      nonBillableHours: 0,
      billableAmount: 0,
      byPeriod: [],
      byProject: [],
      byUser: []
    };
  }

  let logFilter = {
    ...baseFilter(req),
    workDate: { $gte: range.from, $lte: range.to }
  };

  if (isEmployeeScoped(req)) {
    const userId = require('../utils/tenant.util').resolveUserId(req);
    logFilter = { ...logFilter, createdBy: userId };
  }

  const logs = await TimeLog.find(logFilter)
    .select('taskId hours billableAmount isBillable createdBy workDate')
    .lean();

  const taskIds = [...new Set(logs.map((l) => String(l.taskId)).filter(Boolean))];
  const taskMap = {};
  const projectIds = new Set();

  if (Task && taskIds.length) {
    let taskFilter = { ...baseFilter(req), _id: { $in: taskIds } };
    if (scopedProjectIds) {
      taskFilter.projectId = { $in: scopedProjectIds };
    }
    taskFilter = await applyEmployeeTaskListScope(req, taskFilter);
    const tasks = await Task.find(taskFilter).select('_id projectId title assignedTo').lean();
    for (const task of tasks) {
      taskMap[String(task._id)] = task;
      if (task.projectId) projectIds.add(String(task.projectId));
    }
  }

  const projectMap = {};
  if (Project && projectIds.size) {
    let projectFilter = { ...baseFilter(req), _id: { $in: [...projectIds] } };
    if (scopedProjectIds) {
      projectFilter._id = { $in: scopedProjectIds.filter((id) => projectIds.has(id)) };
    }
    projectFilter = await applyEmployeeProjectListScope(req, projectFilter);
    const projects = await Project.find(projectFilter).select('_id name clientId').lean();
    for (const project of projects) {
      projectMap[String(project._id)] = project.name;
    }
  }

  let totalHours = 0;
  let billableHours = 0;
  let billableAmount = 0;
  const byPeriod = {};
  const byProject = {};
  const byUser = {};

  for (const log of logs) {
    const task = taskMap[String(log.taskId)];
    if (!task) continue;

    const hours = Number(log.hours) || 0;
    const amount = Number(log.billableAmount) || 0;
    const isBillable = Boolean(log.isBillable);

    totalHours += hours;
    if (isBillable) {
      billableHours += hours;
      billableAmount += amount;
    }

    const periodKey = log.workDate
      ? new Date(log.workDate).toISOString().slice(0, 7)
      : 'unknown';
    if (!byPeriod[periodKey]) {
      byPeriod[periodKey] = { hours: 0, billableAmount: 0 };
    }
    byPeriod[periodKey].hours += hours;
    byPeriod[periodKey].billableAmount += amount;

    const pid = String(task.projectId || '');
    const projectName = projectMap[pid] || 'Unknown project';
    if (!byProject[pid]) {
      byProject[pid] = { projectId: pid, projectName, hours: 0, billableAmount: 0 };
    }
    byProject[pid].hours += hours;
    byProject[pid].billableAmount += amount;

    const userId = String(log.createdBy || task.assignedTo || '');
    if (userId) {
      if (!byUser[userId]) {
        byUser[userId] = { userId, hours: 0, billableHours: 0, billableAmount: 0 };
      }
      byUser[userId].hours += hours;
      if (isBillable) {
        byUser[userId].billableHours += hours;
      }
      byUser[userId].billableAmount += amount;
    }
  }

  const nonBillableHours = roundHours(totalHours - billableHours);

  const userIds = Object.keys(byUser);
  const usernameMap = userIds.length ? await resolveUsernames(req, userIds) : {};

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    clientId: clientId || undefined,
    defaultCurrency,
    totalHours: roundHours(totalHours),
    billableHours: roundHours(billableHours),
    nonBillableHours,
    billableAmount: roundMoney(billableAmount),
    billablePercent: totalHours > 0 ? roundMoney((billableHours / totalHours) * 100) : 0,
    byPeriod: Object.entries(byPeriod)
      .map(([period, totals]) => ({
        period,
        hours: roundHours(totals.hours),
        billableAmount: roundMoney(totals.billableAmount)
      }))
      .sort((a, b) => a.period.localeCompare(b.period)),
    byProject: Object.values(byProject)
      .map((row) => ({
        ...row,
        name: row.projectName,
        hours: roundHours(row.hours),
        billableAmount: roundMoney(row.billableAmount)
      }))
      .sort((a, b) => b.hours - a.hours),
    byUser: Object.values(byUser)
      .map((row) => {
        const displayName = usernameMap[row.userId] || row.userId;
        return {
          ...row,
          name: displayName,
          username: displayName,
          hours: roundHours(row.hours),
          billableHours: roundHours(row.billableHours),
          billableAmount: roundMoney(row.billableAmount)
        };
      })
      .sort((a, b) => b.hours - a.hours)
  };
}

async function getIncomeExpenseReport(req, query = {}) {
  const range = parseDateRange(query);
  const clientId = await resolveReportClientId(req, query);
  const settings = await SettingService.getAll(req).catch(() => ({}));
  const defaultCurrency = settings.default_currency || 'INR';

  if (isClientUser(req) && clientId === '__UNLINKED_CLIENT_NO_MATCH__') {
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      defaultCurrency,
      incomeTotal: 0,
      expenseTotal: 0,
      netTotal: 0,
      byPeriod: [],
      byCategory: [],
      unlinkedClient: true,
      message: 'Client email ID not found in CRM records'
    };
  }

  const canFinance = hasPermission(req, 'crm.finance.read');
  const canExpenses = hasPermission(req, 'crm.expenses.read');
  const clientProjectIds = clientId ? await getClientProjectIds(req, clientId) : [];

  let incomeTotal = 0;
  let expenseTotal = 0;
  const byPeriod = {};
  const byCategory = {};

  if (canFinance) {
    const Payment = getModel(req, 'Payment');
    if (Payment) {
      const paymentFilter = {
        ...baseFilter(req),
        paymentDate: { $gte: range.from, $lte: range.to }
      };
      if (clientId) paymentFilter.clientId = clientId;

      const payments = await Payment.find(paymentFilter)
        .select('amount paymentDate')
        .lean();

      for (const row of payments) {
        const amount = Number(row.amount) || 0;
        incomeTotal += amount;
        const periodKey = row.paymentDate
          ? new Date(row.paymentDate).toISOString().slice(0, 7)
          : 'unknown';
        if (!byPeriod[periodKey]) {
          byPeriod[periodKey] = { income: 0, expenses: 0 };
        }
        byPeriod[periodKey].income += amount;
      }
    }
  }

  if (canExpenses) {
    const Expense = getModel(req, 'Expense');
    if (Expense) {
      let filter = {
        ...baseFilter(req),
        status: 'Approved',
        expenseDate: { $gte: range.from, $lte: range.to }
      };
      if (clientId) {
        const expenseScope = [{ clientId: String(clientId) }];
        if (clientProjectIds.length) {
          expenseScope.push({ projectId: { $in: clientProjectIds } });
        }
        filter.$or = expenseScope;
      }
      filter = await applyExpenseListScope(req, filter);

      const expenses = await Expense.find(filter).select('amount expenseDate category').lean();

      for (const row of expenses) {
        const amount = Number(row.amount) || 0;
        expenseTotal += amount;
        const periodKey = row.expenseDate
          ? new Date(row.expenseDate).toISOString().slice(0, 7)
          : 'unknown';
        if (!byPeriod[periodKey]) {
          byPeriod[periodKey] = { income: 0, expenses: 0 };
        }
        byPeriod[periodKey].expenses += amount;

        const category = String(row.category || 'Other');
        if (!byCategory[category]) byCategory[category] = 0;
        byCategory[category] += amount;
      }
    }
  }

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    clientId: clientId || undefined,
    defaultCurrency,
    incomeTotal: roundMoney(incomeTotal),
    expenseTotal: roundMoney(expenseTotal),
    netTotal: roundMoney(incomeTotal - expenseTotal),
    byPeriod: Object.entries(byPeriod)
      .map(([period, totals]) => ({
        period,
        income: roundMoney(totals.income),
        expenses: roundMoney(totals.expenses),
        net: roundMoney(totals.income - totals.expenses)
      }))
      .sort((a, b) => a.period.localeCompare(b.period)),
    byCategory: Object.entries(byCategory)
      .map(([category, amount]) => ({ category, amount: roundMoney(amount) }))
      .sort((a, b) => b.amount - a.amount)
  };
}

async function getRecurringInvoicesReport(req, query = {}) {
  const clientId = await resolveReportClientId(req, query);
  const RecurringInvoice = getModel(req, 'RecurringInvoice');
  const Company = getModel(req, 'Company');

  if (isClientUser(req) && clientId === '__UNLINKED_CLIENT_NO_MATCH__') {
    return {
      totalProfiles: 0,
      activeProfiles: 0,
      pausedProfiles: 0,
      completedProfiles: 0,
      projectedMrr: 0,
      projectedArr: 0,
      totalGeneratedInvoices: 0,
      totalGeneratedAmount: 0,
      byFrequency: [],
      profiles: [],
      unlinkedClient: true,
      message: 'Client email ID not found in CRM records'
    };
  }

  if (!RecurringInvoice) {
    return {
      totalProfiles: 0,
      activeProfiles: 0,
      pausedProfiles: 0,
      completedProfiles: 0,
      projectedMrr: 0,
      projectedArr: 0,
      totalGeneratedInvoices: 0,
      totalGeneratedAmount: 0,
      byFrequency: [],
      profiles: []
    };
  }

  let filter = { ...baseFilter(req) };
  if (clientId) filter.clientId = String(clientId);

  const profiles = await RecurringInvoice.find(filter).sort({ nextRunDate: 1, createdAt: -1 }).lean();

  let clientMap = {};
  if (Company && profiles.length) {
    const clientIds = [...new Set(profiles.map((p) => String(p.clientId)).filter(Boolean))];
    const clients = await Company.find({ ...baseFilter(req), _id: { $in: clientIds } }).select('_id name companyName').lean();
    for (const c of clients) {
      clientMap[String(c._id)] = c.companyName || c.name || 'Client';
    }
  }

  let totalProfiles = profiles.length;
  let activeProfiles = 0;
  let pausedProfiles = 0;
  let completedProfiles = 0;
  let projectedMrr = 0;
  let totalGeneratedInvoices = 0;
  let totalGeneratedAmount = 0;
  const freqCount = {};

  const enrichedProfiles = profiles.map((p) => {
    const status = p.status || (p.active === false ? 'paused' : 'active');
    if (status === 'active') activeProfiles++;
    else if (status === 'paused') pausedProfiles++;
    else if (status === 'completed') completedProfiles++;

    const freq = p.frequency || 'monthly';
    freqCount[freq] = (freqCount[freq] || 0) + 1;

    const amount = Number(p.totalAmount || p.subtotal || 0);
    const genCount = Number(p.cyclesCompleted || p.totalGeneratedInvoices || 0);
    totalGeneratedInvoices += genCount;
    totalGeneratedAmount += (amount * genCount);

    if (status === 'active') {
      let monthlyVal = 0;
      switch (freq) {
        case 'daily': monthlyVal = amount * 30; break;
        case 'weekly': monthlyVal = amount * 4.33; break;
        case 'biweekly': monthlyVal = amount * 2.16; break;
        case 'monthly': monthlyVal = amount; break;
        case 'quarterly': monthlyVal = amount / 3; break;
        case 'half_yearly': monthlyVal = amount / 6; break;
        case 'yearly': monthlyVal = amount / 12; break;
        default: monthlyVal = amount; break;
      }
      projectedMrr += monthlyVal;
    }

    return {
      id: p._id,
      profileName: p.profileName || p.title || `Rec #${String(p._id).slice(-4)}`,
      clientId: p.clientId,
      clientName: clientMap[String(p.clientId)] || p.clientName || '—',
      frequency: freq,
      amount: roundMoney(amount),
      currency: p.currency || 'INR',
      status: status,
      nextRunDate: p.nextRunDate,
      startDate: p.startDate,
      cyclesCompleted: genCount,
      cyclesLimit: p.cyclesLimit || null,
      autoSend: Boolean(p.autoSendEmail || p.autoSend)
    };
  });

  const byFrequency = Object.entries(freqCount).map(([frequency, count]) => ({
    frequency,
    count
  })).sort((a, b) => b.count - a.count);

  return {
    totalProfiles,
    activeProfiles,
    pausedProfiles,
    completedProfiles,
    projectedMrr: roundMoney(projectedMrr),
    projectedArr: roundMoney(projectedMrr * 12),
    totalGeneratedInvoices,
    totalGeneratedAmount: roundMoney(totalGeneratedAmount),
    byFrequency,
    profiles: enrichedProfiles
  };
}

async function getCreditNotesReport(req, query = {}) {
  const range = parseDateRange(query);
  const clientId = await resolveReportClientId(req, query);
  const CreditNote = getModel(req, 'CreditNote');
  const Company = getModel(req, 'Company');

  if (isClientUser(req) && clientId === '__UNLINKED_CLIENT_NO_MATCH__') {
    return {
      totalCreditNotes: 0,
      totalAmount: 0,
      totalApplied: 0,
      totalOpenBalance: 0,
      totalRefunded: 0,
      byStatus: [],
      byPeriod: [],
      creditNotes: [],
      unlinkedClient: true,
      message: 'Client email ID not found in CRM records'
    };
  }

  if (!CreditNote) {
    return {
      totalCreditNotes: 0,
      totalAmount: 0,
      totalApplied: 0,
      totalOpenBalance: 0,
      totalRefunded: 0,
      byStatus: [],
      byPeriod: [],
      creditNotes: []
    };
  }

  let filter = {
    ...baseFilter(req),
    createdAt: { $gte: range.from, $lte: range.to }
  };
  if (clientId) filter.clientId = String(clientId);

  const notes = await CreditNote.find(filter).sort({ creditDate: -1, createdAt: -1 }).lean();

  let clientMap = {};
  if (Company && notes.length) {
    const clientIds = [...new Set(notes.map((n) => String(n.clientId)).filter(Boolean))];
    const clients = await Company.find({ ...baseFilter(req), _id: { $in: clientIds } }).select('_id name companyName').lean();
    for (const c of clients) {
      clientMap[String(c._id)] = c.companyName || c.name || 'Client';
    }
  }

  let totalCreditNotes = notes.length;
  let totalAmount = 0;
  let totalApplied = 0;
  let totalOpenBalance = 0;
  let totalRefunded = 0;
  const statusCount = {};
  const periodMap = {};

  const enrichedNotes = notes.map((n) => {
    const status = (n.status || 'open').toLowerCase();
    const amount = Number(n.total || n.amount || 0);
    const applied = typeof n.appliedAmount === 'number'
      ? Number(n.appliedAmount)
      : (n.total !== undefined && n.remainingAmount !== undefined ? Math.max(0, Number(n.total) - Number(n.remainingAmount)) : 0);
    const remaining = typeof n.remainingAmount === 'number'
      ? Number(n.remainingAmount)
      : Math.max(0, amount - applied);
    const refunded = typeof n.refundedAmount === 'number'
      ? Number(n.refundedAmount)
      : (status === 'refunded' ? amount : 0);

    totalAmount += amount;
    totalApplied += applied;
    totalOpenBalance += (status === 'open' ? remaining : 0);
    totalRefunded += refunded;

    statusCount[status] = (statusCount[status] || 0) + 1;

    const periodKey = (n.creditDate || n.createdAt) ? new Date(n.creditDate || n.createdAt).toISOString().slice(0, 7) : '—';
    if (!periodMap[periodKey]) {
      periodMap[periodKey] = { period: periodKey, total: 0, count: 0 };
    }
    periodMap[periodKey].total += amount;
    periodMap[periodKey].count += 1;

    return {
      id: n._id,
      creditNoteNumber: n.creditNoteNumber || n.number || `CN-${String(n._id).slice(-4)}`,
      clientId: n.clientId,
      clientName: clientMap[String(n.clientId)] || n.clientName || '—',
      invoiceNumber: n.invoiceNumber || n.invoiceNo || '—',
      amount: roundMoney(amount),
      appliedAmount: roundMoney(applied),
      remainingAmount: roundMoney(remaining),
      refundedAmount: roundMoney(refunded),
      currency: n.currency || 'INR',
      status: status,
      creditDate: n.creditDate || n.createdAt,
      reason: n.reason || n.notes || '—'
    };
  });

  const byStatus = Object.entries(statusCount).map(([status, count]) => ({
    status,
    count
  })).sort((a, b) => b.count - a.count);

  const byPeriod = Object.values(periodMap).sort((a, b) => a.period.localeCompare(b.period));

  return {
    totalCreditNotes,
    totalAmount: roundMoney(totalAmount),
    totalApplied: roundMoney(totalApplied),
    totalOpenBalance: roundMoney(totalOpenBalance),
    totalRefunded: roundMoney(totalRefunded),
    byStatus,
    byPeriod,
    creditNotes: enrichedNotes
  };
}

async function getPaymentReconciliationReport(req, query = {}) {
  const range = parseDateRange(query);
  const clientId = await resolveReportClientId(req, query);
  const Payment = getModel(req, 'Payment');
  const Company = getModel(req, 'Company');

  if (isClientUser(req) && clientId === '__UNLINKED_CLIENT_NO_MATCH__') {
    return {
      totalPaymentsCount: 0,
      grossAmount: 0,
      totalRefunds: 0,
      netCollected: 0,
      byMethod: [],
      byPeriod: [],
      payments: [],
      unlinkedClient: true,
      message: 'Client email ID not found in CRM records'
    };
  }

  if (!Payment) {
    return {
      totalPaymentsCount: 0,
      grossAmount: 0,
      totalRefunds: 0,
      netCollected: 0,
      byMethod: [],
      byPeriod: [],
      payments: []
    };
  }

  let filter = {
    ...baseFilter(req),
    createdAt: { $gte: range.from, $lte: range.to }
  };
  if (clientId) filter.clientId = String(clientId);

  const payments = await Payment.find(filter).sort({ paymentDate: -1, createdAt: -1 }).lean();

  let clientMap = {};
  if (Company && payments.length) {
    const clientIds = [...new Set(payments.map((p) => String(p.clientId)).filter(Boolean))];
    const clients = await Company.find({ ...baseFilter(req), _id: { $in: clientIds } }).select('_id name companyName').lean();
    for (const c of clients) {
      clientMap[String(c._id)] = c.companyName || c.name || 'Client';
    }
  }

  let totalPaymentsCount = payments.length;
  let grossAmount = 0;
  let totalRefunds = 0;
  const methodMap = {};
  const periodMap = {};

  const enrichedPayments = payments.map((p) => {
    const amount = Number(p.amount || 0);
    const refundAmt = Number(p.refundedAmount || (p.status === 'refunded' ? amount : 0));
    grossAmount += amount;
    totalRefunds += refundAmt;

    const mode = p.paymentMode || p.method || 'Other';
    if (!methodMap[mode]) {
      methodMap[mode] = { method: mode, count: 0, gross: 0, refunds: 0, net: 0 };
    }
    methodMap[mode].count += 1;
    methodMap[mode].gross += amount;
    methodMap[mode].refunds += refundAmt;
    methodMap[mode].net += (amount - refundAmt);

    const periodKey = (p.paymentDate || p.createdAt) ? new Date(p.paymentDate || p.createdAt).toISOString().slice(0, 7) : '—';
    if (!periodMap[periodKey]) {
      periodMap[periodKey] = { period: periodKey, gross: 0, refunds: 0, net: 0, count: 0 };
    }
    periodMap[periodKey].gross += amount;
    periodMap[periodKey].refunds += refundAmt;
    periodMap[periodKey].net += (amount - refundAmt);
    periodMap[periodKey].count += 1;

    return {
      id: p._id,
      receiptNumber: p.receiptNumber || p.paymentNumber || `PAY-${String(p._id).slice(-4)}`,
      clientId: p.clientId,
      clientName: clientMap[String(p.clientId)] || p.clientName || '—',
      invoiceNumber: p.invoiceNumber || p.invoiceNo || '—',
      amount: roundMoney(amount),
      refundedAmount: roundMoney(refundAmt),
      netAmount: roundMoney(amount - refundAmt),
      paymentMode: mode,
      transactionId: p.transactionId || p.referenceNo || '—',
      currency: p.currency || 'INR',
      status: p.status || 'completed',
      refundStatus: p.refundStatus || (refundAmt > 0 ? 'refunded' : 'none'),
      paymentDate: p.paymentDate || p.createdAt
    };
  });

  const byMethod = Object.values(methodMap).map((m) => ({
    ...m,
    gross: roundMoney(m.gross),
    refunds: roundMoney(m.refunds),
    net: roundMoney(m.net)
  })).sort((a, b) => b.gross - a.gross);

  const byPeriod = Object.values(periodMap).map((p) => ({
    ...p,
    gross: roundMoney(p.gross),
    refunds: roundMoney(p.refunds),
    net: roundMoney(p.net)
  })).sort((a, b) => a.period.localeCompare(b.period));

  return {
    totalPaymentsCount,
    grossAmount: roundMoney(grossAmount),
    totalRefunds: roundMoney(totalRefunds),
    netCollected: roundMoney(grossAmount - totalRefunds),
    byMethod,
    byPeriod,
    payments: enrichedPayments
  };
}

const EXPORT_DEFINITIONS = {
  'activity-location': {
    filename: 'activity-location-report',
    async build(req, query) {
      const data = await getActivityLocationReport(req, query);
      const pick = (point, field) => (point && point[field] != null ? point[field] : '');
      const rows = (data.rows || []).map((row) => ({
        salesRep: row.salesRepName || '',
        lead: row.leadName || '',
        company: row.leadCompany || '',
        activity: row.activityTitle || '',
        type: row.activityType || '',
        kind: row.kind || '',
        status: row.displayStatus || row.status || '',
        missed: row.isMissed ? 'Yes' : 'No',
        eventDate: row.eventDate ? new Date(row.eventDate).toISOString() : '',
        completedAt: row.completedAt ? new Date(row.completedAt).toISOString() : '',
        goalLatitude: pick(row.goalLocation, 'latitude'),
        goalLongitude: pick(row.goalLocation, 'longitude'),
        goalAddress: pick(row.goalLocation, 'address'),
        createdLatitude: pick(row.createdLocation, 'latitude'),
        createdLongitude: pick(row.createdLocation, 'longitude'),
        createdAddress: pick(row.createdLocation, 'address'),
        acceptedLatitude: pick(row.acceptedLocation, 'latitude'),
        acceptedLongitude: pick(row.acceptedLocation, 'longitude'),
        acceptedAddress: pick(row.acceptedLocation, 'address'),
        completedLatitude: pick(row.completedLocation, 'latitude'),
        completedLongitude: pick(row.completedLocation, 'longitude'),
        completedAddress: pick(row.completedLocation, 'address')
      }));
      return rowsToCsv(
        [
          { key: 'salesRep', label: 'Sales rep' },
          { key: 'lead', label: 'Lead' },
          { key: 'company', label: 'Company' },
          { key: 'activity', label: 'Activity' },
          { key: 'type', label: 'Type' },
          { key: 'kind', label: 'Kind' },
          { key: 'status', label: 'Status' },
          { key: 'missed', label: 'Missed' },
          { key: 'eventDate', label: 'Activity date' },
          { key: 'completedAt', label: 'Completed at' },
          { key: 'goalLatitude', label: 'Goal latitude' },
          { key: 'goalLongitude', label: 'Goal longitude' },
          { key: 'goalAddress', label: 'Goal address' },
          { key: 'createdLatitude', label: 'Created latitude' },
          { key: 'createdLongitude', label: 'Created longitude' },
          { key: 'createdAddress', label: 'Created address' },
          { key: 'acceptedLatitude', label: 'Accepted latitude' },
          { key: 'acceptedLongitude', label: 'Accepted longitude' },
          { key: 'acceptedAddress', label: 'Accepted address' },
          { key: 'completedLatitude', label: 'Completed latitude' },
          { key: 'completedLongitude', label: 'Completed longitude' },
          { key: 'completedAddress', label: 'Completed address' }
        ],
        rows
      );
    }
  },
  sales: {
    filename: 'sales-report',
    async build(req, query) {
      const data = await getSalesReport(req, query);
      const rows = [
        ...(data.pipeline || []).map((r) => ({
          metric: `Pipeline: ${r.stage}`,
          value: r.count
        })),
        ...(data.leadsByPeriod || []).map((r) => ({
          metric: `Leads ${r.period}`,
          value: r.count
        })),
        { metric: 'Total leads', value: data.totalLeads },
        { metric: 'Won leads', value: data.wonLeads },
        { metric: 'Conversion rate %', value: data.conversionRate },
        { metric: 'Payments total', value: data.paymentsTotal ?? '' }
      ];
      return rowsToCsv(
        [
          { key: 'metric', label: 'Metric' },
          { key: 'value', label: 'Value' }
        ],
        rows
      );
    }
  },
  'lead-conversion': {
    filename: 'lead-conversion-report',
    async build(req, query) {
      const data = await getLeadConversionReport(req, query);
      const rows = [
        { metric: 'Total leads', value: data.totalLeads },
        { metric: 'Won leads', value: data.wonLeads },
        { metric: 'Lost leads', value: data.lostLeads },
        { metric: 'Converted to client', value: data.convertedLeads },
        { metric: 'Win rate %', value: data.winRate },
        { metric: 'Conversion rate %', value: data.conversionRate },
        ...(data.byStage || []).map((r) => ({
          metric: `Stage: ${r.stage}`,
          value: r.count
        }))
      ];
      return rowsToCsv(
        [
          { key: 'metric', label: 'Metric' },
          { key: 'value', label: 'Value' }
        ],
        rows
      );
    }
  },
  projects: {
    filename: 'projects-report',
    async build(req, query) {
      const data = await getProjectsReport(req, query);
      return rowsToCsv(
        [
          { key: 'name', label: 'Project' },
          { key: 'clientName', label: 'Client' },
          { key: 'status', label: 'Status' },
          { key: 'tasksCompleted', label: 'Tasks done' },
          { key: 'tasksTotal', label: 'Tasks total' },
          { key: 'completionPct', label: 'Completion %' },
          { key: 'hoursLogged', label: 'Hours' },
          { key: 'billableAmount', label: 'Billable' }
        ],
        (data.projects || []).map((r) => ({
          name: r.name,
          clientName: r.clientName,
          status: r.status,
          tasksCompleted: r.tasksCompleted,
          tasksTotal: r.tasksTotal,
          completionPct: r.completionPct,
          hoursLogged: r.hoursLogged ?? '',
          billableAmount: r.billableAmount ?? ''
        }))
      );
    }
  },
  time: {
    filename: 'time-report',
    async build(req, query) {
      const data = await getTimeReport(req, query);
      const rows = (data.byProject || []).map((r) => ({
        projectName: r.projectName,
        hours: r.hours,
        billableAmount: r.billableAmount
      }));
      if (!rows.length) {
        rows.push({
          projectName: 'Totals',
          hours: data.totalHours,
          billableAmount: data.billableAmount
        });
      }
      return rowsToCsv(
        [
          { key: 'projectName', label: 'Project' },
          { key: 'hours', label: 'Hours' },
          { key: 'billableAmount', label: 'Billable amount' }
        ],
        rows
      );
    }
  },
  'invoice-ageing': {
    filename: 'invoice-ageing-report',
    async build(req, query) {
      const data = await getInvoiceAgeingReport(req, query);
      return rowsToCsv(
        [
          { key: 'invoiceNo', label: 'Invoice' },
          { key: 'clientName', label: 'Client' },
          { key: 'balanceDue', label: 'Balance due' },
          { key: 'dueDate', label: 'Due date' },
          { key: 'daysOverdue', label: 'Days overdue' },
          { key: 'bucket', label: 'Age bucket' },
          { key: 'status', label: 'Status' }
        ],
        (data.invoices || []).map((r) => ({
          invoiceNo: r.invoiceNo,
          clientName: r.clientName,
          balanceDue: r.balanceDue,
          dueDate: r.dueDate ? new Date(r.dueDate).toISOString().slice(0, 10) : '',
          daysOverdue: r.daysOverdue,
          bucket: r.bucket,
          status: r.status
        }))
      );
    }
  },
  'income-expense': {
    filename: 'income-expense-report',
    async build(req, query) {
      const data = await getIncomeExpenseReport(req, query);
      const rows = [
        { metric: 'Income total', value: data.incomeTotal },
        { metric: 'Expense total', value: data.expenseTotal },
        { metric: 'Net total', value: data.netTotal },
        ...(data.byPeriod || []).flatMap((r) => [
          { metric: `${r.period} income`, value: r.income },
          { metric: `${r.period} expenses`, value: r.expenses },
          { metric: `${r.period} net`, value: r.net }
        ]),
        ...(data.byCategory || []).map((r) => ({
          metric: `Category: ${r.category}`,
          value: r.amount
        }))
      ];
      return rowsToCsv(
        [
          { key: 'metric', label: 'Metric' },
          { key: 'value', label: 'Value' }
        ],
        rows
      );
    }
  },
  'recurring-invoices': {
    filename: 'recurring-invoices-report',
    async build(req, query) {
      const data = await getRecurringInvoicesReport(req, query);
      return rowsToCsv(
        [
          { key: 'profileName', label: 'Profile' },
          { key: 'clientName', label: 'Client' },
          { key: 'frequency', label: 'Frequency' },
          { key: 'amount', label: 'Amount' },
          { key: 'currency', label: 'Currency' },
          { key: 'status', label: 'Status' },
          { key: 'nextRunDate', label: 'Next run' },
          { key: 'cyclesCompleted', label: 'Invoices created' }
        ],
        (data.profiles || []).map((r) => ({
          profileName: r.profileName,
          clientName: r.clientName,
          frequency: r.frequency,
          amount: r.amount,
          currency: r.currency,
          status: r.status,
          nextRunDate: r.nextRunDate ? new Date(r.nextRunDate).toISOString().slice(0, 10) : '',
          cyclesCompleted: r.cyclesCompleted
        }))
      );
    }
  },
  'credit-notes': {
    filename: 'credit-notes-report',
    async build(req, query) {
      const data = await getCreditNotesReport(req, query);
      return rowsToCsv(
        [
          { key: 'creditNoteNumber', label: 'Credit note #' },
          { key: 'clientName', label: 'Client' },
          { key: 'invoiceNumber', label: 'Invoice #' },
          { key: 'amount', label: 'Total amount' },
          { key: 'appliedAmount', label: 'Applied amount' },
          { key: 'remainingAmount', label: 'Remaining balance' },
          { key: 'refundedAmount', label: 'Refunded amount' },
          { key: 'status', label: 'Status' },
          { key: 'creditDate', label: 'Date' }
        ],
        (data.creditNotes || []).map((r) => ({
          creditNoteNumber: r.creditNoteNumber,
          clientName: r.clientName,
          invoiceNumber: r.invoiceNumber,
          amount: r.amount,
          appliedAmount: r.appliedAmount,
          remainingAmount: r.remainingAmount,
          refundedAmount: r.refundedAmount,
          status: r.status,
          creditDate: r.creditDate ? new Date(r.creditDate).toISOString().slice(0, 10) : ''
        }))
      );
    }
  },
  'payment-reconciliation': {
    filename: 'payment-reconciliation-report',
    async build(req, query) {
      const data = await getPaymentReconciliationReport(req, query);
      return rowsToCsv(
        [
          { key: 'receiptNumber', label: 'Receipt #' },
          { key: 'clientName', label: 'Client' },
          { key: 'invoiceNumber', label: 'Invoice #' },
          { key: 'paymentMode', label: 'Payment mode' },
          { key: 'amount', label: 'Gross amount' },
          { key: 'refundedAmount', label: 'Refunded amount' },
          { key: 'netAmount', label: 'Net amount' },
          { key: 'status', label: 'Status' },
          { key: 'paymentDate', label: 'Date' }
        ],
        (data.payments || []).map((r) => ({
          receiptNumber: r.receiptNumber,
          clientName: r.clientName,
          invoiceNumber: r.invoiceNumber,
          paymentMode: r.paymentMode,
          amount: r.amount,
          refundedAmount: r.refundedAmount,
          netAmount: r.netAmount,
          status: r.status,
          paymentDate: r.paymentDate ? new Date(r.paymentDate).toISOString().slice(0, 10) : ''
        }))
      );
    }
  }
};

async function exportReportCsv(req, query = {}) {
  const reportKey = String(query.report || '').trim();
  const type = String(query.type || 'csv').trim().toLowerCase();

  if (type !== 'csv') {
    const error = new Error('Only CSV export is supported');
    error.status = 400;
    throw error;
  }

  const definition = EXPORT_DEFINITIONS[reportKey];
  if (!definition) {
    const error = new Error(
      `Unknown report. Allowed: ${Object.keys(EXPORT_DEFINITIONS).join(', ')}`
    );
    error.status = 400;
    throw error;
  }

  const csv = await definition.build(req, query);
  const from = query.from ? String(query.from).slice(0, 10) : '';
  const to = query.to ? String(query.to).slice(0, 10) : '';
  const suffix = from && to ? `-${from}-to-${to}` : '';
  const filename = `${definition.filename}${suffix}.csv`;

  return { csv, filename, contentType: 'text/csv; charset=utf-8' };
}

/**
 * Activity Location report — where reps were when they logged, scheduled and
 * completed lead activities.
 *
 * A sales agent sees only activities on leads they own (the same lead scope the
 * rest of the CRM applies); managers and admins see the whole team.
 */
async function getActivityLocationReport(req, query = {}) {
  const LeadEvent = getModel(req, 'LeadEvent');
  const Lead = getModel(req, 'Lead');
  const empty = {
    rows: [],
    summary: { total: 0, withLocation: 0, withoutLocation: 0, reps: 0, leads: 0 },
    range: parseDateRange(query)
  };
  if (!LeadEvent || !Lead) return empty;

  // Client portal users have no business seeing rep movements.
  if (isClientUser(req)) return empty;

  const { from, to } = parseDateRange(query);

  // Restrict to leads this user may see, then filter events by those ids.
  const leadFilter = applySalesAgentLeadListScope(req, { ...baseFilter(req), mergedIntoId: null });
  const leadDocs = await Lead.find(leadFilter)
    .select('name company assignedTo stage requestType')
    .lean();
  if (!leadDocs.length) return { ...empty, range: { from, to } };

  const leadMap = new Map(leadDocs.map((l) => [String(l._id), l]));

  const eventFilter = {
    ...baseFilter(req),
    leadId: { $in: Array.from(leadMap.keys()) },
    createdAt: { $gte: from, $lte: to }
  };

  // Several optional filters can be active at once, so they are collected into
  // one $and rather than competing for a single $or key.
  const clauses = [];

  const repFilter = String(query.rep || query.assignedTo || '').trim();
  if (repFilter) {
    clauses.push({
      $or: [{ assignedTo: repFilter }, { createdBy: repFilter }, { completedBy: repFilter }]
    });
  }

  const typeFilter = String(query.eventType || '').trim();
  if (typeFilter) eventFilter.eventType = typeFilter;

  const kindFilter = String(query.kind || '').trim();
  if (kindFilter === 'scheduled') {
    clauses.push({ kind: 'scheduled' });
  } else if (kindFilter === 'logged') {
    // Activities recorded before kinds existed carry no `kind` at all; they
    // were all "done when logged", so they belong in this bucket.
    clauses.push({ $or: [{ kind: 'logged' }, { kind: null }, { kind: { $exists: false } }] });
  }

  if (String(query.withLocation || '') === 'true') {
    clauses.push({
      $or: [
        { 'createdLocation.latitude': { $ne: null } },
        { 'acceptedLocation.latitude': { $ne: null } },
        { 'completedLocation.latitude': { $ne: null } },
        { 'goalLocation.latitude': { $ne: null } }
      ]
    });
  }

  if (clauses.length) eventFilter.$and = clauses;

  const limit = Math.min(Math.max(Number(query.limit) || 500, 1), 2000);
  const events = await LeadEvent.find(eventFilter).sort({ createdAt: -1 }).limit(limit).lean();

  const userIds = new Set();
  for (const ev of events) {
    if (ev.assignedTo) userIds.add(ev.assignedTo);
    if (ev.createdBy && ev.createdBy !== 'system') userIds.add(ev.createdBy);
    if (ev.completedBy) userIds.add(ev.completedBy);
  }
  const nameMap = userIds.size ? await resolveUsernames(req, Array.from(userIds)) : {};
  const nameOf = (id) => (id ? nameMap[id] || id : '');

  const pickPoint = (loc) => {
    if (!loc) return null;
    // Number(null) is 0, which is a finite "valid" coordinate off the coast of
    // Africa — the schema defaults these to null, so reject nullish explicitly.
    const lat = loc.latitude == null ? NaN : Number(loc.latitude);
    const lng = loc.longitude == null ? NaN : Number(loc.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return {
        latitude: null,
        longitude: null,
        address: loc.address || '',
        accuracy: null,
        capturedAt: loc.capturedAt || null,
        unavailableReason: loc.unavailableReason || ''
      };
    }
    return {
      latitude: lat,
      longitude: lng,
      address: loc.address || '',
      accuracy: loc.accuracy ?? null,
      capturedAt: loc.capturedAt || null,
      unavailableReason: ''
    };
  };

  const nowMs = Date.now();
  const reps = new Set();
  const leadsSeen = new Set();
  let withLocation = 0;
  let missed = 0;

  const rows = events.map((ev) => {
    const lead = leadMap.get(String(ev.leadId));
    const createdPoint = pickPoint(ev.createdLocation);
    const completedPoint = pickPoint(ev.completedLocation);
    const goalPoint = pickPoint(ev.goalLocation);
    const acceptedPoint = pickPoint(ev.acceptedLocation);
    const startingStoredPoint = pickPoint(ev.startingLocation);
    const hasValidCoords = (p) => Boolean(p && p.latitude != null && !isNaN(Number(p.latitude)));
    const startingPoint = hasValidCoords(acceptedPoint)
      ? acceptedPoint
      : (hasValidCoords(createdPoint)
          ? createdPoint
          : (hasValidCoords(startingStoredPoint)
              ? startingStoredPoint
              : (acceptedPoint || createdPoint || startingStoredPoint)));
    const hasCoords = Boolean(
      (createdPoint && createdPoint.latitude != null) ||
        (completedPoint && completedPoint.latitude != null) ||
        (goalPoint && goalPoint.latitude != null) ||
        (acceptedPoint && acceptedPoint.latitude != null) ||
        (startingPoint && startingPoint.latitude != null)
    );
    if (hasCoords) withLocation += 1;
    if (isMissedActivity(ev, nowMs)) missed += 1;

    const repId = ev.assignedTo || ev.completedBy || ev.createdBy || '';
    if (repId) reps.add(repId);
    if (ev.leadId) leadsSeen.add(String(ev.leadId));

    return {
      id: String(ev._id),
      leadId: String(ev.leadId || ''),
      leadName: lead ? String(lead.name || '') : '',
      leadCompany: lead ? String(lead.company || '') : '',
      leadStage: lead ? String(lead.stage || '') : '',
      salesRepId: repId,
      salesRepName: nameOf(repId),
      createdByName: nameOf(ev.createdBy),
      completedByName: nameOf(ev.completedBy),
      activityTitle: String(ev.title || ''),
      activityType: String(ev.eventType || ''),
      kind: String(ev.kind || 'logged'),
      status: String(ev.status || ''),
      // A scheduled visit nobody closed out by its due time.
      isMissed: isMissedActivity(ev, nowMs),
      displayStatus: activityDisplayStatus(ev, nowMs),
      description: String(ev.description || ''),
      eventDate: ev.eventDate || null,
      createdAt: ev.createdAt || null,
      completedAt: ev.completedAt || null,
      createdLocation: createdPoint,
      completedLocation: completedPoint,
      goalLocation: goalPoint,
      acceptedLocation: acceptedPoint,
      startingLocation: startingPoint,
      hasCoordinates: hasCoords
    };
  });

  return {
    rows,
    summary: {
      total: rows.length,
      withLocation,
      withoutLocation: rows.length - withLocation,
      missed,
      reps: reps.size,
      leads: leadsSeen.size
    },
    range: { from, to }
  };
}

module.exports = {
  parseDateRange,
  getActivityLocationReport,
  getSalesReport,
  getProjectsReport,
  getLeadConversionReport,
  getInvoiceAgeingReport,
  getTimeReport,
  getIncomeExpenseReport,
  getRecurringInvoicesReport,
  getCreditNotesReport,
  getPaymentReconciliationReport,
  exportReportCsv
};
