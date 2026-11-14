'use strict';

const clientController = require('../controllers/client.controller');
const clientExtensionController = require('../controllers/client-extension.controller');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateClientCreate,
  validateClientUpdate,
  validateClientDuplicateCheck,
  validateContactCreate,
  validateContactUpdate,
  validateClientImportPreview,
  validateClientImport,
  validateClientNoteCreate,
  validateClientNoteUpdate,
  validateClientEventCreate,
  validateClientEventUpdate
} = require('../validation/client.schema');

/**
 * Clients routes (Phase 1 plan Section 6.4).
 * Nested routes registered before /clients/:id.
 */
module.exports = function registerClientsRoutes(app) {
  app.get('/clients/summary', requirePermission('crm.clients.read'), clientController.listSummary);
  app.get('/clients/categories', requirePermission('crm.clients.read'), clientController.listCategories);
  app.post('/clients/categories', requirePermission('crm.clients.write'), clientController.addCategory);
  app.get('/clients/tags', requirePermission('crm.clients.read'), clientController.listTags);
  app.post('/clients/tags', requirePermission('crm.clients.write'), clientController.addTag);
  app.get('/clients/custom-fields', requirePermission('crm.clients.read'), clientController.listCustomFields);
  app.post('/clients/custom-fields', requirePermission('crm.clients.write'), clientController.addCustomField);
  app.get('/clients/statuses', requirePermission('crm.clients.read'), clientController.listStatuses);
  // CRM 3.46.0: Lead create asks whether the typed company is an existing Client (report only).
  app.get(
    '/clients/company-match',
    requireAnyPermission('crm.leads.write', 'crm.clients.read'),
    clientController.companyMatch
  );
  // CRM 3.48.0: the same lookup with the contact (Client create / Contact create), body only.
  app.post(
    '/clients/company-match',
    requireAnyPermission('crm.leads.write', 'crm.clients.read', 'crm.clients.write', 'crm.contacts.write'),
    clientController.companyMatch
  );

  // Import / Export
  app.post(
    '/clients/import/preview',
    requirePermission('crm.clients.write'),
    validateBody(validateClientImportPreview),
    clientController.importPreview
  );
  app.post(
    '/clients/import',
    requirePermission('crm.clients.write'),
    validateBody(validateClientImport),
    clientController.importExecute
  );
  app.get(
    '/clients/export',
    requireAnyPermission('crm.clients.export', 'crm.clients.read', 'crm.clients.write'),
    clientController.exportClients
  );

  app.get('/clients', requirePermission('crm.clients.read'), clientController.list);

  app.post(
    '/clients/duplicate-check',
    requirePermission('crm.clients.write'),
    validateBody(validateClientDuplicateCheck),
    clientController.checkDuplicates
  );

  app.post(
    '/clients',
    requirePermission('crm.clients.write'),
    validateBody(validateClientCreate),
    clientController.create
  );

  // Contacts
  app.get(
    '/clients/:id/contacts',
    requirePermission('crm.clients.read'),
    clientController.listContacts
  );
  app.post(
    '/clients/:id/contacts',
    requirePermission('crm.clients.write'),
    validateBody(validateContactCreate),
    clientController.addContact
  );
  // CRM 3.46.0: "Add as Secondary Contact" (Lead create → matching Client, confirmed by the user).
  app.post(
    '/clients/:id/secondary-contacts',
    requirePermission('crm.clients.write'),
    clientController.addSecondaryContact
  );
  app.put(
    '/clients/:id/contacts/:contactId',
    requirePermission('crm.clients.write'),
    validateBody(validateContactUpdate),
    clientController.updateContact
  );
  app.delete(
    '/clients/:id/contacts/:contactId',
    requirePermission('crm.clients.delete'),
    clientController.removeContact
  );

  // Addresses
  app.get(
    '/clients/:id/addresses',
    requirePermission('crm.clients.read'),
    clientController.listAddresses
  );
  app.post(
    '/clients/:id/addresses',
    requirePermission('crm.clients.write'),
    clientController.addAddress
  );
  app.put(
    '/clients/:id/addresses/:addressId',
    requirePermission('crm.clients.write'),
    clientController.updateAddress
  );
  app.delete(
    '/clients/:id/addresses/:addressId',
    requirePermission('crm.clients.write'),
    clientController.deleteAddress
  );
  app.post(
    '/clients/:id/addresses/:addressId/default',
    requirePermission('crm.clients.write'),
    clientController.setDefaultAddress
  );

  // Client Notes
  app.get(
    '/clients/:id/notes',
    requirePermission('crm.clients.read'),
    clientController.listNotes
  );
  app.post(
    '/clients/:id/notes',
    requirePermission('crm.clients.write'),
    validateBody(validateClientNoteCreate),
    clientController.createNote
  );
  app.put(
    '/clients/:id/notes/:noteId',
    requirePermission('crm.clients.write'),
    validateBody(validateClientNoteUpdate),
    clientController.updateNote
  );
  app.post(
    '/clients/:id/notes/:noteId/pin',
    requirePermission('crm.clients.write'),
    clientController.togglePinNote
  );
  app.delete(
    '/clients/:id/notes/:noteId',
    requirePermission('crm.clients.write'),
    clientController.deleteNote
  );

  // Client Events & Activity Timeline
  app.get(
    '/clients/:id/timeline',
    requirePermission('crm.clients.read'),
    clientController.getTimeline
  );
  app.get(
    '/clients/:id/events',
    requirePermission('crm.clients.read'),
    clientController.listEvents
  );
  app.post(
    '/clients/:id/events',
    requirePermission('crm.clients.write'),
    validateBody(validateClientEventCreate),
    clientController.createEvent
  );
  app.put(
    '/clients/:id/events/:eventId',
    requirePermission('crm.clients.write'),
    validateBody(validateClientEventUpdate),
    clientController.updateEvent
  );
  app.post(
    '/clients/:id/events/:eventId/complete',
    requirePermission('crm.clients.write'),
    clientController.completeEvent
  );
  app.delete(
    '/clients/:id/events/:eventId',
    requirePermission('crm.clients.write'),
    clientController.deleteEvent
  );

  // Relationships
  app.get(
    '/clients/:id/quotations',
    requirePermission('crm.finance.read'),
    clientController.listQuotations
  );
  app.get(
    '/clients/:id/invoices',
    requirePermission('crm.finance.read'),
    clientController.listInvoices
  );
  app.get(
    '/clients/:id/payments',
    requirePermission('crm.finance.read'),
    clientController.listPayments
  );
  app.get(
    '/clients/:id/projects',
    requirePermission('crm.projects.read'),
    clientController.listProjects
  );
  app.get(
    '/clients/:id/tasks',
    requireAnyPermission('crm.clients.read', 'crm.tasks.read'),
    clientController.listTasks
  );
  app.get(
    '/clients/:id/time-logs',
    requireAnyPermission('crm.clients.read', 'crm.time.read'),
    clientController.listTimeLogs
  );
  app.get(
    '/clients/:id/contracts',
    requireAnyPermission('crm.clients.read', 'crm.contracts.read'),
    clientController.listContracts
  );
  app.get(
    '/clients/:id/products',
    requireAnyPermission('crm.clients.read', 'crm.projects.read'),
    clientController.listProducts
  );

  // Client Documents & Attachments
  app.get(
    '/clients/:id/documents',
    requireAnyPermission('crm.clients.read', 'crm.projects.read'),
    clientController.listDocuments
  );
  app.get(
    '/clients/:id/documents/:docId/download',
    requireAnyPermission('crm.clients.read', 'crm.projects.read'),
    clientController.downloadDocument
  );
  app.post(
    '/clients/:id/documents/upload',
    requirePermission('crm.clients.write'),
    clientController.uploadDocument
  );
  app.post(
    '/clients/:id/documents',
    requirePermission('crm.clients.write'),
    clientController.createDocument
  );
  app.delete(
    '/clients/:id/documents/:docId',
    requirePermission('crm.clients.write'),
    clientController.deleteDocument
  );

  /**
   * Plugin-extension data on the client: reads the source lead's extension
   * bag through `Company.leadId` (no copy), so extension sections work
   * without `crm.leads.read`.
   */
  app.get(
    '/clients/:id/extension-data',
    requirePermission('crm.clients.read'),
    clientExtensionController.getExtensionData
  );
  // Client Portal Access & Invitations
  app.get(
    '/clients/:id/portal-access',
    requirePermission('crm.clients.read'),
    clientController.listPortalAccess
  );
  app.post(
    '/clients/:id/portal-access/invite',
    requirePermission('crm.clients.write'),
    clientController.invitePortalContact
  );
  app.post(
    '/clients/:id/portal-access/:accessId/resend',
    requirePermission('crm.clients.write'),
    clientController.resendPortalInvitation
  );
  app.post(
    '/clients/:id/portal-access/:accessId/activate',
    requirePermission('crm.clients.write'),
    clientController.activatePortalUser
  );
  app.post(
    '/clients/:id/portal-access/:accessId/suspend',
    requirePermission('crm.clients.write'),
    clientController.suspendPortalUser
  );
  app.post(
    '/clients/:id/portal-access/:accessId/reinstate',
    requirePermission('crm.clients.write'),
    clientController.reinstatePortalUser
  );
  app.put(
    '/clients/:id/portal-access/:accessId/permissions',
    requirePermission('crm.clients.write'),
    clientController.updatePortalPermissions
  );
  app.get(
    '/portal-access/pending',
    requireAnyPermission('crm.clients.read', 'crm.leads.read', 'crm.dashboard.read'),
    clientController.listPendingPortalApprovals
  );
  app.get(
    '/clients/portal-access/pending',
    requireAnyPermission('crm.clients.read', 'crm.leads.read', 'crm.dashboard.read'),
    clientController.listPendingPortalApprovals
  );
  app.post(
    '/clients/:id/portal-access/:accessId/approve',
    requirePermission('crm.clients.write'),
    clientController.approvePortalUser
  );
  app.post(
    '/clients/:id/portal-access/:accessId/reject',
    requirePermission('crm.clients.write'),
    clientController.rejectPortalUser
  );
  app.post(
    '/clients/:id/portal-access/:accessId/resubmit',
    requirePermission('crm.clients.write'),
    clientController.resubmitPortalUser
  );
  app.delete(
    '/clients/:id/portal-access/:accessId',
    requirePermission('crm.clients.write'),
    clientController.revokePortalAccess
  );

  // Summary & CRUD
  app.get(
    '/clients/:id/summary',
    requirePermission('crm.clients.read'),
    clientController.summary
  );
  app.get('/clients/:id', requirePermission('crm.clients.read'), clientController.get);
  app.put(
    '/clients/:id',
    requirePermission('crm.clients.write'),
    validateBody(validateClientUpdate),
    clientController.update
  );
  app.delete('/clients/:id', requirePermission('crm.clients.delete'), clientController.remove);
};
