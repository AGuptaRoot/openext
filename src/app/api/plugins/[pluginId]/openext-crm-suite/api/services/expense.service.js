'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { getNextNumber } = require('../utils/numbering.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const SettingService = require('./setting.service');
const AuditService = require('./audit.service');
const {
  assertExpenseReadAccess,
  assertExpenseWriteAccess,
  applyExpenseListScope
} = require('../utils/expense-access.util');
const { PAYMENT_MODES } = require('./payment.service');

const EDITABLE_STATUSES = new Set(['Draft', 'Rejected']);

function getExpenseModel(req) {
  const Expense = req.cms?.models.get('Expense');
  if (!Expense) throw new Error('Expense model is not registered');
  return Expense;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function normalizeAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw appError('Expense amount must be greater than zero');
  }
  return Math.round(value * 100) / 100;
}

function normalizeMode(mode) {
  const value = String(mode || 'Other').trim();
  if (!PAYMENT_MODES.includes(value)) {
    throw appError(`Invalid payment mode. Allowed: ${PAYMENT_MODES.join(', ')}`);
  }
  return value;
}

async function getCategories(req) {
  const settings = await SettingService.getAll(req).catch(() => ({}));
  const categories = settings.expense_categories;
  return Array.isArray(categories) && categories.length
    ? categories
    : ['Travel', 'Software', 'Office', 'Marketing', 'Other'];
}

async function findExpenseOrThrow(req, id) {
  const doc = await getExpenseModel(req).findOne({ ...baseFilter(req), _id: id }).lean();
  if (!doc) throw appError('Expense not found', 404);
  await assertExpenseReadAccess(req, doc);
  return doc;
}

async function validateExpenseLinks(req, clientId, projectId) {
  const clientKey = String(clientId || '').trim();
  const projectKey = String(projectId || '').trim();
  let project = null;

  if (clientKey) {
    const Company = req.cms?.models.get('Company');
    if (!Company || !(await Company.exists({ ...baseFilter(req), mergedIntoId: null, _id: clientKey }))) {
      throw appError('Client not found', 404);
    }
  }
  if (projectKey) {
    const Project = req.cms?.models.get('Project');
    project = Project
      ? await Project.findOne({ ...baseFilter(req), _id: projectKey }).select('clientId').lean()
      : null;
    if (!project) throw appError('Project not found', 404);
  }
  if (clientKey && project && String(project.clientId) !== clientKey) {
    throw appError('Selected project does not belong to the selected client');
  }
}

async function enrichExpenses(req, items) {
  if (!items.length) return items;

  const Company = req.cms?.models.get('Company');
  const Project = req.cms?.models.get('Project');

  const clientIds = [...new Set(items.map((row) => String(row.clientId)).filter(Boolean))];
  const projectIds = [...new Set(items.map((row) => String(row.projectId)).filter(Boolean))];

  const clientMap = {};
  const projectMap = {};

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

  if (Project && projectIds.length) {
    const projects = await Project.find({
      ...baseFilter(req),
      _id: { $in: projectIds }
    })
      .select('name')
      .lean();
    for (const project of projects) {
      projectMap[String(project._id)] = project.name;
    }
  }

  return items.map((row) => ({
    ...row,
    clientName: row.clientId ? clientMap[String(row.clientId)] || '' : '',
    projectName: row.projectId ? projectMap[String(row.projectId)] || '' : ''
  }));
}

