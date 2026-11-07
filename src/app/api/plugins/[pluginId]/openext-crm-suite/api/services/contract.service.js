'use strict';

const { resolveTenantId, resolveUserId, applyClientScope } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const AuditService = require('./audit.service');

function getContractModel(req) {
  const Contract = req.cms?.models.get('Contract');
  if (!Contract) throw new Error('Contract model is not registered');
  return Contract;
}

function baseFilter(req) {
  const filter = { tenantId: resolveTenantId(req), isDeleted: false };
  return applyClientScope(req, filter, 'clientId');
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function generateContractNumber() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `CNT-${year}${month}-${rand}`;
}

async function list(req) {
  const Contract = getContractModel(req);
  const { page, limit, skip, sort } = parsePagination(req.query);
  const filter = baseFilter(req);

  if (req.query?.leadId) {
    filter.leadId = String(req.query.leadId).trim();
  }
  if (req.query?.clientId) {
    filter.clientId = String(req.query.clientId).trim();
  }
  if (req.query?.status) {
    filter.status = String(req.query.status).trim();
  }
  if (req.query?.search) {
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      filter.$or = [
        { contractNumber: { $regex: term, $options: 'i' } },
        { subject: { $regex: term, $options: 'i' } },
        { clientName: { $regex: term, $options: 'i' } },
        { contactPerson: { $regex: term, $options: 'i' } }
      ];
    }
  }

  const [items, total] = await Promise.all([
    Contract.find(filter).sort(sort || { createdAt: -1 }).skip(skip).limit(limit).lean(),
    Contract.countDocuments(filter)
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

async function getById(req, id) {
  const Contract = getContractModel(req);
  const contract = await Contract.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!contract) throw appError('Contract not found', 404);
  return contract;
}

async function create(req, input) {
  const Contract = getContractModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const SettingService = require('./setting.service');
  const { resolveRecordCurrency } = require('../utils/record-currency.util');

  if (!input.clientName) throw appError('Client / Company name is required');
  if (!input.subject) throw appError('Subject is required');

  const contractNumber = input.contractNumber
    ? String(input.contractNumber).trim().toUpperCase()
    : generateContractNumber();

  const rawProducts = Array.isArray(input.products) ? input.products : [];
  const products = rawProducts.map((p) => {
    const unitPrice = Math.max(0, Number(p.unitPrice) || 0);
    const quantity = Math.max(1, Number(p.quantity) || 1);
    return {
      productId: String(p.productId || ''),
      sku: String(p.sku || ''),
      productName: String(p.productName || 'Item'),
      description: String(p.description || ''),
      unitPrice,
      quantity,
      totalValue: p.totalValue !== undefined ? Math.max(0, Number(p.totalValue)) : unitPrice * quantity
    };
  });

  const calculatedValue = products.length
    ? products.reduce((sum, item) => sum + (Number(item.totalValue) || 0), 0)
    : Math.max(0, Number(input.value) || 0);

  const settings = await SettingService.getAll(req);
  const currency = resolveRecordCurrency(input, settings);

  const contract = await Contract.create({
    tenantId,
    contractNumber,
    leadId: input.leadId ? String(input.leadId).trim() : null,
    clientId: input.clientId ? String(input.clientId).trim() : null,
    clientName: String(input.clientName).trim(),
    contactPerson: input.contactPerson ? String(input.contactPerson).trim() : '',
    contactEmail: input.contactEmail ? String(input.contactEmail).trim().toLowerCase() : '',
    contactPhone: input.contactPhone ? String(input.contactPhone).trim() : '',
    subject: String(input.subject).trim(),
    contractType: input.contractType || 'Master Services Agreement',
    value: calculatedValue,
    currency,
    startDate: input.startDate ? new Date(input.startDate) : null,
    endDate: input.endDate ? new Date(input.endDate) : null,
    renewalDate: input.renewalDate ? new Date(input.renewalDate) : null,
    status: input.status || 'Draft',
    terms: input.terms ? String(input.terms).trim() : '',
    products,
    notes: input.notes ? String(input.notes).trim() : '',
    createdBy: userId,
    updatedBy: userId
  });

  const doc = contract.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'contract',
    recordId: doc._id.toString(),
    description: `Contract generated: ${doc.contractNumber} (${doc.subject}) for ${doc.clientName}`
  });

  return doc;
}

/**
 * Direct factory method: Create and connect a Contract directly from a qualified Lead
 */
