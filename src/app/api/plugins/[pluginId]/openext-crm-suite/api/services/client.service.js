'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { getNextNumber } = require('../utils/numbering.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const {
  isValidEmail,
  isValidMobile,
  isValidHttpUrl,
  normalizeMobile
} = require('../validation/common.util');
const AuditService = require('./audit.service');
const { normalizeCompanyName, buildCompanyTokens } = require('../utils/lead-duplicate.util');
const { scoreClient } = require('../utils/data-quality.util');
const {
  assertClientWriteAccess,
  assertClientReadAccess,
  applySalesAgentClientListScope,
  hasPermission,
  isSalesAgentScoped
} = require('../utils/sales-access.util');
const {
  isEmployeeScoped,
  applyEmployeeProjectListScope,
  applyEmployeeTaskListScope
} = require('../utils/project-access.util');

function getCompanyModel(req) {
  const Company = req.cms?.models.get('Company');
  if (!Company) throw new Error('Company model is not registered');
  return Company;
}

function getContactModel(req) {
  const Contact = req.cms?.models.get('Contact');
  if (!Contact) throw new Error('Contact model is not registered');
  return Contact;
}

function getLeadModel(req) {
  const Lead = req.cms?.models.get('Lead');
  if (!Lead) throw new Error('Lead model is not registered');
  return Lead;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function companyFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false, mergedIntoId: null };
}

/** Match list/export status filter — treats missing/blank status as Active. */
function applyClientListStatusFilter(filter, statusQuery) {
  const normalized = String(statusQuery || '').trim().toLowerCase();
  if (normalized !== 'active' && normalized !== 'inactive') return;

  const statusCondition =
    normalized === 'inactive'
      ? { status: { $regex: /^inactive$/i } }
      : {
          $or: [
            { status: { $exists: false } },
            { status: null },
            { status: '' },
            { status: { $regex: /^active$/i } }
          ]
        };

  if (filter.$or) {
    const searchClause = { $or: filter.$or };
    delete filter.$or;
    filter.$and = [...(filter.$and || []), searchClause, statusCondition];
    return;
  }

  filter.$and = [...(filter.$and || []), statusCondition];
}

function contactFilter(req, companyId) {
  return {
    tenantId: resolveTenantId(req),
    companyId: String(companyId),
    isDeleted: false
  };
}

async function findCompanyOrThrow(req, id) {
  const company = await getCompanyModel(req).findOne({ ...companyFilter(req), _id: id }).lean();
  if (!company) throw appError('Client not found', 404);
  await assertClientReadAccess(req, company, getLeadModel);
  return company;
}

function normalizeBillingAddress(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    street: String(source.street || '').trim(),
    city: String(source.city || '').trim(),
    state: String(source.state || '').trim(),
    country: String(source.country || '').trim(),
    zip: String(source.zip || '').trim()
  };
}

function cleanCompanyInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    name: source.name !== undefined ? String(source.name).trim() : undefined,
    email: source.email !== undefined ? String(source.email).trim().toLowerCase() : undefined,
    phone: source.phone !== undefined ? normalizeMobile(source.phone) : undefined,
    website: source.website !== undefined ? String(source.website).trim() : undefined,
    status: source.status !== undefined ? (String(source.status).trim() === 'Inactive' ? 'Inactive' : 'Active') : undefined,
    category: source.category !== undefined ? String(source.category).trim() : undefined,
    tags: Array.isArray(source.tags) ? source.tags.map((t) => String(t || '').trim()).filter(Boolean) : undefined,
    customFields: source.customFields && typeof source.customFields === 'object' ? source.customFields : undefined,
    billingAddress:
      source.billingAddress !== undefined
        ? normalizeBillingAddress(source.billingAddress)
        : undefined
  };
}

function cleanContactInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    name: source.name !== undefined ? String(source.name).trim() : undefined,
    email: source.email !== undefined ? String(source.email).trim().toLowerCase() : undefined,
    phone: source.phone !== undefined ? normalizeMobile(source.phone) : undefined,
    designation: source.designation !== undefined ? String(source.designation).trim() : undefined,
    isPrimary: source.isPrimary !== undefined ? Boolean(source.isPrimary) : undefined
  };
}

function clientDuplicateConflict(req, matches, input) {
  const hasExactDuplicate = matches.some((match) =>
    match.reasons.some((reason) => reason !== 'company')
  );
  const hasSimilarCompany = matches.some((match) => match.reasons.includes('company'));
  if (hasExactDuplicate) {
    if (input.allowExactDuplicate === true && hasPermission(req, 'crm.clients.duplicate.override')) return;
    const error = appError('A customer with the same email or mobile number already exists', 409);
    error.code = 'CLIENT_DUPLICATE_EXACT';
    error.details = matches;
    throw error;
  }
  if (hasSimilarCompany && input.allowSimilarCompany !== true) {
    const error = appError('A customer with a similar company name already exists', 409);
    error.code = 'CLIENT_DUPLICATE_COMPANY';
    error.details = matches;
    throw error;
  }
}

async function resolveSourceLeadsForCompanies(req, companies) {
  const items = Array.isArray(companies) ? companies : companies ? [companies] : [];
  const result = new Map();
  if (!items.length) return result;

  const Lead = getLeadModel(req);
  if (!Lead) return result;

  const tenantId = resolveTenantId(req);
  const leadIds = [...new Set(items.map((item) => String(item.leadId || '').trim()).filter(Boolean))];
  const companyIdsMissingLead = items
    .filter((item) => !String(item.leadId || '').trim())
    .map((item) => String(item._id));

  const [leadsById, leadsByClient] = await Promise.all([
    leadIds.length
      ? Lead.find({ tenantId, _id: { $in: leadIds } })
          .select('name stage _id requestType requestTypeId requestTypeKey')
          .lean()
      : [],
    companyIdsMissingLead.length
      ? Lead.find({
          tenantId,
          convertedClientId: { $in: companyIdsMissingLead }
        })
          .select('name stage _id convertedClientId requestType requestTypeId requestTypeKey')
          .lean()
      : []
  ]);

  const leadById = Object.fromEntries(leadsById.map((lead) => [String(lead._id), lead]));
  const leadByCompanyId = {};
  for (const lead of leadsByClient) {
    const companyId = String(lead.convertedClientId || '').trim();
    if (companyId && !leadByCompanyId[companyId]) {
      leadByCompanyId[companyId] = lead;
    }
  }

  for (const company of items) {
    const companyId = String(company._id);
    let leadId = String(company.leadId || '').trim();
    let lead = leadId ? leadById[leadId] : null;

    if (!lead) {
      lead = leadByCompanyId[companyId];
      if (lead) leadId = String(lead._id);
    }

    if (!leadId) continue;

    result.set(companyId, {
      leadId,
      sourceLead: {
        id: leadId,
        /** Same value as `id` — the UI reads `sourceLead._id` in places. */
        _id: leadId,
        name: lead?.name || 'Converted lead',
        stage: lead?.stage || null,
        requestType: lead?.requestType || '',
        requestTypeId: lead?.requestTypeId || null
      }
    });
  }

  return result;
}

async function repairCompanyLeadIdIfNeeded(req, company, resolvedLeadId) {
  const current = String(company?.leadId || '').trim();
  const leadId = String(resolvedLeadId || '').trim();
  if (current || !leadId || !company?._id) return company;

  try {
    const Company = getCompanyModel(req);
    const userId = resolveUserId(req);
    const updated = await Company.findOneAndUpdate(
      { ...companyFilter(req), _id: company._id },
      { $set: { leadId, updatedBy: userId } },
      { new: true }
    ).lean();
    return updated || { ...company, leadId };
  } catch (error) {
    console.warn('[plugin:openext-crm-suite] company leadId repair skipped:', error.message);
    return { ...company, leadId };
  }
}

async function enrichClientWithSourceLead(req, company) {
  if (!company) return company;

  const sourceMap = await resolveSourceLeadsForCompanies(req, [company]);
  const resolved = sourceMap.get(String(company._id));
  if (!resolved) return company;

  const repaired = await repairCompanyLeadIdIfNeeded(req, company, resolved.leadId);
  return {
    ...repaired,
    sourceLead: resolved.sourceLead
  };
}

async function enrichClientsWithSourceLeads(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];

  const sourceMap = await resolveSourceLeadsForCompanies(req, items);

  return Promise.all(
    items.map(async (item) => {
      const resolved = sourceMap.get(String(item._id));
      if (!resolved) return item;

      const repaired = await repairCompanyLeadIdIfNeeded(req, item, resolved.leadId);
      return {
        ...repaired,
        sourceLead: resolved.sourceLead
      };
    })
  );
}

