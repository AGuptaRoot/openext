'use strict';

const leadController = require('../controllers/lead.controller.js');
const { requirePermission } = require('../middleware/permission.middleware');
const { refuseWhenHidden } = require('../middleware/module.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const { validateLeadEventAccept } = require('../validation/lead.schema');

module.exports = function registerLeadRoutes(app) {
  app.post(
    '/api/leads/:id/events/:eventId/accept',
    requirePermission('crm.leads.write'),
    refuseWhenHidden('activities'),
    validateBody(validateLeadEventAccept),
    leadController.acceptLeadEvent
  );
  app.post(
    '/leads/:id/events/:eventId/accept',
    requirePermission('crm.leads.write'),
    refuseWhenHidden('activities'),
    validateBody(validateLeadEventAccept),
    leadController.acceptLeadEvent
  );
};
