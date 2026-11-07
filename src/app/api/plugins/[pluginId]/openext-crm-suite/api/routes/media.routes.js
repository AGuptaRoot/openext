'use strict';

const mediaController = require('../controllers/media.controller');
const { requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * Media upload routes — used by avatars, receipts, tickets, invoices, payments, quotations.
 *
 * POST /media/upload
 * GET  /media/file
 * GET  /media/storage/status
 * GET  /settings/storage
 */
const MEDIA_UPLOAD_PERMS = [
  'crm.dashboard.view',
  'crm.clients.write',
  'crm.leads.write',
  'crm.projects.write',
  'crm.expenses.write',
  'crm.finance.write',
  'crm.tickets.write'
];

const MEDIA_READ_PERMS = [
  'crm.dashboard.view',
  'crm.clients.view',
  'crm.clients.write',
  'crm.leads.view',
  'crm.leads.write',
  'crm.projects.view',
  'crm.projects.write',
  'crm.expenses.view',
  'crm.expenses.write',
  'crm.finance.view',
  'crm.finance.write',
  'crm.tickets.view',
  'crm.tickets.write'
];

module.exports = function registerMediaRoutes(app) {
  app.post('/media/upload', requireAnyPermission(...MEDIA_UPLOAD_PERMS), mediaController.upload);

  app.get('/media/file', requireAnyPermission(...MEDIA_READ_PERMS), mediaController.serveFile);

  app.get(
    '/media/storage/status',
    requireAnyPermission(...MEDIA_UPLOAD_PERMS),
    mediaController.storageStatus
  );

  app.get(
    '/settings/storage',
    requireAnyPermission(...MEDIA_UPLOAD_PERMS),
    mediaController.storageStatus
  );
};
