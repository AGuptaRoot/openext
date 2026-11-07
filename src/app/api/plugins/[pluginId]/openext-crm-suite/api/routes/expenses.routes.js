'use strict';

const expenseController = require('../controllers/expense.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateExpenseCreate,
  validateExpenseUpdate,
  validateExpenseReject
} = require('../validation/expense.schema');

module.exports = function registerExpensesRoutes(app) {
  app.get('/expenses/categories', requirePermission('crm.expenses.read'), expenseController.categories);
  app.get(
    '/expenses/unbilled-billable',
    requirePermission('crm.expenses.read'),
    expenseController.getUnbilledBillable
  );
  app.post(
    '/expenses/mark-billed',
    requirePermission('crm.expenses.write'),
    expenseController.markBilled
  );
  app.get(
    '/expenses/export',
    requireAnyPermission('crm.expenses.export', 'crm.expenses.read', 'crm.expenses.write'),
    expenseController.exportExpenses
  );
  app.get('/expenses', requirePermission('crm.expenses.read'), expenseController.list);
  app.post(
    '/expenses',
    requirePermission('crm.expenses.write'),
    validateBody(validateExpenseCreate),
    expenseController.create
  );

  app.post(
    '/expenses/:id/archive',
    requirePermission('crm.expenses.write'),
    expenseController.archive
  );
  app.post(
    '/expenses/:id/restore',
    requirePermission('crm.expenses.write'),
    expenseController.restore
  );

  app.post(
    '/expenses/:id/submit',
    requirePermission('crm.expenses.write'),
    expenseController.submit
  );
  app.post(
    '/expenses/:id/approve',
    requirePermission('crm.expenses.approve'),
    expenseController.approve
  );
  app.post(
    '/expenses/:id/reject',
    requirePermission('crm.expenses.approve'),
    validateBody(validateExpenseReject),
    expenseController.reject
  );

  app.get('/expenses/:id', requirePermission('crm.expenses.read'), expenseController.get);
  app.put(
    '/expenses/:id',
    requirePermission('crm.expenses.write'),
    validateBody(validateExpenseUpdate),
    expenseController.update
  );
  app.delete(
    '/expenses/:id',
    requirePermission('crm.expenses.delete'),
    expenseController.remove
  );
};