async function enrichClientsWithPrimaryContacts(req, items) {
  if (!Array.isArray(items) || !items.length) return items || [];

  const companyIds = items.map((item) => String(item._id));
  const Contact = getContactModel(req);
  const contacts = await Contact.find({
    tenantId: resolveTenantId(req),
    isDeleted: false,
    companyId: { $in: companyIds }
  })
    .sort({ isPrimary: -1, createdAt: 1 })
    .lean();

  const primaryByCompany = {};
  const countByCompany = {};

  for (const contact of contacts) {
    const companyId = String(contact.companyId);
    countByCompany[companyId] = (countByCompany[companyId] || 0) + 1;
    if (!primaryByCompany[companyId]) {
      primaryByCompany[companyId] = contact;
    }
  }

  return items.map((item) => {
    const companyId = String(item._id);
    const primary = primaryByCompany[companyId];
    const contactCount = countByCompany[companyId] || 0;

    if (!primary) {
      return { ...item, contactCount: 0 };
    }

    return {
      ...item,
      contactCount,
      primaryContact: {
        id: String(primary._id),
        name: primary.name,
        email: primary.email || '',
        phone: primary.phone || '',
        designation: primary.designation || '',
        isPrimary: Boolean(primary.isPrimary)
      }
    };
  });
}

/** Paginated client list */
async function list(req) {
  const Company = getCompanyModel(req);
  const { page, limit, skip, sort } = parsePagination(req.query);
  const filter = companyFilter(req);

  if (req.query?.search) {
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      const companyOr = [
        { name: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } },
        { phone: { $regex: term, $options: 'i' } },
        { taxId: { $regex: term, $options: 'i' } },
        { tags: { $regex: term, $options: 'i' } }
      ];

      const Contact = getContactModel(req);
      const contactMatches = await Contact.find({
        tenantId: resolveTenantId(req),
        isDeleted: false,
        $or: [
          { name: { $regex: term, $options: 'i' } },
          { email: { $regex: term, $options: 'i' } },
          { phone: { $regex: term, $options: 'i' } },
          { designation: { $regex: term, $options: 'i' } }
        ]
      })
        .select('companyId')
        .lean();

      const contactCompanyIds = [
        ...new Set(contactMatches.map((row) => String(row.companyId || '').trim()).filter(Boolean))
      ];

      if (contactCompanyIds.length) {
        companyOr.push({ _id: { $in: contactCompanyIds } });
      }

      filter.$or = companyOr;
    }
  }
  if (req.query?.status) {
    applyClientListStatusFilter(filter, req.query.status);
  }

  if (req.query?.category) {
    const rawCat = String(req.query.category).trim();
    if (rawCat && rawCat !== 'all') {
      filter.category = rawCat;
    }
  }

  if (req.query?.tag) {
    const rawTag = String(req.query.tag).trim();
    if (rawTag && rawTag !== 'all') {
      filter.tags = rawTag;
    }
  }

  const { isClientUser, resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
  let isUnlinkedClient = false;
  if (isClientUser(req)) {
    const userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
    if (!userClientId) {
      isUnlinkedClient = true;
      return {
        items: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
        unlinkedClient: true,
        message: 'Client email ID not found in CRM records'
      };
    }
  }

  const scopedFilter = await applySalesAgentClientListScope(req, filter, getLeadModel);

  const [items, total] = await Promise.all([
    Company.find(scopedFilter).sort(sort).skip(skip).limit(limit).lean(),
    Company.countDocuments(scopedFilter)
  ]);

  let enriched = await enrichClientsWithSourceLeads(req, items);
  enriched = await enrichClientsWithPrimaryContacts(req, enriched);

  return {
    items: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

async function getById(req, id, options = {}) {
  const company = await findCompanyOrThrow(req, id);
  const enriched = await enrichClientWithSourceLead(req, company);
  if (options.includeQuality === false || !hasPermission(req, 'crm.dataQuality.read')) return enriched;
  const [contactCount, duplicates] = await Promise.all([
    getContactModel(req).countDocuments(contactFilter(req, id)),
    require('./record-merge.service').findClientDuplicates(req, company, { excludeId: id })
  ]);
  return {
    ...enriched,
    dataQuality: scoreClient(company, { contactCount, hasDuplicate: duplicates.length > 0 })
  };
}

async function create(req, input) {
  const Company = getCompanyModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  if (!input.name) throw appError('Company name is required');
  if (input.email && !isValidEmail(input.email)) throw appError('Email is invalid');
  if (input.phone && !isValidMobile(normalizeMobile(input.phone))) throw appError('Mobile number is invalid');
  if (input.website && !isValidHttpUrl(input.website)) throw appError('Website is invalid');

  const duplicateMatches = await require('./record-merge.service').findClientDuplicates(req, input);
  clientDuplicateConflict(req, duplicateMatches, input);

  const taxId = await getNextNumber(req, 'clientTaxId') || Date.now().toString();

  const company = await Company.create({
    tenantId,
    name: input.name,
    companyKey: normalizeCompanyName(input.name),
    companyTokens: buildCompanyTokens(input.name),
    email: input.email || '',
    phone: normalizeMobile(input.phone) || '',
    billingAddress: input.billingAddress || {},
    taxId,
    website: input.website || '',
    avatarUrl: input.avatarUrl || '',
    status: input.status !== undefined ? (input.status === 'Inactive' ? 'Inactive' : 'Active') : 'Active',
    category: input.category ? String(input.category).trim() : '',
    tags: Array.isArray(input.tags) ? input.tags : [],
    customFields: input.customFields && typeof input.customFields === 'object' ? input.customFields : {},
    leadId: input.leadId || null,
    createdBy: userId,
    updatedBy: userId
  });

  const doc = company.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'client',
    recordId: doc._id.toString(),
    description: `Client created: ${doc.name}`,
    metadata: {
      taxId: doc.taxId,
      similarCompanyOverride: input.allowSimilarCompany === true,
      exactDuplicateOverride: input.allowExactDuplicate === true
    }
  });

  return doc;
}

async function update(req, id, input) {
  const Company = getCompanyModel(req);
  const userId = resolveUserId(req);
  const existing = await findCompanyOrThrow(req, id);
  await assertClientWriteAccess(req, existing, getLeadModel);

  const updates = { updatedBy: userId };
  if (input.name !== undefined) {
    if (!input.name) throw appError('Company name is required');
    updates.name = input.name;
    updates.companyKey = normalizeCompanyName(input.name);
    updates.companyTokens = buildCompanyTokens(input.name);
  }
  if (input.email !== undefined) {
    if (input.email && !isValidEmail(input.email)) throw appError('Email is invalid');
    updates.email = input.email;
  }
  if (input.phone !== undefined) {
    const phone = normalizeMobile(input.phone);
    if (phone && !isValidMobile(phone)) throw appError('Mobile number is invalid');
    updates.phone = phone;
  }
  if (input.website !== undefined) {
    if (input.website && !isValidHttpUrl(input.website)) throw appError('Website is invalid');
    updates.website = input.website;
  }
  if (input.avatarUrl !== undefined) {
    updates.avatarUrl = String(input.avatarUrl || '').trim();
  }
  if (input.status !== undefined) {
    updates.status = input.status === 'Inactive' ? 'Inactive' : 'Active';
  }
  if (input.category !== undefined) {
    updates.category = String(input.category || '').trim();
  }
  if (input.tags !== undefined) {
    updates.tags = Array.isArray(input.tags) ? input.tags : [];
  }
  if (input.customFields !== undefined && typeof input.customFields === 'object') {
    updates.customFields = input.customFields;
  }
  if (input.billingAddress !== undefined) updates.billingAddress = input.billingAddress;

  if (['name', 'email', 'phone'].some((field) => input[field] !== undefined)) {
    const identity = {
      name: updates.name !== undefined ? updates.name : existing.name,
      email: updates.email !== undefined ? updates.email : existing.email,
      phone: updates.phone !== undefined ? updates.phone : existing.phone
    };
    const duplicateMatches = await require('./record-merge.service').findClientDuplicates(
      req,
      identity,
      { excludeId: id }
    );
    clientDuplicateConflict(req, duplicateMatches, input);
  }

  const company = await Company.findOneAndUpdate(
    { ...companyFilter(req), _id: id },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'client',
    recordId: id,
    description: `Client updated: ${company.name}`,
    metadata: {
      similarCompanyOverride: input.allowSimilarCompany === true,
      exactDuplicateOverride: input.allowExactDuplicate === true
    }
  });

  return company;
}

async function remove(req, id) {
  const Company = getCompanyModel(req);
  const userId = resolveUserId(req);
  const existing = await findCompanyOrThrow(req, id);
  await assertClientWriteAccess(req, existing, getLeadModel);

  await Company.findOneAndUpdate(
    { ...companyFilter(req), _id: id },
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
    module: 'client',
    recordId: id,
    description: `Client deleted: ${existing.name}`
  });

  return { deleted: true, id };
}

/** List contacts for a client */
async function listContacts(req, companyId) {
  await findCompanyOrThrow(req, companyId);
  const items = await getContactModel(req)
    .find(contactFilter(req, companyId))
    .sort({ isPrimary: -1, createdAt: 1 })
    .lean();
  return backfillPersonContactIds(req, companyId, items);
}

/**
 * For legacy company-contact rows created without a directory link, match by
 * email/phone to PersonContact and attach personContactId (+ reverse clientIds).
 */
