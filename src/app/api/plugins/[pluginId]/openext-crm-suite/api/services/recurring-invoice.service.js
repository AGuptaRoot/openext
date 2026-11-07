'use strict';

const crypto = require('crypto');
const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getRecurringModel(req) {
  const RecurringInvoice = req.cms?.models.get('RecurringInvoice');
  if (!RecurringInvoice) throw appError('RecurringInvoice model is not registered', 500);
  return RecurringInvoice;
}

function getCompanyModel(req) {
  return req.cms?.models.get('Company');
}

function calculateNextRunDate(fromDate, frequency, customIntervalDays = 30) {
  const base = new Date(fromDate || Date.now());
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

async function enrichWithClientNames(req, profiles) {
  if (!Array.isArray(profiles) || !profiles.length) return [];
  const Company = getCompanyModel(req);
  if (!Company) return profiles;

  const tenantId = resolveTenantId(req);
  const clientIds = [...new Set(profiles.map((p) => String(p.clientId)).filter(Boolean))];
  const companies = await Company.find({ tenantId, _id: { $in: clientIds } }).lean();
  const map = new Map(companies.map((c) => [String(c._id), c.companyName || c.name || 'Client']));

  return profiles.map((p) => ({
    ...p,
    clientName: map.get(String(p.clientId)) || 'Unknown Client'
  }));
}

async function listProfiles(req) {
  const tenantId = resolveTenantId(req);
  const RecurringInvoice = getRecurringModel(req);

  const filter = { tenantId, isDeleted: false };
  if (req.query?.status) {
    filter.status = String(req.query.status).trim();
  }
  if (req.query?.clientId) {
    filter.clientId = String(req.query.clientId).trim();
  }
  if (req.query?.search) {
    const term = String(req.query.search).trim();
    filter.$or = [
      { profileName: { $regex: term, $options: 'i' } },
      { notes: { $regex: term, $options: 'i' } }
    ];
  }

  const items = await RecurringInvoice.find(filter)
    .sort({ nextRunDate: 1, createdAt: -1 })
    .lean();

  return enrichWithClientNames(req, items);
}

async function getProfileById(req, id) {
  const tenantId = resolveTenantId(req);
  const RecurringInvoice = getRecurringModel(req);

  const doc = await RecurringInvoice.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!doc) throw appError('Recurring invoice profile not found', 404);

  const enriched = await enrichWithClientNames(req, [doc]);
  return enriched[0];
}

async function createProfile(req, payload = {}) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const RecurringInvoice = getRecurringModel(req);
  const SettingService = require('./setting.service');
  const settings = await SettingService.getAll(req);
  const defaultCurrency = String(settings.default_currency || 'INR').trim().toUpperCase() || 'INR';

  const profileName = String(payload.profileName || '').trim();
  if (!profileName) throw appError('Profile name is required');
  if (!payload.clientId) throw appError('Client is required');

  const startDate = payload.startDate ? new Date(payload.startDate) : new Date();
  const nextRunDate = payload.nextRunDate ? new Date(payload.nextRunDate) : new Date(startDate);

  const docData = {
    tenantId,
    profileName,
    clientId: String(payload.clientId),
    projectId: payload.projectId ? String(payload.projectId) : null,
    bankAccount: payload.bankAccount ? String(payload.bankAccount).trim() : '',
    clientCanStopRecurring: Boolean(payload.clientCanStopRecurring),
    templateId: payload.templateId ? String(payload.templateId) : null,
    frequency: payload.frequency || 'monthly',
    customIntervalDays: Number(payload.customIntervalDays || 30),
    startDate,
    nextRunDate,
    endCondition: payload.endCondition || 'never',
    endDate: payload.endDate ? new Date(payload.endDate) : null,
    totalCycles: payload.totalCycles ? Number(payload.totalCycles) : null,
    cyclesCompleted: 0,
    status: payload.status || 'Active',
    currency: String(payload.currency || defaultCurrency).trim().toUpperCase(),
    lineItems: Array.isArray(payload.lineItems) ? payload.lineItems : [],
    discountType: payload.discountType === 'amount' ? 'amount' : 'percent',
    discountValue: Number(payload.discountValue || payload.discountPercent || 0),
    discountPercent: Number(payload.discountPercent || 0),
    discountAmount: Number(payload.discountAmount || 0),
    taxCalculation: payload.taxCalculation === 'before_discount' ? 'before_discount' : 'after_discount',
    paymentTermsDays: Number(payload.paymentTermsDays || 30),
    recipientNotes: String(payload.recipientNotes || payload.notes || '').trim(),
    notes: String(payload.notes || payload.recipientNotes || '').trim(),
    terms: String(payload.terms || '').trim(),
    autoSendEmail: Boolean(payload.autoSendEmail),
    executionLogs: [],
    createdBy: userId,
    updatedBy: userId
  };

  const created = await RecurringInvoice.create(docData);
  const doc = created.toObject ? created.toObject() : created;

  await AuditService.log(req, {
    action: 'created',
    module: 'recurring_invoice',
    recordId: doc._id.toString(),
    description: `Created recurring invoice profile "${profileName}" (${doc.frequency})`,
    metadata: { profileName, clientId: doc.clientId, frequency: doc.frequency }
  });

  return doc;
}

