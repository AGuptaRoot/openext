'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const AuditService = require('./audit.service');

function getModel(req) {
  const PersonContact = req.cms?.models.get('PersonContact');
  if (!PersonContact) throw new Error('PersonContact model is not registered');
  return PersonContact;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '').trim();
}

function normalizePan(pan) {
  return String(pan || '').trim().toUpperCase();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function serialize(doc) {
  if (!doc) return null;
  const item = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  item.leadsCount = Array.isArray(item.leadIds) ? item.leadIds.length : Number(item.leadsCount) || 0;
  item.clientsCount = Array.isArray(item.clientIds)
    ? item.clientIds.length
    : Number(item.clientsCount) || 0;
  item.companyName = item.companyName || '';
  item.IsportalAssigned = item.IsportalAssigned === true;
  return item;
}

/** Build likely stored phone variants so +91 / spacing differences still match. */
function phoneMatchVariants(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];
  const digits = normalized.replace(/\D/g, '');
  const variants = new Set([normalized]);
  if (digits) variants.add(digits);
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    variants.add(last10);
    variants.add(`+91${last10}`);
    variants.add(`91${last10}`);
    variants.add(`0${last10}`);
  }
  return [...variants].filter(Boolean);
}

async function findDuplicates(req, { email, phone, pan, excludeId } = {}) {
  const PersonContact = getModel(req);
  const filter = { ...baseFilter(req), $or: [] };
  const e = normalizeEmail(email);
  const panN = normalizePan(pan);
  if (e) filter.$or.push({ email: e });
  for (const variant of phoneMatchVariants(phone)) {
    filter.$or.push({ phone: variant });
  }
  if (panN) filter.$or.push({ pan: panN });
  if (!filter.$or.length) return [];
  if (excludeId) filter._id = { $ne: excludeId };
  const items = await PersonContact.find(filter).limit(20).lean();
  return items.map(serialize);
}

async function list(req) {
  const PersonContact = getModel(req);
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { ...baseFilter(req) };
  const search = toLiteralSearchTerm(req.query.search || req.query.q);
  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: re }, { email: re }, { phone: re }, { pan: re }, { jobTitle: re }];
  }

  const leadId = String(req.query.leadId || '').trim();
  const clientId = String(req.query.clientId || '').trim();

  // Scope to lead / client related contacts only (used by Opportunity create).
  if (leadId || clientId) {
    const relatedLeadIds = new Set();
    if (leadId) relatedLeadIds.add(leadId);

    if (clientId) {
      const Lead = req.cms?.models.get('Lead');
      if (Lead) {
        const linkedLeads = await Lead.find({
          tenantId: resolveTenantId(req),
          isDeleted: { $ne: true },
          convertedClientId: clientId
        })
          .select('_id')
          .lean();
        linkedLeads.forEach((l) => relatedLeadIds.add(String(l._id)));
      }
    }

    const scopeClauses = [];
    if (relatedLeadIds.size) {
      scopeClauses.push({ leadIds: { $in: [...relatedLeadIds] } });
    }
    if (clientId) {
      // Direct client ↔ person-contact links from the client Contacts tab.
      scopeClauses.push({ clientIds: clientId });
    }
    if (leadId) {
      // Include the primary PersonContact pointed by the lead even if leadIds is stale.
      const Lead = req.cms?.models.get('Lead');
      if (Lead) {
        const lead = await Lead.findOne({
          tenantId: resolveTenantId(req),
          _id: leadId,
          isDeleted: { $ne: true }
        })
          .select('contactId')
          .lean();
        if (lead?.contactId) {
          scopeClauses.push({ _id: String(lead.contactId) });
        }
      }
    }

    if (!scopeClauses.length) {
      return {
        data: [],
        meta: { page, limit, total: 0, totalPages: 1 }
      };
    }

    filter.$and = [...(filter.$and || []), { $or: scopeClauses }];
  }

  const [items, total] = await Promise.all([
    PersonContact.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    PersonContact.countDocuments(filter)
  ]);
  const withClients = await attachClientLinksForList(req, items);
  return {
    data: withClients.map(serialize),
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }
  };
}

