'use strict';

/**
 * POST /lead-readiness   { leadIds: [...] } → { leads: { <id>: { ready, reasons, summary } } }
 *
 * The CRM's lead workflow contract (crm-extension.json → leadWorkflow.readinessRoute).
 * The CRM calls this to decide the Create Opportunity button, the leads offered for a new
 * opportunity, and (with sdk.workflow.leadReady) moving a lead to Qualified.
 */

const { readinessFor } = require('../services/readiness.js');

exports.readiness = async (req, sdk) => {
  const ids = req.body && Array.isArray(req.body.leadIds) ? req.body.leadIds : null;
  if (!ids) throw sdk.error(400, 'leadIds must be a list', 'INVALID_INPUT');
  return { leads: await readinessFor(sdk, ids) };
};