async function updateProfile(req, id, payload = {}) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const RecurringInvoice = getRecurringModel(req);

  const existing = await RecurringInvoice.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!existing) throw appError('Recurring invoice profile not found', 404);

  const updates = { updatedBy: userId };
  if (payload.profileName !== undefined) updates.profileName = String(payload.profileName).trim();
  if (payload.clientId !== undefined) updates.clientId = String(payload.clientId);
  if (payload.projectId !== undefined) updates.projectId = payload.projectId ? String(payload.projectId) : null;
  if (payload.bankAccount !== undefined) updates.bankAccount = String(payload.bankAccount).trim();
  if (payload.clientCanStopRecurring !== undefined) updates.clientCanStopRecurring = Boolean(payload.clientCanStopRecurring);
  if (payload.templateId !== undefined) updates.templateId = payload.templateId ? String(payload.templateId) : null;
  if (payload.frequency !== undefined) updates.frequency = payload.frequency;
  if (payload.customIntervalDays !== undefined) updates.customIntervalDays = Number(payload.customIntervalDays);
  if (payload.startDate !== undefined) updates.startDate = new Date(payload.startDate);
  if (payload.nextRunDate !== undefined) updates.nextRunDate = new Date(payload.nextRunDate);
  if (payload.endCondition !== undefined) updates.endCondition = payload.endCondition;
  if (payload.endDate !== undefined) updates.endDate = payload.endDate ? new Date(payload.endDate) : null;
  if (payload.totalCycles !== undefined) updates.totalCycles = payload.totalCycles ? Number(payload.totalCycles) : null;
  if (payload.status !== undefined) updates.status = payload.status;
  if (payload.currency !== undefined) updates.currency = String(payload.currency).trim().toUpperCase();
  if (payload.lineItems !== undefined) updates.lineItems = payload.lineItems;
  if (payload.discountType !== undefined) updates.discountType = payload.discountType;
  if (payload.discountValue !== undefined) updates.discountValue = Number(payload.discountValue);
  if (payload.discountPercent !== undefined) updates.discountPercent = Number(payload.discountPercent);
  if (payload.discountAmount !== undefined) updates.discountAmount = Number(payload.discountAmount);
  if (payload.taxCalculation !== undefined) updates.taxCalculation = payload.taxCalculation;
  if (payload.paymentTermsDays !== undefined) updates.paymentTermsDays = Number(payload.paymentTermsDays);
  if (payload.recipientNotes !== undefined) updates.recipientNotes = String(payload.recipientNotes).trim();
  if (payload.notes !== undefined) updates.notes = String(payload.notes).trim();
  if (payload.terms !== undefined) updates.terms = String(payload.terms).trim();
  if (payload.autoSendEmail !== undefined) updates.autoSendEmail = Boolean(payload.autoSendEmail);

  const updated = await RecurringInvoice.findOneAndUpdate(
    { _id: id, tenantId, isDeleted: false },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'recurring_invoice',
    recordId: id,
    description: `Updated recurring invoice profile "${updated.profileName}"`,
    metadata: { profileName: updated.profileName, status: updated.status }
  });

  return updated;
}