/** Merge clientIds from company Contact rows for a page of person contacts. */
async function attachClientLinksForList(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];
  const Contact = req.cms?.models.get('Contact');
  if (!Contact) return items;

  const ids = items.map((item) => String(item._id));
  const rows = await Contact.find({
    tenantId: resolveTenantId(req),
    isDeleted: false,
    personContactId: { $in: ids }
  })
    .select('companyId personContactId')
    .lean();

  const byPerson = new Map();
  for (const row of rows) {
    const personId = String(row.personContactId || '');
    const companyId = String(row.companyId || '').trim();
    if (!personId || !companyId) continue;
    if (!byPerson.has(personId)) byPerson.set(personId, new Set());
    byPerson.get(personId).add(companyId);
  }

  return items.map((item) => {
    const fromRows = byPerson.get(String(item._id)) || new Set();
    const existing = Array.isArray(item.clientIds) ? item.clientIds.map(String).filter(Boolean) : [];
    const merged = [...new Set([...existing, ...fromRows])];
    return { ...item, clientIds: merged, clientsCount: merged.length };
  });
}

/**
 * Ensure PersonContact.clientIds includes every client company contact row
 * that references this person (keeps Contact detail “Linked Clients” accurate).
 */
async function syncClientIdsFromCompanyContacts(req, doc) {
  if (!doc?._id) return doc;
  const Contact = req.cms?.models.get('Contact');
  if (!Contact) return doc;

  const personId = String(doc._id);
  const rows = await Contact.find({
    tenantId: resolveTenantId(req),
    isDeleted: false,
    personContactId: personId
  })
    .select('companyId')
    .lean();

  const fromRows = [
    ...new Set(rows.map((r) => String(r.companyId || '').trim()).filter(Boolean))
  ];
  const existing = Array.isArray(doc.clientIds)
    ? doc.clientIds.map((id) => String(id)).filter(Boolean)
    : [];
  const merged = [...new Set([...existing, ...fromRows])];
  if (merged.length === existing.length && merged.every((id) => existing.includes(id))) {
    return { ...doc, clientIds: existing, clientsCount: existing.length };
  }

  const PersonContact = getModel(req);
  await PersonContact.updateOne(
    { _id: doc._id },
    { $set: { clientIds: merged, clientsCount: merged.length } }
  );
  return { ...doc, clientIds: merged, clientsCount: merged.length };
}

async function getById(req, id) {
  const PersonContact = getModel(req);
  const doc = await PersonContact.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!doc) throw appError('Contact not found', 404);
  const synced = await syncClientIdsFromCompanyContacts(req, doc);
  return serialize(synced);
}

async function create(req, input) {
  const PersonContact = getModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const name = String(input.name || '').trim();
  if (!name) throw appError('Contact name is required');

  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const pan = normalizePan(input.pan);

  if (!input.allowDuplicate) {
    const dupes = await findDuplicates(req, { email, phone, pan });
    if (dupes.length) {
      const error = appError('This contact is duplicate — you can reuse an existing contact', 409);
      error.code = 'CONTACT_DUPLICATE';
      error.duplicates = dupes;
      throw error;
    }
  }

  const doc = await PersonContact.create({
    tenantId,
    salutation: String(input.salutation || '').trim(),
    name,
    photoUrl: String(input.photoUrl || '').trim(),
    email,
    phone,
    gender: String(input.gender || '').trim(),
    pan,
    jobTitle: String(input.jobTitle || '').trim(),
    companyName: String(input.companyName || input.company || '').trim(),
    leadIds: [],
    leadsCount: 0,
    clientIds: [],
    clientsCount: 0,
    createdBy: userId,
    updatedBy: userId
  });

  const result = serialize(doc);
  await AuditService.log(req, {
    action: 'created',
    module: 'contact',
    recordId: String(result._id),
    description: `Contact created: ${result.name}`
  });
  return result;
}