async function backfillPersonContactIds(req, companyId, items) {
  if (!Array.isArray(items) || !items.length) return items || [];
  const PersonContact = req.cms?.models.get('PersonContact');
  if (!PersonContact) return items;

  const Contact = getContactModel(req);
  const PersonContactService = require('./person-contact.service');
  const out = [];

  for (const item of items) {
    if (item.personContactId) {
      out.push(item);
      continue;
    }
    const email = String(item.email || '').trim().toLowerCase();
    const phoneDigits = String(item.phone || '').replace(/\D/g, '');
    if (!email && phoneDigits.length < 7) {
      out.push(item);
      continue;
    }

    const or = [];
    if (email) or.push({ email });
    if (phoneDigits.length >= 10) {
      const last10 = phoneDigits.slice(-10);
      or.push({ phone: last10 }, { phone: `+91${last10}` }, { phone: `91${last10}` });
    } else if (phoneDigits.length >= 7) {
      or.push({ phone: phoneDigits });
    }

    const match = await PersonContact.findOne({
      tenantId: resolveTenantId(req),
      isDeleted: false,
      $or: or
    })
      .select('_id')
      .lean();

    if (!match) {
      out.push(item);
      continue;
    }

    const personContactId = String(match._id);
    await Contact.updateOne(
      { _id: item._id },
      { $set: { personContactId } }
    );
    try {
      await PersonContactService.linkClient(req, personContactId, companyId);
    } catch {
      /* best-effort reverse link */
    }
    out.push({ ...item, personContactId });
  }

  return out;
}

async function addContact(req, companyId, input) {
  const Contact = getContactModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const company = await findCompanyOrThrow(req, companyId);
  await assertClientWriteAccess(req, company, getLeadModel);

  if (!input.name) throw appError('Contact name is required');
  if (input.email && !isValidEmail(input.email)) throw appError('Email is invalid');
  if (input.phone && !isValidMobile(normalizeMobile(input.phone))) throw appError('Mobile number is invalid');

  if (input.isPrimary) {
    await Contact.updateMany(
      { ...contactFilter(req, companyId), isPrimary: true },
      { $set: { isPrimary: false, updatedBy: userId } }
    );
  }

  const contact = await Contact.create({
    tenantId,
    companyId: String(companyId),
    name: input.name,
    email: input.email || '',
    phone: normalizeMobile(input.phone) || '',
    designation: input.designation || '',
    personContactId: input.personContactId ? String(input.personContactId).trim() : null,
    isPrimary: Boolean(input.isPrimary),
    createdBy: userId,
    updatedBy: userId
  });

  const doc = contact.toObject();

  if (doc.personContactId) {
    try {
      const PersonContactService = require('./person-contact.service');
      await PersonContactService.linkClient(req, doc.personContactId, companyId);
    } catch (err) {
      console.warn('[plugin:openext-crm-suite] link person contact to client failed:', err?.message || err);
    }
  }

  await AuditService.log(req, {
    action: 'created',
    module: 'contact',
    recordId: doc._id.toString(),
    description: `Contact added: ${doc.name}`,
    metadata: {
      companyId: String(companyId),
      personContactId: doc.personContactId || null
    }
  });

  return doc;
}

async function updateContact(req, companyId, contactId, input) {
  const Contact = getContactModel(req);
  const userId = resolveUserId(req);
  const company = await findCompanyOrThrow(req, companyId);
  await assertClientWriteAccess(req, company, getLeadModel);

  const existing = await Contact.findOne({
    ...contactFilter(req, companyId),
    _id: contactId
  }).lean();
  if (!existing) throw appError('Contact not found', 404);

  if (input.email !== undefined && input.email && !isValidEmail(input.email)) {
    throw appError('Email is invalid');
  }

  const updates = { updatedBy: userId };
  if (input.name !== undefined) {
    if (!input.name) throw appError('Contact name is required');
    updates.name = input.name;
  }
  if (input.email !== undefined) updates.email = input.email;
  if (input.phone !== undefined) {
    const phone = normalizeMobile(input.phone);
    if (phone && !isValidMobile(phone)) throw appError('Mobile number is invalid');
    updates.phone = phone;
  }
  if (input.designation !== undefined) updates.designation = input.designation;

  const prevPersonId = existing.personContactId ? String(existing.personContactId) : null;
  let nextPersonId = prevPersonId;
  if (input.personContactId !== undefined) {
    nextPersonId = input.personContactId ? String(input.personContactId).trim() : null;
    updates.personContactId = nextPersonId;
  }

  if (input.isPrimary === true) {
    await Contact.updateMany(
      { ...contactFilter(req, companyId), isPrimary: true },
      { $set: { isPrimary: false, updatedBy: userId } }
    );
    updates.isPrimary = true;
  } else if (input.isPrimary === false) {
    updates.isPrimary = false;
  }

  const contact = await Contact.findOneAndUpdate(
    { ...contactFilter(req, companyId), _id: contactId },
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  try {
    const PersonContactService = require('./person-contact.service');
    if (prevPersonId && prevPersonId !== nextPersonId) {
      await PersonContactService.unlinkClient(req, prevPersonId, companyId);
    }
    if (nextPersonId) {
      await PersonContactService.linkClient(req, nextPersonId, companyId);
    }
  } catch (err) {
    console.warn('[plugin:openext-crm-suite] sync person↔client link on contact update failed:', err?.message || err);
  }

  await AuditService.log(req, {
    action: 'updated',
    module: 'contact',
    recordId: contactId,
    description: `Contact updated: ${contact.name}`,
    metadata: {
      companyId: String(companyId),
      personContactId: nextPersonId || null
    }
  });

  return contact;
}

async function removeContact(req, companyId, contactId) {
  const Contact = getContactModel(req);
  const userId = resolveUserId(req);
  const company = await findCompanyOrThrow(req, companyId);
  await assertClientWriteAccess(req, company, getLeadModel);

  const existing = await Contact.findOne({
    ...contactFilter(req, companyId),
    _id: contactId
  }).lean();
  if (!existing) throw appError('Contact not found', 404);

  await Contact.findOneAndUpdate(
    { ...contactFilter(req, companyId), _id: contactId },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId,
        updatedBy: userId
      }
    }
  );

  if (existing.personContactId) {
    try {
      const PersonContactService = require('./person-contact.service');
      await PersonContactService.unlinkClient(req, existing.personContactId, companyId);
    } catch (err) {
      console.warn('[plugin:openext-crm-suite] unlink person contact from client failed:', err?.message || err);
    }
  }

  await AuditService.log(req, {
    action: 'deleted',
    module: 'contact',
    recordId: contactId,
    description: `Contact deleted: ${existing.name}`,
    metadata: {
      companyId: String(companyId),
      personContactId: existing.personContactId || null
    }
  });

  return { deleted: true, id: contactId };
}

/**
 * The sales records that belong to a client although they were made before it existed: the leads
 * converted into it (and the lead it was created from) and the opportunities of the client or of those
 * leads. Used by the client's Quotations and Invoices tabs. Tenant-scoped; at most 500 of each.
 * @returns {Promise<{ leadIds: string[], opportunityIds: string[] }>}
 */
