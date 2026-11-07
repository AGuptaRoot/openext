'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getTemplateModel(req) {
  const EstimateTemplate = req.cms?.models.get('EstimateTemplate');
  if (!EstimateTemplate) throw appError('EstimateTemplate model is not registered', 500);
  return EstimateTemplate;
}

function getEstimateModel(req) {
  const Estimate = req.cms?.models.get('Estimate');
  if (!Estimate) throw appError('Estimate model is not registered', 500);
  return Estimate;
}

async function listTemplates(req) {
  const tenantId = resolveTenantId(req);
  const EstimateTemplate = getTemplateModel(req);

  const filter = { tenantId, isDeleted: false };
  if (req.query?.category) {
    filter.category = String(req.query.category).trim();
  }
  if (req.query?.search) {
    const term = String(req.query.search).trim();
    filter.$or = [
      { name: { $regex: term, $options: 'i' } },
      { description: { $regex: term, $options: 'i' } }
    ];
  }

  const items = await EstimateTemplate.find(filter)
    .sort({ isDefault: -1, createdAt: -1 })
    .lean();

  return items;
}

async function getTemplateById(req, id) {
  const tenantId = resolveTenantId(req);
  const EstimateTemplate = getTemplateModel(req);

  const template = await EstimateTemplate.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!template) throw appError('Quotation template not found', 404);
  return template;
}

/** Template lines: extension columns checked like quotations; line references never kept (they point at one lead). */
async function templateLines(req, items) {
  if (!Array.isArray(items)) return [];
  const cleaned = await require('./sales-flow.service').cleanLineExtras(req, items);
  return cleaned.map((line) => {
    if (!line || typeof line !== 'object') return line;
    const { sourceRef, selected, ...rest } = line; // eslint-disable-line no-unused-vars
    return rest;
  });
}

function templateSections(raw) {
  const errors = [];
  const sections = require('../validation/finance.schema').validateSections(errors, raw);
  if (errors.length) throw appError(errors[0], 400);
  return sections;
}

async function createTemplate(req, payload = {}) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const EstimateTemplate = getTemplateModel(req);
  const SettingService = require('./setting.service');
  const settings = await SettingService.getAll(req);
  const defaultCurrency = String(settings.default_currency || 'INR').trim().toUpperCase() || 'INR';

  const name = String(payload.name || '').trim();
  if (!name) throw appError('Template name is required', 400);

  const docData = {
    tenantId,
    name,
    description: String(payload.description || '').trim(),
    category: String(payload.category || 'General').trim(),
    currency: String(payload.currency || defaultCurrency).trim().toUpperCase(),
    taxCalculation: payload.taxCalculation === 'before_discount' ? 'before_discount' : 'after_discount',
    lineItems: await templateLines(req, payload.lineItems),
    sections: templateSections(payload.sections),
    discountPercent: Math.min(100, Math.max(0, Number(payload.discountPercent) || 0)),
    shippingState: String(payload.shippingState || '').trim(),
    notes: String(payload.notes || '').trim(),
    recipientNotes: String(payload.recipientNotes || '').trim(),
    terms: String(payload.terms || '').trim(),
    isDefault: Boolean(payload.isDefault),
    createdBy: userId,
    updatedBy: userId
  };

  const created = await EstimateTemplate.create(docData);
  const doc = created.toObject ? created.toObject() : created;

  await AuditService.log(req, {
    action: 'created',
    module: 'quotation_template',
    recordId: doc._id.toString(),
    description: `Created quotation template "${name}"`,
    metadata: { name, category: doc.category, lineItemCount: doc.lineItems.length }
  });

  return doc;
}

async function updateTemplate(req, id, payload = {}) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const EstimateTemplate = getTemplateModel(req);

  const existing = await EstimateTemplate.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!existing) throw appError('Quotation template not found', 404);

  const updates = { updatedBy: userId };
  if (payload.name !== undefined) updates.name = String(payload.name).trim();
  if (payload.description !== undefined) updates.description = String(payload.description).trim();
  if (payload.category !== undefined) updates.category = String(payload.category).trim();
  if (payload.currency !== undefined) updates.currency = String(payload.currency).trim().toUpperCase();
  if (payload.taxCalculation !== undefined) updates.taxCalculation = payload.taxCalculation;
  if (payload.lineItems !== undefined) updates.lineItems = await templateLines(req, payload.lineItems);
  if (payload.sections !== undefined) updates.sections = templateSections(payload.sections);
  if (payload.discountPercent !== undefined) updates.discountPercent = Number(payload.discountPercent) || 0;
  if (payload.shippingState !== undefined) updates.shippingState = String(payload.shippingState).trim();
  if (payload.notes !== undefined) updates.notes = String(payload.notes).trim();
  if (payload.recipientNotes !== undefined) updates.recipientNotes = String(payload.recipientNotes).trim();
  if (payload.terms !== undefined) updates.terms = String(payload.terms).trim();
  if (payload.isDefault !== undefined) updates.isDefault = Boolean(payload.isDefault);

  const query = EstimateTemplate.findOneAndUpdate(
    { _id: id, tenantId, isDeleted: false },
    { $set: updates },
    { new: true }
  );
  const updated = typeof query?.lean === 'function' ? await query.lean() : await query;

  await AuditService.log(req, {
    action: 'updated',
    module: 'quotation_template',
    recordId: String(id),
    description: `Updated quotation template "${updated.name}"`
  });

  return updated;
}

async function deleteTemplate(req, id) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const EstimateTemplate = getTemplateModel(req);

  const existing = await EstimateTemplate.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!existing) throw appError('Quotation template not found', 404);

  await EstimateTemplate.updateOne(
    { _id: id, tenantId },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId, updatedBy: userId } }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'quotation_template',
    recordId: String(id),
    description: `Deleted quotation template "${existing.name}"`
  });

  return { success: true, id };
}

async function saveAsTemplate(req, quotationId, options = {}) {
  const tenantId = resolveTenantId(req);
  const Estimate = getEstimateModel(req);

  const quote = await Estimate.findOne({ _id: quotationId, tenantId, isDeleted: false }).lean();
  if (!quote) throw appError('Source quotation not found', 404);

  const templatePayload = {
    name: options.name || `${quote.title || quote.quotationNo} (Template)`,
    description: options.description || quote.description || '',
    category: options.category || 'Standard',
    currency: quote.currency || 'INR',
    taxCalculation: quote.taxCalculation || 'after_discount',
    lineItems: quote.lineItems || [],
    discountPercent: quote.discountPercent || 0,
    shippingState: quote.shippingState || '',
    notes: quote.notes || '',
    recipientNotes: quote.recipientNotes || '',
    terms: quote.terms || '',
    sections: Array.isArray(quote.sections) ? quote.sections : []
  };

  return createTemplate(req, templatePayload);
}

module.exports = {
  listTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  saveAsTemplate
};
