'use strict';

/**
 * CRM 3.46.0 — Lead create: the company typed for a NEW contact already exists as a Client.
 *
 * Nothing here links anything on its own. findClientsByCompany() only reports the existing Clients whose
 * company name matches, so the UI can ask the user. addSecondaryContact() runs only when the user chose
 * "Add as Secondary Contact" for one named Client:
 * - reuses that Client (no new Client, no new Lead);
 * - reuses the directory Contact when one is given or already linked; otherwise creates it once, with
 *   the normal Email / Mobile / PAN duplicate check;
 * - adds it to the Client as a Secondary contact (isPrimary false), so the Primary contact stays as it is;
 * - is tenant-scoped, needs write access to the Client, and is audited (no email / phone in the log).
 */

const { resolveTenantId } = require('../utils/tenant.util');
const { isValidEmail, isValidMobile, normalizeMobile } = require('../validation/common.util');
const { normalizeCompanyName } = require('../utils/lead-duplicate.util');
const { assertClientWriteAccess, assertClientReadAccess, hasPermission } = require('../utils/sales-access.util');
const ClientContactPolicy = require('../utils/client-contact-policy.util');
const AuditService = require('./audit.service');

const MAX_MATCHES = 5;
const OBJECT_ID = /^[a-f0-9]{24}$/i;

function appError(message, status = 400, code) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  if (code) error.code = code;
  return error;
}

function model(req, name) {
  return req?.cms?.models?.get?.(name) || null;
}

function leadModelGetter(req) {
  return model(req, 'Lead');
}

function lean(q) {
  return q && typeof q.lean === 'function' ? q.lean() : q;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function companyFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false, mergedIntoId: null };
}

async function allowed(check) {
  try {
    await check();
    return true;
  } catch {
    return false;
  }
}

/**
 * Existing Clients whose company name matches `company` (same normalised name: case, spacing, punctuation,
 * "&" / "and" and legal suffixes such as Pvt Ltd are ignored). At most 5, oldest first.
 * @returns {Promise<Array<{ id: string, name: string, canOpen: boolean, canAddContact: boolean, primaryContactName: string }>>}
 */
