'use strict';

const RecurringInvoiceService = require('../services/recurring-invoice.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] recurring invoice error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Recurring invoice operation failed',
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const data = await RecurringInvoiceService.listProfiles(req);
    res.json({
      success: true,
      data,
      message: 'Recurring invoice profiles loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const doc = await RecurringInvoiceService.getProfileById(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Recurring invoice profile loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const doc = await RecurringInvoiceService.createProfile(req, req.validatedBody || req.body);
    res.status(201).json({ success: true, data: doc, message: 'Recurring invoice profile created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const doc = await RecurringInvoiceService.updateProfile(req, req.params.id, req.validatedBody || req.body);
    res.json({ success: true, data: doc, message: 'Recurring invoice profile updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const result = await RecurringInvoiceService.deleteProfile(req, req.params.id);
    res.json({ success: true, data: result, message: 'Recurring invoice profile deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function toggleStatus(req, res) {
  try {
    const doc = await RecurringInvoiceService.toggleStatus(req, req.params.id, req.body?.status);
    res.json({ success: true, data: doc, message: `Recurring profile status set to ${doc.status}` });
  } catch (error) {
    sendError(res, error);
  }
}

async function runNow(req, res) {
  try {
    const result = await RecurringInvoiceService.executeRun(req, req.params.id, { force: true });
    res.json({ success: true, data: result, message: `Invoice ${result.invoice.invoiceNo} generated successfully` });
  } catch (error) {
    sendError(res, error);
  }
}

async function runDue(req, res) {
  try {
    const result = await RecurringInvoiceService.runAllDue(req);
    res.json({
      success: true,
      data: result,
      message: `Processed ${result.totalDue} due profiles (${result.successCount} succeeded, ${result.failedCount} failed)`
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function upcomingReport(req, res) {
  try {
    const result = await RecurringInvoiceService.getUpcomingReport(req);
    res.json({ success: true, data: result, message: 'Upcoming recurring invoices report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  get,
  create,
  update,
  remove,
  toggleStatus,
  runNow,
  runDue,
  upcomingReport
};
