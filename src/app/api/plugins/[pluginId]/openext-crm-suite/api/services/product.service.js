'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { parsePagination } = require('../utils/pagination.util');
const { toLiteralSearchTerm } = require('../utils/search.util');
const AuditService = require('./audit.service');

function getProductModel(req) {
  const Product = req.cms?.models.get('Product');
  if (!Product) throw new Error('Product model is not registered');
  return Product;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const DEFAULT_STARTER_PRODUCTS = [
  {
    sku: 'CRM-ENT-LIC',
    name: 'Enterprise CRM Suite License',
    category: 'Software',
    type: 'subscription',
    unit: 'user/year',
    unitPrice: 480,
    taxRate: 18,
    description: 'Annual enterprise multi-tenant CRM license per active user.'
  },
  {
    sku: 'CRM-ONBOARD-PKG',
    name: 'CRM Implementation & Onboarding',
    category: 'Services',
    type: 'service',
    unit: 'package',
    unitPrice: 2500,
    taxRate: 18,
    description: 'Complete data migration, workflow automation setup, and team training.'
  },
  {
    sku: 'SLA-GOLD-ANNUAL',
    name: 'Gold SLA 24/7 Dedicated Support',
    category: 'Subscriptions',
    type: 'service',
    unit: 'year',
    unitPrice: 1200,
    taxRate: 18,
    description: 'Guaranteed 1-hour response SLA with dedicated technical account manager.'
  },
  {
    sku: 'API-INTEGRATE-DEV',
    name: 'Custom Integration Engineering',
    category: 'Consulting',
    type: 'service',
    unit: 'hour',
    unitPrice: 85,
    taxRate: 18,
    description: 'Custom REST webhook and 3rd party ERP connector development.'
  }
];

async function ensureDefaultProducts(req) {
  try {
    const Product = getProductModel(req);
    const tenantId = resolveTenantId(req);
    const count = await Product.countDocuments({ tenantId, isDeleted: false });
    if (count === 0) {
      const docs = DEFAULT_STARTER_PRODUCTS.map((p) => ({
        ...p,
        tenantId,
        createdBy: 'system',
        updatedBy: 'system'
      }));
      await Product.insertMany(docs);
    }
  } catch (err) {
    console.warn('[ProductService] Seed warning:', err.message);
  }
}

async function list(req) {
  await ensureDefaultProducts(req);
  const Product = getProductModel(req);
  const { page, limit, skip, sort } = parsePagination(req.query);
  const filter = baseFilter(req);

  if (req.query?.category) {
    filter.category = String(req.query.category).trim();
  }
  if (req.query?.type) {
    filter.type = String(req.query.type).trim();
  }
  if (req.query?.status) {
    filter.status = String(req.query.status).trim();
  }
  if (req.query?.search) {
    const term = toLiteralSearchTerm(req.query.search);
    if (term) {
      filter.$or = [
        { name: { $regex: term, $options: 'i' } },
        { sku: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } },
        { category: { $regex: term, $options: 'i' } }
      ];
    }
  }

  const [items, total] = await Promise.all([
    Product.find(filter).sort(sort || { name: 1 }).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter)
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
  };
}

async function getById(req, id) {
  const Product = getProductModel(req);
  const product = await Product.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!product) throw appError('Product not found', 404);
  return product;
}

async function create(req, input) {
  const Product = getProductModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const sku = String(input.sku || '').trim().toUpperCase();
  const name = String(input.name || '').trim();

  if (!sku) throw appError('SKU is required');
  if (!name) throw appError('Product name is required');

  const existing = await Product.findOne({ tenantId, sku, isDeleted: false });
  if (existing) {
    throw appError(`Product with SKU "${sku}" already exists in your catalogue`, 409);
  }

  const product = await Product.create({
    tenantId,
    sku,
    name,
    category: input.category ? String(input.category).trim() : 'General',
    type: ['product', 'service', 'subscription'].includes(input.type) ? input.type : 'product',
    unit: input.unit ? String(input.unit).trim() : 'unit',
    unitPrice: Number(input.unitPrice) >= 0 ? Number(input.unitPrice) : 0,
    taxRate: Number(input.taxRate) >= 0 ? Number(input.taxRate) : 0,
    description: input.description ? String(input.description).trim() : '',
    status: input.status || 'active',
    stockQuantity: Number(input.stockQuantity) || 0,
    imageUrl: input.imageUrl ? String(input.imageUrl).trim() : '',
    customFields: input.customFields || {},
    createdBy: userId,
    updatedBy: userId
  });

  const doc = product.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'product',
    recordId: doc._id.toString(),
    description: `Catalogue item created: ${doc.name} (${doc.sku})`
  });

  return doc;
}

async function update(req, id, input) {
  const Product = getProductModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const existing = await Product.findOne({ ...baseFilter(req), _id: id });
  if (!existing) throw appError('Product not found', 404);

  const updates = { updatedBy: userId };

  if (input.sku !== undefined) {
    const nextSku = String(input.sku).trim().toUpperCase();
    if (!nextSku) throw appError('SKU cannot be empty');
    if (nextSku !== existing.sku) {
      const dup = await Product.findOne({ tenantId, sku: nextSku, _id: { $ne: id }, isDeleted: false });
      if (dup) throw appError(`Product with SKU "${nextSku}" already exists`, 409);
      updates.sku = nextSku;
    }
  }

  if (input.name !== undefined) {
    if (!String(input.name).trim()) throw appError('Product name cannot be empty');
    updates.name = String(input.name).trim();
  }
  if (input.category !== undefined) updates.category = String(input.category).trim();
  if (input.type !== undefined) updates.type = input.type;
  if (input.unit !== undefined) updates.unit = String(input.unit).trim();
  if (input.unitPrice !== undefined) updates.unitPrice = Math.max(0, Number(input.unitPrice));
  if (input.taxRate !== undefined) updates.taxRate = Math.max(0, Number(input.taxRate));
  if (input.description !== undefined) updates.description = String(input.description).trim();
  if (input.status !== undefined) updates.status = input.status;
  if (input.stockQuantity !== undefined) updates.stockQuantity = Number(input.stockQuantity);
  if (input.imageUrl !== undefined) updates.imageUrl = String(input.imageUrl).trim();
  if (input.customFields !== undefined) updates.customFields = input.customFields;

  const updated = await Product.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'product',
    recordId: String(id),
    description: `Catalogue item updated: ${updated.name}`
  });

  return updated;
}

async function remove(req, id) {
  const Product = getProductModel(req);
  const userId = resolveUserId(req);

  const existing = await Product.findOne({ ...baseFilter(req), _id: id });
  if (!existing) throw appError('Product not found', 404);

  await Product.updateOne(
    { ...baseFilter(req), _id: id },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId } }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'product',
    recordId: String(id),
    description: `Catalogue item removed: ${existing.name} (${existing.sku})`
  });

  return { success: true, message: 'Product deleted' };
}

async function getCategories(req) {
  await ensureDefaultProducts(req);
  const Product = getProductModel(req);
  const cats = await Product.distinct('category', baseFilter(req));
  return cats.filter(Boolean);
}

module.exports = {
  list,
  getById,
  create,
  update,
  remove,
  getCategories
};
