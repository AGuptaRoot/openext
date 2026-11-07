'use strict';

/**
 * Lead workflow (services/lead-workflow.service.js).
 *
 * GET /leads/:id/workflow                   ready / qualified, Create Opportunity allowed, Commercial Requirement shown
 * GET /lead-workflow/opportunity-leads?q=&include=<leadId>   leads offered on the Create Opportunity page
 */

const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const LeadWorkflowService = require('../services/lead-workflow.service');

function fail(res, error, fallback) {
  const status = Number(error && error.status) || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] lead workflow:', error);
  res.status(status).json({
    success: false,
    error: status >= 500 ? fallback : String((error && error.message) || fallback),
    code: (error && error.code) || undefined
  });
}

module.exports = function registerLeadWorkflowRoutes(app) {
  app.get('/leads/:id/workflow', requirePermission('crm.leads.read'), async (req, res) => {
    try {
      const data = await LeadWorkflowService.forLead(req, req.params.id);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Failed to load the lead workflow');
    }
  });

  app.get(
    '/lead-workflow/opportunity-leads',
    requireAnyPermission(['crm.opportunities.write', 'crm.leads.write']),
    async (req, res) => {
      try {
        const data = await LeadWorkflowService.opportunityCandidates(req, req.query || {});
        res.json({ success: true, data });
      } catch (error) {
        fail(res, error, 'Failed to load leads for a new opportunity');
      }
    }
  );
};
