'use strict';

const AuditService = require('../services/audit.service');

/**
 * CRM BUSINESS USE CASE: Internal helper — standardized error response formatter used by all audit trail endpoints.
 * Ensures consistent JSON error shape with status, error message, and optional validation details array.
 *
 * HTTP method: N/A (internal helper, not an endpoint)
 * Expected parameters:
 *   - res: Express response object
 *   - status: HTTP status code (number)
 *   - error: Error message string
 *   - details: Optional array of validation error strings (default: [])
 *
 * Response JSON shape (sent via res.status(status).json):
 *   {
 *     success: false,
 *     error: string,
 *     details: string[]
 *   }
 * Status codes: Passed in via status parameter (typically 400, 404, 500)
 */
function sendError(res, status, error, details = []) {
  res.status(status).json({
    success: false,
    error,
    details
  });
}

/**
 * CRM BUSINESS USE CASE: User opens the Audit Trail page from the CRM sidebar, frontend calls this endpoint via
 * CrmApi.audit.list() with pagination (page, pageSize), optional module filter (e.g. "lead", "client"),
 * and optional search term to find specific changes by user name or field values.
 *
 * HTTP method: GET /audit
 * Expected req.query fields:
 *   - page: number (optional, default 1) — pagination page number
 *   - pageSize: number (optional, default 25) — items per page
 *   - module: string (optional) — filter by CRM module name (lead, client, quotation, invoice, etc.)
 *   - search: string (optional) — free-text search across actor name and change details
 *
 * Response JSON shape on success (200 OK):
 *   {
 *     success: true,
 *     data: Array<AuditRecord>,          // array of audit log entries
 *     pagination: { page, pageSize, total, totalPages },
 *     message: 'Audit history loaded'
 *   }
 * Response JSON shape on failure (500 Internal Server Error):
 *   { success: false, error: 'Failed to load audit history', details: [] }
 * Status codes: 200 OK, 500 Internal Server Error
 */
async function list(req, res) {
  try {
    const result = await AuditService.list(req);
    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      message: 'Audit history loaded'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] audit list:', error);
    sendError(res, 500, 'Failed to load audit history');
  }
}

/**
 * CRM BUSINESS USE CASE: User views a specific CRM record (e.g. Lead detail page, Client detail page) and
 * opens the "Activity / History" tab. Frontend calls this endpoint via CrmApi.audit.listByRecord(module, recordId)
 * with pagination to display the complete change history for that single record — who edited what, when.
 *
 * HTTP method: GET /audit/:module/:recordId
 * Expected req.params fields:
 *   - module: string — CRM module name (must be one of AuditService.MODULES: lead, client, quotation, invoice, payment, expense, project, task, timeLog, setting)
 *   - recordId: string — MongoDB ObjectId of the record to fetch history for
 * Expected req.query fields:
 *   - page: number (optional, default 1)
 *   - pageSize: number (optional, default 25)
 *
 * Response JSON shape on success (200 OK):
 *   {
 *     success: true,
 *     data: Array<AuditRecord>,
 *     pagination: { page, pageSize, total, totalPages },
 *     message: 'Record audit history loaded'
 *   }
 * Response JSON shape on invalid module (400 Bad Request):
 *   { success: false, error: 'Invalid module', details: ['Module must be one of: lead, client, ...'] }
 * Response JSON shape on failure (500 Internal Server Error):
 *   { success: false, error: 'Failed to load record audit history', details: [] }
 * Status codes: 200 OK, 400 Bad Request, 500 Internal Server Error
 */
async function listByRecord(req, res) {
  try {
    const { module, recordId } = req.params;
    const result = await AuditService.listByRecord(req, module, recordId);

    if (result === null) {
      sendError(res, 400, 'Invalid module', [
        `Module must be one of: ${[...AuditService.MODULES].join(', ')}`
      ]);
      return;
    }

    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      message: 'Record audit history loaded'
    });
  } catch (error) {
    // Honour deliberate 4xx (e.g. a permission refusal) instead of reporting
    // it as a server fault — the UI needs to tell the two apart.
    const status = error.status && error.status < 500 ? error.status : 500;
    if (status >= 500) {
      console.error('[plugin:openext-crm-suite] audit listByRecord:', error);
    }
    sendError(
      res,
      status,
      status >= 500 ? 'Failed to load record audit history' : error.message
    );
  }
}

async function exportAudit(req, res) {
  try {
    const result = await AuditService.exportAudit(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(result.content);
    } else {
      res.status(200).send(result.content);
    }
  } catch (error) {
    console.error('[plugin:openext-crm-suite] audit export:', error);
    sendError(res, 500, 'Failed to export audit history');
  }
}

module.exports = {
  list,
  listByRecord,
  exportAudit
};
