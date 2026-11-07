'use strict';

const SettingService = require('../services/setting.service');
const { snapshotOf } = require('./customer-snapshot.util');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  const { resolveTenantId } = require('./tenant.util');
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function getCompanyModel(req) {
  return req.cms?.models.get('Company');
}

function getLeadModel(req) {
  return req.cms?.models.get('Lead');
}

function getContactModel(req) {
  return req.cms?.models.get('Contact');
}

function formatClient(client) {
  if (!client) {
    return {
      name: '—',
      taxId: '',
      email: '',
      phone: '',
      billingAddress: {}
    };
  }

  return {
    name: client.name || '—',
    taxId: client.taxId || '',
    email: client.email || '',
    phone: client.phone || '',
    billingAddress: client.billingAddress || {}
  };
}

function formatLead(lead) {
  if (!lead) return formatClient(null);

  return {
    name: lead.company || lead.name || '—',
    taxId: '',
    email: lead.email || '',
    phone: lead.phone || '',
    billingAddress: lead.address ? { street: lead.address } : {}
  };
}

async function loadClient(req, clientId) {
  const Company = getCompanyModel(req);
  if (!Company) throw appError('Company model is not registered', 500);

  const client = await Company.findOne({
    ...baseFilter(req),
    mergedIntoId: null,
    _id: String(clientId)
  }).lean();

  if (!client) throw appError('Client not found', 404);
  return client;
}

async function loadLead(req, leadId) {
  const Lead = getLeadModel(req);
  if (!Lead) throw appError('Lead model is not registered', 500);

  const lead = await Lead.findOne({
    ...baseFilter(req),
    mergedIntoId: null,
    _id: String(leadId)
  }).lean();

  if (!lead) throw appError('Lead not found', 404);
  return lead;
}

async function loadPrimaryContactEmail(req, companyId) {
  const Contact = getContactModel(req);
  if (!Contact || !companyId) return '';

  const contact = await Contact.findOne({
    ...baseFilter(req),
    companyId: String(companyId),
    isPrimary: true
  }).lean();

  return contact?.email || '';
}

async function enrichClientForDocument(req, client) {
  const formatted = formatClient(client);
  if (!formatted.email && client?._id) {
    formatted.email = await loadPrimaryContactEmail(req, client._id);
  }
  return formatted;
}

async function loadCompanySettings(req) {
  const settings = await SettingService.getAll(req);
  return {
    name: settings.company_name || 'Root CRM',
    currency: settings.default_currency || 'INR'
  };
}

/**
 * "Bill To" as it was when the document was created (customerSnapshot, CRM 3.35.0): name, email and
 * phone from the snapshot; the address and tax id stay the master's. Documents without a snapshot
 * (before 3.35.0) print the current master unchanged. The current email is kept as the delivery address.
 */
function withSnapshotClient(client, doc) {
  const snap = snapshotOf(doc);
  if (!snap || !client) return { client, recipientEmail: client?.email || '' };
  return {
    client: {
      ...client,
      name: snap.name || client.name,
      email: snap.email || client.email,
      phone: snap.phone || client.phone
    },
    recipientEmail: client.email || snap.email || ''
  };
}

async function buildQuotationPayload(req, quotation) {
  const company = await loadCompanySettings(req);
  let client;

  if (quotation.clientId) {
    const rawClient = await loadClient(req, quotation.clientId);
    client = await enrichClientForDocument(req, rawClient);
  } else if (quotation.leadId) {
    const lead = await loadLead(req, quotation.leadId);
    client = formatLead(lead);
  } else {
    throw appError('Quotation has no client or lead assigned', 409);
  }

  // Unit and printable extension columns under each line ("Rooms × Nights · Availability: Held").
  // Lines follow the extension's declared group order (salesFlow.quotationLineGroups), when any.
  let document = quotation;
  try {
    const notes = await require('../services/sales-flow.service').printNotes(req, quotation.lineItems);
    if (notes.some(Boolean)) {
      document = { ...quotation, lineItems: (quotation.lineItems || []).map((line, i) => ({ ...line, printNote: notes[i] || '' })) };
    }
  } catch {
    /* print without the notes */
  }
  document = await withGroupOrder(req, document);

  const billed = withSnapshotClient(client, quotation);
  return {
    type: 'quotation',
    company,
    client: billed.client,
    recipientEmail: billed.recipientEmail,
    document
  };
}

