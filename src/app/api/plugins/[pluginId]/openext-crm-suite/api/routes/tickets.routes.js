'use strict';

const controller = require('../controllers/ticket.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * Support Ticket routes.
 * Mounted at /api/plugins/openext-crm-suite
 */
module.exports = function registerTicketRoutes(app) {
  app.get(
    '/tickets/feedback/summary',
    requirePermission('crm.tickets.read'),
    controller.getFeedbackSummary
  );

  app.get(
    '/tickets/feedback/reviews',
    requirePermission('crm.tickets.read'),
    controller.listFeedback
  );

  app.post(
    '/tickets/feedback/reviews',
    requirePermission('crm.tickets.write'),
    controller.createFeedback
  );

  app.get(
    '/tickets/canned-responses',
    requirePermission('crm.tickets.read'),
    controller.getCannedResponses
  );

  app.post(
    '/tickets/canned-responses',
    requirePermission('crm.tickets.write'),
    controller.createCannedResponse
  );

  app.delete(
    '/tickets/canned-responses/:id',
    requirePermission('crm.tickets.write'),
    controller.deleteCannedResponse
  );

  app.get(
    '/tickets/export',
    requireAnyPermission('crm.tickets.export', 'crm.tickets.read', 'crm.tickets.write'),
    controller.exportTickets
  );

  app.get(
    '/tickets',
    requirePermission('crm.tickets.read'),
    controller.list
  );

  app.get(
    '/tickets/:id',
    requirePermission('crm.tickets.read'),
    controller.getById
  );

  app.post(
    '/tickets',
    requirePermission('crm.tickets.write'),
    controller.create
  );

  app.get(
    '/tickets/:id/messages',
    requirePermission('crm.tickets.read'),
    controller.listMessages
  );

  app.post(
    '/tickets/:id/messages',
    requirePermission('crm.tickets.write'),
    controller.addMessage
  );

  app.post(
    '/tickets/:id/watchers',
    requirePermission('crm.tickets.write'),
    controller.addWatcher
  );

  app.delete(
    '/tickets/:id/watchers',
    requirePermission('crm.tickets.write'),
    controller.removeWatcher
  );

  app.post(
    '/tickets/:id/reassign',
    requirePermission('crm.tickets.write'),
    controller.reassign
  );

  app.post(
    '/tickets/:id/escalate',
    requirePermission('crm.tickets.write'),
    controller.escalate
  );

  app.post(
    '/tickets/:id/archive',
    requirePermission('crm.tickets.write'),
    controller.archiveTicket
  );

  app.post(
    '/tickets/:id/restore',
    requirePermission('crm.tickets.write'),
    controller.restoreTicket
  );

  app.post(
    '/tickets/:id/status',
    requirePermission('crm.tickets.write'),
    controller.updateStatus
  );

  app.post(
    '/tickets/:id/resolve',
    requirePermission('crm.tickets.resolve'),
    controller.resolveTicket
  );

  app.delete(
    '/tickets/:id',
    requireAnyPermission('crm.tickets.delete', 'crm.tickets.write'),
    controller.remove
  );
};
