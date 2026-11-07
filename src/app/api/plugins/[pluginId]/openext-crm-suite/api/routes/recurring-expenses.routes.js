'use strict';

const recurringExpenseController = require('../controllers/recurring-expense.controller');
const { requirePermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateRecurringExpenseCreate,
  validateRecurringExpenseUpdate
} = require('../validation/recurring-expense.schema');

module.exports = function registerRecurringExpenseRoutes(app) {
  app.get(
    '/recurring-expenses/upcoming-report',
    requirePermission('crm.expenses.read'),
    recurringExpenseController.upcomingReport
  );

  app.post(
    '/recurring-expenses/run-due',
    requirePermission('crm.expenses.write'),
    recurringExpenseController.runDue
  );

  app.get(
    '/recurring-expenses',
    requirePermission('crm.expenses.read'),
    recurringExpenseController.list
  );

  app.post(
    '/recurring-expenses',
    requirePermission('crm.expenses.write'),
    validateBody(validateRecurringExpenseCreate),
    recurringExpenseController.create
  );

  app.get(
    '/recurring-expenses/:id',
    requirePermission('crm.expenses.read'),
    recurringExpenseController.get
  );

  app.put(
    '/recurring-expenses/:id',
    requirePermission('crm.expenses.write'),
    validateBody(validateRecurringExpenseUpdate),
    recurringExpenseController.update
  );

  app.delete(
    '/recurring-expenses/:id',
    requirePermission('crm.expenses.delete'),
    recurringExpenseController.remove
  );

  app.post(
    '/recurring-expenses/:id/toggle-status',
    requirePermission('crm.expenses.write'),
    recurringExpenseController.toggleStatus
  );

  app.post(
    '/recurring-expenses/:id/run-now',
    requirePermission('crm.expenses.write'),
    recurringExpenseController.runNow
  );
};
