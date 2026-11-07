'use strict';

const milestoneController = require('../controllers/milestone.controller.js');
const { requirePermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateMilestoneCreate,
  validateMilestoneUpdate
} = require('../validation/milestone.schema');

module.exports = function registerMilestonesRoutes(app) {
  app.get('/milestones', requirePermission('crm.projects.read'), milestoneController.list);

  app.post(
    '/milestones',
    requirePermission('crm.projects.write'),
    validateBody(validateMilestoneCreate),
    milestoneController.create
  );

  app.get('/milestones/:id', requirePermission('crm.projects.read'), milestoneController.get);

  app.put(
    '/milestones/:id',
    requirePermission('crm.projects.write'),
    validateBody(validateMilestoneUpdate),
    milestoneController.update
  );

  app.delete('/milestones/:id', requirePermission('crm.projects.write'), milestoneController.remove);
};