async function list(req) {
  const Expense = getExpenseModel(req);
  const { page, limit, skip, sort } = parsePagination(req.query, { sortField: 'expenseDate' });
  let filter = baseFilter(req);

  if (req.query?.status) filter.status = String(req.query.status).trim();
  if (req.query?.category) filter.category = String(req.query.category).trim();
  if (req.query?.clientId) filter.clientId = String(req.query.clientId).trim();
  if (req.query?.projectId) filter.projectId = String(req.query.projectId).trim();
  if (req.query?.isArchived === 'true') {
    filter.isArchived = true;
  } else {
    filter.isArchived = { $ne: true };
  }
  if (req.query?.isProjectDropped === 'true' || req.query?.dropped === 'true') {
    filter.isProjectDropped = true;
  } else if (req.query?.isProjectDropped === 'all') {
    /* no project dropped filter */
  } else {
    filter.isProjectDropped = { $ne: true };
  }
  if (req.query?.isBillable === 'true') filter.isBillable = true;
  if (req.query?.isBilled === 'true') filter.isBilled = true;
  if (req.query?.isBilled === 'false') filter.isBilled = { $ne: true };

  const { isClientUser, resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
  if (isClientUser(req)) {
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId) {
      return {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        unlinkedClient: true,
        message: 'Client email ID not found in CRM records'
      };
    }
    filter.clientId = userClientId;
  }

  if (req.query?.search) {
    const { findMatchingClientIds } = require('../utils/search.util');
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      const or = [
        { title: { $regex: term, $options: 'i' } },
        { itemName: { $regex: term, $options: 'i' } },
        { expenseNo: { $regex: term, $options: 'i' } },
        { purchasedFrom: { $regex: term, $options: 'i' } },
        { notes: { $regex: term, $options: 'i' } },
        { clientId: { $regex: term, $options: 'i' } },
        { clientName: { $regex: term, $options: 'i' } },
        { employeeName: { $regex: term, $options: 'i' } },
        { projectName: { $regex: term, $options: 'i' } }
      ];
      const clientIds = await findMatchingClientIds(req, req.query.search);
      if (clientIds.length) or.push({ clientId: { $in: clientIds } });
      filter.$or = or;
    }
  }

  filter = await applyExpenseListScope(req, filter);

  const [items, total] = await Promise.all([
    Expense.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Expense.countDocuments(filter)
  ]);

  return {
    items: await enrichExpenses(req, items),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

async function getById(req, id) {
  const doc = await findExpenseOrThrow(req, id);
  const [enriched] = await enrichExpenses(req, [doc]);
  return enriched;
}

async function create(req, input) {
  const Expense = getExpenseModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const settings = await SettingService.getAll(req).catch(() => ({}));

  const amount = normalizeAmount(input.amount !== undefined ? input.amount : input.price);
  const categories = await getCategories(req);
  const category = String(input.category || 'Other').trim();
  if (!categories.includes(category)) {
    throw appError(`Invalid category. Allowed: ${categories.join(', ')}`);
  }
  await validateExpenseLinks(req, input.clientId, input.projectId);

  const status = input.submit ? 'Submitted' : 'Draft';
  const expenseNo = await getNextNumber(req, 'expense');
  const expenseDate = input.expenseDate ? new Date(input.expenseDate) : new Date();
  const itemName = String(input.itemName || input.title).trim();
  const price = input.price !== undefined ? Number(input.price) : amount;
  const currency = String(input.currency || settings.default_currency || 'INR').trim().toUpperCase();
  const exchangeRate = Number(input.exchangeRate) || 1;
  const purchaseDate = input.purchaseDate ? new Date(input.purchaseDate) : expenseDate;
  const employeeId = String(input.employeeId || input.employee || '').trim();
  const employeeName = String(input.employeeName || '').trim();
  const purchasedFrom = String(input.purchasedFrom || input.vendor || '').trim();
  const bankAccount = String(input.bankAccount || '').trim();
  const description = String(input.description || input.notes || '').trim();
  const bill = String(input.bill || input.receiptUrl || '').trim();

  const doc = await Expense.create({
    tenantId,
    expenseNo,
    title: itemName,
    itemName,
    amount,
    price,
    currency,
    exchangeRate,
    expenseDate,
    purchaseDate,
    category,
    clientId: input.clientId ? String(input.clientId) : '',
    projectId: input.projectId ? String(input.projectId) : '',
    employeeId,
    employeeName,
    purchasedFrom,
    bankAccount,
    paymentMode: normalizeMode(input.paymentMode),
    isBillable: Boolean(input.isBillable),
    isBilled: false,
    isArchived: false,
    receiptUrl: bill,
    bill,
    notes: description,
    description,
    status,
    submittedAt: status === 'Submitted' ? new Date() : null,
    createdBy: userId,
    updatedBy: userId
  });

  const result = doc.toObject();
  await AuditService.log(req, {
    action: status === 'Submitted' ? 'submitted' : 'created',
    module: 'expense',
    recordId: result._id.toString(),
    description: `Expense ${status === 'Submitted' ? 'submitted' : 'created'}: ${expenseNo} (${amount})`,
    metadata: { expenseNo, amount, status }
  });

  const [enriched] = await enrichExpenses(req, [result]);
  return enriched;
}

async function update(req, id, input) {
  const Expense = getExpenseModel(req);
  const userId = resolveUserId(req);
  const existing = await findExpenseOrThrow(req, id);
  await assertExpenseWriteAccess(req, existing);

  if (!EDITABLE_STATUSES.has(existing.status)) {
    throw appError('Only draft or rejected expenses can be edited', 409);
  }

  const updates = { updatedBy: userId };
  const categories = await getCategories(req);

  if (input.title !== undefined || input.itemName !== undefined) {
    updates.title = String(input.itemName || input.title).trim();
    updates.itemName = updates.title;
  }
  if (input.amount !== undefined || input.price !== undefined) {
    updates.amount = normalizeAmount(input.amount !== undefined ? input.amount : input.price);
    updates.price = updates.amount;
  }
  if (input.expenseDate !== undefined || input.purchaseDate !== undefined) {
    updates.expenseDate = new Date(input.expenseDate || input.purchaseDate);
    updates.purchaseDate = updates.expenseDate;
  }
  if (input.currency !== undefined) updates.currency = String(input.currency).trim().toUpperCase();
  if (input.exchangeRate !== undefined) updates.exchangeRate = Number(input.exchangeRate) || 1;
  if (input.employeeId !== undefined || input.employee !== undefined) updates.employeeId = String(input.employeeId || input.employee || '').trim();
  if (input.employeeName !== undefined) updates.employeeName = String(input.employeeName || '').trim();
  if (input.purchasedFrom !== undefined || input.vendor !== undefined) updates.purchasedFrom = String(input.purchasedFrom || input.vendor || '').trim();
  if (input.bankAccount !== undefined) updates.bankAccount = String(input.bankAccount || '').trim();
  if (input.category !== undefined) {
    const category = String(input.category).trim();
    if (!categories.includes(category)) {
      throw appError(`Invalid category. Allowed: ${categories.join(', ')}`);
    }
    updates.category = category;
  }
  if (input.paymentMode !== undefined) updates.paymentMode = normalizeMode(input.paymentMode);
  if (input.clientId !== undefined) updates.clientId = String(input.clientId || '');
  if (input.projectId !== undefined) updates.projectId = String(input.projectId || '');
  if (input.receiptUrl !== undefined || input.bill !== undefined) {
    updates.receiptUrl = String(input.bill || input.receiptUrl || '').trim();
    updates.bill = updates.receiptUrl;
  }
  if (input.notes !== undefined || input.description !== undefined) {
    updates.notes = String(input.description || input.notes || '').trim();
    updates.description = updates.notes;
  }

  await validateExpenseLinks(
    req,
    updates.clientId !== undefined ? updates.clientId : existing.clientId,
    updates.projectId !== undefined ? updates.projectId : existing.projectId
  );

  const doc = await Expense.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'expense',
    recordId: id,
    description: `Expense updated: ${doc.expenseNo}`
  });

  const [enriched] = await enrichExpenses(req, [doc]);
  return enriched;
}