async function clientSalesOrigins(req, companyId) {
  const tenantId = resolveTenantId(req);
  const clientId = String(companyId || '').trim();
  const rows = async (make) => {
    try {
      const query = make();
      const q = typeof query.select === 'function' ? query.select('_id leadId') : query;
      const list = typeof q.limit === 'function' ? await q.limit(500).lean() : await q;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const model = (name) => {
    try {
      return req.cms?.models?.get?.(name) || null;
    } catch {
      return null;
    }
  };
  const Lead = model('Lead');
  const Company = model('Company');
  const leads = Lead ? await rows(() => Lead.find({ tenantId, isDeleted: false, convertedClientId: clientId })) : [];
  const leadIds = new Set(leads.map((l) => String(l._id)));
  try {
    const company = Company ? await Company.findOne({ tenantId, _id: clientId }).select('leadId').lean() : null;
    if (company && company.leadId) leadIds.add(String(company.leadId));
  } catch {
    /* no source lead */
  }
  const Opportunity = model('Opportunity');
  const or = [{ clientId }];
  if (leadIds.size) or.push({ leadId: { $in: [...leadIds] } });
  const opps = Opportunity ? await rows(() => Opportunity.find({ tenantId, isDeleted: false, $or: or })) : [];
  return { leadIds: [...leadIds], opportunityIds: opps.map((o) => String(o._id)) };
}

/** List quotations for a client detail tab */
async function listQuotationsForClient(req, companyId) {
  const QuotationService = require('./quotation.service');
  return QuotationService.listByClient(req, companyId);
}

async function listInvoicesForClient(req, companyId) {
  const InvoiceService = require('./invoice.service');
  return InvoiceService.listByClient(req, companyId);
}

async function listPaymentsForClient(req, companyId) {
  const PaymentService = require('./payment.service');
  return PaymentService.listByClient(req, companyId);
}

/**
 * Convert Won lead → Company + primary Contact (Phase 1 plan Section 6.4).
 */
/**
 * The one existing customer that has this lead's email or mobile number, or null when there is none or
 * more than one (then a person has to choose). Tenant-scoped; merged and deleted customers are skipped.
 */
async function findExistingCustomerForLead(req, lead) {
  const Company = getCompanyModel(req);
  const email = String(lead.email || '').trim().toLowerCase();
  const phones = [...new Set([String(lead.phone || '').trim(), normalizeMobile(lead.phone || '')].filter(Boolean))];
  const or = [];
  if (email) or.push({ email });
  for (const phone of phones) or.push({ phone });
  if (!or.length) return { match: null, count: 0 };
  const rows = await Company.find({ tenantId: resolveTenantId(req), isDeleted: false, mergedIntoId: null, $or: or })
    .select('_id name email phone')
    .limit(5)
    .lean();
  const ids = [...new Set(rows.map((r) => String(r._id)))];
  return { match: ids.length === 1 ? rows[0] : null, count: ids.length };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.linkExisting]  when a customer with the lead's email / mobile already exists
 *   (a returning customer), link the lead to that customer instead of failing on the duplicate rule.
 *   Used when an accepted quotation converts the lead; the manual "Convert to Client" keeps asking.
 * @param {boolean} [options.allowSimilarCompany] a similar company name alone does not stop the conversion.
 */
async function convertFromLead(req, leadId, options = {}) {
  const Lead = getLeadModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const lead = await Lead.findOne({
    tenantId,
    isDeleted: false,
    mergedIntoId: null,
    _id: leadId
  }).lean();

  if (!lead) throw appError('Lead not found', 404);
  if (lead.convertedClientId) throw appError('Lead has already been converted to a client', 409);

  const SettingService = require('./setting.service');
  const stages = await SettingService.getPipelineStages(req);
  const wonStage = SettingService.resolveWonStage(stages);
  if (lead.stage !== wonStage) {
    throw appError(`Lead must be in "${wonStage}" stage before conversion`, 400);
  }

  const Company = getCompanyModel(req);
  const existingCompany = await Company.findOne({
    tenantId,
    isDeleted: false,
    mergedIntoId: null,
    leadId: String(leadId)
  }).lean();

  if (existingCompany) {
    if (!lead.convertedClientId) {
      await Lead.findOneAndUpdate(
        { tenantId, _id: leadId },
        {
          $set: {
            convertedClientId: String(existingCompany._id),
            convertedAt: lead.convertedAt || new Date(),
            updatedBy: userId
          }
        }
      );
    }
    throw appError('Lead has already been converted to a client', 409);
  }

  const companyName = lead.company?.trim() || lead.name;
  let company;
  try {
    company = await create(req, {
      name: companyName,
      email: lead.email || '',
      phone: lead.phone || '',
      leadId: String(leadId),
      ...(options.allowSimilarCompany === true ? { allowSimilarCompany: true } : {})
    });
  } catch (error) {
    if (!(options.linkExisting === true && error && error.code === 'CLIENT_DUPLICATE_EXACT')) throw error;
    const { match, count } = await findExistingCustomerForLead(req, lead);
    if (!match) {
      if (count > 1) {
        const ambiguous = appError(
          "This lead's email or mobile number belongs to more than one customer. Open the lead and convert it to the right customer first.",
          409
        );
        ambiguous.code = 'CLIENT_DUPLICATE_AMBIGUOUS';
        throw ambiguous;
      }
      throw error;
    }
    const existingId = String(match._id);
    const linked = await Lead.findOneAndUpdate(
      { tenantId, _id: leadId, convertedClientId: { $in: [null, ''] } },
      { $set: { convertedClientId: existingId, convertedAt: new Date(), updatedBy: userId } },
      { new: true }
    );
    if (!linked) throw appError('Lead has already been converted to a client', 409);
    await AuditService.log(req, {
      action: 'converted',
      module: 'lead',
      recordId: String(leadId),
      description: `Lead linked to existing customer ${match.name || existingId} (same email or mobile number)`,
      metadata: { clientId: existingId, linkedExisting: true }
    });
    await require('./opportunity.service').completeOpenOpportunitiesForLead(req, leadId, { exceptOpportunityId: options.exceptOpportunityId });
    return { clientId: existingId, contactId: null, company: match, contact: null, linkedExisting: true };
  }

  const clientId = company._id.toString();
  let contact;

  try {
    contact = await addContact(req, clientId, {
      name: lead.name,
      email: lead.email || '',
      phone: lead.phone || '',
      designation: '',
      isPrimary: true
    });

    const updatedLead = await Lead.findOneAndUpdate(
      {
        tenantId,
        _id: leadId,
        convertedClientId: { $in: [null, ''] }
      },
      {
        $set: {
          convertedClientId: clientId,
          convertedAt: new Date(),
          updatedBy: userId
        }
      },
      { new: true }
    );

    if (!updatedLead) {
      throw appError('Lead has already been converted to a client', 409);
    }
  } catch (error) {
    await Company.updateOne(
      { tenantId, _id: clientId },
      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
          deletedBy: userId
        }
      }
    );
    throw error;
  }

  await AuditService.log(req, {
    action: 'converted',
    module: 'lead',
    recordId: String(leadId),
    description: `Lead converted to client: ${companyName}`,
    metadata: { clientId, contactId: contact._id.toString(), leadName: lead.name }
  });
  await require('./opportunity.service').completeOpenOpportunitiesForLead(req, leadId, { exceptOpportunityId: options.exceptOpportunityId });

  return { clientId, contactId: contact._id.toString(), company, contact };
}

function getModel(req, name) {
  return req.cms?.models.get(name) || null;
}

function monthRange() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
}

/** Aggregate list-level counts for the clients index page. */
async function getListSummary(req) {
  let filter = companyFilter(req);
  if (isSalesAgentScoped(req)) {
    filter = await applySalesAgentClientListScope(req, filter, getLeadModel);
  }

  const Company = getCompanyModel(req);
  const [total, fromLead] = await Promise.all([
    Company.countDocuments(filter),
    Company.countDocuments({
      ...filter,
      leadId: { $exists: true, $nin: [null, ''] }
    })
  ]);

  return { total, fromLead };
}