async function removeProfile(req, id) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const RecurringInvoice = getRecurringModel(req);

  const existing = await RecurringInvoice.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!existing) throw appError('Recurring invoice profile not found', 404);

  await RecurringInvoice.updateOne(
    { _id: id, tenantId },
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
    module: 'recurring_invoice',
    recordId: id,
    description: `Deleted recurring invoice profile "${existing.profileName}"`
  });

  return { success: true, message: 'Recurring invoice profile deleted' };
}

const deleteProfile = removeProfile;

async function toggleStatus(req, id) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const RecurringInvoice = getRecurringModel(req);

  const existing = await RecurringInvoice.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!existing) throw appError('Recurring invoice profile not found', 404);

  if (existing.status === 'Completed') {
    throw appError('Completed profiles cannot be paused or resumed. Create a new schedule instead.', 409);
  }

  const nextStatus = existing.status === 'Active' ? 'Paused' : 'Active';

  const updated = await RecurringInvoice.findOneAndUpdate(
    { _id: id, tenantId },
    { $set: { status: nextStatus, updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'status_changed',
    module: 'recurring_invoice',
    recordId: id,
    description: `Recurring profile "${existing.profileName}" status changed to ${nextStatus}`,
    metadata: { previousStatus: existing.status, newStatus: nextStatus }
  });

  return updated;
}

/**
 * Executes a single recurring invoice generation run.
 * Idempotent: generates an invoice, computes nextRunDate, tracks cycles, and logs output.
 */
async function executeRun(req, id, options = {}) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const RecurringInvoice = getRecurringModel(req);
  const InvoiceService = require('./invoice.service');

  const profile = await RecurringInvoice.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!profile) throw appError('Recurring invoice profile not found', 404);

  if (!options.force && profile.status !== 'Active') {
    throw appError(`Recurring profile is ${profile.status}. Resume it before running.`, 409);
  }

  const runId = crypto.randomUUID ? crypto.randomUUID() : `run_${Date.now()}`;
  const now = new Date();

  try {
    const paymentTerms = Number(profile.paymentTermsDays || 30);
    const issueDate = now;
    const dueDate = new Date(issueDate);
    dueDate.setDate(dueDate.getDate() + paymentTerms);

    const invoicePayload = {
      clientId: profile.clientId,
      projectId: profile.projectId || undefined,
      bankAccount: profile.bankAccount || '',
      currency: profile.currency || 'INR',
      issueDate,
      dueDate,
      lineItems: profile.lineItems,
      discountType: profile.discountType || 'percent',
      discountPercent: profile.discountPercent || 0,
      discountAmount: profile.discountAmount || 0,
      taxCalculation: profile.taxCalculation || 'after_discount',
      notes: profile.notes || profile.recipientNotes || `Generated from recurring profile: ${profile.profileName}`,
      recipientNotes: profile.recipientNotes || profile.notes || '',
      terms: profile.terms || '',
      recurringProfileId: String(profile._id),
      recurringCycle: (profile.cyclesCompleted || 0) + 1
    };

    const invoice = await InvoiceService.create(req, invoicePayload);

    if (profile.autoSendEmail) {
      try {
        await InvoiceService.send(req, invoice._id);
      } catch (sendErr) {
        console.warn('[plugin:openext-crm-suite] recurring auto-email send failed:', sendErr.message);
      }
    }

    const nextCycles = (profile.cyclesCompleted || 0) + 1;
    const nextRun = calculateNextRunDate(profile.nextRunDate || now, profile.frequency, profile.customIntervalDays);

    let nextStatus = profile.status;
    if (profile.endCondition === 'after_cycles' && profile.totalCycles && nextCycles >= profile.totalCycles) {
      nextStatus = 'Completed';
    } else if (profile.endCondition === 'on_date' && profile.endDate && nextRun > new Date(profile.endDate)) {
      nextStatus = 'Completed';
    }

    const logEntry = {
      runId,
      runDate: now,
      invoiceId: String(invoice._id),
      invoiceNo: invoice.invoiceNo,
      status: 'Success',
      error: ''
    };

    await RecurringInvoice.updateOne(
      { _id: profile._id, tenantId },
      {
        $set: {
          lastRunDate: now,
          nextRunDate: nextRun,
          cyclesCompleted: nextCycles,
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
      module: 'recurring_invoice',
      recordId: String(profile._id),
      description: `Recurring profile "${profile.profileName}" generated invoice ${invoice.invoiceNo} (Cycle ${nextCycles})`,
      metadata: { invoiceId: invoice._id, invoiceNo: invoice.invoiceNo, cycle: nextCycles }
    });

    return {
      success: true,
      profileId: profile._id,
      invoice,
      cycle: nextCycles,
      nextRunDate: nextRun,
      status: nextStatus
    };
  } catch (error) {
    const failedLog = {
      runId,
      runDate: now,
      invoiceId: null,
      invoiceNo: '',
      status: 'Failed',
      error: error.message || 'Generation failed'
    };

    await RecurringInvoice.updateOne(
      { _id: profile._id, tenantId },
      {
        $push: {
          executionLogs: {
            $each: [failedLog],
            $slice: -50
          }
        }
      }
    );

    throw error;
  }
}