async function remove(req, id) {
  const Expense = getExpenseModel(req);
  const userId = resolveUserId(req);
  const existing = await findExpenseOrThrow(req, id);
  assertExpenseWriteAccess(req, existing);

  if (existing.status !== 'Draft') {
    throw appError('Only draft expenses can be deleted', 409);
  }

  await Expense.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        updatedBy: userId
      }
    }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'expense',
    recordId: id,
    description: `Expense deleted: ${existing.expenseNo}`,
    metadata: { amount: existing.amount }
  });

  return { deleted: true, id };
}

async function submit(req, id) {
  const Expense = getExpenseModel(req);
  const userId = resolveUserId(req);
  const existing = await findExpenseOrThrow(req, id);
  assertExpenseWriteAccess(req, existing);

  if (!EDITABLE_STATUSES.has(existing.status)) {
    throw appError('Only draft or rejected expenses can be submitted', 409);
  }

  const doc = await Expense.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        status: 'Submitted',
        submittedAt: new Date(),
        rejectionReason: '',
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'submitted',
    module: 'expense',
    recordId: id,
    description: `Expense submitted for approval: ${doc.expenseNo}`
  });

  const [enriched] = await enrichExpenses(req, [doc]);
  return enriched;
}

async function approve(req, id) {
  const Expense = getExpenseModel(req);
  const userId = resolveUserId(req);
  const existing = await findExpenseOrThrow(req, id);

  if (existing.status !== 'Submitted') {
    throw appError('Only submitted expenses can be approved', 409);
  }

  const doc = await Expense.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        status: 'Approved',
        approvedBy: userId,
        approvedAt: new Date(),
        rejectionReason: '',
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'approved',
    module: 'expense',
    recordId: id,
    description: `Expense approved: ${doc.expenseNo} (${doc.amount})`
  });

  const [enriched] = await enrichExpenses(req, [doc]);
  return enriched;
}