/** Permission-scoped dashboard metrics for a single client detail page. */
async function getSummary(req, companyId) {
  await findCompanyOrThrow(req, companyId);

  const base = companyFilter(req);
  const clientId = String(companyId);
  const canFinance = hasPermission(req, 'crm.finance.read');
  const canProjects = hasPermission(req, 'crm.projects.read');
  const canTasks = hasPermission(req, 'crm.tasks.read');
  const canTime = hasPermission(req, 'crm.time.read');
  const canExpenses = hasPermission(req, 'crm.expenses.read');
  const canExpensesApprove = hasPermission(req, 'crm.expenses.approve');

  const Contact = getContactModel(req);
  const contactCount = await Contact.countDocuments(contactFilter(req, clientId));

  let totalProjects = 0;
  let activeProjects = 0;
  let openTasks = 0;
  let overdueTasks = 0;
  let projectIds = [];

  if (canProjects) {
    const Project = getModel(req, 'Project');
    if (Project) {
      let projectFilter = { ...base, clientId };
      if (isEmployeeScoped(req)) {
        projectFilter = await applyEmployeeProjectListScope(req, projectFilter);
      }
      [totalProjects, activeProjects] = await Promise.all([
        Project.countDocuments(projectFilter),
        Project.countDocuments({
          ...projectFilter,
          status: { $nin: ['Completed', 'Cancelled'] }
        })
      ]);
      const projectRows = await Project.find(projectFilter).select('_id').lean();
      projectIds = projectRows.map((row) => String(row._id));
    }
  }

  if (canTasks && projectIds.length) {
    const Task = getModel(req, 'Task');
    if (Task) {
      let taskFilter = { ...base, projectId: { $in: projectIds } };
      if (isEmployeeScoped(req)) {
        taskFilter = await applyEmployeeTaskListScope(req, taskFilter);
      }
      [openTasks, overdueTasks] = await Promise.all([
        Task.countDocuments({
          ...taskFilter,
          status: { $nin: ['Completed'] }
        }),
        Task.countDocuments({
          ...taskFilter,
          status: { $nin: ['Completed'] },
          dueDate: { $lt: new Date(), $ne: null }
        })
      ]);
    }
  }

  let loggedHoursThisMonth = 0;
  let billableHoursThisMonth = 0;
  let billableAmountThisMonth = 0;

  if (canTime && projectIds.length) {
    const TimeLog = getModel(req, 'TimeLog');
    if (TimeLog) {
      const { start, end } = monthRange();
      const rows = await TimeLog.find({
        ...base,
        projectId: { $in: projectIds },
        workDate: { $gte: start, $lt: end }
      })
        .select('hours billableAmount isBillable')
        .lean();

      loggedHoursThisMonth = rows.reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
      billableHoursThisMonth = rows
        .filter((row) => row.isBillable)
        .reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
      billableAmountThisMonth = rows.reduce(
        (sum, row) => sum + (Number(row.billableAmount) || 0),
        0
      );
    }
  }

  let totalQuotations = 0;
  let unpaidInvoices = 0;
  let overdueInvoices = 0;
  let outstandingBalance = 0;
  let paymentsThisMonth = 0;

  if (canFinance) {
    const Estimate = getModel(req, 'Estimate');
    if (Estimate) {
      totalQuotations = await Estimate.countDocuments({ ...base, clientId });
    }

    const Invoice = getModel(req, 'Invoice');
    if (Invoice) {
      [unpaidInvoices, overdueInvoices] = await Promise.all([
        Invoice.countDocuments({
          ...base,
          clientId,
          balanceDue: { $gt: 0 },
          status: { $nin: ['Cancelled', 'Draft'] }
        }),
        Invoice.countDocuments({
          ...base,
          clientId,
          balanceDue: { $gt: 0 },
          dueDate: { $lt: new Date() },
          status: { $nin: ['Cancelled', 'Paid', 'Draft'] }
        })
      ]);

      const unpaidRows = await Invoice.find({
        ...base,
        clientId,
        balanceDue: { $gt: 0 },
        status: { $nin: ['Cancelled', 'Draft'] }
      })
        .select('balanceDue')
        .lean();
      outstandingBalance = unpaidRows.reduce(
        (sum, row) => sum + (Number(row.balanceDue) || 0),
        0
      );
    }

    const Payment = getModel(req, 'Payment');
    if (Payment) {
      const { start, end } = monthRange();
      const paymentRows = await Payment.find({
        ...base,
        clientId,
        paymentDate: { $gte: start, $lt: end }
      })
        .select('amount')
        .lean();
      paymentsThisMonth = paymentRows.reduce(
        (sum, row) => sum + (Number(row.amount) || 0),
        0
      );
    }
  }

  let pendingExpenses = 0;
  let approvedExpensesThisMonth = 0;

  if (canExpenses) {
    const Expense = getModel(req, 'Expense');
    if (Expense) {
      if (canExpensesApprove) {
        pendingExpenses = await Expense.countDocuments({
          ...base,
          clientId,
          status: 'Submitted'
        });
      }
      const { start, end } = monthRange();
      const approvedRows = await Expense.find({
        ...base,
        clientId,
        status: 'Approved',
        expenseDate: { $gte: start, $lt: end }
      })
        .select('amount')
        .lean();
      approvedExpensesThisMonth = approvedRows.reduce(
        (sum, row) => sum + (Number(row.amount) || 0),
        0
      );
    }
  }

  const SettingService = require('./setting.service');
  const settings = await SettingService.getAll(req).catch(() => ({}));

  return {
    contactCount,
    totalProjects,
    activeProjects,
    openTasks,
    overdueTasks,
    loggedHoursThisMonth: Math.round(loggedHoursThisMonth * 100) / 100,
    billableHoursThisMonth: Math.round(billableHoursThisMonth * 100) / 100,
    billableAmountThisMonth: Math.round(billableAmountThisMonth * 100) / 100,
    totalQuotations,
    unpaidInvoices,
    overdueInvoices,
    outstandingBalance: Math.round(outstandingBalance * 100) / 100,
    paymentsThisMonth: Math.round(paymentsThisMonth * 100) / 100,
    pendingExpenses,
    approvedExpensesThisMonth: Math.round(approvedExpensesThisMonth * 100) / 100,
    defaultCurrency: settings.default_currency || 'INR'
  };
}

async function previewImport(req, { rows = [], options = {} }) {
  const { parseTags, parseCustomFields } = require('../validation/client.schema');
  const Company = getCompanyModel(req);
  const base = companyFilter(req);

  const defaultCategory = options.defaultCategory ? String(options.defaultCategory).trim() : '';
  const defaultStatus = options.defaultStatus === 'Inactive' ? 'Inactive' : 'Active';

  const results = [];
  const inBatchEmails = new Map();
  const inBatchPhones = new Map();
  const inBatchCompanyKeys = new Map();

  let validCount = 0;
  let warningCount = 0;
  let errorCount = 0;
  let duplicateCount = 0;

  for (let index = 0; index < rows.length; index++) {
    const raw = rows[index] || {};
    const rowIndex = index + 1;
    const errors = [];
    const warnings = [];
    const duplicates = [];

    const name = String(raw.name || raw['Company'] || raw['Company Name'] || raw['Name'] || raw['Organization'] || '').trim();
    const email = String(raw.email || raw['Company Email'] || raw['Email'] || raw['Email Address'] || '').trim().toLowerCase();
    const rawPhone = String(raw.phone || raw['Company Phone'] || raw['Phone'] || raw['Mobile'] || raw['Phone Number'] || raw['Contact'] || '').trim();
    const phone = rawPhone ? normalizeMobile(rawPhone) : '';
    const website = String(raw.website || raw['Website'] || raw['URL'] || '').trim();
    const taxId = String(raw.taxId || raw['Tax ID'] || raw['GSTIN'] || raw['VAT'] || raw['Tax Number'] || '').trim();
    const category = String(raw.category || raw['Category'] || raw['Client Category'] || defaultCategory).trim();
    const rawStatus = String(raw.status || raw['Status'] || raw['Client Status'] || defaultStatus).trim();
    const status = rawStatus.toLowerCase() === 'inactive' ? 'Inactive' : 'Active';

    const tags = parseTags(raw.tags || raw['Tags'] || raw['Labels']);
    const customFields = parseCustomFields(raw.customFields || raw['custom_fields'] || raw['Custom Fields']);

    const billingAddress = {
      street: String(raw.street || raw['Street'] || raw.address || raw['Address'] || raw['Billing Street'] || '').trim(),
      city: String(raw.city || raw['City'] || raw['Billing City'] || '').trim(),
      state: String(raw.state || raw['State'] || raw['Billing State'] || '').trim(),
      country: String(raw.country || raw['Country'] || raw['Billing Country'] || '').trim(),
      zip: String(raw.zip || raw['ZIP'] || raw['Zip'] || raw['Postal Code'] || raw['Billing Zip'] || '').trim()
    };

    const contactName = String(raw.contactName || raw['Contact Name'] || raw['Primary Contact'] || raw['Contact Person'] || '').trim();
    const contactEmail = String(raw.contactEmail || raw['Contact Email'] || '').trim().toLowerCase();
    const rawContactPhone = String(raw.contactPhone || raw['Contact Phone'] || raw['Contact Mobile'] || '').trim();
    const contactPhone = rawContactPhone ? normalizeMobile(rawContactPhone) : '';
    const contactDesignation = String(raw.contactDesignation || raw['Contact Designation'] || raw['Designation'] || raw['Title'] || '').trim();

    // Field-level Validation
    if (!name) errors.push('Company name is required');
    if (name && name.length > 120) errors.push('Company name must be 120 characters or fewer');
    if (email && !isValidEmail(email)) errors.push(`Invalid company email format: "${email}"`);
    if (phone && !isValidMobile(phone)) errors.push(`Invalid company mobile format: "${rawPhone}"`);
    if (website && !isValidHttpUrl(website)) errors.push(`Invalid website URL format: "${website}"`);
    if (contactEmail && !isValidEmail(contactEmail)) errors.push(`Invalid primary contact email format: "${contactEmail}"`);
    if (contactPhone && !isValidMobile(contactPhone)) errors.push(`Invalid primary contact mobile format: "${rawContactPhone}"`);

    const companyKey = name ? normalizeCompanyName(name) : '';

    // In-batch duplicate detection
    if (email) {
      if (inBatchEmails.has(email)) {
        warnings.push(`Duplicate email in this file (matches row ${inBatchEmails.get(email)})`);
        duplicateCount++;
      } else {
        inBatchEmails.set(email, rowIndex);
      }
    }
    if (phone) {
      if (inBatchPhones.has(phone)) {
        warnings.push(`Duplicate phone in this file (matches row ${inBatchPhones.get(phone)})`);
        duplicateCount++;
      } else {
        inBatchPhones.set(phone, rowIndex);
      }
    }
    if (companyKey) {
      if (inBatchCompanyKeys.has(companyKey)) {
        warnings.push(`Duplicate company name in this file (matches row ${inBatchCompanyKeys.get(companyKey)})`);
        duplicateCount++;
      } else {
        inBatchCompanyKeys.set(companyKey, rowIndex);
      }
    }

    // Database duplicate detection
    if (name || email || phone) {
      try {
        const queryOr = [];
        if (email) queryOr.push({ email });
        if (phone) queryOr.push({ phone });
        if (companyKey) queryOr.push({ companyKey });

        if (queryOr.length) {
          const existingMatches = await Company.find({
            ...base,
            $or: queryOr
          }).select('name email phone taxId').lean();

          if (existingMatches && existingMatches.length) {
            const matchDescs = existingMatches.map((m) => `${m.name} (${m.email || m.phone || m.taxId || 'existing client'})`);
            warnings.push(`Existing client found in CRM database: ${matchDescs.join('; ')}`);
            duplicates.push(...existingMatches);
            duplicateCount++;
          }
        }
      } catch (err) {
        // Continue if duplicate search encounters non-fatal issue
      }
    }

    let rowStatus = 'valid';
    if (errors.length) {
      rowStatus = 'error';
      errorCount++;
    } else if (warnings.length) {
      rowStatus = 'warning';
      warningCount++;
    } else {
      validCount++;
    }

    results.push({
      rowIndex,
      status: rowStatus,
      errors,
      warnings,
      duplicates,
      data: {
        name,
        email,
        phone,
        website,
        taxId,
        category,
        status,
        tags,
        customFields,
        billingAddress,
        primaryContact: contactName || contactEmail || contactPhone ? {
          name: contactName,
          email: contactEmail,
          phone: contactPhone,
          designation: contactDesignation
        } : null
      }
    });
  }

  return {
    totalRows: rows.length,
    validCount,
    warningCount,
    errorCount,
    duplicateCount,
    rows: results
  };
}