async function update(req, id, input) {
  const PersonContact = getModel(req);
  const userId = resolveUserId(req);
  const existing = await getById(req, id);
  const updates = { updatedBy: userId };

  if (input.salutation !== undefined) updates.salutation = String(input.salutation || '').trim();
  if (input.name !== undefined) {
    const name = String(input.name || '').trim();
    if (!name) throw appError('Contact name is required');
    updates.name = name;
  }
  if (input.photoUrl !== undefined) updates.photoUrl = String(input.photoUrl || '').trim();
  if (input.email !== undefined) updates.email = normalizeEmail(input.email);
  if (input.phone !== undefined) updates.phone = normalizePhone(input.phone);
  if (input.gender !== undefined) updates.gender = String(input.gender || '').trim();
  if (input.pan !== undefined) updates.pan = normalizePan(input.pan);
  if (input.jobTitle !== undefined) updates.jobTitle = String(input.jobTitle || '').trim();
  if (input.companyName !== undefined) updates.companyName = String(input.companyName || '').trim();

  if (!input.allowDuplicate) {
    const dupes = await findDuplicates(req, {
      email: updates.email !== undefined ? updates.email : existing.email,
      phone: updates.phone !== undefined ? updates.phone : existing.phone,
      pan: updates.pan !== undefined ? updates.pan : existing.pan,
      excludeId: id
    });
    if (dupes.length) {
      const error = appError('This contact is duplicate — you can reuse an existing contact', 409);
      error.code = 'CONTACT_DUPLICATE';
      error.duplicates = dupes;
      throw error;
    }
  }

  const doc = await PersonContact.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  // Company Name is business data (no personal identifiers), so the change itself is recorded.
  const companyBefore = String(existing.companyName || '').trim();
  const companyChanged = updates.companyName !== undefined && updates.companyName !== companyBefore;
  await AuditService.log(req, {
    action: 'updated',
    module: 'contact',
    recordId: id,
    description: companyChanged
      ? `Contact updated: ${doc.name} (Company Name: ${companyBefore || '—'} → ${updates.companyName || '—'})`
      : `Contact updated: ${doc.name}`,
    ...(companyChanged ? { metadata: { changes: { companyName: { from: companyBefore, to: updates.companyName } } } } : {})
  });
  return serialize(doc);
}

async function remove(req, id) {
  const PersonContact = getModel(req);
  const userId = resolveUserId(req);
  const existing = await getById(req, id);
  await PersonContact.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        updatedBy: userId
      }
    }
  );
  await AuditService.log(req, {
    action: 'deleted',
    module: 'contact',
    recordId: id,
    description: `Contact deleted: ${existing.name}`
  });
  return { deleted: true };
}

async function linkLead(req, contactId, leadId) {
  if (!contactId || !leadId) return null;
  const PersonContact = getModel(req);
  const doc = await PersonContact.findOneAndUpdate(
    { ...baseFilter(req), _id: contactId },
    {
      $addToSet: { leadIds: String(leadId) },
      $set: { updatedBy: resolveUserId(req) }
    },
    { new: true }
  ).lean();
  if (!doc) return null;
  const leadsCount = Array.isArray(doc.leadIds) ? doc.leadIds.length : 0;
  await PersonContact.updateOne(
    { _id: contactId },
    { $set: { leadsCount } }
  );
  return serialize({ ...doc, leadsCount });
}

async function linkClient(req, contactId, clientId) {
  if (!contactId || !clientId) return null;
  const PersonContact = getModel(req);
  const doc = await PersonContact.findOneAndUpdate(
    { ...baseFilter(req), _id: contactId },
    {
      $addToSet: { clientIds: String(clientId) },
      $set: { updatedBy: resolveUserId(req) }
    },
    { new: true }
  ).lean();
  if (!doc) return null;
  const clientsCount = Array.isArray(doc.clientIds) ? doc.clientIds.length : 0;
  await PersonContact.updateOne({ _id: contactId }, { $set: { clientsCount } });
  return serialize({ ...doc, clientsCount });
}

