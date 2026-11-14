'use strict';

/**
 * Sales flow (services/sales-flow.service.js): suggestions from the active extension.
 *
 * POST /sales-flow/opportunity-prefill { leadId }                  title, close date, lines, field values, warnings
 * POST /sales-flow/quotation-prefill   { leadId | opportunityId }  lines, sections, warnings
 *
 * GET  /sales-flow                                                 what the active extension offers (page layout switches)
 *
 * POST /sales-flow/opportunity-saved   { opportunityId }            after save: hands the record to the extension's
 * POST /sales-flow/quotation-saved     { quotationId }              salesFlow.*Form.savedRoute → { ok } | { ok: false, message }
 * POST /sales-flow/quotation-dates     { leadId?, opportunityId? }  Issue Date / Valid Till limits of the extension:
 *                                                                   { today, issueDateMin?, validTillMax?, validTillMaxLabel? }
 *                                                                   | { ok: true, skipped: true } (no contract)
 *
 * All answer { available: false } when no active extension offers it.
 */

const { requireAnyPermission } = require('../middleware/permission.middleware');
const SalesFlowService = require('../services/sales-flow.service');

function fail(res, error, fallback) {
  const status = Number(error && error.status) || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] sales flow:', error);
  res.status(status).json({
    success: false,
    error: status >= 500 ? fallback : String((error && error.message) || fallback),
    code: (error && error.code) || undefined
  });
}

module.exports = function registerSalesFlowRoutes(app) {
  app.get(
    '/sales-flow',
    requireAnyPermission(['crm.opportunities.read', 'crm.opportunities.write', 'crm.finance.read', 'crm.finance.write']),
    async (req, res) => {
      try {
        res.json({ success: true, data: await SalesFlowService.config(req) });
      } catch (error) {
        fail(res, error, 'Failed to load the sales flow');
      }
    }
  );

  app.post(
    '/sales-flow/opportunity-prefill',
    requireAnyPermission(['crm.opportunities.write', 'crm.leads.write']),
    async (req, res) => {
      try {
        res.json({ success: true, data: await SalesFlowService.opportunityPrefill(req, req.body || {}) });
      } catch (error) {
        fail(res, error, 'Failed to prepare the opportunity');
      }
    }
  );

  app.post('/sales-flow/invoice-prefill', requireAnyPermission(['crm.finance.read', 'crm.finance.write']), async (req, res) => {
    try {
      res.json({ success: true, data: await SalesFlowService.invoicePrefill(req, req.body || {}) });
    } catch (error) {
      fail(res, error, 'Failed to prepare the invoice');
    }
  });

  // 3.34.0: a quotation for a client through the extension (salesFlow.clientQuotation).
  app.get('/sales-flow/client-quotation/eligible', requireAnyPermission(['crm.finance.write', 'crm.quotes.write']), async (req, res) => {
    try {
      res.json({ success: true, data: await SalesFlowService.clientQuotationEligible(req) });
    } catch (error) {
      fail(res, error, 'Failed to load the clients');
    }
  });
  app.get('/sales-flow/client-quotation/:clientId/picker', requireAnyPermission(['crm.finance.write', 'crm.quotes.write']), async (req, res) => {
    try {
      res.json({ success: true, data: await SalesFlowService.clientQuotationPicker(req, req.params.clientId) });
    } catch (error) {
      fail(res, error, 'Failed to load the choices');
    }
  });
  // 3.47.0: Lead create → "Add as Secondary Contact" → copy the lead form's values to the client (extension-owned).
  app.get('/sales-flow/client-quotation/:clientId/lead-form-sync', requireAnyPermission(['crm.leads.write', 'crm.clients.write']), async (req, res) => {
    try {
      res.json({ success: true, data: await SalesFlowService.clientLeadFormSyncStatus(req, req.params.clientId) });
    } catch (error) {
      fail(res, error, 'Failed to check the client');
    }
  });
  app.post('/sales-flow/client-quotation/:clientId/lead-form-sync', requireAnyPermission(['crm.clients.write']), async (req, res) => {
    try {
      res.json({ success: true, data: await SalesFlowService.clientLeadFormSync(req, req.params.clientId, req.body || {}) });
    } catch (error) {
      fail(res, error, 'Failed to copy the lead form values to the client');
    }
  });
  app.post('/sales-flow/client-quotation/:clientId/start', requireAnyPermission(['crm.finance.write', 'crm.quotes.write']), async (req, res) => {
    try {
      res.json({ success: true, data: await SalesFlowService.clientQuotationStart(req, req.params.clientId, req.body || {}) });
    } catch (error) {
      fail(res, error, 'Failed to prepare the quotation');
    }
  });

  app.post('/sales-flow/quotation-dates', requireAnyPermission(['crm.finance.read', 'crm.finance.write', 'crm.quotes.write']), async (req, res) => {
    try {
      const body = req.body || {};
      const rules = await SalesFlowService.quotationDateRules(req, { leadId: body.leadId, opportunityId: body.opportunityId });
      res.json({ success: true, data: { today: require('../utils/date-only.util').localDay(), ...rules } });
    } catch (error) {
      fail(res, error, 'Failed to load the quotation date rules');
    }
  });

  app.post('/sales-flow/quotation-prefill', requireAnyPermission(['crm.finance.write']), async (req, res) => {
    try {
      res.json({ success: true, data: await SalesFlowService.quotationPrefill(req, req.body || {}) });
    } catch (error) {
      fail(res, error, 'Failed to prepare the quotation');
    }
  });

  app.post(
    '/sales-flow/opportunity-saved',
    requireAnyPermission(['crm.opportunities.write', 'crm.leads.write']),
    async (req, res) => {
      try {
        res.json({ success: true, data: await SalesFlowService.opportunitySaved(req, req.body || {}) });
      } catch (error) {
        fail(res, error, 'Failed to sync the opportunity');
      }
    }
  );

  app.post(
    '/sales-flow/quotation-saved',
    requireAnyPermission(['crm.quotes.write', 'crm.finance.write']),
    async (req, res) => {
      try {
        res.json({ success: true, data: await SalesFlowService.quotationSaved(req, req.body || {}) });
      } catch (error) {
        fail(res, error, 'Failed to sync the quotation');
      }
    }
  );
};
