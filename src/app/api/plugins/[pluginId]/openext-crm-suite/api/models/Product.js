'use strict';

const { Schema } = require('mongoose');

/**
 * Product & Service Catalogue Item Schema
 */
const ProductSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    sku: { type: String, required: true, trim: true, uppercase: true, maxlength: 60 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, trim: true, default: 'General', maxlength: 100 },
    type: {
      type: String,
      enum: ['product', 'service', 'subscription'],
      default: 'product'
    },
    unit: { type: String, trim: true, default: 'unit', maxlength: 40 },
    unitPrice: { type: Number, required: true, min: 0, default: 0 },
    taxRate: { type: Number, min: 0, max: 100, default: 0 },
    description: { type: String, trim: true, default: '', maxlength: 2000 },
    status: {
      type: String,
      enum: ['active', 'inactive', 'archived'],
      default: 'active'
    },
    stockQuantity: { type: Number, default: 0 },
    imageUrl: { type: String, trim: true, default: '', maxlength: 500 },
    customFields: { type: Schema.Types.Mixed, default: () => ({}) },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_products',
    timestamps: true
  }
);

ProductSchema.index({ tenantId: 1, sku: 1 }, { name: 'products_tenant_sku' });
ProductSchema.index({ tenantId: 1, category: 1 }, { name: 'products_tenant_category' });
ProductSchema.index({ tenantId: 1, status: 1 }, { name: 'products_tenant_status' });
ProductSchema.index({ tenantId: 1, type: 1 }, { name: 'products_tenant_type' });

module.exports = {
  name: 'Product',
  schema: ProductSchema
};
