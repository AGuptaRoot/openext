'use strict';

const OpportunityService = require('../services/opportunity.service');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] opportunity error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Opportunity operation failed',
    ...(error.code ? { code: error.code } : {}),
    details: error.details || []
  });
}

/**
 * Controller to list opportunities.
 * 
 * Usecase: Handles GET /opportunities request.
 */
async function list(req, res) {
  try {
    const data = await OpportunityService.list(req);
    res.json({ success: true, data: data.items, pagination: data.pagination, message: 'Opportunities loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to compute pipeline summary metrics.
 * 
 * Usecase: Handles GET /opportunities/summary request.
 */
async function getSummary(req, res) {
  try {
    const summary = await OpportunityService.getSummary(req);
    res.json({ success: true, data: summary, message: 'Pipeline summary calculated' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to fetch opportunity details by ID.
 * 
 * Usecase: Handles GET /opportunities/:id request.
 */
async function getById(req, res) {
  try {
    const doc = await OpportunityService.getById(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Opportunity details loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to create an opportunity.
 * 
 * Usecase: Handles POST /opportunities request.
 */
async function create(req, res) {
  try {
    // The stage the user asked for (the validator fills a default), so a locked start stage can refuse it.
    const requestedStage = req.body && typeof req.body.stage === 'string' ? req.body.stage : '';
    const doc = await OpportunityService.create(req, req.validatedBody, { requestedStage });
    res.status(201).json({ success: true, data: doc, message: 'Opportunity created successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

/** GET /opportunities/start-stage?leadId= — the stage a new opportunity opens in (salesFlow.opportunityForm.startStage). */
async function getStartStage(req, res) {
  try {
    const data = await OpportunityService.getStartStage(req, req.query && req.query.leadId);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to reassign opportunity sales owner.
 *
 * Usecase: Handles POST /opportunities/:id/assign-owner request.
 */
/** POST /opportunities/:id/contact-correction — admin / sales manager, with a reason (audited). */
async function correctContact(req, res) {
  try {
    const item = await OpportunityService.correctContact(req, req.params.id, req.body || {});
    res.json({ success: true, data: item, message: 'Primary contact corrected' });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: status >= 500 ? 'The contact could not be corrected' : error.message });
  }
}

async function update(req, res) {
  try {
    const item = await OpportunityService.update(req, req.params.id, req.validatedBody);
    res.json({
      success: true,
      data: item,
      message: item.contactSynced
        ? 'Opportunity updated and contact record synced'
        : 'Opportunity updated'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function assignOwner(req, res) {
  try {
    const doc = await OpportunityService.assignOwner(req, req.params.id, req.validatedBody);
    res.json({
      success: true,
      data: doc,
      message: 'Opportunity assigned to sales representative'
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to update pipeline stage.
 * 
 * Usecase: Handles POST /opportunities/:id/stage request.
 */
async function changeStage(req, res) {
  try {
    const doc = await OpportunityService.changeStage(req, req.params.id, req.validatedBody);
    res.json({ success: true, data: doc, message: `Opportunity moved to stage ${doc.stage}` });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to convert a Won Opportunity to a Quotation.
 * 
 * Usecase: Handles POST /opportunities/:id/convert-quotation request.
 */
async function convertToQuotation(req, res) {
  try {
    const quotation = await OpportunityService.convertToQuotation(req, req.params.id);
    res.status(201).json({ success: true, data: quotation, message: 'Quotation generated successfully from Won Opportunity' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to delete an opportunity.
 * 
 * Usecase: Handles DELETE /opportunities/:id request.
 */
async function remove(req, res) {
  try {
    const result = await OpportunityService.remove(req, req.params.id);
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
}

async function exportOpportunities(req, res) {
  try {
    const result = await OpportunityService.exportOpportunities(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(result.content);
    } else {
      res.status(200).send(result.content);
    }
  } catch (error) {
    sendError(res, error);
  }
}

async function listItemSuggestions(req, res) {
  try {
    const LeadEventService = require('../services/lead-event.service');
    const items = await LeadEventService.listItemSuggestions(req, req.query || {});
    res.json({ success: true, data: items, message: 'Item suggestions loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  getStartStage,
  correctContact,
  list,
  listItemSuggestions,
  getSummary,
  getById,
  create,
  update,
  assignOwner,
  changeStage,
  convertToQuotation,
  remove,
  exportOpportunities
};
