'use strict';

const personContactController = require('../controllers/person-contact.controller');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');

/**
 * Standalone CRM contacts (PersonContact) used by Leads.
 * Client-company contacts remain under /clients/:id/contacts.
 */
module.exports = function registerPersonContactsRoutes(app) {
  const readPerms = ['crm.contacts.read', 'crm.leads.read', 'crm.clients.read'];
  const writePerms = ['crm.contacts.write', 'crm.leads.write'];

  app.get(
    '/contacts',
    requireAnyPermission(...readPerms),
    personContactController.list
  );

  app.get(
    '/contacts/duplicates',
    requireAnyPermission(...readPerms, ...writePerms),
    personContactController.checkDuplicates
  );

  app.get(
    '/contacts/:id',
    requireAnyPermission(...readPerms),
    personContactController.getById
  );

  app.post(
    '/contacts',
    requireAnyPermission(...writePerms),
    personContactController.create
  );

  app.put(
    '/contacts/:id',
    requireAnyPermission(...writePerms),
    personContactController.update
  );

  app.delete(
    '/contacts/:id',
    requireAnyPermission('crm.contacts.delete', 'crm.leads.delete', 'crm.leads.write'),
    personContactController.remove
  );
};
