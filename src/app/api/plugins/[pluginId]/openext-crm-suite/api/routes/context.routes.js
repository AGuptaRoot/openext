'use strict';

const contextController = require('../controllers/context.controller');
const { requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * User context routes — /me, /permissions, assignable users for lead/project/task ownership.
 */
module.exports = function registerContextRoutes(app) {
  app.get(
    '/me',
    contextController.me
  );

  /** Any logged-in user — used by OpenExt parent sidebar to filter CRM submenu items. */
  app.get('/permissions', contextController.permissions);

  app.get(
    '/users/assignable',
    requireAnyPermission(
      'crm.leads.write',
      'crm.leads.read',
      'crm.projects.write',
      'crm.projects.read',
      'crm.tasks.write',
      'crm.tasks.read',
      'crm.tickets.write',
      'crm.tickets.read',
      'crm.opportunities.write',
      'crm.dashboard.view'
    ),
    contextController.assignableUsers
  );
};
