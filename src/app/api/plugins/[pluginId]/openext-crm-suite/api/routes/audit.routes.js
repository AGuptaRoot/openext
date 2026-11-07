'use strict';

const auditController = require('../controllers/audit.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * Audit routes (Phase 1 plan Section 6.2).
 *
 * GET /audit/export               → CSV/JSON export (crm.audit.read)
 * GET /audit                      → paginated log (crm.audit.read)
 * GET /audit/:module/:recordId    → log for one record (crm.audit.read)
 *
 * Note: There are no POST/PUT/DELETE routes — audit logs are immutable.
 */
module.exports = function registerAuditRoutes(app) {
  app.get(
    '/audit/export',
    requireAnyPermission('crm.audit.export', 'crm.audit.read'),
    auditController.exportAudit
  );

  // Per-record trail: AuditService decides precisely who may read it, so that
  // a lead's own owner can see its history without the tenant-wide permission.
  // The plain /audit feed below stays restricted to crm.audit.read.
  app.get(
    '/audit/:module/:recordId',
    requireAnyPermission('crm.audit.read', 'crm.leads.read'),
    auditController.listByRecord
  );

  app.get('/audit', requirePermission('crm.audit.read'), auditController.list);
};