async function reject(req, id, input) {
  const Expense = getExpenseModel(req);
  const userId = resolveUserId(req);
  const existing = await findExpenseOrThrow(req, id);

  if (existing.status !== 'Submitted') {
    throw appError('Only submitted expenses can be rejected', 409);
  }

  const reason = String(input?.reason || input || '').trim();
  if (!reason) throw appError('Rejection reason is required');

  const updates = {
    status: 'Rejected',
    rejectedAt: new Date(),
    rejectedBy: userId,
    rejectionReason: reason,
    updatedBy: userId
  };

  const doc = await Expense.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'rejected',
    module: 'expense',
    recordId: id,
    description: `Expense rejected: ${doc.expenseNo}`,
    metadata: { reason }
  });

  const [enriched] = await enrichExpenses(req, [doc]);
  return enriched;
}

async function markBilled(req, id) {
  const Expense = getExpenseModel(req);
  const userId = resolveUserId(req);
  const existing = await findExpenseOrThrow(req, id);

  if (existing.status !== 'Approved') {
    throw appError('Only approved expenses can be marked as billed', 409);
  }

  if (!existing.isBillable) {
    throw appError('Non-billable expenses cannot be marked as billed', 409);
  }

  const doc = await Expense.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { isBilled: true, updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'expense',
    recordId: id,
    description: `Expense marked as billed: ${doc.expenseNo}`
  });

  const [enriched] = await enrichExpenses(req, [doc]);
  return enriched;
}

async function attachReceipt(req, id, receiptUrl) {
  const Expense = getExpenseModel(req);
  const userId = resolveUserId(req);
  await findExpenseOrThrow(req, id);

  const cleanUrl = String(receiptUrl || '').trim();
  const doc = await Expense.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { receiptUrl: cleanUrl, bill: cleanUrl, updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'receipt_attached',
    module: 'expense',
    recordId: id,
    description: `Receipt attached to expense: ${doc.expenseNo}`
  });

  const [enriched] = await enrichExpenses(req, [doc]);
  return enriched;
}

async function countPendingApproval(req) {
  let filter = { ...baseFilter(req), status: 'Submitted' };
  filter = await applyExpenseListScope(req, filter);
  return getExpenseModel(req).countDocuments(filter);
}

async function sumApprovedThisMonth(req, { startDate = null, endDate = null } = {}) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  let filter = {
    ...baseFilter(req),
    status: 'Approved'
  };

  if (startDate || endDate) {
    filter.expenseDate = {
      ...(startDate ? { $gte: startDate } : {}),
      ...(endDate ? { $lte: endDate } : {})
    };
  } else if (startDate === null && endDate === null && req?.query?.period === 'all') {
    // no date filter for 'all'
  } else {
    filter.expenseDate = { $gte: start, $lt: end };
  }

  filter = await applyExpenseListScope(req, filter);

  const rows = await getExpenseModel(req).find(filter).select('amount').lean();
  const total = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  return Math.round(total * 100) / 100;
}

async function sumApprovedInRange(req, from, to) {
  let filter = {
    ...baseFilter(req),
    status: 'Approved',
    expenseDate: { $gte: from, $lte: to }
  };
  filter = await applyExpenseListScope(req, filter);

  const rows = await getExpenseModel(req).find(filter).select('amount').lean();
  const total = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  return Math.round(total * 100) / 100;
}

