'use strict';

const ExpenseService = require('../services/expense.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] expense error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Expense operation failed',
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const result = await ExpenseService.list(req);
    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      message: 'Expenses loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const doc = await ExpenseService.getById(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Expense loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const doc = await ExpenseService.create(req, req.validatedBody);
    res.status(201).json({ success: true, data: doc, message: 'Expense created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const doc = await ExpenseService.update(req, req.params.id, req.validatedBody);
    res.json({ success: true, data: doc, message: 'Expense updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const result = await ExpenseService.remove(req, req.params.id);
    res.json({ success: true, data: result, message: 'Expense deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function submit(req, res) {
  try {
    const doc = await ExpenseService.submit(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Expense submitted for approval' });
  } catch (error) {
    sendError(res, error);
  }
}

async function approve(req, res) {
  try {
    const doc = await ExpenseService.approve(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Expense approved' });
  } catch (error) {
    sendError(res, error);
  }
}

async function reject(req, res) {
  try {
    const doc = await ExpenseService.reject(req, req.params.id, req.validatedBody);
    res.json({ success: true, data: doc, message: 'Expense rejected' });
  } catch (error) {
    sendError(res, error);
  }
}

async function categories(req, res) {
  try {
    const items = await ExpenseService.getCategories(req);
    res.json({ success: true, data: items, message: 'Expense categories loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportExpenses(req, res) {
  try {
    const result = await ExpenseService.exportExpenses(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(result.content);
    } else {
      res.status(200).send(result.content);
    }
  } catch (error) {
    sendError(res, error);
  }
}

async function archive(req, res) {
  try {
    const doc = await ExpenseService.archive(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Expense archived successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function restore(req, res) {
  try {
    const doc = await ExpenseService.restore(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Expense restored successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function getUnbilledBillable(req, res) {
  try {
    const items = await ExpenseService.getUnbilledBillableExpenses(req, req.query || {});
    res.json({ success: true, data: items });
  } catch (error) {
    sendError(res, error);
  }
}

async function markBilled(req, res) {
  try {
    const result = await ExpenseService.markExpensesAsBilled(req, req.body || {});
    res.json({ success: true, data: result, message: `Marked ${result.updatedCount} expense(s) as billed` });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  exportExpenses,
  get,
  create,
  update,
  remove,
  submit,
  approve,
  reject,
  archive,
  restore,
  getUnbilledBillable,
  markBilled,
  categories
};
