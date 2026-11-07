'use strict';

const ClientService = require('../services/client.service');
const RecordMergeService = require('../services/record-merge.service');

/**
 * CRM BUSINESS USE CASE: Internal helper — standardized error response formatter used by all client endpoints.
 * Handles MongoDB CastError (invalid ID) with 400, extracts status/message/code/details from service-layer errors,
 * and logs 5xx errors to server console.
 *
 * HTTP method: N/A (internal helper, not an endpoint)
 * Expected parameters:
 *   - res: Express response object
 *   - error: Error object with optional properties: name (CastError), status, message, code, details[]
 *
 * Response JSON shape (sent via res.status(status).json):
 *   - CastError (400): { success: false, error: 'Invalid ID', details: [] }
 *   - Generic: { success: false, error: string, code?: string|number, details: string[] }
 * Status codes: 400 (CastError or client error.status < 500), 500 (default or server errors)
 */
function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] client error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Client operation failed',
    code: error.code,
    details: error.details || []
  });
}

/**
 * CRM BUSINESS USE CASE: Sales user fills the "Create Client" form and the frontend runs a real-time duplicate
 * check on blur of the email/phone/company fields, or before submitting, to warn the user about potential
 * duplicate customers. This prevents creating multiple client records for the same company/person.
 *
 * HTTP method: POST /clients/check-duplicates
 * Expected req.body (validatedBody) fields:
 *   - excludeId: string (optional) — ObjectId of current client to exclude from match (used when editing existing client)
 *   - company: string (optional) — company name to fuzzy-match
 *   - email: string (optional) — primary email to match exactly (case-insensitive)
 *   - phone: string (optional) — phone number to match (normalized)
 *   - taxId: string (optional) — tax ID / GSTIN to match exactly
 *
 * Response JSON shape on success (200 OK):
 *   {
 *     success: true,
 *     data: {
 *       hasExactDuplicate: boolean,   // true if matching email/phone/taxId found
 *       hasSimilarCompany: boolean,   // true if fuzzy company name match only
 *       matches: Array<{ clientId, clientName, reasons: string[], score: number }>
 *     },
 *     message: 'Customer duplicate check completed'
 *   }
 * Response JSON shape on failure:
 *   { success: false, error: string, code?: any, details: string[] }
 * Status codes: 200 OK, 400 Bad Request, 500 Internal Server Error
 */
