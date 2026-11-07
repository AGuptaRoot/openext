'use strict';

/**
 * The active extension's Reports page (services/extension-report.service.js, CRM 3.29.0).
 *
 * GET  /extension-reports            the page: title, filters (with options), sections the user may see
 * POST /extension-reports/data       { filters, params, sections? } → section data
 * POST /extension-reports/export     { sectionId, filters, params } → { fileName, csv }
 * GET  /extension-dashboard          the Dashboard of the extension (json/dashboard.json), same format
 * POST /extension-dashboard/data     its section data
 */

const { requirePermission } = require('../middleware/permission.middleware');
const ExtensionReportService = require('../services/extension-report.service');

function send(res, work) {
  return work.then(
    (data) => res.json({ success: true, data }),
    (error) => {
      const status = Number(error && error.status) || 500;
      if (status >= 500) console.error('[plugin:openext-crm-suite] extension reports:', error && error.message);
      res.status(status).json({
        success: false,
        error: status >= 500 ? 'The report could not be loaded' : String((error && error.message) || 'The report could not be loaded'),
        code: (error && error.code) || undefined
      });
    }
  );
}

module.exports = function registerExtensionReportRoutes(app) {
  app.get('/extension-reports', requirePermission('crm.reports.read'), (req, res) => send(res, ExtensionReportService.definition(req)));
  app.post('/extension-reports/data', requirePermission('crm.reports.read'), (req, res) => send(res, ExtensionReportService.data(req, req.body || {})));
  app.post('/extension-reports/export', requirePermission('crm.reports.read'), (req, res) => send(res, ExtensionReportService.exportCsv(req, req.body || {})));

  // The extension's Dashboard (json/dashboard.json, CRM 3.31.0): the dashboard permission, then each section's own.
  app.get('/extension-dashboard', requirePermission('crm.dashboard.view'), (req, res) => send(res, ExtensionReportService.definition(req, 'dashboard')));
  app.post('/extension-dashboard/data', requirePermission('crm.dashboard.view'), (req, res) => send(res, ExtensionReportService.data(req, req.body || {}, 'dashboard')));
};
