'use strict';

const SampleService = require('../services/sample.service');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] sample error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Sample operation failed',
    details: error.details || []
  });
}

/**
 * Controller to list sample requests.
 * 
 * Usecase: Handles GET /samples request.
 */
async function list(req, res) {
  try {
    const data = await SampleService.list(req);
    res.json({ success: true, data: data.items, pagination: data.pagination, message: 'Sample requests loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to get sample request details.
 * 
 * Usecase: Handles GET /samples/:id request.
 */
async function getById(req, res) {
  try {
    const doc = await SampleService.getById(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Sample request details loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to create a new sample request.
 * 
 * Usecase: Handles POST /samples request.
 */
async function create(req, res) {
  try {
    const doc = await SampleService.create(req, req.validatedBody);
    res.status(201).json({ success: true, data: doc, message: 'Sample request created successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to edit a sample request that has not been dispatched.
 *
 * Usecase: Handles PUT /samples/:id request.
 */
async function update(req, res) {
  try {
    const doc = await SampleService.update(req, req.params.id, req.validatedBody);
    res.json({ success: true, data: doc, message: 'Sample request updated successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller for Manager approval or rejection.
 * 
 * Usecase: Handles PUT /samples/:id/approve request.
 */
async function approve(req, res) {
  try {
    const doc = await SampleService.approve(req, req.params.id, req.validatedBody);
    res.json({ success: true, data: doc, message: `Sample request ${doc.status.toLowerCase()} successfully` });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to record sample dispatch details.
 * 
 * Usecase: Handles PUT /samples/:id/dispatch request.
 */
/**
 * Controller for the create form's item-name picker.
 *
 * Usecase: Handles GET /samples/item-suggestions?q= — read-only, and scoped to
 * the caller's own account for a portal user.
 */
async function listItemSuggestions(req, res) {
  try {
    const items = await SampleService.listItemSuggestions(req, req.query || {});
    res.json({ success: true, data: items, message: 'Sample item suggestions loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to cancel a sample request.
 *
 * Usecase: Handles POST /samples/:id/cancel from the client portal or from
 * staff acting on the client's behalf.
 */
async function cancel(req, res) {
  try {
    const doc = await SampleService.cancel(req, req.params.id, req.validatedBody || {});
    res.json({ success: true, data: doc, message: 'Sample request cancelled' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to set the stock address a sample ships from.
 *
 * Usecase: Handles PUT /samples/:id/stock-address. The route has always pointed
 * here; without the handler every save answered with an HTML 500 that the admin
 * UI could not parse ("Failed to parse JSON response").
 */
async function updateStockAddress(req, res) {
  try {
    const doc = await SampleService.updateStockAddress(
      req,
      req.params.id,
      req.validatedBody.stockLocation
    );
    res.json({ success: true, data: doc, message: 'Stock address updated successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function dispatch(req, res) {
  try {
    const doc = await SampleService.dispatch(req, req.params.id, req.validatedBody);
    res.json({ success: true, data: doc, message: 'Sample dispatched and tracking updated' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to mark sample delivered.
 * 
 * Usecase: Handles PUT /samples/:id/deliver request.
 */
async function deliver(req, res) {
  try {
    const doc = await SampleService.deliver(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Sample marked as delivered' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Controller to submit customer feedback.
 * 
 * Usecase: Handles POST /samples/:id/feedback request.
 */
async function submitFeedback(req, res) {
  try {
    const doc = await SampleService.submitFeedback(req, req.params.id, req.validatedBody);
    res.json({ success: true, data: doc, message: 'Customer feedback recorded successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportSamples(req, res) {
  try {
    const result = await SampleService.exportSamples(req, req.query || {});
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

module.exports = {
  list,
  exportSamples,
  getById,
  create,
  update,
  approve,
  cancel,
  listItemSuggestions,
  updateStockAddress,
  dispatch,
  deliver,
  submitFeedback
};
