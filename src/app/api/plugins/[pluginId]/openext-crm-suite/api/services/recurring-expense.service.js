'use strict';

const crypto = require('crypto');
const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { getNextNumber } = require('../utils/numbering.util');
const AuditService = require('./audit.service');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getRecurringModel(req) {
  const RecurringExpense = req.cms?.models.get('RecurringExpense');
  if (!RecurringExpense) throw appError('RecurringExpense model is not registered', 500);
  return RecurringExpense;
}

function getExpenseModel(req) {
  const Expense = req.cms?.models.get('Expense');
  if (!Expense) throw appError('Expense model is not registered', 500);
  return Expense;
}

function computeNextRunDate(baseDate, frequency, customIntervalDays = 30) {
  const base = baseDate instanceof Date && !isNaN(baseDate.getTime()) ? baseDate : new Date();
  const next = new Date(base);

  switch (frequency) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'biweekly':
      next.setDate(next.getDate() + 14);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      break;
    case 'quarterly':
      next.setMonth(next.getMonth() + 3);
      break;
    case 'half_yearly':
      next.setMonth(next.getMonth() + 6);
      break;
    case 'yearly':
      next.setFullYear(next.getFullYear() + 1);
      break;
    case 'custom':
    default:
      next.setDate(next.getDate() + Math.max(1, Number(customIntervalDays) || 30));
      break;
  }
  return next;
}

async function listProfiles(req, query = {}) {
  const tenantId = resolveTenantId(req);
  const RecurringExpense = getRecurringModel(req);

  const filter = { tenantId, isDeleted: false };
  if (query.status) {
    filter.status = query.status;
  }
  if (query.category) {
    filter.category = new RegExp(`^${String(query.category).trim()}$`, 'i');
  }

  const items = await RecurringExpense.find(filter)
    .sort({ createdAt: -1 })
    .lean();

  return items;
}

async function getProfileById(req, id) {
  const tenantId = resolveTenantId(req);
  const RecurringExpense = getRecurringModel(req);

  const doc = await RecurringExpense.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!doc) throw appError('Recurring expense profile not found', 404);

  return doc;
}

async function createProfile(req, input) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const RecurringExpense = getRecurringModel(req);
  const SettingService = require('./setting.service');
  const settings = await SettingService.getAll(req);
  const defaultCurrency = String(settings.default_currency || 'INR').trim().toUpperCase() || 'INR';

  const startDate = input.startDate ? new Date(input.startDate) : new Date();
  const nextRunDate = new Date(startDate);

  const docData = {
    tenantId,
    profileName: input.profileName,
    vendorName: input.vendorName || input.purchasedFrom || '',
    itemName: input.itemName,
    category: input.category || 'Other',
    price: input.price || input.amount,
    amount: input.price || input.amount,
    currency: input.currency || defaultCurrency,
    exchangeRate: input.exchangeRate || 1,
    frequency: input.frequency || 'monthly',
    customIntervalDays: input.customIntervalDays || 30,
    startDate,
    nextRunDate,
    endCondition: input.endCondition || 'never',
    endDate: input.endDate ? new Date(input.endDate) : null,
    totalCycles: input.totalCycles || null,
    cyclesCompleted: 0,
    status: input.status || 'Active',
    employeeId: input.employeeId || '',
    employeeName: input.employeeName || '',
    projectId: input.projectId || '',
    clientId: input.clientId || '',
    bankAccount: input.bankAccount || '',
    paymentMode: input.paymentMode || 'Bank Transfer',
    isBillable: Boolean(input.isBillable),
    autoSubmit: input.autoSubmit !== undefined ? Boolean(input.autoSubmit) : true,
    description: input.description || '',
    notes: input.notes || '',
    executionLogs: [],
    createdBy: userId,
    updatedBy: userId
  };

  const created = await RecurringExpense.create(docData);

  await AuditService.log(req, {
    action: 'created',
    module: 'expense',
    recordId: String(created._id),
    description: `Created recurring expense schedule "${created.profileName}" (${created.frequency})`,
    metadata: {
      profileName: created.profileName,
      amount: created.amount,
      frequency: created.frequency
    }
  });

  return created.toObject();
}