async function findClientsByCompany(req, company) {
  const raw = String(company || '').trim().slice(0, 120);
  const key = normalizeCompanyName(raw);
  const Company = model(req, 'Company');
  if (!Company || key.length < 2) return [];

  const firstWord = key.split(' ')[0];
  const query = Company.find({
    ...companyFilter(req),
    $or: [
      { companyKey: key },
      // Older clients saved before companyKey existed.
      { companyTokens: firstWord },
      { name: new RegExp(`^${escapeRegex(raw)}$`, 'i') }
    ]
  });
  const sorted = query && typeof query.sort === 'function' ? query.sort({ createdAt: 1 }) : query;
  const limited = sorted && typeof sorted.limit === 'function' ? sorted.limit(50) : sorted;
  const rows = (await lean(limited)) || [];

  const canWriteClients = hasPermission(req, 'crm.clients.write');
  const out = [];
  for (const row of rows) {
    if (out.length >= MAX_MATCHES) break;
    if (normalizeCompanyName(row.name) !== key) continue;
    const canOpen = await allowed(() => assertClientReadAccess(req, row, leadModelGetter));
    const canAddContact = canOpen && canWriteClients && (await allowed(() => assertClientWriteAccess(req, row, leadModelGetter)));
    let primaryContactName = '';
    if (canOpen) {
      const linked = await ClientContactPolicy.linkedContact(req, row._id);
      primaryContactName = linked ? String(linked.name || '') : '';
    }
    out.push({ id: String(row._id), name: String(row.name || ''), canOpen, canAddContact, primaryContactName });
  }
  return out;
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

/** The client's row for this person: linked by personContactId, else the same email / mobile (older rows). */
async function existingRow(req, clientId, person) {
  const Contact = model(req, 'Contact');
  if (!Contact) return null;
  const rows = (await lean(Contact.find({ tenantId: resolveTenantId(req), companyId: String(clientId), isDeleted: false }))) || [];
  const personId = String(person._id || '');
  const byLink = rows.find((r) => r.personContactId && String(r.personContactId) === personId);
  if (byLink) return byLink;
  const email = String(person.email || '').trim().toLowerCase();
  const phone = digits(person.phone).slice(-10);
  return (
    rows.find((r) => {
      if (email && String(r.email || '').trim().toLowerCase() === email) return true;
      return phone.length >= 7 && digits(r.phone).slice(-10) === phone;
    }) || null
  );
}

/**
 * "Add as Secondary Contact": adds the lead form's new contact (or `personContactId`) to an existing Client.
 * @param {object} input - { personContactId? } or the contact fields { salutation, name, email, phone, gender,
 *   pan, jobTitle, companyName, photoUrl }, plus allowDuplicate (the user already chose to keep a duplicate).
 * @returns {Promise<{ client: { id: string, name: string }, contact: object, personContactId: string, alreadyLinked: boolean }>}
 */
async function addSecondaryContact(req, clientId, input = {}) {
  const id = String(clientId || '').trim();
  if (!OBJECT_ID.test(id)) throw appError('Client not found', 404);
  const Company = model(req, 'Company');
  if (!Company) throw new Error('Company model is not registered');
  const client = await lean(Company.findOne({ ...companyFilter(req), _id: id }));
  if (!client) throw appError('Client not found', 404);
  await assertClientReadAccess(req, client, leadModelGetter);
  await assertClientWriteAccess(req, client, leadModelGetter);

  const PersonContactService = require('./person-contact.service');
  const ClientService = require('./client.service');
  const source = input && typeof input === 'object' ? input : {};
  const personContactId = String(source.personContactId || '').trim();

  let person;
  let personCreated = false;
  if (personContactId) {
    if (!OBJECT_ID.test(personContactId)) throw appError('Contact not found', 404);
    person = await PersonContactService.getById(req, personContactId);
  } else {
    const name = String(source.name || '').trim();
    if (!name) throw appError('Contact name is required');
    const email = String(source.email || '').trim().toLowerCase();
    const phone = normalizeMobile(source.phone);
    if (email && !isValidEmail(email)) throw appError('Email is invalid');
    if (phone && !isValidMobile(phone)) throw appError('Mobile number is invalid');
    if (!email && !phone) throw appError('Enter an email or a mobile number for the contact');
    if (!hasPermission(req, 'crm.contacts.write') && !hasPermission(req, 'crm.leads.write')) {
      throw appError('You do not have permission to create contacts', 403);
    }
    // Checked before the directory contact is made, so a refused add leaves nothing behind.
    await ClientContactPolicy.assertCanAddContact(req, id);
    person = await PersonContactService.create(req, {
      salutation: source.salutation,
      name,
      email,
      phone,
      gender: source.gender,
      pan: source.pan,
      jobTitle: source.jobTitle,
      photoUrl: source.photoUrl,
      companyName: String(source.companyName || '').trim() || client.name,
      allowDuplicate: source.allowDuplicate === true
    });
    personCreated = true;
  }

  const clientRef = { id, name: String(client.name || '') };
  const existing = await existingRow(req, id, person);
  if (existing) {
    if (!existing.personContactId) {
      await ClientService.updateContact(req, id, String(existing._id), { personContactId: String(person._id) });
    }
    return { client: clientRef, contact: { ...existing, personContactId: String(person._id) }, personContactId: String(person._id), alreadyLinked: true };
  }

  const contact = await ClientService.addContact(req, id, {
    name: String(person.name || '').trim(),
    email: String(person.email || '').trim().toLowerCase(),
    phone: normalizeMobile(person.phone) || '',
    designation: String(person.jobTitle || '').trim(),
    personContactId: String(person._id),
    isPrimary: false
  });

  await AuditService.log(req, {
    action: 'updated',
    module: 'client',
    recordId: id,
    description: `${contact.isPrimary ? 'Primary' : 'Secondary'} contact added from Lead create: ${contact.name}`,
    metadata: {
      contactId: String(contact._id),
      personContactId: String(person._id),
      personContactCreated: personCreated,
      source: 'lead_create_company_match'
    }
  });

  return { client: clientRef, contact, personContactId: String(person._id), alreadyLinked: false };
}

module.exports = {
  MAX_MATCHES,
  findClientsByCompany,
  addSecondaryContact
};