/** Lines in the extension's declared group order; the same document when nothing changes. */
async function withGroupOrder(req, doc) {
  try {
    const lines = Array.isArray(doc && doc.lineItems) ? doc.lineItems : null;
    if (!lines) return doc;
    const ordered = await require('../services/sales-flow.service').orderLinesByGroup(req, lines);
    return ordered === lines ? doc : { ...doc, lineItems: ordered };
  } catch {
    return doc;
  }
}

/** Adds printNote ("Rooms × Nights · Availability: Held") to each line when the active extension declares columns. */
async function withPrintNotes(req, doc) {
  try {
    const notes = await require('../services/sales-flow.service').printNotes(req, doc.lineItems);
    if (!notes.some(Boolean)) return withGroupOrder(req, doc);
    return withGroupOrder(req, { ...doc, lineItems: (doc.lineItems || []).map((line, i) => ({ ...line, printNote: notes[i] || '' })) });
  } catch {
    return doc;
  }
}

async function buildInvoicePayload(req, invoice) {
  const company = await loadCompanySettings(req);
  const clientId = String(invoice.clientId || '').trim();

  let client;
  if (clientId) {
    try {
      const rawClient = await loadClient(req, clientId);
      client = await enrichClientForDocument(req, rawClient);
    } catch (error) {
      // Keep PDF export usable even if linked client record is missing/merged.
      console.warn(
        '[plugin:openext-crm-suite] invoice PDF client lookup failed:',
        error?.message || error
      );
      client = formatClient({
        name: invoice.clientName || invoice.customerLabel || 'Customer',
        email: invoice.customerEmail || invoice.clientEmail || '',
        phone: invoice.customerPhone || invoice.clientPhone || '',
        taxId: invoice.clientTaxId || '',
        billingAddress: {}
      });
    }
  } else {
    client = formatClient({
      name: invoice.clientName || invoice.customerLabel || 'Customer',
      email: invoice.customerEmail || invoice.clientEmail || '',
      phone: invoice.customerPhone || invoice.clientPhone || '',
      billingAddress: {}
    });
  }

  const billed = withSnapshotClient(client, invoice);
  return withServicePrint(req, invoice, {
    type: 'invoice',
    company,
    client: billed.client,
    recipientEmail: billed.recipientEmail,
    document: await withPrintNotes(req, invoice)
  });
}

/**
 * Service invoice PDF (active extension's salesFlow.invoicePrint): adds `servicePrint` — the print switches
 * and wording, the extension's summary, the company contact line, the quotation number and the money
 * from verified payments ({ total, paid, advancePaid, credit, balance, status }). Without the switch the
 * payload is returned unchanged (the standard invoice PDF).
 */
async function withServicePrint(req, invoice, payload) {
  let print = null;
  try {
    print = await require('../services/sales-flow.service').invoicePrintContext(req, invoice);
  } catch {
    print = null;
  }
  if (!print) return payload;
  const settings = await SettingService.getAll(req).catch(() => ({}));
  let payments = null;
  try {
    payments = await require('../services/proforma.service').invoicePaymentSummary(req, invoice);
  } catch {
    payments = null;
  }
  let quotationNo = '';
  try {
    const Estimate = req.cms?.models.get('Estimate');
    if (Estimate && invoice.quotationId) {
      const quotation = await Estimate.findOne({ ...baseFilter(req), _id: String(invoice.quotationId) }).select('quotationNo').lean();
      quotationNo = String((quotation && quotation.quotationNo) || '');
    }
  } catch {
    quotationNo = '';
  }
  return {
    ...payload,
    servicePrint: {
      ...print,
      company: { address: settings.company_address || '', phone: settings.company_phone || '', email: settings.company_email || '' },
      quotationNo,
      payments
    }
  };
}

module.exports = {
  buildQuotationPayload,
  buildInvoicePayload
};