async function updateProfile(req, id, input) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const RecurringExpense = getRecurringModel(req);

  const existing = await RecurringExpense.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!existing) throw appError('Recurring expense profile not found', 404);

  const patch = { ...input, updatedBy: userId };

  if (input.startDate && new Date(input.startDate).getTime() !== new Date(existing.startDate).getTime()) {
    patch.nextRunDate = new Date(input.startDate);
  }

  const updated = await RecurringExpense.findOneAndUpdate(
    { _id: id, tenantId, isDeleted: false },
    { $set: patch },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'expense',
    recordId: String(id),
    description: `Updated recurring expense schedule "${updated.profileName}"`,
    metadata: { changes: Object.keys(input) }
  });

  return updated;
}

async function deleteProfile(req, id) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const RecurringExpense = getRecurringModel(req);

  const existing = await RecurringExpense.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!existing) throw appError('Recurring expense profile not found', 404);

  await RecurringExpense.updateOne(
    { _id: id, tenantId },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId } }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'expense',
    recordId: String(id),
    description: `Deleted recurring expense schedule "${existing.profileName}"`
  });

  return { success: true, message: 'Recurring expense schedule deleted successfully' };
}

async function toggleStatus(req, id, desiredStatus) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const RecurringExpense = getRecurringModel(req);

  const existing = await RecurringExpense.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!existing) throw appError('Recurring expense profile not found', 404);

  const newStatus = desiredStatus || (existing.status === 'Active' ? 'Paused' : 'Active');
  const updated = await RecurringExpense.findOneAndUpdate(
    { _id: id, tenantId, isDeleted: false },
    { $set: { status: newStatus, updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'expense',
    recordId: String(id),
    description: `Changed recurring expense schedule status to "${newStatus}"`
  });

  return updated;
}

async function executeRun(req, id, options = {}) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const RecurringExpense = getRecurringModel(req);
  const Expense = getExpenseModel(req);

  const profile = await RecurringExpense.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!profile) throw appError('Recurring expense profile not found', 404);

  if (!options.force && profile.status !== 'Active') {
    throw appError(`Recurring profile is ${profile.status}. Only Active schedules can be run.`);
  }

  const runId = crypto.randomUUID();
  const runDate = new Date();
  let createdExpense = null;
  let runError = null;

  try {
    const expenseNo = await getNextNumber(req, 'expense');
    const newCycle = (profile.cyclesCompleted || 0) + 1;

    const expenseData = {
      tenantId,
      expenseNo,
      title: profile.itemName || profile.profileName,
      itemName: profile.itemName || profile.profileName,
      amount: profile.amount || profile.price,
      price: profile.price || profile.amount,
      currency: profile.currency || 'INR',
      exchangeRate: profile.exchangeRate || 1,
      expenseDate: runDate,
      purchaseDate: runDate,
      category: profile.category || 'Other',
      employeeId: profile.employeeId || '',
      employeeName: profile.employeeName || '',
      purchasedFrom: profile.vendorName || '',
      bankAccount: profile.bankAccount || '',
      paymentMode: profile.paymentMode || 'Bank Transfer',
      clientId: profile.clientId || '',
      projectId: profile.projectId || '',
      isBillable: Boolean(profile.isBillable),
      isBilled: false,
      recurringProfileId: String(profile._id),
      recurringCycle: newCycle,
      isArchived: false,
      status: profile.autoSubmit ? 'Submitted' : 'Draft',
      submittedAt: profile.autoSubmit ? runDate : null,
      description: profile.description || '',
      notes: profile.notes ? `${profile.notes}\n[Generated by Recurring Schedule "${profile.profileName}" (Cycle #${newCycle})]` : `[Generated by Recurring Schedule "${profile.profileName}" (Cycle #${newCycle})]`,
      createdBy: userId,
      updatedBy: userId
    };

    createdExpense = await Expense.create(expenseData);

    const logEntry = {
      runId,
      runDate,
      expenseId: String(createdExpense._id),
      expenseNo: createdExpense.expenseNo,
      status: 'Success',
      error: ''
    };

    const nextRun = computeNextRunDate(profile.nextRunDate || runDate, profile.frequency, profile.customIntervalDays);

    let nextStatus = profile.status;
    if (profile.endCondition === 'after_cycles' && profile.totalCycles && newCycle >= profile.totalCycles) {
      nextStatus = 'Completed';
    } else if (profile.endCondition === 'on_date' && profile.endDate && nextRun > new Date(profile.endDate)) {
      nextStatus = 'Completed';
    }

    await RecurringExpense.updateOne(
      { _id: id, tenantId },
      {
        $set: {
          lastRunDate: runDate,
          nextRunDate: nextRun,
          cyclesCompleted: newCycle,
          status: nextStatus,
          updatedBy: userId
        },
        $push: {
          executionLogs: {
            $each: [logEntry],
            $slice: -50
          }
        }
      }
    );

    await AuditService.log(req, {
      action: 'executed',
      module: 'expense',
      recordId: String(profile._id),
      description: `Recurring schedule executed successfully -> Generated Expense ${createdExpense.expenseNo} (Cycle #${newCycle})`,
      metadata: {
        expenseId: String(createdExpense._id),
        expenseNo: createdExpense.expenseNo,
        amount: createdExpense.amount
      }
    });

    return {
      success: true,
      expense: createdExpense.toObject(),
      runId,
      cycle: newCycle,
      nextRunDate: nextRun,
      status: nextStatus
    };
  } catch (err) {
    runError = err.message || 'Execution failed';
    const logEntry = {
      runId,
      runDate,
      expenseId: null,
      expenseNo: '',
      status: 'Failed',
      error: runError
    };

    await RecurringExpense.updateOne(
      { _id: id, tenantId },
      {
        $set: { lastRunDate: runDate },
        $push: {
          executionLogs: {
            $each: [logEntry],
            $slice: -50
          }
        }
      }
    );

    throw appError(`Failed to generate recurring expense: ${runError}`, 500);
  }
}

