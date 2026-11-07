'use strict';

const RecurringExpenseService = require('../services/recurring-expense.service');

function sendError(res, error) {
  const status = error.status || 500;
  const message = error.message || 'Internal Server Error';
  res.status(status).json({
    success: false,
    error: message,
    status
  });
}

async function list(req, res) {
  try {
    const data = await RecurringExpenseService.listProfiles(req, req.query || {});
    res.json({
      success: true,
      data
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const doc = await RecurringExpenseService.getProfileById(req, req.params.id);
    res.json({
      success: true,
      data: doc
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const doc = await RecurringExpenseService.createProfile(req, req.validatedBody || req.body);
    res.status(201).json({
      success: true,
      data: doc,
      message: 'Recurring expense profile created successfully'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const doc = await RecurringExpenseService.updateProfile(req, req.params.id, req.validatedBody || req.body);
    res.json({
      success: true,
      data: doc,
      message: 'Recurring expense profile updated successfully'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const result = await RecurringExpenseService.deleteProfile(req, req.params.id);
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
}

async function toggleStatus(req, res) {
  try {
    const doc = await RecurringExpenseService.toggleStatus(req, req.params.id, req.body?.status);
    res.json({
      success: true,
      data: doc,
      message: `Recurring expense profile is now ${doc.status}`
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function runNow(req, res) {
  try {
    const result = await RecurringExpenseService.executeRun(req, req.params.id, { force: true });
    res.json({
      success: true,
      data: result,
      message: `Generated expense ${result.expense?.expenseNo} successfully!`
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function runDue(req, res) {
  try {
    const result = await RecurringExpenseService.runAllDue(req);
    res.json({
      success: true,
      data: result,
      message: `Processed ${result.processedCount} due profile(s) (${result.successCount} succeeded)`
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function upcomingReport(req, res) {
  try {
    const result = await RecurringExpenseService.getUpcomingReport(req, req.query || {});
    res.json({
      success: true,
      data: result
    });
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