/**
 * Runs all active recurring profiles whose nextRunDate is due (<= now).
 */
async function runAllDue(req) {
  const tenantId = resolveTenantId(req);
  const RecurringInvoice = getRecurringModel(req);

  const dueProfiles = await RecurringInvoice.find({
    tenantId,
    status: 'Active',
    isDeleted: false,
    nextRunDate: { $lte: new Date() }
  }).lean();

  const results = [];
  let successCount = 0;
  let failedCount = 0;

  for (const profile of dueProfiles) {
    try {
      const res = await executeRun(req, profile._id);
      results.push(res);
      successCount++;
    } catch (err) {
      results.push({
        success: false,
        profileId: profile._id,
        profileName: profile.profileName,
        error: err.message
      });
      failedCount++;
    }
  }

  return {
    totalDue: dueProfiles.length,
    successCount,
    failedCount,
    results
  };
}

/**
 * Forecasts upcoming scheduled generations across active recurring invoice profiles.
 */
async function getUpcomingReport(req, options = {}) {
  const tenantId = resolveTenantId(req);
  const RecurringInvoice = getRecurringModel(req);
  const daysAhead = Math.min(365, Math.max(7, Number(options.daysAhead || req.query?.daysAhead || 90)));
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() + daysAhead);

  const activeProfiles = await RecurringInvoice.find({
    tenantId,
    status: 'Active',
    isDeleted: false
  }).lean();

  const enrichedProfiles = await enrichWithClientNames(req, activeProfiles);
  const forecast = [];

  for (const p of enrichedProfiles) {
    let simDate = new Date(p.nextRunDate);
    let simCycle = (p.cyclesCompleted || 0) + 1;

    // Approximate grand total
    let approxTotal = 0;
    for (const line of p.lineItems || []) {
      const qty = Number(line.qty) || 1;
      const rate = Number(line.rate) || 0;
      const tax = Number(line.tax) || 0;
      const sub = qty * rate;
      approxTotal += sub + sub * (tax / 100);
    }
    if (p.discountPercent > 0) {
      approxTotal = approxTotal - approxTotal * (p.discountPercent / 100);
    }
    approxTotal = Math.round(approxTotal * 100) / 100;

    while (simDate <= cutoffDate) {
      if (p.endCondition === 'after_cycles' && p.totalCycles && simCycle > p.totalCycles) break;
      if (p.endCondition === 'on_date' && p.endDate && simDate > new Date(p.endDate)) break;

      forecast.push({
        profileId: p._id,
        profileName: p.profileName,
        clientId: p.clientId,
        clientName: p.clientName,
        currency: p.currency,
        frequency: p.frequency,
        scheduledDate: new Date(simDate),
        cycle: simCycle,
        estimatedTotal: approxTotal
      });

      simDate = calculateNextRunDate(simDate, p.frequency, p.customIntervalDays);
      simCycle++;
    }
  }

  forecast.sort((a, b) => new Date(a.scheduledDate) - new Date(b.scheduledDate));

  const totalProjectedRevenue = forecast.reduce((sum, item) => sum + item.estimatedTotal, 0);

  return {
    daysAhead,
    totalScheduledGenerations: forecast.length,
    totalProjectedRevenue: Math.round(totalProjectedRevenue * 100) / 100,
    forecast
  };
}

module.exports = {
  calculateNextRunDate,
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