async function executeImport(req, { rows = [], options = {} }) {
  const { parseTags, parseCustomFields } = require('../validation/client.schema');
  const Company = getCompanyModel(req);
  const Contact = getContactModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const base = companyFilter(req);

  const skipDuplicates = options.skipDuplicates !== false;
  const allowSimilarCompany = options.allowSimilarCompany !== false;
  const allowExactDuplicate = Boolean(options.allowExactDuplicate);
  const defaultCategory = options.defaultCategory ? String(options.defaultCategory).trim() : '';
  const defaultStatus = options.defaultStatus === 'Inactive' ? 'Inactive' : 'Active';
  const createPrimaryContact = options.createPrimaryContact !== false;

  const results = [];
  let createdCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let index = 0; index < rows.length; index++) {
    const raw = rows[index] || {};
    const rowIndex = index + 1;

    try {
      const name = String(raw.name || raw['Company'] || raw['Company Name'] || raw['Name'] || raw['Organization'] || '').trim();
      const email = String(raw.email || raw['Company Email'] || raw['Email'] || raw['Email Address'] || '').trim().toLowerCase();
      const rawPhone = String(raw.phone || raw['Company Phone'] || raw['Phone'] || raw['Mobile'] || raw['Phone Number'] || raw['Contact'] || '').trim();
      const phone = rawPhone ? normalizeMobile(rawPhone) : '';
      const website = String(raw.website || raw['Website'] || raw['URL'] || '').trim();
      let taxId = String(raw.taxId || raw['Tax ID'] || raw['GSTIN'] || raw['VAT'] || raw['Tax Number'] || '').trim();
      const category = String(raw.category || raw['Category'] || raw['Client Category'] || defaultCategory).trim();
      const rawStatus = String(raw.status || raw['Status'] || raw['Client Status'] || defaultStatus).trim();
      const status = rawStatus.toLowerCase() === 'inactive' ? 'Inactive' : 'Active';

      if (!name) {
        skippedCount++;
        results.push({
          rowIndex,
          success: false,
          reason: 'Skipped: Missing required company name'
        });
        continue;
      }

      if (email && !isValidEmail(email)) {
        skippedCount++;
        results.push({
          rowIndex,
          success: false,
          reason: `Skipped: Invalid email format: "${email}"`
        });
        continue;
      }

      if (phone && !isValidMobile(phone)) {
        skippedCount++;
        results.push({
          rowIndex,
          success: false,
          reason: `Skipped: Invalid mobile format: "${rawPhone}"`
        });
        continue;
      }

      const companyKey = normalizeCompanyName(name);
      const companyTokens = buildCompanyTokens(name);

      // Check duplicates in DB
      if (email || phone || companyKey) {
        const queryOr = [];
        if (email) queryOr.push({ email });
        if (phone) queryOr.push({ phone });
        if (companyKey) queryOr.push({ companyKey });

        if (queryOr.length) {
          const existingMatches = await Company.find({
            ...base,
            $or: queryOr
          }).select('name email phone').lean();

          if (existingMatches && existingMatches.length) {
            if (skipDuplicates && !allowExactDuplicate) {
              skippedCount++;
              results.push({
                rowIndex,
                success: false,
                reason: `Skipped: Duplicate client found in database (${existingMatches.map((m) => m.name).join(', ')})`
              });
              continue;
            }
          }
        }
      }

      if (!taxId) {
        taxId = await getNextNumber(req, 'clientTaxId');
      }

      const billingAddress = raw.billingAddress && typeof raw.billingAddress === 'object' ? raw.billingAddress : {
        street: String(raw.street || raw['Street'] || raw.address || raw['Address'] || '').trim(),
        city: String(raw.city || raw['City'] || '').trim(),
        state: String(raw.state || raw['State'] || '').trim(),
        country: String(raw.country || raw['Country'] || '').trim(),
        zip: String(raw.zip || raw['ZIP'] || raw['Zip'] || raw['Postal Code'] || '').trim()
      };

      const tags = parseTags(raw.tags || raw['Tags'] || raw['Labels']);
      const customFields = parseCustomFields(raw.customFields || raw['custom_fields']);

      const companyDoc = await Company.create({
        tenantId,
        name,
        companyKey,
        companyTokens,
        email: email || '',
        phone: phone || '',
        billingAddress,
        taxId,
        website: website || '',
        status,
        category,
        tags,
        customFields,
        createdBy: userId,
        updatedBy: userId
      });

      const companyObj = companyDoc.toObject ? companyDoc.toObject() : companyDoc;
      createdCount++;

      // Create primary contact if provided
      const rawContact = raw.primaryContact || {};
      const contactName = String(rawContact.name || raw.contactName || raw['Contact Name'] || raw['Primary Contact'] || '').trim();
      const contactEmail = String(rawContact.email || raw.contactEmail || raw['Contact Email'] || '').trim().toLowerCase();
      const rawContactPhone = String(rawContact.phone || raw.contactPhone || raw['Contact Phone'] || raw['Contact Mobile'] || '').trim();
      const contactPhone = rawContactPhone ? normalizeMobile(rawContactPhone) : '';
      const contactDesignation = String(rawContact.designation || raw.contactDesignation || raw['Contact Designation'] || raw['Designation'] || raw['Title'] || '').trim();

      if (createPrimaryContact && (contactName || contactEmail || contactPhone)) {
        try {
          await Contact.create({
            tenantId,
            companyId: String(companyObj._id),
            name: contactName || name,
            email: contactEmail || email || '',
            phone: contactPhone || phone || '',
            designation: contactDesignation || 'Primary Contact',
            isPrimary: true,
            createdBy: userId,
            updatedBy: userId
          });
        } catch (contactErr) {
          // Non-fatal if contact creation has issues
        }
      }

      results.push({
        rowIndex,
        success: true,
        clientId: String(companyObj._id),
        name: companyObj.name,
        taxId: companyObj.taxId
      });

      AuditService.log(req, {
        action: 'created',
        module: 'client',
        recordId: String(companyObj._id),
        description: `Client imported via bulk import: "${companyObj.name}" (Tax ID: ${companyObj.taxId})`,
        metadata: {
          clientId: String(companyObj._id),
          name: companyObj.name,
          email: companyObj.email,
          taxId: companyObj.taxId,
          source: 'Bulk Import'
        }
      });
    } catch (err) {
      failedCount++;
      results.push({
        rowIndex,
        success: false,
        reason: err.message
      });
    }
  }

  return {
    totalProcessed: rows.length,
    createdCount,
    skippedCount,
    failedCount,
    results
  };
}