async function exportExpenses(req, query = {}) {
  const Expense = getExpenseModel(req);
  let filter = baseFilter(req);

  if (query.status) {
    const s = toLiteralSearchTerm(String(query.status).trim());
    if (s) filter.status = new RegExp(`^${s}$`, 'i');
  }
  if (query.category) {
    const c = toLiteralSearchTerm(String(query.category).trim());
    if (c) filter.category = new RegExp(`^${c}$`, 'i');
  }
  if (query.clientId) filter.clientId = String(query.clientId).trim();
  if (query.projectId) filter.projectId = String(query.projectId).trim();
  if (query.from || query.to) {
    filter.expenseDate = {};
    if (query.from) filter.expenseDate.$gte = new Date(query.from);
    if (query.to) {
      const toDate = new Date(query.to);
      toDate.setHours(23, 59, 59, 999);
      filter.expenseDate.$lte = toDate;
    }
  }
  if (query.search) {
    const term = toLiteralSearchTerm(query.search);
    if (term) {
      filter.$or = [
        { expenseNo: { $regex: term, $options: 'i' } },
        { title: { $regex: term, $options: 'i' } },
        { itemName: { $regex: term, $options: 'i' } },
        { employeeName: { $regex: term, $options: 'i' } },
        { purchasedFrom: { $regex: term, $options: 'i' } }
      ];
    }
  }

  filter = await applyExpenseListScope(req, filter);

  const raw = await Expense.find(filter).sort({ expenseDate: -1, createdAt: -1 }).lean();
  const enriched = await enrichExpenses(req, raw);

  const format = String(query.format || 'csv').trim().toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  await AuditService.log(req, {
    action: 'exported',
    module: 'expense',
    recordId: 'export',
    description: `Exported ${enriched.length} expenses in ${format.toUpperCase()} format`
  });

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `expenses_export_${nowStr}.json`,
      content: JSON.stringify(enriched, null, 2),
      data: enriched,
      count: enriched.length
    };
  }

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const headers = [
    'ID',
    'Expense Number',
    'Title / Item',
    'Category',
    'Amount',
    'Currency',
    'Expense Date',
    'Client',
    'Project',
    'Claimant / Employee',
    'Status',
    'Payment Mode',
    'Vendor / Purchased From',
    'Bank Account',
    'Notes',
    'Created At'
  ];

  const rows = [headers.map(escapeCsv).join(',')];

  for (const exp of enriched) {
    rows.push(
      [
        exp._id,
        exp.expenseNo || '',
        exp.itemName || exp.title || '',
        exp.category || '',
        Number(exp.amount || exp.price || 0),
        exp.currency || 'INR',
        exp.expenseDate ? new Date(exp.expenseDate).toISOString().slice(0, 10) : '',
        exp.clientCompany || exp.clientName || '',
        exp.projectName || '',
        exp.employeeName || exp.employee || '',
        exp.status || '',
        exp.paymentMode || '',
        exp.purchasedFrom || exp.vendor || '',
        exp.bankAccount || '',
        exp.notes || exp.description || '',
        exp.createdAt ? new Date(exp.createdAt).toISOString() : ''
      ]
        .map(escapeCsv)
        .join(',')
    );
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `expenses_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enriched.length
  };
}

async function archive(req, id) {
  const Expense = getExpenseModel(req);
  const userId = resolveUserId(req);
  const existing = await findExpenseOrThrow(req, id);
  assertExpenseWriteAccess(req, existing);

  const updated = await Expense.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { isArchived: true, archivedAt: new Date(), archivedBy: userId, updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'archived',
    module: 'expense',
    recordId: id,
    description: `Expense archived: ${existing.expenseNo}`
  });

  const [enriched] = await enrichExpenses(req, [updated]);
  return enriched;
}

async function restore(req, id) {
  const Expense = getExpenseModel(req);
  const userId = resolveUserId(req);
  const existing = await findExpenseOrThrow(req, id);
  assertExpenseWriteAccess(req, existing);

  const updated = await Expense.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { isArchived: false, archivedAt: null, archivedBy: null, updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'restored',
    module: 'expense',
    recordId: id,
    description: `Expense restored: ${existing.expenseNo}`
  });

  const [enriched] = await enrichExpenses(req, [updated]);
  return enriched;
}

async function getUnbilledBillableExpenses(req, query = {}) {
  const Expense = getExpenseModel(req);
  const filter = {
    ...baseFilter(req),
    status: 'Approved',
    isBillable: true,
    isBilled: { $ne: true },
    isArchived: { $ne: true }
  };

  if (query.clientId) filter.clientId = String(query.clientId).trim();
  if (query.projectId) filter.projectId = String(query.projectId).trim();

  const items = await Expense.find(filter).sort({ expenseDate: -1 }).lean();
  return enrichExpenses(req, items);
}

async function markExpensesAsBilled(req, input = {}) {
  const { expenseIds = [], invoiceId, invoiceNo } = input;
  if (!Array.isArray(expenseIds) || !expenseIds.length) {
    return { updatedCount: 0 };
  }
  const Expense = getExpenseModel(req);
  const userId = resolveUserId(req);

  const res = await Expense.updateMany(
    {
      ...baseFilter(req),
      _id: { $in: expenseIds }
    },
    {
      $set: {
        isBilled: true,
        billedInvoiceId: String(invoiceId || ''),
        billedInvoiceNo: String(invoiceNo || ''),
        billedAt: new Date(),
        updatedBy: userId
      }
    }
  );

  return { updatedCount: res.modifiedCount || res.nModified || 0 };
}

module.exports = {
  list,
  getById,
  create,
  update,
  remove,
  submit,
  approve,
  reject,
  archive,
  restore,
  getUnbilledBillableExpenses,
  markExpensesAsBilled,
  countPendingApproval,
  sumApprovedThisMonth,
  sumApprovedInRange,
  getCategories,
  exportExpenses
};