async function createFromLead(req, leadId, input = {}) {
  const Lead = req.cms?.models.get('Lead');
  if (!Lead) throw appError('Lead model is not registered', 500);

  const lead = await Lead.findOne({ tenantId: resolveTenantId(req), _id: leadId, isDeleted: false }).lean();
  if (!lead) throw appError('Lead not found', 404);

  const leadProducts = Array.isArray(lead.interestedProducts) ? lead.interestedProducts : [];
  const products = (Array.isArray(input.products) && input.products.length)
    ? input.products
    : leadProducts.map((p) => ({
        productId: p.productId,
        sku: p.sku,
        productName: p.productName,
        unitPrice: p.unitPrice,
        quantity: p.quantity,
        totalValue: p.totalValue || (p.unitPrice * p.quantity)
      }));

  const value = input.value !== undefined
    ? Number(input.value)
    : (lead.qualification?.expectedRevenue || (products.length ? products.reduce((s, p) => s + (p.totalValue || 0), 0) : 0));

  const contract = await create(req, {
    leadId: String(lead._id),
    clientId: lead.convertedClientId || null,
    clientName: lead.company || lead.name,
    contactPerson: lead.name,
    contactEmail: lead.email,
    contactPhone: lead.phone,
    subject: input.subject || `Service & Delivery Agreement - ${lead.company}`,
    contractType: input.contractType || lead.qualification?.contractType || 'Master Services Agreement',
    value,
    currency: input.currency || input.currencyCode || undefined,
    startDate: input.startDate || new Date(),
    endDate: input.endDate || new Date(Date.now() + 365 * 86400000), // 1 year default
    renewalDate: input.renewalDate || null,
    terms: input.terms || `Standard commercial terms, SLA guarantees, and payment schedule for ${lead.company}.`,
    products,
    notes: input.notes || `Drafted from qualified lead (${lead.name} · ${lead.company})`
  });

  // Update lead qualification contract status
  await Lead.updateOne(
    { _id: leadId, tenantId: resolveTenantId(req) },
    {
      $set: {
        'qualification.contractRequired': true,
        'qualification.contractType': contract.contractType,
        'qualification.updatedAt': new Date(),
        'qualification.updatedBy': resolveUserId(req)
      }
    }
  );

  return contract;
}

async function update(req, id, input) {
  const Contract = getContractModel(req);
  const userId = resolveUserId(req);

  const existing = await Contract.findOne({ ...baseFilter(req), _id: id });
  if (!existing) throw appError('Contract not found', 404);

  const updates = { updatedBy: userId };

  if (input.clientName !== undefined) updates.clientName = String(input.clientName).trim();
  if (input.contactPerson !== undefined) updates.contactPerson = String(input.contactPerson).trim();
  if (input.contactEmail !== undefined) updates.contactEmail = String(input.contactEmail).trim();
  if (input.contactPhone !== undefined) updates.contactPhone = String(input.contactPhone).trim();
  if (input.subject !== undefined) updates.subject = String(input.subject).trim();
  if (input.contractType !== undefined) updates.contractType = input.contractType;
  if (input.currency !== undefined) updates.currency = String(input.currency).trim().toUpperCase();
  if (input.startDate !== undefined) updates.startDate = input.startDate ? new Date(input.startDate) : null;
  if (input.endDate !== undefined) updates.endDate = input.endDate ? new Date(input.endDate) : null;
  if (input.renewalDate !== undefined) updates.renewalDate = input.renewalDate ? new Date(input.renewalDate) : null;
  if (input.terms !== undefined) updates.terms = String(input.terms).trim();
  if (input.notes !== undefined) updates.notes = String(input.notes).trim();
  if (input.status !== undefined) updates.status = input.status;

  if (input.products !== undefined && Array.isArray(input.products)) {
    updates.products = input.products.map((p) => {
      const unitPrice = Math.max(0, Number(p.unitPrice) || 0);
      const quantity = Math.max(1, Number(p.quantity) || 1);
      return {
        productId: String(p.productId || ''),
        sku: String(p.sku || ''),
        productName: String(p.productName || 'Item'),
        description: String(p.description || ''),
        unitPrice,
        quantity,
        totalValue: p.totalValue !== undefined ? Math.max(0, Number(p.totalValue)) : unitPrice * quantity
      };
    });
    updates.value = updates.products.reduce((sum, item) => sum + (Number(item.totalValue) || 0), 0);
  } else if (input.value !== undefined) {
    updates.value = Math.max(0, Number(input.value));
  }

  const updated = await Contract.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'contract',
    recordId: String(id),
    description: `Contract updated: ${updated.contractNumber}`
  });

  return updated;
}

async function changeStatus(req, id, status, notes = '') {
  const valid = ['Draft', 'Sent', 'Under Review', 'Accepted', 'Declined', 'Active', 'Expired'];
  if (!valid.includes(status)) throw appError(`Invalid status. Must be one of: ${valid.join(', ')}`);

  return update(req, id, { status, notes });
}

async function sign(req, id, { signerName, signerEmail, signatureData }) {
  const Contract = getContractModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const existing = await Contract.findOne({ tenantId, _id: id, isDeleted: false });
  if (!existing) throw appError('Contract not found', 404);

  const now = new Date();
  const signerIp = req.ip || req.headers?.['x-forwarded-for'] || '127.0.0.1';

  const updated = await Contract.findOneAndUpdate(
    { tenantId, _id: id },
    {
      $set: {
        status: 'Active',
        signerName: String(signerName || existing.contactPerson || 'Authorized Signer').trim(),
        signerEmail: String(signerEmail || existing.contactEmail || '').trim(),
        signedAt: now,
        signerIp: String(signerIp),
        signatureData: signatureData || `SIGNED_${now.getTime()}`,
        updatedBy: userId
      }
    },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'contract_signed',
    module: 'contract',
    recordId: String(id),
    description: `Contract ${updated.contractNumber} signed electronically by ${updated.signerName} (${signerIp})`
  });

  return updated;
}

async function remove(req, id) {
  const Contract = getContractModel(req);
  const userId = resolveUserId(req);

  const existing = await Contract.findOne({ ...baseFilter(req), _id: id });
  if (!existing) throw appError('Contract not found', 404);

  await Contract.updateOne(
    { ...baseFilter(req), _id: id },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId } }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'contract',
    recordId: String(id),
    description: `Contract removed: ${existing.contractNumber}`
  });

  return { success: true, message: 'Contract deleted' };
}

module.exports = {
  list,
  getById,
  create,
  createFromLead,
  update,
  changeStatus,
  sign,
  remove
};
