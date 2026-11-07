'use strict';

/**
 * Lead detail nested routes (activities, follow-ups, proposals).
 * Kept in a dedicated route file so backend reload picks them up reliably.
 */
const leadController = require('../controllers/lead.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateLeadEventCreate,
  validateLeadEventUpdate,
  validateFollowUpCreate,
  validateFollowUpUpdate,
  validateLeadProposalCreate,
  validateLeadEventComplete,
  validateLeadEventAccept,
  validateLeadEventConvert,
  validateLeadNoteWrite,
  validateLeadPortalInvite
} = require('../validation/lead.schema');

module.exports = function registerLeadDetailRoutes(app) {
  // Cross-lead reminder feed (dashboard alert + hourly in-app reminder).
  // Declared before the nested routes so it is never read as a lead id.
  app.get(
    '/lead-activities/reminders',
    requirePermission('crm.leads.read'),
    leadController.listActivityReminders
  );
  // Client portal access granted straight from the lead. Creating it never
  // converts the lead or moves its stage.
  app.get(
    '/leads/:id/portal-access',
    requirePermission('crm.leads.read'),
    leadController.listLeadPortalAccess
  );
  app.post(
    '/leads/:id/portal-access/invite',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadPortalInvite),
    leadController.inviteLeadPortalContact
  );
  app.post(
    '/leads/:id/portal-access/:accessId/approve',
    requirePermission('crm.leads.write'),
    leadController.approveLeadPortalUser
  );
  app.post(
    '/leads/:id/portal-access/:accessId/reject',
    requirePermission('crm.leads.write'),
    leadController.rejectLeadPortalUser
  );
  app.post(
    '/leads/:id/portal-access/:accessId/resubmit',
    requirePermission('crm.leads.write'),
    leadController.resubmitLeadPortalUser
  );
  app.delete(
    '/leads/:id/portal-access/:accessId',
    requirePermission('crm.leads.write'),
    leadController.revokeLeadPortalAccess
  );
  app.get('/leads/:id/events', requirePermission('crm.leads.read'), leadController.listEvents);
  app.post(
    '/leads/:id/events',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadEventCreate),
    leadController.createEvent
  );
  app.put(
    '/leads/:id/events/:eventId',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadEventUpdate),
    leadController.updateEvent
  );
  app.put(
    '/api/leads/:id/events/:eventId',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadEventUpdate),
    leadController.updateEvent
  );
  app.patch(
    '/leads/:id/events/:eventId',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadEventUpdate),
    leadController.updateEvent
  );
  app.patch(
    '/api/leads/:id/events/:eventId',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadEventUpdate),
    leadController.updateEvent
  );
  app.post(
    '/leads/:id/events/:eventId/complete',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadEventComplete),
    leadController.completeEvent
  );
  app.post(
    '/leads/:id/events/:eventId/accept',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadEventAccept),
    leadController.acceptLeadEvent
  );
  app.post(
    '/api/leads/:id/events/:eventId/accept',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadEventAccept),
    leadController.acceptLeadEvent
  );
  app.get(
    '/leads/:id/events/item-suggestions',
    requirePermission('crm.leads.read'),
    leadController.listEventItemSuggestions
  );
  app.post(
    '/leads/:id/events/:eventId/convert-opportunity',
    requireAnyPermission('crm.opportunities.write', 'crm.leads.write'),
    validateBody(validateLeadEventConvert),
    leadController.convertEventToOpportunity
  );
  app.delete(
    '/leads/:id/events/:eventId',
    requirePermission('crm.leads.write'),
    leadController.removeEvent
  );

  app.get('/leads/:id/notes', requirePermission('crm.leads.read'), leadController.listNotes);
  app.post(
    '/leads/:id/notes',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadNoteWrite),
    leadController.createNote
  );
  app.put(
    '/leads/:id/notes/:noteId',
    requirePermission('crm.leads.write'),
    validateBody(validateLeadNoteWrite),
    leadController.updateNote
  );
  app.delete(
    '/leads/:id/notes/:noteId',
    requirePermission('crm.leads.write'),
    leadController.removeNote
  );

  app.get('/leads/:id/follow-ups', requirePermission('crm.leads.read'), leadController.listFollowUps);
  app.get('/leads/:id/followups', requirePermission('crm.leads.read'), leadController.listFollowUps);
  app.post(
    '/leads/:id/follow-ups',
    requirePermission('crm.leads.write'),
    validateBody(validateFollowUpCreate),
    leadController.createFollowUp
  );
  app.post(
    '/leads/:id/followups',
    requirePermission('crm.leads.write'),
    validateBody(validateFollowUpCreate),
    leadController.createFollowUp
  );
  app.put(
    '/leads/:id/follow-ups/:followUpId',
    requirePermission('crm.leads.write'),
    validateBody(validateFollowUpUpdate),
    leadController.updateFollowUp
  );
  app.put(
    '/leads/:id/followups/:followUpId',
    requirePermission('crm.leads.write'),
    validateBody(validateFollowUpUpdate),
    leadController.updateFollowUp
  );
  app.post(
    '/leads/:id/follow-ups/:followUpId/complete',
    requirePermission('crm.leads.write'),
    leadController.completeFollowUp
  );
  app.post(
    '/leads/:id/followups/:followUpId/complete',
    requirePermission('crm.leads.write'),
    leadController.completeFollowUp
  );
  app.delete(
    '/leads/:id/follow-ups/:followUpId',
    requirePermission('crm.leads.write'),
    leadController.removeFollowUp
  );
  app.delete(
    '/leads/:id/followups/:followUpId',
    requirePermission('crm.leads.write'),
    leadController.removeFollowUp
  );

  app.get('/leads/:id/quotations', requirePermission('crm.finance.read'), leadController.listQuotations);
  app.post(
    '/leads/:id/proposal',
    requirePermission('crm.finance.write'),
    validateBody(validateLeadProposalCreate),
    leadController.createProposal
  );

  app.get('/leads/storage/status', requirePermission('crm.leads.read'), leadController.storageStatus);

  app.post('/leads/:id/photo', requirePermission('crm.leads.write'), leadController.uploadPhoto);
  app.get('/leads/:id/attachments', requirePermission('crm.leads.read'), leadController.listAttachments);
  app.post(
    '/leads/:id/attachments',
    requirePermission('crm.leads.write'),
    leadController.uploadAttachment
  );
  app.delete(
    '/leads/:id/attachments/:attachmentId',
    requirePermission('crm.leads.write'),
    leadController.removeAttachment
  );

  // Product Catalogue Interests on Leads
  app.post('/leads/:id/products', requirePermission('crm.leads.write'), leadController.addProduct);
  app.delete('/leads/:id/products/:productId', requirePermission('crm.leads.write'), leadController.removeProduct);

  // Contracts on Leads
  app.get('/leads/:id/contracts', requirePermission('crm.leads.read'), leadController.listContracts);
  app.post('/leads/:id/contracts', requirePermission('crm.leads.write'), leadController.createContract);
};