async function unlinkClient(req, contactId, clientId) {
  if (!contactId || !clientId) return null;
  const PersonContact = getModel(req);
  const doc = await PersonContact.findOneAndUpdate(
    { ...baseFilter(req), _id: contactId },
    {
      $pull: { clientIds: String(clientId) },
      $set: { updatedBy: resolveUserId(req) }
    },
    { new: true }
  ).lean();
  if (!doc) return null;
  const clientsCount = Array.isArray(doc.clientIds) ? doc.clientIds.length : 0;
  await PersonContact.updateOne({ _id: contactId }, { $set: { clientsCount } });
  return serialize({ ...doc, clientsCount });
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeCompany(company) {
  return String(company || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function canonicalDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Check if a contact with matching email, phone, or exact name exists
 * under a different company name (cross-entity company discrepancy check).
 */
async function checkDiscrepancy(req, params = {}) {
  const PersonContact = req.cms?.models.get('PersonContact');
  if (!PersonContact) return { hasDiscrepancy: false, discrepancy: null };

  const Lead = req.cms?.models.get('Lead');
  const tenantId = resolveTenantId(req);

  const inputName = String(params.name || '').trim();
  const inputNameNorm = normalizeName(inputName);
  const inputEmail = normalizeEmail(params.email);
  const inputPhone = normalizePhone(params.phone);
  const inputPhoneCanonical = canonicalDigits(inputPhone);
  const inputCompany = String(params.companyName || params.company || '').trim();
  const inputCompanyNorm = normalizeCompany(inputCompany);
  const excludeId = String(params.excludeId || '').trim();
  const entityType = String(params.entityType || '').trim();

  if (!inputEmail && !inputPhone && inputNameNorm.length < 2) {
    return { hasDiscrepancy: false, discrepancy: null };
  }

  const phoneVariants = phoneMatchVariants(inputPhone);
  const contactOr = [];
  if (inputEmail) contactOr.push({ email: inputEmail });
  for (const variant of phoneVariants) {
    contactOr.push({ phone: variant });
  }
  if (inputNameNorm.length >= 2) {
    contactOr.push({ name: new RegExp('^' + inputName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
  }

  if (contactOr.length && typeof PersonContact.find === 'function') {
    const contactFilter = { tenantId, isDeleted: false, $or: contactOr };
    if (excludeId && entityType !== 'lead') contactFilter._id = { $ne: excludeId };

    const query = PersonContact.find(contactFilter);
    const matchedContacts = typeof query?.limit === 'function'
      ? (typeof query.limit(30).lean === 'function' ? await query.limit(30).lean() : await query.limit(30))
      : await query;

    if (Array.isArray(matchedContacts)) {
      for (const contact of matchedContacts) {
        const contactCompany = String(contact.companyName || '').trim();
        const companyDiffers = normalizeCompany(contactCompany) !== inputCompanyNorm;
        if (companyDiffers) {
          let matchedField = null;
          let matchedValue = '';
          if (inputEmail && normalizeEmail(contact.email) === inputEmail) {
            matchedField = 'email';
            matchedValue = contact.email;
          } else if (inputPhoneCanonical && canonicalDigits(contact.phone) === inputPhoneCanonical) {
            matchedField = 'phone';
            matchedValue = contact.phone;
          } else if (inputNameNorm.length >= 2 && normalizeName(contact.name) === inputNameNorm) {
            matchedField = 'name';
            matchedValue = contact.name;
          }

          if (matchedField) {
            return {
              hasDiscrepancy: true,
              discrepancy: {
                matchedField,
                matchedValue,
                existingCompany: contactCompany || 'None',
                newCompany: inputCompany || 'None',
                existingRecordName: contact.name,
                entityType: 'contact',
                recordId: String(contact._id)
              }
            };
          }
        }
      }
    }
  }

  if (Lead && contactOr.length && typeof Lead.find === 'function') {
    const leadFilter = { tenantId, isDeleted: { $ne: true }, $or: contactOr };
    if (excludeId && entityType === 'lead') leadFilter._id = { $ne: excludeId };

    const query = Lead.find(leadFilter);
    const matchedLeads = typeof query?.limit === 'function'
      ? (typeof query.limit(30).lean === 'function' ? await query.limit(30).lean() : await query.limit(30))
      : await query;

    if (Array.isArray(matchedLeads)) {
      for (const lead of matchedLeads) {
        const leadCompany = String(lead.company || '').trim();
        const companyDiffers = normalizeCompany(leadCompany) !== inputCompanyNorm;
        if (companyDiffers) {
          let matchedField = null;
          let matchedValue = '';
          if (inputEmail && normalizeEmail(lead.email) === inputEmail) {
            matchedField = 'email';
            matchedValue = lead.email;
          } else if (inputPhoneCanonical && canonicalDigits(lead.phone) === inputPhoneCanonical) {
            matchedField = 'phone';
            matchedValue = lead.phone;
          } else if (inputNameNorm.length >= 2 && normalizeName(lead.name) === inputNameNorm) {
            matchedField = 'name';
            matchedValue = lead.name;
          }

          if (matchedField) {
            return {
              hasDiscrepancy: true,
              discrepancy: {
                matchedField,
                matchedValue,
                existingCompany: leadCompany || 'None',
                newCompany: inputCompany || 'None',
                existingRecordName: lead.name,
                entityType: 'lead',
                recordId: String(lead._id)
              }
            };
          }
        }
      }
    }
  }

  return { hasDiscrepancy: false, discrepancy: null };
}

module.exports = {
  list,
  getById,
  create,
  update,
  remove,
  findDuplicates,
  checkDiscrepancy,
  linkLead,
  linkClient,
  unlinkClient,
  phoneMatchVariants
};
