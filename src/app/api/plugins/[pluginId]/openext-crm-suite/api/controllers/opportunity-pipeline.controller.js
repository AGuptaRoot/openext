'use strict';

const OpportunityPipelineService = require('../services/opportunity-pipeline.service');
const {
  validatePipelineCreate,
  validatePipelineUpdate,
  DEFAULT_STAGE_CATALOG
} = require('../validation/opportunity-pipeline.schema');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) {
    console.error('[plugin:openext-crm-suite] opportunity-pipeline error:', error);
  }
  res.status(status).json({
    success: false,
    error: error.message || 'Opportunity pipeline operation failed',
    code: error.code || undefined,
    opportunityCount: error.opportunityCount,
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const data = await OpportunityPipelineService.list(req);
    res.json({ success: true, data, message: 'Opportunity pipelines loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function getActive(req, res) {
  try {
    const data = await OpportunityPipelineService.getActive(req);
    res.json({
      success: true,
      data,
      catalog: DEFAULT_STAGE_CATALOG,
      message: 'Active opportunity pipeline loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function getCatalog(req, res) {
  try {
    res.json({
      success: true,
      data: DEFAULT_STAGE_CATALOG,
      message: 'Default stage catalog loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function getById(req, res) {
  try {
    const data = await OpportunityPipelineService.getById(req, req.params.id);
    res.json({ success: true, data, message: 'Opportunity pipeline loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const validated = validatePipelineCreate(req.body);
    if (!validated.ok) {
      res.status(400).json({ success: false, error: validated.errors[0], details: validated.errors });
      return;
    }
    const data = await OpportunityPipelineService.create(req, validated.value);
    res.status(201).json({ success: true, data, message: 'Opportunity pipeline created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const existing = await OpportunityPipelineService.getById(req, req.params.id);
    const body = {
      ...req.body,
      _quotationWorkflowEnabled: existing.quotationWorkflowEnabled
    };
    const validated = validatePipelineUpdate(body);
    if (!validated.ok) {
      res.status(400).json({ success: false, error: validated.errors[0], details: validated.errors });
      return;
    }
    // Re-validate stages with the pipeline's quotation flag when stages change.
    if (validated.value.stages && req.body.quotationWorkflowEnabled === undefined) {
      const { validateStages } = require('../validation/opportunity-pipeline.schema');
      const { errors } = validateStages(validated.value.stages, {
        quotationWorkflowEnabled: existing.quotationWorkflowEnabled !== false
      });
      if (errors.length) {
        res.status(400).json({ success: false, error: errors[0], details: errors });
        return;
      }
    }
    const data = await OpportunityPipelineService.update(req, req.params.id, validated.value);
    res.json({ success: true, data, message: 'Opportunity pipeline updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function activate(req, res) {
  try {
    const data = await OpportunityPipelineService.activate(req, req.params.id);
    res.json({ success: true, data, message: 'Opportunity pipeline activated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const data = await OpportunityPipelineService.remove(req, req.params.id);
    res.json({ success: true, data, message: 'Opportunity pipeline deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  getActive,
  getCatalog,
  getById,
  create,
  update,
  activate,
  remove
};