async function exportClients(req, query = {}) {
  const Company = getCompanyModel(req);
  const Contact = getContactModel(req);
  const base = companyFilter(req);
  const filter = { ...base };

  if (query.status) {
    applyClientListStatusFilter(filter, query.status);
  }
  if (query.category) {
    const c = toLiteralSearchTerm(String(query.category).trim());
    if (c) filter.category = new RegExp(`^${c}$`, 'i');
  }
  if (query.tag) {
    const t = toLiteralSearchTerm(String(query.tag).trim());
    if (t) filter.tags = new RegExp(`^${t}$`, 'i');
  }
  if (query.search) {
    const term = toLiteralSearchTerm(String(query.search).trim());
    if (term) {
      const rx = new RegExp(term, 'i');
      filter.$or = [
        { name: rx },
        { email: rx },
        { phone: rx },
        { taxId: rx },
        { category: rx },
        { tags: rx }
      ];
    }
  }
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) {
      const toDate = new Date(query.to);
      toDate.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = toDate;
    }
  }

  const clients = await Company.find(filter)
    .sort({ createdAt: -1 })
    .lean();

  // Fetch primary contacts for all matching companies
  const companyIds = clients.map((c) => String(c._id));
  const contacts = companyIds.length
    ? await Contact.find({
        tenantId: resolveTenantId(req),
        companyId: { $in: companyIds },
        isDeleted: false
      }).lean()
    : [];

  const primaryContactsByCompanyId = new Map();
  contacts.forEach((ct) => {
    const cid = String(ct.companyId);
    if (!primaryContactsByCompanyId.has(cid) || ct.isPrimary) {
      primaryContactsByCompanyId.set(cid, ct);
    }
  });

  const enrichedClients = clients.map((c) => {
    const pc = primaryContactsByCompanyId.get(String(c._id)) || null;
    return {
      ...c,
      primaryContact: pc
        ? {
            name: pc.name || '',
            email: pc.email || '',
            phone: pc.phone || '',
            designation: pc.designation || ''
          }
        : null
    };
  });

  const format = (query.format || 'csv').toLowerCase();
  const nowStr = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      format: 'json',
      filename: `clients_export_${nowStr}.json`,
      content: JSON.stringify(enrichedClients, null, 2),
      data: enrichedClients,
      count: enrichedClients.length
    };
  }

  // Flatten custom fields for CSV
  const customFieldsHeaderSet = new Set();
  enrichedClients.forEach((client) => {
    if (client.customFields && typeof client.customFields === 'object') {
      Object.keys(client.customFields).forEach((k) => customFieldsHeaderSet.add(k));
    }
  });
  const customFieldKeys = Array.from(customFieldsHeaderSet);

  const baseHeaders = [
    'ID',
    'Company Name',
    'Tax ID',
    'Status',
    'Category',
    'Company Email',
    'Company Phone',
    'Website',
    'Tags',
    'Street',
    'City',
    'State',
    'Country',
    'ZIP',
    'Primary Contact Name',
    'Primary Contact Email',
    'Primary Contact Phone',
    'Primary Contact Designation',
    'Created At',
    'Updated At'
  ];

  const allHeaders = [...baseHeaders, ...customFieldKeys.map((k) => `Custom: ${k}`)];

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const rows = [allHeaders.map(escapeCsv).join(',')];

  for (const client of enrichedClients) {
    const pc = client.primaryContact || {};
    const addr = client.billingAddress || {};
    const row = [
      client._id,
      client.name,
      client.taxId || '',
      client.status || 'Active',
      client.category || '',
      client.email || '',
      client.phone || '',
      client.website || '',
      Array.isArray(client.tags) ? client.tags.join('; ') : '',
      addr.street || '',
      addr.city || '',
      addr.state || '',
      addr.country || '',
      addr.zip || '',
      pc.name || '',
      pc.email || '',
      pc.phone || '',
      pc.designation || '',
      client.createdAt ? new Date(client.createdAt).toISOString() : '',
      client.updatedAt ? new Date(client.updatedAt).toISOString() : ''
    ];

    for (const cfKey of customFieldKeys) {
      const val = client.customFields?.[cfKey];
      row.push(val !== undefined && val !== null ? (typeof val === 'object' ? JSON.stringify(val) : String(val)) : '');
    }

        rows.push(row.map(escapeCsv).join(','));
  }

  const csvContent = rows.join('\r\n');

  return {
    contentType: 'text/csv; charset=utf-8',
    format: 'csv',
    filename: `clients_export_${nowStr}.csv`,
    content: csvContent,
    data: csvContent,
    count: enrichedClients.length
  };
}

/**
 * List all billing, shipping, and branch addresses for a client.
 */
async function listAddresses(req, clientId) {
  const company = await findCompanyOrThrow(req, clientId);
  let addresses = Array.isArray(company.addresses) ? company.addresses : [];

  // If no addresses in array, but legacy billingAddress exists with content, seed it virtually
  if (!addresses.length && company.billingAddress && (company.billingAddress.street || company.billingAddress.city)) {
    const defaultBilling = {
      _id: 'default_billing',
      type: 'billing',
      label: 'Primary Billing Address',
      street: company.billingAddress.street || '',
      city: company.billingAddress.city || '',
      state: company.billingAddress.state || '',
      country: company.billingAddress.country || 'India',
      zip: company.billingAddress.zip || '',
      isDefault: true,
      contactPerson: '',
      phone: company.phone || '',
      taxNumber: company.taxId || ''
    };
    return [defaultBilling];
  }

  return addresses;
}

/**
 * Add a new address to client company.
 */
