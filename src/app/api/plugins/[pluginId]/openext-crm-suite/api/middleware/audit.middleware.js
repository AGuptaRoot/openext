'use strict';

/**
 * Audit middleware helpers.
 *
 * Phase 1 pattern: call AuditService.log() directly inside each service
 * after a successful write (see setting.service.js for example).
 *
 * This file provides optional wrappers for future use — not mounted globally.
 */
const AuditService = require('../services/audit.service');

/**
 * Run a write handler, then log the audit entry if the handler succeeds.
 *
 * Example:
 *   await withAudit(req, { action: 'created', module: 'lead', recordId: id }, async () => {
 *     return LeadService.create(req, data);
 *   });
 */
async function withAudit(req, auditEntry, handler) {
  const result = await handler();
  await AuditService.log(req, auditEntry);
  return result;
}

module.exports = {
  withAudit
};
