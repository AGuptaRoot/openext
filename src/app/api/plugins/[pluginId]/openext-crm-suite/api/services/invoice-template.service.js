'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getTemplateModel(req) {
  const InvoiceTemplate = req.cms?.models.get('InvoiceTemplate');
  if (!InvoiceTemplate) throw appError('InvoiceTemplate model is not registered', 500);
  return InvoiceTemplate;
}

function getInvoiceModel(req) {
  const Invoice = req.cms?.models.get('Invoice');
  if (!Invoice) throw appError('Invoice model is not registered', 500);
  return Invoice;
}

async function listTemplates(req) {
  const tenantId = resolveTenantId(req);
  const InvoiceTemplate = getTemplateModel(req);

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

  const items = await InvoiceTemplate.find(filter)
    .sort({ isDefault: -1, createdAt: -1 })
    .lean();

  return items;
}

async function getTemplateById(req, id) {
  const tenantId = resolveTenantId(req);
  const InvoiceTemplate = getTemplateModel(req);

  const template = await InvoiceTemplate.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!template) throw appError('Invoice template not found', 404);
  return template;
}

async function createTemplate(req, payload = {}) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const InvoiceTemplate = getTemplateModel(req);
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
    paymentTermsDays: Number(payload.paymentTermsDays || 30),
    taxCalculation: payload.taxCalculation === 'before_discount' ? 'before_discount' : 'after_discount',
    lineItems: Array.isArray(payload.lineItems) ? payload.lineItems : [],
    discountType: payload.discountType === 'amount' ? 'amount' : 'percent',
    discountPercent: Math.min(100, Math.max(0, Number(payload.discountPercent) || 0)),
    discountAmount: Math.max(0, Number(payload.discountAmount) || 0),
    paymentDetails: String(payload.paymentDetails || '').trim(),
    billingAddress: String(payload.billingAddress || '').trim(),
    shippingAddress: String(payload.shippingAddress || '').trim(),
    shippingState: String(payload.shippingState || '').trim(),
    shippingCharge: Math.max(0, Number(payload.shippingCharge) || 0),
    tags: Array.isArray(payload.tags) ? payload.tags : (typeof payload.tags === 'string' ? payload.tags.split(',').map((t) => t.trim()).filter(Boolean) : []),
    notes: String(payload.notes || '').trim(),
    recipientNotes: String(payload.recipientNotes || '').trim(),
    adminNotes: String(payload.adminNotes || '').trim(),
    terms: String(payload.terms || '').trim(),
    reminder: payload.reminder && typeof payload.reminder === 'object' ? {
      enabled: Boolean(payload.reminder.enabled),
      timing: payload.reminder.timing === 'before_due_date' ? 'before_due_date' : 'after_due_date',
      count: Math.max(1, Number(payload.reminder.count) || 1),
      days: Math.max(1, Number(payload.reminder.days) || 3)
    } : { enabled: false, timing: 'after_due_date', count: 1, days: 3 },
    isDefault: Boolean(payload.isDefault),
    createdBy: userId,
    updatedBy: userId
  };

  const created = await InvoiceTemplate.create(docData);
  const doc = created.toObject ? created.toObject() : created;

  await AuditService.log(req, {
    action: 'created',
    module: 'invoice_template',
    recordId: doc._id.toString(),
    description: `Created invoice template "${name}"`,
    metadata: { name, category: doc.category, lineItemCount: doc.lineItems.length }
  });

  return doc;
}