async function addAddress(req, clientId, input) {
  const { validateClientAddress } = require('../validation/client.schema');
  const validation = validateClientAddress(input);
  if (!validation.ok) throw appError(validation.errors.join(', '));
  const newAddr = validation.value;

  const Company = getCompanyModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const company = await findCompanyOrThrow(req, clientId);

  const existingAddresses = Array.isArray(company.addresses) ? [...company.addresses] : [];

  // If this is the first address of this type, make it default
  const hasSameType = existingAddresses.some((a) => a.type === newAddr.type);
  if (!hasSameType) {
    newAddr.isDefault = true;
  }

  if (newAddr.isDefault) {
    existingAddresses.forEach((a) => {
      if (a.type === newAddr.type) a.isDefault = false;
    });
  }

  let newId;
  try {
    const mongoose = req.cms?.mongoose || require('mongoose');
    if (newAddr._id && mongoose.Types.ObjectId.isValid(newAddr._id)) {
      newId = new mongoose.Types.ObjectId(newAddr._id);
    } else if (newAddr.id && mongoose.Types.ObjectId.isValid(newAddr.id)) {
      newId = new mongoose.Types.ObjectId(newAddr.id);
    } else {
      newId = new mongoose.Types.ObjectId();
    }
  } catch {
    newId = undefined;
  }

  const addrDoc = {
    ...(newId ? { _id: newId } : {}),
    ...newAddr,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  existingAddresses.push(addrDoc);

  const updates = {
    addresses: existingAddresses,
    updatedBy: userId
  };

  if (newAddr.type === 'billing' && newAddr.isDefault) {
    updates.billingAddress = {
      street: newAddr.street || '',
      city: newAddr.city || '',
      state: newAddr.state || '',
      country: newAddr.country || 'India',
      zip: newAddr.zip || ''
    };
  } else if (newAddr.type === 'shipping' && newAddr.isDefault) {
    updates.shippingAddress = {
      street: newAddr.street || '',
      city: newAddr.city || '',
      state: newAddr.state || '',
      country: newAddr.country || 'India',
      zip: newAddr.zip || ''
    };
  }

  await Company.updateOne({ tenantId, _id: clientId }, { $set: updates });

  await AuditService.log(req, {
    action: 'client_address_created',
    module: 'client',
    recordId: String(clientId),
    description: `Added ${newAddr.type} address for client ${company.name}${newAddr.label ? ` (${newAddr.label})` : ''}`,
    metadata: { clientId, addressType: newAddr.type, label: newAddr.label }
  });

  const updatedCompany = await findCompanyOrThrow(req, clientId);
  const savedAddress = updatedCompany.addresses ? updatedCompany.addresses[updatedCompany.addresses.length - 1] : addrDoc;
  return savedAddress || addrDoc;
}

/**
 * Update an existing address by addressId.
 */
async function updateAddress(req, clientId, addressId, input) {
  const { validateClientAddress } = require('../validation/client.schema');
  const validation = validateClientAddress(input, true);
  if (!validation.ok) throw appError(validation.errors.join(', '));
  const patch = validation.value;

  const Company = getCompanyModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const company = await findCompanyOrThrow(req, clientId);

  const existingAddresses = Array.isArray(company.addresses) ? [...company.addresses] : [];
  const idx = existingAddresses.findIndex((a) => String(a._id) === String(addressId) || String(a.id) === String(addressId));

  if (idx === -1) {
    throw appError('Address not found', 404);
  }

  const current = existingAddresses[idx];
  const updatedType = patch.type || current.type;
  const isNowDefault = patch.isDefault !== undefined ? patch.isDefault : current.isDefault;

  if (isNowDefault) {
    existingAddresses.forEach((a, i) => {
      if (i !== idx && a.type === updatedType) a.isDefault = false;
    });
  }

  const merged = {
    ...(current.toObject ? current.toObject() : current),
    ...patch,
    type: updatedType,
    isDefault: isNowDefault,
    updatedAt: new Date()
  };

  existingAddresses[idx] = merged;

  const updates = {
    addresses: existingAddresses,
    updatedBy: userId
  };

  if (updatedType === 'billing' && isNowDefault) {
    updates.billingAddress = {
      street: merged.street || '',
      city: merged.city || '',
      state: merged.state || '',
      country: merged.country || 'India',
      zip: merged.zip || ''
    };
  } else if (updatedType === 'shipping' && isNowDefault) {
    updates.shippingAddress = {
      street: merged.street || '',
      city: merged.city || '',
      state: merged.state || '',
      country: merged.country || 'India',
      zip: merged.zip || ''
    };
  }

  await Company.updateOne({ tenantId, _id: clientId }, { $set: updates });

  await AuditService.log(req, {
    action: 'client_address_updated',
    module: 'client',
    recordId: String(clientId),
    description: `Updated ${updatedType} address for client ${company.name}`,
    metadata: { clientId, addressId, addressType: updatedType }
  });

  return merged;
}

/**
 * Delete an address by addressId.
 */
async function deleteAddress(req, clientId, addressId) {
  const Company = getCompanyModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const company = await findCompanyOrThrow(req, clientId);

  const existingAddresses = Array.isArray(company.addresses) ? [...company.addresses] : [];
  const target = existingAddresses.find((a) => String(a._id) === String(addressId) || String(a.id) === String(addressId));

  if (!target) {
    throw appError('Address not found', 404);
  }

  const filtered = existingAddresses.filter((a) => String(a._id) !== String(addressId) && String(a.id) !== String(addressId));

  // If deleted address was default, make next address of same type default
  if (target.isDefault && filtered.length) {
    const nextOfSameType = filtered.find((a) => a.type === target.type);
    if (nextOfSameType) nextOfSameType.isDefault = true;
  }

  await Company.updateOne(
    { tenantId, _id: clientId },
    { $set: { addresses: filtered, updatedBy: userId } }
  );

  await AuditService.log(req, {
    action: 'client_address_deleted',
    module: 'client',
    recordId: String(clientId),
    description: `Deleted address for client ${company.name}`,
    metadata: { clientId, addressId, addressType: target.type }
  });

  return { success: true, deletedAddressId: addressId };
}

/**
 * Set an address as the default for its type.
 */
async function setDefaultAddress(req, clientId, addressId, type) {
  return updateAddress(req, clientId, addressId, { isDefault: true, type });
}

/**
 * List all contracts linked to a client.
 */
async function listContractsForClient(req, clientId) {
  await findCompanyOrThrow(req, clientId);
  const tenantId = resolveTenantId(req);
  let Contract = req.cms?.models?.get('Contract');
  if (!Contract) {
    try {
      Contract = require('mongoose').model('Contract');
    } catch (_e) {
      Contract = null;
    }
  }
  if (!Contract) return [];

  return await Contract.find({
    tenantId,
    client: String(clientId),
    isDeleted: { $ne: true }
  })
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * List all Product Catalogue items historically purchased, quoted, or invoiced for this client.
 */
async function listProductsForClient(req, clientId) {
  const company = await findCompanyOrThrow(req, clientId);
  const tenantId = resolveTenantId(req);
  const strClientId = String(clientId);

  const getModel = (name) => {
    try {
      return req.cms?.models?.get(name) || require('mongoose').model(name);
    } catch (_e) {
      return null;
    }
  };

  const Estimate = getModel('Estimate');
  const SalesOrder = getModel('SalesOrder');
  const Invoice = getModel('Invoice');

  const history = [];

  // 1. Line items from Sales Orders
  if (SalesOrder) {
    try {
      const orders = await SalesOrder.find({
        tenantId,
        clientId: strClientId,
        isDeleted: { $ne: true }
      }).sort({ createdAt: -1 }).lean();

      for (const ord of orders) {
        if (Array.isArray(ord.items)) {
          for (const item of ord.items) {
            history.push({
              id: `so_${ord._id}_${item._id || item.sku || Math.random()}`,
              sourceType: 'Sales Order',
              sourceDocNumber: ord.orderNumber || 'SO',
              sourceId: ord._id,
              sku: item.sku || item.itemSku || '',
              name: item.name || item.title || item.itemName || 'Product',
              category: item.category || 'Product',
              quantity: Number(item.quantity) || 1,
              unitPrice: Number(item.unitPrice || item.price) || 0,
              total: Number(item.total || item.amount) || ((Number(item.quantity) || 1) * (Number(item.unitPrice || item.price) || 0)),
              status: ord.status || 'Active',
              date: ord.orderDate || ord.createdAt
            });
          }
        }
      }
    } catch (_e) {
      // ignore
    }
  }

  // 2. Line items from Invoices
  if (Invoice) {
    try {
      const invoices = await Invoice.find({
        tenantId,
        clientId: strClientId,
        isDeleted: { $ne: true }
      }).sort({ createdAt: -1 }).lean();

      for (const inv of invoices) {
        if (Array.isArray(inv.items)) {
          for (const item of inv.items) {
            history.push({
              id: `inv_${inv._id}_${item._id || item.sku || Math.random()}`,
              sourceType: 'Invoice',
              sourceDocNumber: inv.invoiceNumber || 'INV',
              sourceId: inv._id,
              sku: item.sku || item.itemSku || '',
              name: item.name || item.title || item.itemName || 'Item',
              category: item.category || 'Service',
              quantity: Number(item.quantity) || 1,
              unitPrice: Number(item.unitPrice || item.price) || 0,
              total: Number(item.total || item.amount) || ((Number(item.quantity) || 1) * (Number(item.unitPrice || item.price) || 0)),
              status: inv.status || 'Active',
              date: inv.issueDate || inv.createdAt
            });
          }
        }
      }
    } catch (_e) {
      // ignore
    }
  }

  // 3. Line items from Quotations / Proposals
  if (Estimate) {
    try {
      const quotes = await Estimate.find({
        tenantId,
        clientId: strClientId,
        isDeleted: { $ne: true }
      }).sort({ createdAt: -1 }).lean();

      for (const q of quotes) {
        if (Array.isArray(q.items)) {
          for (const item of q.items) {
            history.push({
              id: `qt_${q._id}_${item._id || item.sku || Math.random()}`,
              sourceType: 'Quotation',
              sourceDocNumber: q.estimateNumber || q.quotationNo || 'QUO',
              sourceId: q._id,
              sku: item.sku || item.itemSku || '',
              name: item.name || item.title || item.itemName || 'Quoted Product',
              category: item.category || 'Product',
              quantity: Number(item.quantity) || 1,
              unitPrice: Number(item.unitPrice || item.price) || 0,
              total: Number(item.total || item.amount) || ((Number(item.quantity) || 1) * (Number(item.unitPrice || item.price) || 0)),
              status: q.status || 'Draft',
              date: q.issueDate || q.createdAt
            });
          }
        }
      }
    } catch (_e) {
      // ignore
    }
  }

  // Sort descending by date
  history.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Aggregate stats
  const totalSpend = history.reduce((sum, i) => sum + (Number(i.total) || 0), 0);
  const uniqueSkus = new Set(history.map(i => i.sku || i.name).filter(Boolean));

  return {
    client: { id: company._id, name: company.name },
    summary: {
      totalItems: history.length,
      uniqueProducts: uniqueSkus.size,
      totalValue: totalSpend
    },
    items: history
  };
}

async function listTasksForClient(req, companyId) {
  const company = await findCompanyOrThrow(req, companyId);
  const tenantId = resolveTenantId(req);
  const Project = req.cms?.models.get('Project');
  const Task = req.cms?.models.get('Task');
  if (!Task) return [];

  let projectIds = [];
  if (Project) {
    const projects = await Project.find({
      tenantId,
      isDeleted: false,
      clientId: String(companyId)
    }).select('_id name').lean();
    projectIds = projects.map((p) => String(p._id));
  }

  const TaskService = require('./task.service');
  const filter = {
    tenantId,
    isDeleted: false,
    isArchived: { $ne: true },
    $or: [
      { clientId: String(companyId) },
      { projectId: { $in: projectIds } }
    ]
  };

  const tasks = await Task.find(filter).sort({ createdAt: -1 }).lean();
  return TaskService.enrichTasks ? TaskService.enrichTasks(req, tasks) : tasks;
}

async function listTimeLogsForClient(req, companyId) {
  const company = await findCompanyOrThrow(req, companyId);
  const tenantId = resolveTenantId(req);
  const Project = req.cms?.models.get('Project');
  const Task = req.cms?.models.get('Task');
  const TimeLog = req.cms?.models.get('TimeLog');
  if (!TimeLog) return [];

  let projectIds = [];
  if (Project) {
    const projects = await Project.find({
      tenantId,
      isDeleted: false,
      clientId: String(companyId)
    }).select('_id name').lean();
    projectIds = projects.map((p) => String(p._id));
  }

  let taskIds = [];
  if (Task) {
    const tasks = await Task.find({
      tenantId,
      isDeleted: false,
      $or: [
        { clientId: String(companyId) },
        { projectId: { $in: projectIds } }
      ]
    }).select('_id').lean();
    taskIds = tasks.map((t) => String(t._id));
  }

  const TimeLogService = require('./time-log.service');
  const filter = {
    tenantId,
    isDeleted: false,
    $or: [
      { clientId: String(companyId) },
      { projectId: { $in: projectIds } },
      { taskId: { $in: taskIds } }
    ]
  };

  const logs = await TimeLog.find(filter).sort({ workDate: -1, createdAt: -1 }).lean();
  return TimeLogService.enrichLogs ? TimeLogService.enrichLogs(req, logs) : logs;
}

module.exports = {
  clientSalesOrigins,
  list,
  getById,
  create,
  update,
  remove,
  listContacts,
  addContact,
  updateContact,
  removeContact,
  listQuotationsForClient,
  listInvoicesForClient,
  listPaymentsForClient,
  listContractsForClient,
  listProductsForClient,
  listTasksForClient,
  listTimeLogsForClient,
  convertFromLead,
  getListSummary,
  getSummary,
  cleanCompanyInput,
  cleanContactInput,
  previewImport,
  executeImport,
  exportClients,
  listAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress
};
