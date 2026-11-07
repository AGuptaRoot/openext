'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const {
  assertLeadWriteAccess,
  assertClientWriteAccess,
  isSalesAgentScoped,
  userOwnsClient
} = require('../utils/sales-access.util');
const {
  normalizeCompanyName,
  buildCompanyTokens,
  companySimilarity,
  COMPANY_SIMILARITY_THRESHOLD
} = require('../utils/lead-duplicate.util');
const AuditService = require('./audit.service');

const LEAD_MERGE_FIELDS = [
  'name', 'salutation', 'jobTitle', 'gender', 'leadType', 'requestType', 'email', 'phone',
  'company', 'pan', 'stage', 'source', 'assignedTo', 'notes', 'photoUrl', 'address',
  'latitude', 'longitude', 'locationCapturedAt'
];
const CLIENT_MERGE_FIELDS = ['name', 'email', 'phone', 'website', 'billingAddress', 'leadId'];

function appError(message, status = 400, code = '') {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function getModel(req, name) {
  const Model = req.cms?.models.get(name);
  if (!Model) throw appError(`${name} model is not registered`, 500);
  return Model;
}

function activeFilter(req) {
  return {
    tenantId: resolveTenantId(req),
    isDeleted: false,
    mergedIntoId: null
  };
}

function selectedUpdates(primary, secondary, fieldSources, fields) {
  const updates = {};
  for (const field of fields) {
    const primaryValue = primary?.[field];
    const secondaryValue = secondary?.[field];
    const primaryEmpty =
      primaryValue === undefined || primaryValue === null || String(primaryValue).trim() === '';
    if (fieldSources?.[field] === 'secondary' || (fieldSources?.[field] === undefined && primaryEmpty)) {
      if (secondaryValue !== undefined) updates[field] = secondaryValue;
    }
  }
  return updates;
}

function mergeSourceIds(primary, secondary) {
  return [
    String(secondary._id),
    ...(Array.isArray(secondary.mergedFromIds) ? secondary.mergedFromIds.map(String) : []),
    ...(Array.isArray(primary.mergedFromIds) ? primary.mergedFromIds.map(String) : [])
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function isTransactionUnsupported(error) {
  const message = String(error?.message || '');
  return error?.code === 20 || /transaction numbers are only allowed|replica set|transactions are not supported/i.test(message);
}

async function runTransaction(Model, work) {
  if (!Model?.db?.startSession) {
    throw appError('Database transactions are unavailable; merge was not started', 503, 'MERGE_TRANSACTION_REQUIRED');
  }
  const session = await Model.db.startSession();
  let result;
  try {
    if (typeof session?.withTransaction !== 'function') {
      throw appError('Database transactions are unavailable; merge was not started', 503, 'MERGE_TRANSACTION_REQUIRED');
    }
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    if (isTransactionUnsupported(error)) {
      throw appError(
        'This database must use a MongoDB replica set before records can be merged safely',
        503,
        'MERGE_TRANSACTION_REQUIRED'
      );
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function updateRelation(Model, filter, update, session) {
  if (!Model) return 0;
  const result = await Model.updateMany(filter, update, { session });
  return Number(result?.modifiedCount ?? result?.nModified ?? 0);
}

async function getLeadMergeCandidates(req, primaryId) {
  const Lead = getModel(req, 'Lead');
  const primary = await Lead.findOne({ ...activeFilter(req), _id: primaryId }).lean();
  if (!primary) throw appError('Lead not found', 404);
  assertLeadWriteAccess(req, primary);

  const LeadService = require('./lead.service');
  const result = await LeadService.findDuplicates(req, primary, { excludeId: primaryId });
  return result.matches.filter((match) => !match.restricted && match.id);
}

function clientDuplicateReasons(input, candidate) {
  const reasons = [];
  if (input.email && input.email === String(candidate.email || '').trim().toLowerCase()) reasons.push('email');
  if (input.phone && input.phone === String(candidate.phone || '').trim()) reasons.push('mobile');
  const similarity = companySimilarity(input.name, candidate.name);
  if (input.name && similarity >= COMPANY_SIMILARITY_THRESHOLD) reasons.push('company');
  return { reasons, similarity };
}

async function findClientDuplicates(req, input, options = {}) {
  const Company = getModel(req, 'Company');
  const tenantId = resolveTenantId(req);
  const normalized = {
    name: String(input?.name || '').trim(),
    email: String(input?.email || '').trim().toLowerCase(),
    phone: String(input?.phone || '').trim()
  };
  const filter = { tenantId, isDeleted: false, mergedIntoId: null };
  const excludeId = String(options.excludeId || '').trim();
  if (excludeId) filter._id = { $ne: excludeId };

  const exact = [];
  if (normalized.email) exact.push({ email: normalized.email });
  if (normalized.phone) exact.push({ phone: normalized.phone });
  const tokens = buildCompanyTokens(normalized.name);
  const projection = '_id name email phone taxId website billingAddress leadId companyKey createdAt';
  const [exactRows, companyRows] = await Promise.all([
    exact.length
      ? Company.find({ ...filter, $or: exact }).select(projection).limit(50).lean()
      : [],
    tokens.length
      ? Company.find({ ...filter, companyTokens: { $in: tokens } })
          .select(projection)
          .limit(100)
          .lean()
      : []
  ]);
  const rows = new Map([...exactRows, ...companyRows].map((row) => [String(row._id), row]));
  const matches = [];
  for (const row of rows.values()) {
      const duplicate = clientDuplicateReasons(normalized, row);
      if (!duplicate.reasons.length) continue;
      const visible =
        !isSalesAgentScoped(req) ||
        await userOwnsClient(req, row, (request) => request.cms?.models.get('Lead'));
      matches.push({
        id: visible ? String(row._id) : null,
        name: visible ? row.name : 'Existing customer',
        email: visible ? row.email || '' : '',
        phone: visible ? row.phone || '' : '',
        taxId: visible ? row.taxId || '' : '',
        website: visible ? row.website || '' : '',
        billingAddress: visible ? row.billingAddress || {} : {},
        leadId: visible ? row.leadId || null : null,
        createdAt: visible ? row.createdAt || null : null,
        reasons: duplicate.reasons,
        companySimilarity: Number(duplicate.similarity.toFixed(3)),
        restricted: !visible
      });
  }
  return matches
    .sort((left, right) => right.companySimilarity - left.companySimilarity)
    .slice(0, 20);
}

async function getClientMergeCandidates(req, primaryId) {
  const Company = getModel(req, 'Company');
  const primary = await Company.findOne({ ...activeFilter(req), _id: primaryId }).lean();
  if (!primary) throw appError('Client not found', 404);
  await assertClientWriteAccess(req, primary, (request) => request.cms?.models.get('Lead'));
  return findClientDuplicates(req, primary, { excludeId: primaryId });
}

async function mergeLead(req, primaryId, input) {
  const Lead = getModel(req, 'Lead');
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const secondaryId = String(input.secondaryId);
  if (String(primaryId) === secondaryId) throw appError('A lead cannot be merged into itself', 409);

  const result = await runTransaction(Lead, async (session) => {
    const [primary, secondary] = await Promise.all([
      Lead.findOne({ tenantId, isDeleted: false, mergedIntoId: null, _id: primaryId }).session(session).lean(),
      Lead.findOne({ tenantId, isDeleted: false, mergedIntoId: null, _id: secondaryId }).session(session).lean()
    ]);
    if (!primary || !secondary) throw appError('One of the selected leads is unavailable', 404);
    assertLeadWriteAccess(req, primary);
    assertLeadWriteAccess(req, secondary);
    if (primary.convertedClientId || secondary.convertedClientId) {
      throw appError('Converted leads cannot be merged; merge their customer records instead', 409);
    }

    const updates = selectedUpdates(primary, secondary, input.fieldSources, LEAD_MERGE_FIELDS);
    if (updates.company !== undefined) {
      updates.companyKey = normalizeCompanyName(updates.company);
      updates.companyTokens = buildCompanyTokens(updates.company);
    }
    updates.updatedBy = userId;
    updates.mergedFromIds = mergeSourceIds(primary, secondary);

    const relationSpecs = [
      ['LeadEvent', 'leadId'],
      ['FollowUp', 'leadId'],
      ['LeadAttachment', 'leadId'],
      ['Estimate', 'leadId']
    ];
    const moved = {};
    for (const [modelName, field] of relationSpecs) {
      moved[modelName] = await updateRelation(
        req.cms?.models.get(modelName),
        { tenantId, [field]: secondaryId },
        { $set: { [field]: String(primaryId), updatedBy: userId } },
        session
      );
    }

    const target = await Lead.findOneAndUpdate(
      { tenantId, isDeleted: false, mergedIntoId: null, _id: primaryId },
      { $set: updates },
      { new: true, runValidators: true, session }
    ).lean();
    const source = await Lead.findOneAndUpdate(
      { tenantId, isDeleted: false, mergedIntoId: null, _id: secondaryId },
      {
        $set: {
          mergedIntoId: String(primaryId),
          mergedAt: new Date(),
          mergedBy: userId,
          status: 'merged',
          updatedBy: userId
        }
      },
      { new: true, session }
    ).lean();
    if (!target || !source) throw appError('Merge conflict detected; no records were changed', 409);
    return { primary: target, secondary: source, moved };
  });

  const metadata = {
    secondaryId,
    fieldSources: input.fieldSources,
    reason: input.reason,
    moved: result.moved
  };
  await Promise.all([
    AuditService.log(req, {
      action: 'merged_primary', module: 'lead', recordId: String(primaryId),
      description: `Lead merged into primary record: ${result.primary.name}`, metadata
    }),
    AuditService.log(req, {
      action: 'merged_secondary', module: 'lead', recordId: secondaryId,
      description: `Lead merged into ${result.primary.name}`, metadata: { ...metadata, primaryId: String(primaryId) }
    })
  ]);
  return result;
}

async function mergeClient(req, primaryId, input) {
  const Company = getModel(req, 'Company');
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const secondaryId = String(input.secondaryId);
  if (String(primaryId) === secondaryId) throw appError('A client cannot be merged into itself', 409);

  const result = await runTransaction(Company, async (session) => {
    const [primary, secondary] = await Promise.all([
      Company.findOne({ tenantId, isDeleted: false, mergedIntoId: null, _id: primaryId }).session(session).lean(),
      Company.findOne({ tenantId, isDeleted: false, mergedIntoId: null, _id: secondaryId }).session(session).lean()
    ]);
    if (!primary || !secondary) throw appError('One of the selected clients is unavailable', 404);
    const getLead = (request) => request.cms?.models.get('Lead');
    await assertClientWriteAccess(req, primary, getLead);
    await assertClientWriteAccess(req, secondary, getLead);

    const updates = selectedUpdates(primary, secondary, input.fieldSources, CLIENT_MERGE_FIELDS);
    if (updates.name !== undefined) {
      updates.companyKey = normalizeCompanyName(updates.name);
      updates.companyTokens = buildCompanyTokens(updates.name);
    }
    updates.updatedBy = userId;
    updates.mergedFromIds = mergeSourceIds(primary, secondary);

    const Contact = req.cms?.models.get('Contact');
    const existingPrimaryContact = Contact
      ? await Contact.findOne({
          tenantId, companyId: String(primaryId), isDeleted: false, isPrimary: true
        }).sort({ createdAt: 1 }).session(session).lean()
      : null;

    const relationSpecs = [
      ['Contact', 'companyId'],
      ['Project', 'clientId'],
      ['Estimate', 'clientId'],
      ['Invoice', 'clientId'],
      ['Payment', 'clientId'],
      ['Expense', 'clientId']
    ];
    const moved = {};
    for (const [modelName, field] of relationSpecs) {
      moved[modelName] = await updateRelation(
        req.cms?.models.get(modelName),
        { tenantId, [field]: secondaryId },
        { $set: { [field]: String(primaryId), updatedBy: userId } },
        session
      );
    }
    moved.convertedLeads = await updateRelation(
      req.cms?.models.get('Lead'),
      { tenantId, convertedClientId: secondaryId },
      { $set: { convertedClientId: String(primaryId), updatedBy: userId } },
      session
    );

    if (Contact) {
      const primaryContact = existingPrimaryContact || await Contact.findOne({
        tenantId, companyId: String(primaryId), isDeleted: false
      }).sort({ isPrimary: -1, createdAt: 1 }).session(session).lean();
      await Contact.updateMany(
        { tenantId, companyId: String(primaryId), isDeleted: false },
        { $set: { isPrimary: false, updatedBy: userId } },
        { session }
      );
      if (primaryContact) {
        await Contact.updateOne(
          { tenantId, _id: primaryContact._id },
          { $set: { isPrimary: true, updatedBy: userId } },
          { session }
        );
      }
    }

    const target = await Company.findOneAndUpdate(
      { tenantId, isDeleted: false, mergedIntoId: null, _id: primaryId },
      { $set: updates },
      { new: true, runValidators: true, session }
    ).lean();
    const source = await Company.findOneAndUpdate(
      { tenantId, isDeleted: false, mergedIntoId: null, _id: secondaryId },
      {
        $set: {
          mergedIntoId: String(primaryId), mergedAt: new Date(), mergedBy: userId,
          status: 'merged', updatedBy: userId
        }
      },
      { new: true, session }
    ).lean();
    if (!target || !source) throw appError('Merge conflict detected; no records were changed', 409);
    return { primary: target, secondary: source, moved };
  });

  const metadata = {
    secondaryId,
    fieldSources: input.fieldSources,
    reason: input.reason,
    moved: result.moved
  };
  await Promise.all([
    AuditService.log(req, {
      action: 'merged_primary', module: 'client', recordId: String(primaryId),
      description: `Client merged into primary record: ${result.primary.name}`, metadata
    }),
    AuditService.log(req, {
      action: 'merged_secondary', module: 'client', recordId: secondaryId,
      description: `Client merged into ${result.primary.name}`, metadata: { ...metadata, primaryId: String(primaryId) }
    })
  ]);
  return result;
}

module.exports = {
  LEAD_MERGE_FIELDS,
  CLIENT_MERGE_FIELDS,
  findClientDuplicates,
  getLeadMergeCandidates,
  getClientMergeCandidates,
  mergeLead,
  mergeClient
};