async function updateTemplate(req, id, payload = {}) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const InvoiceTemplate = getTemplateModel(req);

  const existing = await InvoiceTemplate.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!existing) throw appError('Invoice template not found', 404);

  const updates = { updatedBy: userId };
  if (payload.name !== undefined) updates.name = String(payload.name).trim();
  if (payload.description !== undefined) updates.description = String(payload.description).trim();
  if (payload.category !== undefined) updates.category = String(payload.category).trim();
  if (payload.currency !== undefined) updates.currency = String(payload.currency).trim().toUpperCase();
  if (payload.paymentTermsDays !== undefined) updates.paymentTermsDays = Number(payload.paymentTermsDays) || 30;
  if (payload.taxCalculation !== undefined) updates.taxCalculation = payload.taxCalculation;
  if (payload.lineItems !== undefined) updates.lineItems = payload.lineItems;
  if (payload.discountType !== undefined) updates.discountType = payload.discountType === 'amount' ? 'amount' : 'percent';
  if (payload.discountPercent !== undefined) updates.discountPercent = Number(payload.discountPercent) || 0;
  if (payload.discountAmount !== undefined) updates.discountAmount = Number(payload.discountAmount) || 0;
  if (payload.paymentDetails !== undefined) updates.paymentDetails = String(payload.paymentDetails).trim();
  if (payload.billingAddress !== undefined) updates.billingAddress = String(payload.billingAddress).trim();
  if (payload.shippingAddress !== undefined) updates.shippingAddress = String(payload.shippingAddress).trim();
  if (payload.shippingState !== undefined) updates.shippingState = String(payload.shippingState).trim();
  if (payload.shippingCharge !== undefined) updates.shippingCharge = Number(payload.shippingCharge) || 0;
  if (payload.tags !== undefined) updates.tags = Array.isArray(payload.tags) ? payload.tags : (typeof payload.tags === 'string' ? payload.tags.split(',').map((t) => t.trim()).filter(Boolean) : []);
  if (payload.notes !== undefined) updates.notes = String(payload.notes).trim();
  if (payload.recipientNotes !== undefined) updates.recipientNotes = String(payload.recipientNotes).trim();
  if (payload.adminNotes !== undefined) updates.adminNotes = String(payload.adminNotes).trim();
  if (payload.terms !== undefined) updates.terms = String(payload.terms).trim();
  if (payload.reminder !== undefined && payload.reminder && typeof payload.reminder === 'object') {
    updates.reminder = {
      enabled: Boolean(payload.reminder.enabled),
      timing: payload.reminder.timing === 'before_due_date' ? 'before_due_date' : 'after_due_date',
      count: Math.max(1, Number(payload.reminder.count) || 1),
      days: Math.max(1, Number(payload.reminder.days) || 3)
    };
  }
  if (payload.isDefault !== undefined) updates.isDefault = Boolean(payload.isDefault);

  const query = InvoiceTemplate.findOneAndUpdate(
    { _id: id, tenantId, isDeleted: false },
    { $set: updates },
    { new: true }
  );
  const updated = typeof query?.lean === 'function' ? await query.lean() : await query;

  await AuditService.log(req, {
    action: 'updated',
    module: 'invoice_template',
    recordId: String(id),
    description: `Updated invoice template "${updated.name}"`
  });

  return updated;
}

async function deleteTemplate(req, id) {
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);
  const InvoiceTemplate = getTemplateModel(req);

  const existing = await InvoiceTemplate.findOne({ _id: id, tenantId, isDeleted: false }).lean();
  if (!existing) throw appError('Invoice template not found', 404);

  await InvoiceTemplate.updateOne(
    { _id: id, tenantId },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId, updatedBy: userId } }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'invoice_template',
    recordId: String(id),
    description: `Deleted invoice template "${existing.name}"`
  });

  return { success: true, id };
}

async function saveAsTemplate(req, invoiceId, options = {}) {
  const tenantId = resolveTenantId(req);
  const Invoice = getInvoiceModel(req);

  const invoice = await Invoice.findOne({ _id: invoiceId, tenantId, isDeleted: false }).lean();
  if (!invoice) throw appError('Source invoice not found', 404);

  const templatePayload = {
    name: options.name || `${invoice.invoiceNo} (Template)`,
    description: options.description || `Template created from invoice ${invoice.invoiceNo}`,
    category: options.category || 'Standard',
    currency: invoice.currency || 'INR',
    taxCalculation: invoice.taxCalculation || 'after_discount',
    paymentTermsDays: 30,
    lineItems: invoice.lineItems || [],
    discountType: invoice.discountType || 'percent',
    discountPercent: invoice.discountPercent || 0,
    discountAmount: invoice.discountAmount || 0,
    paymentDetails: invoice.paymentDetails || '',
    billingAddress: invoice.billingAddress || '',
    shippingAddress: invoice.shippingAddress || '',
    shippingState: invoice.shippingState || '',
    shippingCharge: invoice.shippingCharge || 0,
    notes: invoice.notes || '',
    recipientNotes: invoice.recipientNotes || '',
    adminNotes: invoice.adminNotes || '',
    terms: invoice.terms || '',
    reminder: invoice.reminder || { enabled: false, timing: 'after_due_date', count: 1, days: 3 }
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
