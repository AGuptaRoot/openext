'use strict';

const timeLogController = require('../controllers/time-log.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateTimeLogCreate,
  validateTimeLogUpdate,
  validateCheckIn,
  validateCheckOut,
  validateReject,
  validateBulkApprove,
  validateLock
} = require('../validation/time-log.schema');

/**
 * Time logs routes including Check-in / Check-out session management,
 * weekly timesheets, approvals, and invoice-period locking.
 * Mounted at /api/plugins/openext-crm-suite/time-logs
 */
module.exports = function registerTimeLogsRoutes(app) {
  app.get(
    '/time-logs/export',
    requireAnyPermission('crm.time.export', 'crm.time.read', 'crm.time.write'),
    timeLogController.exportTimeLogs
  );
  app.get('/time-logs', requirePermission('crm.time.read'), timeLogController.list);

  app.get(
    '/time-logs/active',
    requirePermission('crm.time.read'),
    timeLogController.getActiveCheckIn
  );

  app.get(
    '/time-logs/timesheet/weekly',
    requirePermission('crm.time.read'),
    timeLogController.getWeeklyTimesheet
  );

  app.post(
    '/time-logs/bulk-approve',
    requirePermission('crm.time.write'),
    validateBody(validateBulkApprove),
    timeLogController.bulkApprove
  );

  app.post(
    '/time-logs/lock',
    requirePermission('crm.time.write'),
    validateBody(validateLock),
    timeLogController.lockLogs
  );

  app.post(
    '/time-logs/unlock',
    requirePermission('crm.time.write'),
    validateBody(validateLock),
    timeLogController.unlockLogs
  );

  app.post(
    '/time-logs/check-in',
    requirePermission('crm.time.write'),
    validateBody(validateCheckIn),
    timeLogController.checkIn
  );

  app.post(
    '/time-logs/check-out',
    requirePermission('crm.time.write'),
    validateBody(validateCheckOut),
    timeLogController.checkOut
  );

  app.post(
    '/time-logs',
    requirePermission('crm.time.write'),
    validateBody(validateTimeLogCreate),
    timeLogController.create
  );

  app.get('/time-logs/:id', requirePermission('crm.time.read'), timeLogController.get);

  app.post(
    '/time-logs/:id/submit',
    requirePermission('crm.time.write'),
    timeLogController.submit
  );

  app.post(
    '/time-logs/:id/approve',
    requirePermission('crm.time.write'),
    timeLogController.approve
  );

  app.post(
    '/time-logs/:id/reject',
    requirePermission('crm.time.write'),
    validateBody(validateReject),
    timeLogController.reject
  );

  app.put(
    '/time-logs/:id',
    requirePermission('crm.time.write'),
    validateBody(validateTimeLogUpdate),
    timeLogController.update
  );

  app.delete('/time-logs/:id', requirePermission('crm.time.delete'), timeLogController.remove);
};
