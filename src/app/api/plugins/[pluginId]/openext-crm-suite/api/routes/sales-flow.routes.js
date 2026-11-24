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
 * GET  /sales-flow/quotation-leads?q=&include=<leadId>             leads offered on the Create Quotation page
 *                                                                   (services/lead-workflow.service.js quotationCandidates):
 *                                                                   { leads, notReady, hidden, hasReadiness, included? }
 *
 * CRM 3.64.0 — "Create Invoice from Scratch" (salesFlow.guidedInvoice), finance users only (not sales reps):
 * POST /sales-flow/guided-invoice/check   { draft, step }      the extension checks one of its steps → { errors }
 * POST /sales-flow/guided-invoice/preview { draft }            the lines to price (nothing saved)
 * POST /sales-flow/guided-invoice/commit  { clientId, draft }  the extension saves its steps → { leadId }
 * POST /sales-flow/guided-invoice/after   { quotationId, invoiceId, leadId }  3.64.9: the extension's follow-up (never fails)
 *
 * All answer { available: false } when no active extension offers it.
 */

const { requireAnyPermission, requirePermission } = require('../middleware/permission.middleware');

/** The guided invoice ends in a tax invoice: like Convert to Invoice, never for sales representatives. */
function guidedAccess(req) {
  const { isSalesRepresentative, isAdmin, isSalesManager } = require('../utils/sales-access.util');
  if (isSalesRepresentative(req) && !isAdmin(req) && !isSalesManager(req)) {
    const error = new Error('Sales representatives cannot create direct invoices or quotations');
    error.status = 403;
    throw error;
  }
}
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

  // Leads offered on the Create Quotation page (open, right Request Type, ready when the extension says so).
  app.get('/sales-flow/quotation-leads', requireAnyPermission(['crm.finance.write', 'crm.quotes.write']), async (req, res) => {
    try {
      const query = req.query || {};
      const data = await require('../services/lead-workflow.service').quotationCandidates(req, { q: query.q, include: query.include });
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Failed to load leads for a new quotation');
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
      const rules = await SalesFlowService.quotationDateRules(req, { leadId: body.leadId, opportunityId: body.opportunityId, recordId: body.recordId, clientId: body.clientId });
      res.json({ success: true, data: { today: require('../utils/date-only.util').localDay(), ...rules } });
    } catch (error) {
      fail(res, error, 'Failed to load the quotation date rules');
    }
  });

  app.post('/sales-flow/guided-invoice/check', requirePermission('crm.finance.write'), async (req, res) => {
    try {
      guidedAccess(req);
      res.json({ success: true, data: await SalesFlowService.guidedInvoiceCheck(req, req.body || {}) });
    } catch (error) {
      fail(res, error, 'Failed to check this step');
    }
  });

  app.post('/sales-flow/guided-invoice/preview', requirePermission('crm.finance.write'), async (req, res) => {
    try {
      guidedAccess(req);
      res.json({ success: true, data: await SalesFlowService.guidedInvoicePreview(req, req.body || {}) });
    } catch (error) {
      fail(res, error, 'Failed to prepare the invoice lines');
    }
  });

  app.post(
    '/sales-flow/guided-invoice/commit',
    requirePermission('crm.finance.write'),
    requirePermission('crm.leads.write'),
    requirePermission('crm.clients.write'),
    async (req, res) => {
      try {
        guidedAccess(req);
        res.json({ success: true, data: await SalesFlowService.guidedInvoiceCommit(req, req.body || {}) });
      } catch (error) {
        fail(res, error, 'Failed to save the trip');
      }
    }
  );

  app.post('/sales-flow/guided-invoice/after', requirePermission('crm.finance.write'), async (req, res) => {
    try {
      guidedAccess(req);
      res.json({ success: true, data: await SalesFlowService.guidedInvoiceAfter(req, req.body || {}) });
    } catch (error) {
      fail(res, error, 'The follow-up step did not run');
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