async function checkDuplicates(req, res) {
  try {
    const matches = await RecordMergeService.findClientDuplicates(req, req.validatedBody, {
      excludeId: req.validatedBody.excludeId
    });
    res.json({
      success: true,
      data: {
        hasExactDuplicate: matches.some((match) => match.reasons.some((reason) => reason !== 'company')),
        hasSimilarCompany: matches.some((match) => match.reasons.includes('company')),
        matches
      },
      message: 'Customer duplicate check completed'
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: User opens the Clients list page from the CRM sidebar, frontend calls this endpoint
 * via CrmApi.clients.list() with pagination, optional search (name/email/phone), industry filter, owner filter,
 * and sort options to display the paginated client table.
 *
 * HTTP method: GET /clients
 * Expected req.query fields:
 *   - page: number (optional, default 1)
 *   - pageSize: number (optional, default 25)
 *   - search: string (optional) — free-text search on company name, contact name, email, phone
 *   - owner: string (optional) — ObjectId of assigned owner user
 *   - industry: string (optional) — industry category filter
 *   - sort: string (optional) — sort field e.g. "createdAt:desc"
 *   - includeQuality: boolean (optional) — include data-quality scores (default true)
 *
 * Response JSON shape on success (200 OK):
 *   {
 *     success: true,
 *     data: Array<Client>,               // client records with contact info, owner, stats
 *     pagination: { page, pageSize, total, totalPages },
 *     message: 'Clients loaded'
 *   }
 * Response JSON shape on failure:
 *   { success: false, error: string, code?: any, details: string[] }
 * Status codes: 200 OK, 400 Bad Request, 500 Internal Server Error
 */
async function list(req, res) {
  try {
    const result = await ClientService.list(req);
    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      message: 'Clients loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: User clicks a client row in the Clients list or navigates to a client via deep link,
 * frontend calls this endpoint via CrmApi.clients.get(id) to load the full client detail (primary contact,
 * addresses, custom fields, owner, data-quality score) for the Client Detail page header and overview tab.
 *
 * HTTP method: GET /clients/:id
 * Expected req.params fields:
 *   - id: string — MongoDB ObjectId of the client
 * Expected req.query fields:
 *   - includeQuality: boolean (optional, default true)
 *
 * Response JSON shape on success (200 OK):
 *   {
 *     success: true,
 *     data: Client,                      // full client object with nested contacts/addresses
 *     message: 'Client loaded'
 *   }
 * Response JSON shape on invalid ID (400): { success: false, error: 'Invalid ID', details: [] }
 * Response JSON shape on not found (404): { success: false, error: 'Client not found', details: [] }
 * Status codes: 200 OK, 400 Bad Request, 404 Not Found, 500 Internal Server Error
 */
async function get(req, res) {
  try {
    const client = await ClientService.getById(req, req.params.id);
    res.json({ success: true, data: client, message: 'Client loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: Sales user clicks "New Client" on the Clients page or converts a qualified lead into
 * a client via the "Convert to Client" action (handled separately in lead.controller, but this endpoint is also
 * called for manual entry). Frontend posts the filled form data including company, primary contact info,
 * addresses, and assigned owner.
 *
 * HTTP method: POST /clients
 * Expected req.body (validatedBody) fields:
 *   - company: string — client/company name (required)
 *   - displayName: string (optional)
 *   - industry: string (optional)
 *   - website: string (optional)
 *   - description: string (optional)
 *   - taxId: string (optional)
 *   - owner: string (optional) — ObjectId of assigned user
 *   - source: string (optional) — lead source e.g. "Website", "Referral"
 *   - contacts: Array<Contact> (optional) — initial contact persons
 *   - addresses: Array<Address> (optional)
 *   - customFields: object (optional) — key-value custom fields
 *
 * Response JSON shape on success (201 Created):
 *   { success: true, data: Client, message: 'Client created' }
 * Response JSON shape on validation failure (400):
 *   { success: false, error: 'Validation failed', details: string[], code?: any }
 * Status codes: 201 Created, 400 Bad Request, 500 Internal Server Error
 */
async function create(req, res) {
  try {
    const client = await ClientService.create(req, req.validatedBody);
    res.status(201).json({ success: true, data: client, message: 'Client created' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: User opens the Client Detail page, edits fields in the overview section (company name,
 * industry, owner, etc.) or edits address/contact via sub-modals, and clicks Save. Frontend PATCHes the changed
 * fields — the update is partial so only provided keys are overwritten on the record.
 *
 * HTTP method: PUT /clients/:id  (or PATCH — handler accepts partial updates)
 * Expected req.params fields:
 *   - id: string — MongoDB ObjectId of the client
 * Expected req.body (validatedBody) fields: Any subset of Client fields (company, displayName, industry,
 *   website, description, taxId, owner, source, contacts, addresses, customFields, etc.)
 *
 * Response JSON shape on success (200 OK):
 *   { success: true, data: Client, message: 'Client updated' }
 * Response JSON shape on invalid ID (400): { success: false, error: 'Invalid ID', details: [] }
 * Response JSON shape on not found (404): { success: false, error: 'Client not found', details: [] }
 * Status codes: 200 OK, 400 Bad Request, 404 Not Found, 500 Internal Server Error
 */
async function update(req, res) {
  try {
    const client = await ClientService.update(req, req.params.id, req.validatedBody);
    res.json({ success: true, data: client, message: 'Client updated' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: Admin or owner performs a cleanup action and deletes a client from the Client Detail
 * page (via the 3-dot menu → Delete) or bulk-selects in the list. Service layer validates no linked invoices /
 * quotations / projects exist or cascades per configuration, then returns confirmation.
 *
 * HTTP method: DELETE /clients/:id
 * Expected req.params fields:
 *   - id: string — MongoDB ObjectId of the client
 *
 * Response JSON shape on success (200 OK):
 *   { success: true, data: { deleted: boolean, id: string }, message: 'Client deleted' }
 * Response JSON shape on invalid ID (400): { success: false, error: 'Invalid ID', details: [] }
 * Response JSON shape on not found (404): { success: false, error: 'Client not found', details: [] }
 * Response JSON shape on linked records (409):
 *   { success: false, error: 'Cannot delete client with linked invoices/projects', details: string[] }
 * Status codes: 200 OK, 400 Bad Request, 404 Not Found, 409 Conflict, 500 Internal Server Error
 */
async function remove(req, res) {
  try {
    const result = await ClientService.remove(req, req.params.id);
    res.json({ success: true, data: result, message: 'Client deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: User opens the "Contacts" tab on the Client Detail page. Frontend calls this endpoint
 * via CrmApi.clients.listContacts(clientId) to fetch all contact persons stored for that client for the
 * contacts sub-table.
 *
 * HTTP method: GET /clients/:id/contacts
 * Expected req.params fields:
 *   - id: string — MongoDB ObjectId of the client
 *
 * Response JSON shape on success (200 OK):
 *   {
 *     success: true,
 *     data: Array<Contact>,              // { _id, firstName, lastName, email, phone, position, isPrimary, ... }
 *     message: 'Contacts loaded'
 *   }
 * Response JSON shape on not found (404): { success: false, error: 'Client not found', details: [] }
 * Status codes: 200 OK, 400 Bad Request, 404 Not Found, 500 Internal Server Error
 */
async function listContacts(req, res) {
  try {
    const contacts = await ClientService.listContacts(req, req.params.id);
    res.json({ success: true, data: contacts, message: 'Contacts loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: User clicks "Add Contact" on the Client Detail → Contacts tab, fills the contact
 * form (name, email, phone, position, marks isPrimary), and submits. The endpoint appends the new embedded
 * contact to the client document and returns the full contact with generated _id.
 *
 * HTTP method: POST /clients/:id/contacts
 * Expected req.params fields:
 *   - id: string — MongoDB ObjectId of the client
 * Expected req.body (validatedBody) fields:
 *   - firstName: string (required)
 *   - lastName: string (optional)
 *   - email: string (optional)
 *   - phone: string (optional)
 *   - position: string (optional) — job title
 *   - isPrimary: boolean (optional, default false)
 *   - notes: string (optional)
 *
 * Response JSON shape on success (201 Created):
 *   { success: true, data: Contact, message: 'Contact created' }
 * Response JSON shape on validation failure (400): { success: false, error: string, details: string[] }
 * Status codes: 201 Created, 400 Bad Request, 404 Not Found, 500 Internal Server Error
 */
async function addContact(req, res) {
  try {
    const contact = await ClientService.addContact(req, req.params.id, req.validatedBody);
    res.status(201).json({ success: true, data: contact, message: 'Contact created' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: User clicks the edit pencil on a contact row in the Client Detail → Contacts tab,
 * updates email/phone/name in the modal, and saves. The endpoint updates the embedded contact sub-document
 * matched by contactId and returns the modified contact.
 *
 * HTTP method: PUT /clients/:id/contacts/:contactId
 * Expected req.params fields:
 *   - id: string — MongoDB ObjectId of the client
 *   - contactId: string — _id of the embedded contact sub-document
 * Expected req.body (validatedBody) fields: Any subset of Contact fields (firstName, lastName, email, phone, position, isPrimary, notes)
 *
 * Response JSON shape on success (200 OK):
 *   { success: true, data: Contact, message: 'Contact updated' }
 * Response JSON shape on not found (404): { success: false, error: 'Contact not found', details: [] }
 * Status codes: 200 OK, 400 Bad Request, 404 Not Found, 500 Internal Server Error
 */
async function updateContact(req, res) {
  try {
    const contact = await ClientService.updateContact(
      req,
      req.params.id,
      req.params.contactId,
      req.validatedBody
    );
    res.json({ success: true, data: contact, message: 'Contact updated' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: User clicks the delete icon on a contact row in the Client Detail → Contacts tab
 * and confirms the deletion dialog. The endpoint removes the embedded contact by contactId.
 *
 * HTTP method: DELETE /clients/:id/contacts/:contactId
 * Expected req.params fields:
 *   - id: string — MongoDB ObjectId of the client
 *   - contactId: string — _id of the embedded contact to remove
 *
 * Response JSON shape on success (200 OK):
 *   { success: true, data: { deleted: true, id: string }, message: 'Contact deleted' }
 * Response JSON shape on not found (404): { success: false, error: 'Contact not found', details: [] }
 * Status codes: 200 OK, 400 Bad Request, 404 Not Found, 500 Internal Server Error
 */
async function removeContact(req, res) {
  try {
    const result = await ClientService.removeContact(
      req,
      req.params.id,
      req.params.contactId
    );
    res.json({ success: true, data: result, message: 'Contact deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: User opens the "Quotations" tab on the Client Detail page to see all proposals/sales
 * quotes sent to this client. Frontend calls this endpoint to list the quotations with their status (draft,
 * sent, accepted, rejected) and totals. Validates the client exists first.
 *
 * HTTP method: GET /clients/:id/quotations
 * Expected req.params fields:
 *   - id: string — MongoDB ObjectId of the client
 *
 * Response JSON shape on success (200 OK):
 *   {
 *     success: true,
 *     data: Array<QuotationSummary>,     // { _id, number, title, total, status, issueDate, expiryDate }
 *     message: 'Quotations loaded' | 'No quotations yet — module coming in Step 6'
 *   }
 * Response JSON shape on not found (404): { success: false, error: 'Client not found', details: [] }
 * Status codes: 200 OK, 400 Bad Request, 404 Not Found, 500 Internal Server Error
 */
async function listQuotations(req, res) {
  try {
    await ClientService.getById(req, req.params.id, { includeQuality: false });
    const data = await ClientService.listQuotationsForClient(req, req.params.id);
    res.json({
      success: true,
      data,
      message: data.length ? 'Quotations loaded' : 'No quotations yet — module coming in Step 6'
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: User opens the "Invoices" tab on the Client Detail page to review all invoices raised
 * against this client (paid, unpaid, overdue, cancelled). Frontend calls this endpoint after confirming the
 * client exists via a lightweight getById check.
 *
 * HTTP method: GET /clients/:id/invoices
 * Expected req.params fields:
 *   - id: string — MongoDB ObjectId of the client
 *
 * Response JSON shape on success (200 OK):
 *   {
 *     success: true,
 *     data: Array<InvoiceSummary>,       // { _id, number, total, status, issueDate, dueDate, paidAmount }
 *     message: 'Invoices loaded' | 'No invoices for this client yet'
 *   }
 * Response JSON shape on not found (404): { success: false, error: 'Client not found', details: [] }
 * Status codes: 200 OK, 400 Bad Request, 404 Not Found, 500 Internal Server Error
 */
async function listInvoices(req, res) {
  try {
    await ClientService.getById(req, req.params.id, { includeQuality: false });
    const data = await ClientService.listInvoicesForClient(req, req.params.id);
    res.json({
      success: true,
      data,
      message: data.length ? 'Invoices loaded' : 'No invoices for this client yet'
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: User opens the "Payments" tab on the Client Detail page to see the payment history
 * for this client — which invoices were paid, when, via which method, and by which reference. Useful for
 * accounts receivable reconciliation.
 *
 * HTTP method: GET /clients/:id/payments
 * Expected req.params fields:
 *   - id: string — MongoDB ObjectId of the client
 *
 * Response JSON shape on success (200 OK):
 *   {
 *     success: true,
 *     data: Array<PaymentSummary>,       // { _id, number, amount, method, date, invoiceNumber }
 *     message: 'Payments loaded' | 'No payments for this client yet'
 *   }
 * Response JSON shape on not found (404): { success: false, error: 'Client not found', details: [] }
 * Status codes: 200 OK, 400 Bad Request, 404 Not Found, 500 Internal Server Error
 */
async function listPayments(req, res) {
  try {
    await ClientService.getById(req, req.params.id, { includeQuality: false });
    const data = await ClientService.listPaymentsForClient(req, req.params.id);
    res.json({
      success: true,
      data,
      message: data.length ? 'Payments loaded' : 'No payments for this client yet'
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: User opens the "Projects" tab on the Client Detail page. This endpoint is called to
 * load all delivery projects linked to the client (with their status, budget, assigned members). Used by
 * account managers to see active work for the client. Lazy-loads ProjectService to avoid circular deps.
 *
 * HTTP method: GET /clients/:id/projects
 * Expected req.params fields:
 *   - id: string — MongoDB ObjectId of the client
 * Expected req.query fields:
 *   - page: number (optional, default 1)
 *   - pageSize: number (optional, default 25)
 *   - status: string (optional) — project status filter
 *
 * Response JSON shape on success (200 OK):
 *   {
 *     success: true,
 *     data: Array<Project>,
 *     pagination: { page, pageSize, total, totalPages },
 *     message: 'Projects loaded' | 'No projects for this client yet'
 *   }
 * Response JSON shape on not found (404): { success: false, error: 'Client not found', details: [] }
 * Status codes: 200 OK, 400 Bad Request, 404 Not Found, 500 Internal Server Error
 */
async function listProjects(req, res) {
  try {
    await ClientService.getById(req, req.params.id, { includeQuality: false });
    const ProjectService = require('../services/project.service');
    const result = await ProjectService.listByClient(req, req.params.id);
    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      message: result.items.length ? 'Projects loaded' : 'No projects for this client yet'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function listTasks(req, res) {
  try {
    await ClientService.getById(req, req.params.id, { includeQuality: false });
    const data = await ClientService.listTasksForClient(req, req.params.id);
    res.json({
      success: true,
      data,
      message: data.length ? 'Tasks loaded' : 'No tasks for this client yet'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function listTimeLogs(req, res) {
  try {
    await ClientService.getById(req, req.params.id, { includeQuality: false });
    const data = await ClientService.listTimeLogsForClient(req, req.params.id);
    res.json({
      success: true,
      data,
      message: data.length ? 'Time logs loaded' : 'No time logs for this client yet'
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: Top of the Clients list page shows KPI chips: "Total Clients", "New this month",
 * "Clients by industry", "Clients by owner". Frontend calls this lightweight summary endpoint once on page
 * load to render those stat chips without loading the full paginated list.
 *
 * HTTP method: GET /clients/summary (or GET /clients/summary/list)
 * Expected req.query fields:
 *   - owner: string (optional) — owner filter to scope summary stats
 *   - industry: string (optional) — industry filter
 *
 * Response JSON shape on success (200 OK):
 *   {
 *     success: true,
 *     data: {
 *       total: number,
 *       newThisMonth: number,
 *       byIndustry: Array<{ industry, count }>,
 *       byOwner: Array<{ ownerId, ownerName, count }>,
 *       byQualityScore?: { excellent: number, good: number, needsWork: number }
 *     },
 *     message: 'Client list summary loaded'
 *   }
 * Response JSON shape on failure: { success: false, error: string, details: string[] }
 * Status codes: 200 OK, 500 Internal Server Error
 */
async function listSummary(req, res) {
  try {
    const data = await ClientService.getListSummary(req);
    res.json({ success: true, data, message: 'Client list summary loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * CRM BUSINESS USE CASE: Client Detail page header / "Overview" tab shows financial & engagement summary for
 * a single client: total revenue (paid invoices), outstanding (unpaid invoices), open quotations count,
 * active projects count, last activity date. Frontend calls this once when the detail page mounts.
 *
 * HTTP method: GET /clients/:id/summary
 * Expected req.params fields:
 *   - id: string — MongoDB ObjectId of the client
 *
 * Response JSON shape on success (200 OK):
 *   {
 *     success: true,
 *     data: {
 *       totalRevenue: number,
 *       outstandingAmount: number,
 *       openQuotations: number,
 *       activeProjects: number,
 *       invoicesPaid: number,
 *       invoicesUnpaid: number,
 *       lastActivityAt: ISODate | null
 *     },
 *     message: 'Client summary loaded'
 *   }
 * Response JSON shape on not found (404): { success: false, error: 'Client not found', details: [] }
 * Status codes: 200 OK, 400 Bad Request, 404 Not Found, 500 Internal Server Error
 */
async function summary(req, res) {
  try {
    const data = await ClientService.getSummary(req, req.params.id);
    res.json({ success: true, data, message: 'Client summary loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listCategories(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const data = await SettingService.getClientCategories(req);
    res.json({ success: true, data, message: 'Client categories loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addCategory(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const category = req.body?.category || req.body?.name;
    const data = await SettingService.addClientCategory(req, category);
    res.status(201).json({ success: true, data, message: 'Category added' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listStatuses(req, res) {
  try {
    res.json({ success: true, data: ['Active', 'Inactive'], message: 'Client statuses loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listTags(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const data = await SettingService.getClientTags(req);
    res.json({ success: true, data, message: 'Client tags loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addTag(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const name = req.body?.name || req.body?.tag;
    const data = await SettingService.addClientTag(req, name);
    res.status(201).json({ success: true, data, message: 'Tag added' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listCustomFields(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const data = await SettingService.getClientCustomFields(req);
    res.json({ success: true, data, message: 'Client custom fields loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addCustomField(req, res) {
  try {
    const SettingService = require('../services/setting.service');
    const data = await SettingService.addClientCustomField(req, req.body);
    res.status(201).json({ success: true, data, message: 'Custom field added' });
  } catch (error) {
    sendError(res, error);
  }
}

async function importPreview(req, res) {
  try {
    const result = await ClientService.previewImport(req, req.validatedBody);
    res.json({ success: true, data: result, message: 'Client import preview generated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function importExecute(req, res) {
  try {
    const result = await ClientService.executeImport(req, req.validatedBody);
    res.json({ success: true, data: result, message: `Client import completed: ${result.createdCount} clients created` });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportClients(req, res) {
  try {
    const result = await ClientService.exportClients(req, req.query || {});
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

async function listAddresses(req, res) {
  try {
    const items = await ClientService.listAddresses(req, req.params.id);
    res.json({ success: true, data: items, message: 'Client addresses loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function addAddress(req, res) {
  try {
    const item = await ClientService.addAddress(req, req.params.id, req.body);
    res.status(201).json({ success: true, data: item, message: 'Address added' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateAddress(req, res) {
  try {
    const item = await ClientService.updateAddress(
      req,
      req.params.id,
      req.params.addressId,
      req.body
    );
    res.json({ success: true, data: item, message: 'Address updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function deleteAddress(req, res) {
  try {
    const result = await ClientService.deleteAddress(
      req,
      req.params.id,
      req.params.addressId
    );
    res.json({ success: true, data: result, message: 'Address deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function setDefaultAddress(req, res) {
  try {
    const item = await ClientService.setDefaultAddress(
      req,
      req.params.id,
      req.params.addressId,
      req.body?.type
    );
    res.json({ success: true, data: item, message: 'Default address updated' });
  } catch (error) {
    sendError(res, error);
  }
}

// ---------------------------------------------------------------------------
// Client Notes Controller Endpoints
// ---------------------------------------------------------------------------

const ClientNoteService = require('../services/client-note.service');
const ClientTimelineService = require('../services/client-timeline.service');

async function listNotes(req, res) {
  try {
    const items = await ClientNoteService.listByClient(req, req.params.id);
    res.json({ success: true, data: items });
  } catch (error) {
    sendError(res, error);
  }
}

async function createNote(req, res) {
  try {
    const item = await ClientNoteService.create(req, req.params.id, req.validatedBody || req.body);
    res.status(201).json({ success: true, data: item, message: 'Note created successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateNote(req, res) {
  try {
    const item = await ClientNoteService.update(req, req.params.id, req.params.noteId, req.validatedBody || req.body);
    res.json({ success: true, data: item, message: 'Note updated successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function togglePinNote(req, res) {
  try {
    const item = await ClientNoteService.togglePin(req, req.params.id, req.params.noteId);
    res.json({ success: true, data: item, message: `Note ${item.isPinned ? 'pinned' : 'unpinned'}` });
  } catch (error) {
    sendError(res, error);
  }
}

async function deleteNote(req, res) {
  try {
    const result = await ClientNoteService.remove(req, req.params.id, req.params.noteId);
    res.json({ success: true, data: result, message: 'Note deleted successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

// ---------------------------------------------------------------------------
// Client Events & Activity Timeline Controller Endpoints
// ---------------------------------------------------------------------------

async function listEvents(req, res) {
  try {
    const items = await ClientTimelineService.listEvents(req, req.params.id);
    res.json({ success: true, data: items });
  } catch (error) {
    sendError(res, error);
  }
}

async function createEvent(req, res) {
  try {
    const item = await ClientTimelineService.createEvent(req, req.params.id, req.validatedBody || req.body);
    res.status(201).json({ success: true, data: item, message: 'Activity logged successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateEvent(req, res) {
  try {
    const item = await ClientTimelineService.updateEvent(req, req.params.id, req.params.eventId, req.validatedBody || req.body);
    res.json({ success: true, data: item, message: 'Activity updated successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function completeEvent(req, res) {
  try {
    const item = await ClientTimelineService.completeEvent(req, req.params.id, req.params.eventId);
    res.json({ success: true, data: item, message: 'Activity completed' });
  } catch (error) {
    sendError(res, error);
  }
}

async function deleteEvent(req, res) {
  try {
    const result = await ClientTimelineService.removeEvent(req, req.params.id, req.params.eventId);
    res.json({ success: true, data: result, message: 'Activity deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function getTimeline(req, res) {
  try {
    const timeline = await ClientTimelineService.getAccountTimeline(req, req.params.id, req.query);
    res.json({ success: true, data: timeline });
  } catch (error) {
    sendError(res, error);
  }
}

async function listContracts(req, res) {
  try {
    const items = await ClientService.listContractsForClient(req, req.params.id);
    res.json({ success: true, data: items });
  } catch (error) {
    sendError(res, error);
  }
}

async function listProducts(req, res) {
  try {
    const data = await ClientService.listProductsForClient(req, req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Client Document & Attachment Management
 */
async function listDocuments(req, res) {
  try {
    const ClientAttachmentService = require('../services/client-attachment.service');
    const category = req.query?.category ? String(req.query.category) : '';
    const data = await ClientAttachmentService.listAttachments(req, req.params.id, category);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

async function uploadDocument(req, res) {
  try {
    const ClientAttachmentService = require('../services/client-attachment.service');
    const data = await ClientAttachmentService.uploadAttachment(req, req.params.id);
    res.status(201).json({ success: true, data, message: 'Document uploaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function createDocument(req, res) {
  try {
    const ClientAttachmentService = require('../services/client-attachment.service');
    const data = await ClientAttachmentService.createRecord(req, req.params.id, req.body);
    res.status(201).json({ success: true, data, message: 'Document created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function deleteDocument(req, res) {
  try {
    const ClientAttachmentService = require('../services/client-attachment.service');
    const data = await ClientAttachmentService.removeAttachment(req, req.params.id, req.params.docId);
    res.json({ success: true, data, message: 'Document deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function downloadDocument(req, res) {
  try {
    const ClientAttachmentService = require('../services/client-attachment.service');
    const result = await ClientAttachmentService.downloadAttachment(
      req,
      req.params.id,
      req.params.docId
    );

    if (result.redirectUrl) {
      res.redirect(302, result.redirectUrl);
      return;
    }

    const safeName = String(result.fileName || 'document').replace(/["\\\r\n]/g, '_');
    res.setHeader('Content-Type', result.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(result.buffer);
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Client Portal Access Management
 */
async function listPortalAccess(req, res) {
  try {
    const ClientPortalService = require('../services/client-portal.service');
    const data = await ClientPortalService.listPortalAccess(req, req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
}

async function invitePortalContact(req, res) {
  try {
    const ClientPortalService = require('../services/client-portal.service');
    const data = await ClientPortalService.inviteContact(req, req.params.id, req.body);
    res.status(201).json({ success: true, data, message: 'Portal invitation sent' });
  } catch (error) {
    sendError(res, error);
  }
}

async function resendPortalInvitation(req, res) {
  try {
    const ClientPortalService = require('../services/client-portal.service');
    const data = await ClientPortalService.resendInvitation(req, req.params.id, req.params.accessId);
    res.json({ success: true, data, message: 'Portal invitation resent' });
  } catch (error) {
    sendError(res, error);
  }
}

async function activatePortalUser(req, res) {
  try {
    const ClientPortalService = require('../services/client-portal.service');
    const data = await ClientPortalService.activatePortalAccess(req, req.params.id, req.params.accessId);
    res.json({ success: true, data, message: 'Portal access activated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function suspendPortalUser(req, res) {
  try {
    const ClientPortalService = require('../services/client-portal.service');
    const data = await ClientPortalService.suspendPortalAccess(req, req.params.id, req.params.accessId, req.body?.reason);
    res.json({ success: true, data, message: 'Portal access suspended' });
  } catch (error) {
    sendError(res, error);
  }
}

async function reinstatePortalUser(req, res) {
  try {
    const ClientPortalService = require('../services/client-portal.service');
    const data = await ClientPortalService.reinstatePortalAccess(req, req.params.id, req.params.accessId);
    res.json({ success: true, data, message: 'Portal access reinstated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updatePortalPermissions(req, res) {
  try {
    const ClientPortalService = require('../services/client-portal.service');
    const data = await ClientPortalService.updatePermissions(req, req.params.id, req.params.accessId, req.body);
    res.json({ success: true, data, message: 'Portal permissions updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function revokePortalAccess(req, res) {
  try {
    const ClientPortalService = require('../services/client-portal.service');
    const data = await ClientPortalService.revokePortalAccess(req, req.params.id, req.params.accessId);
    res.json({ success: true, data, message: 'Portal access revoked' });
  } catch (error) {
    sendError(res, error);
  }
}

async function approvePortalUser(req, res) {
  try {
    const ClientPortalService = require('../services/client-portal.service');
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

async function rejectPortalUser(req, res) {
  try {
    const ClientPortalService = require('../services/client-portal.service');
    const data = await ClientPortalService.rejectPortalAccess(req, req.params.id, req.params.accessId, req.body);
    res.json({ success: true, data, message: 'Portal access request rejected' });
  } catch (error) {
    sendError(res, error);
  }
}

async function resubmitPortalUser(req, res) {
  try {
    const ClientPortalService = require('../services/client-portal.service');
    const data = await ClientPortalService.resubmitPortalAccess(req, req.params.id, req.params.accessId, req.body);
    res.json({ success: true, data, message: 'Portal access request resubmitted for manager approval' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listPendingPortalApprovals(req, res) {
  try {
    const ClientPortalService = require('../services/client-portal.service');
    const data = await ClientPortalService.listPendingApprovals(req);
    res.json({ success: true, data, message: 'Pending portal approvals retrieved' });
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
  remove,
  listContacts,
  addContact,
  updateContact,
  removeContact,
  listQuotations,
  listInvoices,
  listPayments,
  listProjects,
  listTasks,
  listTimeLogs,
  listContracts,
  listProducts,
  listDocuments,
  uploadDocument,
  createDocument,
  deleteDocument,
  downloadDocument,
  listPortalAccess,
  invitePortalContact,
  resendPortalInvitation,
  activatePortalUser,
  suspendPortalUser,
  reinstatePortalUser,
  updatePortalPermissions,
  revokePortalAccess,
  approvePortalUser,
  rejectPortalUser,
  resubmitPortalUser,
  listPendingPortalApprovals,
  listSummary,
  summary,
  listCategories,
  addCategory,
  listStatuses,
  listTags,
  addTag,
  listCustomFields,
  addCustomField,
  importPreview,
  importExecute,
  exportClients,
  listAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  listNotes,
  createNote,
  updateNote,
  togglePinNote,
  deleteNote,
  listEvents,
  createEvent,
  updateEvent,
  completeEvent,
  deleteEvent,
  getTimeline
};
