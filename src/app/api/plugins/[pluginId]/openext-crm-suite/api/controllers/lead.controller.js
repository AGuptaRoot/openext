'use strict';

const LeadService = require('../services/lead.service');
const LeadEventService = require('../services/lead-event.service');
const LeadNoteService = require('../services/lead-note.service');
const FollowUpService = require('../services/follow-up.service');
const QuotationService = require('../services/quotation.service');
const LeadUploadService = require('../services/lead-upload.service');
const LeadOcrService = require('../services/lead-ocr.service');
const ClientPortalService = require('../services/client-portal.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid lead ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) {
    console.error('[plugin:openext-crm-suite] lead error:', error);
  }
  res.status(status).json({
    success: false,
    error: error.message || 'Lead operation failed',
    code: error.code || undefined,
    details: error.details || []
  });
}

async function checkDuplicates(req, res) {
  try {
    const result = await LeadService.findDuplicates(req, req.validatedBody, {
      excludeId: req.validatedBody.excludeId
    });
    res.json({ success: true, data: result, message: 'Duplicate check completed' });
  } catch (error) {
    sendError(res, error);
  }
}

async function list(req, res) {
  try {
    const result = await LeadService.list(req);
    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      message: 'Leads loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const lead = await LeadService.getById(req, req.params.id);
    res.json({ success: true, data: lead, message: 'Lead loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const lead = await LeadService.create(req, req.validatedBody);
    res.status(201).json({ success: true, data: lead, message: 'Lead created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const input =
      req.validatedBody && Object.keys(req.validatedBody).length
        ? req.validatedBody
        : req.body && typeof req.body === 'object'
          ? req.body
          : {};
    const lead = await LeadService.update(req, req.params.id, input);
    res.json({ success: true, data: lead, message: 'Lead updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateQualification(req, res) {
  try {
    const input =
      req.validatedBody && Object.keys(req.validatedBody).length
        ? req.validatedBody
        : req.body && typeof req.body === 'object'
          ? req.body
          : {};
    const lead = await LeadService.updateQualification(req, req.params.id, input);
    res.json({ success: true, data: lead, message: 'Lead qualification updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateCommercialRequirement(req, res) {
  try {
    const input =
      req.validatedBody && Object.keys(req.validatedBody).length
        ? req.validatedBody
        : req.body && typeof req.body === 'object'
          ? req.body
          : {};
    const lead = await LeadService.updateCommercialRequirement(req, req.params.id, input);
    res.json({
      success: true,
      data: lead,
      message: 'Commercial requirement updated'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function changeStage(req, res) {
  try {
    const lead = await LeadService.changeStage(req, req.params.id, req.validatedBody.stage);
    res.json({ success: true, data: lead, message: 'Lead stage updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function convert(req, res) {
  try {
    const result = await LeadService.convert(req, req.params.id);
    res.status(201).json({
      success: true,
      data: {
        clientId: result.clientId,
        contactId: result.contactId,
        company: result.company,
        contact: result.contact
      },
      message: 'Lead converted to client'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    await LeadService.remove(req, req.params.id);
    res.json({ success: true, data: { deleted: true, id: req.params.id }, message: 'Lead deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listEvents(req, res) {
  try {
    const items = await LeadEventService.listByLead(req, req.params.id);
    res.json({ success: true, data: items, message: 'Lead events loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Scheduled activities that are missed or about to start.
 *
 * Used by the dashboard alert and the hourly in-app reminder, so it is kept
 * cheap: no pagination, a bounded date window, and read permission only.
 */
/**
 * Portal credentials already issued for this lead, plus why a new invite is
 * not allowed yet. Returned together so the page can render the button, the
 * "already sent" state and the tooltip from one request.
 */
async function listLeadPortalAccess(req, res) {
  try {
    const [access, blockedReason, contactPortalAssigned] = await Promise.all([
      ClientPortalService.listLeadPortalAccess(req, req.params.id),
      ClientPortalService.describeLeadPortalBlock(req, req.params.id).catch(() => ''),
      ClientPortalService.leadContactPortalAssigned(req, req.params.id).catch(() => false)
    ]);
    res.json({
      success: true,
      data: { access, blockedReason, contactPortalAssigned },
      message: 'Lead portal access loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function inviteLeadPortalContact(req, res) {
  try {
    const result = await ClientPortalService.inviteLeadContact(
      req,
      req.params.id,
      req.validatedBody
    );
    res.status(201).json({
      success: true,
      data: result,
      message: result.emailSent
        ? 'Portal access created and emailed'
        : 'Portal access created, but the email could not be sent'
    });
  } catch (error) {
    sendError(res, error);
  }
}

/** Withdraw a lead's portal access and close its deals to the portal. */
async function revokeLeadPortalAccess(req, res) {
  try {
    const result = await ClientPortalService.revokeLeadPortalAccess(
      req,
      req.params.id,
      req.params.accessId
    );
    res.json({ success: true, data: result, message: 'Portal access revoked' });
  } catch (error) {
    sendError(res, error);
  }
}

async function approveLeadPortalUser(req, res) {
  try {
    const data = await ClientPortalService.approvePortalAccess(req, req.params.id, req.params.accessId);
    res.json({
      success: true,
      data,
      message: data.emailSent
        ? 'Portal access approved, user account created, and login credentials emailed to client'
        : 'Portal access approved and user created, but email could not be sent'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function rejectLeadPortalUser(req, res) {
  try {
    const data = await ClientPortalService.rejectPortalAccess(req, req.params.id, req.params.accessId, req.body);
    res.json({ success: true, data, message: 'Portal access request rejected' });
  } catch (error) {
    sendError(res, error);
  }
}

async function resubmitLeadPortalUser(req, res) {
  try {
    const data = await ClientPortalService.resubmitPortalAccess(req, req.params.id, req.params.accessId, req.body);
    res.json({ success: true, data, message: 'Portal access request resubmitted for manager approval' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listActivityReminders(req, res) {
  try {
    const data = await LeadEventService.listReminders(req, {
      scope: req.query?.scope,
      windowMinutes: req.query?.windowMinutes
    });
    res.json({ success: true, data, message: 'Activity reminders loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function createEvent(req, res) {
  try {
    const item = await LeadEventService.create(req, req.params.id, req.validatedBody);
    res.status(201).json({ success: true, data: item, message: 'Lead event created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateEvent(req, res) {
  try {
    const item = await LeadEventService.update(
      req,
      req.params.id,
      req.params.eventId,
      req.validatedBody
    );
    res.json({ success: true, data: item, message: 'Lead event updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function acceptLeadEvent(req, res) {
  try {
    const item = await LeadEventService.acceptEvent(
      req,
      req.params.id,
      req.params.eventId,
      req.validatedBody || req.body || {}
    );
    res.json({ success: true, data: item, message: 'Lead event accepted' });
  } catch (error) {
    sendError(res, error);
  }
}
const acceptEvent = acceptLeadEvent;

async function completeEvent(req, res) {
  try {
    const item = await LeadEventService.complete(
      req,
      req.params.id,
      req.params.eventId,
      req.validatedBody || {}
    );
    res.json({ success: true, data: item, message: 'Lead event completed' });
  } catch (error) {
    sendError(res, error);
  }
}

async function convertEventToOpportunity(req, res) {
  try {
    const result = await LeadEventService.convertToOpportunity(
      req,
      req.params.id,
      req.params.eventId,
      req.validatedBody || {}
    );
    res.status(201).json({
      success: true,
      data: result,
      message: 'Opportunity created from commercial requirement'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function listEventItemSuggestions(req, res) {
  try {
    const items = await LeadEventService.listItemSuggestions(req, req.query || {});
    res.json({ success: true, data: items, message: 'Item suggestions loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function removeEvent(req, res) {
  try {
    const result = await LeadEventService.remove(req, req.params.id, req.params.eventId);
    res.json({ success: true, data: result, message: 'Lead event deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listNotes(req, res) {
  try {
    const items = await LeadNoteService.listByLead(req, req.params.id);
    res.json({ success: true, data: items, message: 'Lead notes loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function createNote(req, res) {
  try {
    const item = await LeadNoteService.create(req, req.params.id, req.validatedBody);
    res.status(201).json({ success: true, data: item, message: 'Lead note added' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateNote(req, res) {
  try {
    const item = await LeadNoteService.update(
      req,
      req.params.id,
      req.params.noteId,
      req.validatedBody
    );
    res.json({ success: true, data: item, message: 'Lead note updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function removeNote(req, res) {
  try {
    const result = await LeadNoteService.remove(req, req.params.id, req.params.noteId);
    res.json({ success: true, data: result, message: 'Lead note deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listFollowUps(req, res) {
  try {
    const items = await FollowUpService.listByLead(req, req.params.id);
    res.json({ success: true, data: items, message: 'Follow-ups loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function createFollowUp(req, res) {
  try {
    const item = await FollowUpService.create(req, req.params.id, req.validatedBody);
    res.status(201).json({ success: true, data: item, message: 'Follow-up created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateFollowUp(req, res) {
  try {
    const item = await FollowUpService.update(
      req,
      req.params.id,
      req.params.followUpId,
      req.validatedBody
    );
    res.json({ success: true, data: item, message: 'Follow-up updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function completeFollowUp(req, res) {
  try {
    const item = await FollowUpService.complete(req, req.params.id, req.params.followUpId);
    res.json({ success: true, data: item, message: 'Follow-up completed' });
  } catch (error) {
    sendError(res, error);
  }
}

async function removeFollowUp(req, res) {
  try {
    const result = await FollowUpService.remove(req, req.params.id, req.params.followUpId);
    res.json({ success: true, data: result, message: 'Follow-up deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listQuotations(req, res) {
  try {
    const items = await QuotationService.listByLead(req, req.params.id);
    res.json({ success: true, data: items, message: 'Lead quotations loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function createProposal(req, res) {
  try {
    const result = await QuotationService.createForLead(req, req.params.id, req.validatedBody);
    const doc = result.doc || result;
    const email = result.emailDelivery;
    const message = email?.sent
      ? `Proposal created and emailed to ${email.to}`
      : req.validatedBody?.send
        ? 'Proposal created and marked as sent'
        : 'Proposal created';
    res.status(201).json({ success: true, data: doc, email, message });
  } catch (error) {
    sendError(res, error);
  }
}

async function uploadPhoto(req, res) {
  try {
    const result = await LeadUploadService.uploadPhoto(req, req.params.id);
    res.json({ success: true, data: result, message: 'Lead photo uploaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listAttachments(req, res) {
  try {
    const items = await LeadUploadService.listAttachments(req, req.params.id);
    res.json({ success: true, data: items, message: 'Lead attachments loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function uploadAttachment(req, res) {
  try {
    const item = await LeadUploadService.uploadAttachment(req, req.params.id);
    res.status(201).json({ success: true, data: item, message: 'Document uploaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function removeAttachment(req, res) {
  try {
    const result = await LeadUploadService.removeAttachment(
      req,
      req.params.id,
      req.params.attachmentId
    );
    res.json({ success: true, data: result, message: 'Document deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function storageStatus(req, res) {
  try {
    res.json({
      success: true,
      data: await require('../utils/storage.util').storageStatus(req),
      message: 'Storage status loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function listSources(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const sources = await SettingService.getLeadSources(req);
    res.json({ success: true, data: sources, message: 'Lead sources loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addSource(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const sourceName = req.body?.name || req.body?.source;
    const sources = await SettingService.addLeadSource(req, sourceName);
    res.status(201).json({ success: true, data: sources, message: 'Lead source created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listStatuses(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const statuses = await SettingService.getLeadStatuses(req);
    res.json({ success: true, data: statuses, message: 'Lead statuses loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addStatus(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const statusName = req.body?.name || req.body?.status;
    const statuses = await SettingService.addLeadStatus(req, statusName);
    res.status(201).json({ success: true, data: statuses, message: 'Lead status created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listTypes(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const types = await SettingService.getLeadTypes(req);
    res.json({ success: true, data: types, message: 'Lead types loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addType(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const typeName = req.body?.name || req.body?.type || req.body?.leadType;
    const types = await SettingService.addLeadType(req, typeName);
    res.status(201).json({ success: true, data: types, message: 'Lead type created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listPriorities(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const priorities = await SettingService.getLeadPriorities(req);
    res.json({ success: true, data: priorities, message: 'Lead priorities loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addPriority(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const priorityName = req.body?.name || req.body?.priority;
    const priorities = await SettingService.addLeadPriority(req, priorityName);
    res.status(201).json({ success: true, data: priorities, message: 'Lead priority created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listTags(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const tags = await SettingService.getLeadTags(req);
    res.json({ success: true, data: tags, message: 'Lead tags loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addTag(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const tagName = req.body?.name || req.body?.tag;
    const tags = await SettingService.addLeadTag(req, tagName);
    res.status(201).json({ success: true, data: tags, message: 'Lead tag created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listActivityTypes(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const types = await SettingService.getActivityTypes(req);
    res.json({ success: true, data: types, message: 'Activity types loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addActivityType(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const typeName = req.body?.name || req.body?.type;
    const types = await SettingService.addActivityType(req, typeName);
    res.status(201).json({ success: true, data: types, message: 'Activity type created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listCustomFields(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const fields = await SettingService.getLeadCustomFields(req);
    res.json({ success: true, data: fields, message: 'Lead custom fields loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addCustomField(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const fields = await SettingService.addLeadCustomField(req, req.body);
    res.status(201).json({ success: true, data: fields, message: 'Lead custom field created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function importPreview(req, res) {
  try {
    const result = await LeadService.previewImport(req, req.validatedBody);
    res.json({ success: true, data: result, message: 'Import preview generated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function importExecute(req, res) {
  try {
    const result = await LeadService.executeImport(req, req.validatedBody);
    res.json({ success: true, data: result, message: `Import completed: ${result.createdCount} leads created` });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportLeads(req, res) {
  try {
    const result = await LeadService.exportLeads(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(JSON.stringify(result.data, null, 2));
    } else {
      res.status(200).send(result.csv);
    }
  } catch (error) {
    sendError(res, error);
  }
}

async function bulkAssign(req, res) {
  try {
    const result = await LeadService.bulkAssign(req, req.validatedBody);
    res.json({
      success: true,
      data: result,
      message: `Assigned ${result.updatedCount} leads successfully`
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function bulkChangeStage(req, res) {
  try {
    const result = await LeadService.bulkChangeStage(req, req.validatedBody);
    res.json({
      success: true,
      data: result,
      message: `Changed stage for ${result.updatedCount} leads to ${result.stage}`
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function listSavedFilters(req, res) {
  try {
    const filters = await LeadService.getSavedFilters(req);
    res.json({
      success: true,
      data: filters
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function createSavedFilter(req, res) {
  try {
    const filter = await LeadService.createSavedFilter(req, req.validatedBody);
    res.status(201).json({
      success: true,
      data: filter,
      message: 'Saved filter created successfully'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateSavedFilter(req, res) {
  try {
    const filter = await LeadService.updateSavedFilter(req, req.params.id, req.validatedBody);
    res.json({
      success: true,
      data: filter,
      message: 'Saved filter updated successfully'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function deleteSavedFilter(req, res) {
  try {
    const result = await LeadService.deleteSavedFilter(req, req.params.id);
    res.json({
      success: true,
      data: result,
      message: 'Saved filter deleted successfully'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function addProduct(req, res) {
  try {
    const lead = await LeadService.addLeadProduct(req, req.params.id, req.body);
    res.json({ success: true, data: lead, message: 'Product added to lead' });
  } catch (error) {
    sendError(res, error);
  }
}

async function removeProduct(req, res) {
  try {
    const lead = await LeadService.removeLeadProduct(req, req.params.id, req.params.productId);
    res.json({ success: true, data: lead, message: 'Product removed from lead' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listContracts(req, res) {
  try {
    const contracts = await LeadService.getLeadContracts(req, req.params.id);
    res.json({ success: true, data: contracts, message: 'Lead contracts loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function createContract(req, res) {
  try {
    const contract = await LeadService.createContractFromLead(req, req.params.id, req.body);
    res.status(201).json({ success: true, data: contract, message: 'Contract created from lead' });
  } catch (error) {
    sendError(res, error);
  }
}

async function extractOcr(req, res) {
  try {
    const data = await LeadOcrService.extractFromCard(req, req.validatedBody || {});
    res.json({
      success: true,
      data,
      message: 'Visiting card fields extracted from image'
    });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  checkDuplicates,
  get,
  create,
  update,
  updateQualification,
  updateCommercialRequirement,
  changeStage,
  convert,
  remove,
  listEvents,
  listActivityReminders,
  listLeadPortalAccess,
  inviteLeadPortalContact,
  revokeLeadPortalAccess,
  approveLeadPortalUser,
  rejectLeadPortalUser,
  resubmitLeadPortalUser,
  createEvent,
  updateEvent,
  completeEvent,
  acceptLeadEvent,
  acceptEvent,
  convertEventToOpportunity,
  listEventItemSuggestions,
  removeEvent,
  listNotes,
  createNote,
  updateNote,
  removeNote,
  listFollowUps,
  createFollowUp,
  updateFollowUp,
  completeFollowUp,
  removeFollowUp,
  listQuotations,
  createProposal,
  uploadPhoto,
  listAttachments,
  uploadAttachment,
  removeAttachment,
  storageStatus,
  listSources,
  addSource,
  listStatuses,
  addStatus,
  listTypes,
  addType,
  listPriorities,
  addPriority,
  listTags,
  addTag,
  listActivityTypes,
  addActivityType,
  listCustomFields,
  addCustomField,
  importPreview,
  importExecute,
  extractOcr,
  exportLeads,
  bulkAssign,
  bulkChangeStage,
  listSavedFilters,
  createSavedFilter,
  updateSavedFilter,
  deleteSavedFilter,
  addProduct,
  removeProduct,
  listContracts,
  createContract
};