async function runAllDue(req) {
  const tenantId = resolveTenantId(req);
  const RecurringExpense = getRecurringModel(req);

  const now = new Date();
  const dueProfiles = await RecurringExpense.find({
    tenantId,
    status: 'Active',
    isDeleted: false,
    nextRunDate: { $lte: now }
  }).lean();

  const results = [];
  for (const profile of dueProfiles) {
    try {
      const res = await executeRun(req, profile._id, { force: false });
      results.push({ profileId: profile._id, profileName: profile.profileName, success: true, expenseNo: res.expense?.expenseNo });
    } catch (err) {
      results.push({ profileId: profile._id, profileName: profile.profileName, success: false, error: err.message });
    }
  }

  return {
    processedCount: dueProfiles.length,
    successCount: results.filter((r) => r.success).length,
    results
  };
}

async function getUpcomingReport(req, options = {}) {
  const tenantId = resolveTenantId(req);
  const RecurringExpense = getRecurringModel(req);

  const daysAhead = Math.min(365, Math.max(7, Number(options.daysAhead) || 90));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + daysAhead);

  const activeProfiles = await RecurringExpense.find({
    tenantId,
    status: 'Active',
    isDeleted: false
  }).lean();

  const forecast = [];
  let totalProjectedExpense = 0;

  for (const profile of activeProfiles) {
    let simDate = new Date(profile.nextRunDate || new Date());
    let simCycle = (profile.cyclesCompleted || 0) + 1;

    while (simDate <= cutoff) {
      if (profile.endCondition === 'after_cycles' && profile.totalCycles && simCycle > profile.totalCycles) {
        break;
      }
      if (profile.endCondition === 'on_date' && profile.endDate && simDate > new Date(profile.endDate)) {
        break;
      }

      const estimatedTotal = Number(profile.amount || profile.price || 0);
      totalProjectedExpense += estimatedTotal;

      forecast.push({
        profileId: profile._id,
        profileName: profile.profileName,
        vendorName: profile.vendorName,
        category: profile.category,
        frequency: profile.frequency,
        currency: profile.currency || 'INR',
        estimatedTotal,
        scheduledDate: new Date(simDate),
        cycle: simCycle
      });

      simDate = computeNextRunDate(simDate, profile.frequency, profile.customIntervalDays);
      simCycle++;
    }
  }

  forecast.sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));

  return {
    daysAhead,
    totalProfiles: activeProfiles.length,
    scheduledOccurrences: forecast.length,
    totalProjectedExpense: Math.round(totalProjectedExpense * 100) / 100,
    forecast
  };
}

module.exports = {
  listProfiles,
  getProfileById,
  createProfile,
  updateProfile,
  deleteProfile,
  toggleStatus,
  executeRun,
  runAllDue,
  getUpcomingReport
};
