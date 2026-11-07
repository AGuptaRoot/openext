'use strict';

const { Schema } = require('mongoose');

const SalesOrderLineItemSchema = new Schema(
  {
    description: { type: String, required: true, trim: true, maxlength: 500 },
    qty: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0 },
    tax: { type: Number, default: 0, min: 0, max: 100 },
    amount: { type: Number, required: true, min: 0 },
    productId: { type: String, trim: true, default: null },
    shippedQty: { type: Number, default: 0, min: 0 },
    returnedQty: { type: Number, default: 0, min: 0 }
  },
  { _id: false }
);

const SalesOrderShipmentItemSchema = new Schema(
  {
    lineItemIndex: { type: Number, default: 0 },
    description: { type: String, required: true, trim: true },
    qty: { type: Number, required: true, min: 1 },
    productId: { type: String, trim: true, default: null }
  },
  { _id: false }
);

const SalesOrderShipmentSchema = new Schema(
  {
    shipmentNumber: { type: String, required: true, trim: true },
    courierName: { type: String, required: true, trim: true },
    trackingNumber: { type: String, trim: true, default: '' },
    shippingState: { type: String, trim: true, default: '' },
    weightKg: { type: Number, default: 1 },
    shippedItems: { type: [SalesOrderShipmentItemSchema], default: [] },
    dispatchedAt: { type: Date, default: Date.now },
    deliveredAt: { type: Date, default: null },
    deliveryStatus: {
      type: String,
      enum: ['Dispatched', 'In-Transit', 'Delivered', 'Failed'],
      default: 'Dispatched'
    },
    proofOfDelivery: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    createdBy: { type: String, default: 'system' }
  },
  { timestamps: true }
);

const SalesOrderReturnItemSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    qty: { type: Number, required: true, min: 1 },
    unitRate: { type: Number, default: 0 },
    reason: { type: String, trim: true, default: '' },
    productId: { type: String, trim: true, default: null }
  },
  { _id: false }
);

const SalesOrderReturnSchema = new Schema(
  {
    rmaNumber: { type: String, required: true, trim: true },
    type: { type: String, enum: ['Return', 'Replacement'], default: 'Return' },
    status: {
      type: String,
      enum: ['Requested', 'Approved', 'Received', 'Inspected', 'Refunded', 'Replaced', 'Rejected'],
      default: 'Requested'
    },
    returnedItems: { type: [SalesOrderReturnItemSchema], default: [] },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    refundAmount: { type: Number, default: 0, min: 0 },
    replacementOrderId: { type: String, trim: true, default: null },
    requestedAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    inspectedBy: { type: String, default: null },
    createdBy: { type: String, default: 'system' }
  },
  { timestamps: true }
);

/**
 * SalesOrder model — stores priced, approved sales orders converted from Won opportunities or Quotations.
 * Collection: plugin_openext_crm_suite_sales_orders
 */
const SalesOrderSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    orderNumber: { type: String, required: true, trim: true, index: true },
    quotationId: { type: String, trim: true, default: null, index: true },
    opportunityId: { type: String, trim: true, default: null, index: true },
    clientId: { type: String, required: true, trim: true, index: true },
    projectId: { type: String, trim: true, default: null, index: true },
    leadId: { type: String, trim: true, default: null, index: true },
    generatedBy: { type: String, trim: true, default: 'Root CRM' },
    issueDate: { type: Date, required: true, default: Date.now },
    deliveryTargetDate: { type: Date, default: null },
    status: {
      type: String,
      enum: [
        'Draft', 'Pending', 'On Hold', 'Failed', 'Processing', 'Approved', 'Partially Shipped', 'Shipped', 'Completed', 'Cancelled', 'Returned',
        'pending', 'on hold', 'failed', 'processing', 'approved', 'cancelled', 'draft', 'completed', 'shipped', 'returned'
      ],
      default: 'Approved',
      index: true
    },
    currency: { type: String, required: true, trim: true, default: 'INR' },
    exchangeRate: { type: Number, min: 0.0001, default: 1 },
    lineItems: { type: [SalesOrderLineItemSchema], default: [] },
    subtotal: { type: Number, required: true, default: 0 },
    discountType: { type: String, enum: ['percent', 'amount'], default: 'percent' },
    discountValue: { type: Number, default: 0, min: 0 },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    discountTotal: { type: Number, default: 0, min: 0 },
    taxTotal: { type: Number, required: true, default: 0 },
    shippingCharge: { type: Number, default: 0 },
    shippingState: { type: String, trim: true, default: '' },
    totalWeightKg: { type: Number, default: 1 },
    grandTotal: { type: Number, required: true, default: 0 },
    deliveryStatus: {
      type: String,
      enum: ['Pending Allocation', 'Allocated', 'Partially Dispatched', 'Dispatched', 'In-Transit', 'Delivered', 'Returned'],
      default: 'Pending Allocation',
      index: true
    },
    // Primary / default shipment fields (preserved for backwards-compatibility)
    courierName: { type: String, trim: true, default: '' },
    trackingNumber: { type: String, trim: true, default: '' },
    dispatchedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    proofOfDelivery: { type: String, trim: true, default: '' },
    // Multiple Shipments support
    shipments: { type: [SalesOrderShipmentSchema], default: [] },
    // Returns / RMA support
    returns: { type: [SalesOrderReturnSchema], default: [] },
    // Stock / Inventory reservation tracking
    stockReserved: { type: Boolean, default: false },
    stockReservedAt: { type: Date, default: null },
    inventoryDeducted: { type: Boolean, default: false },
    inventoryDeductedAt: { type: Date, default: null },
    stockAudit: {
      type: [
        {
          action: { type: String },
          performedAt: { type: Date, default: Date.now },
          performedBy: { type: String },
          details: { type: String }
        }
      ],
      default: []
    },
    billingAddress: { type: String, trim: true, maxlength: 1000, default: '' },
    shippingAddress: { type: String, trim: true, maxlength: 1000, default: '' },
    notes: { type: String, trim: true, maxlength: 2000, default: '' },
    cancellationReason: { type: String, trim: true, maxlength: 1000, default: '' },
    // Linked Tax Invoice
    convertedInvoiceId: { type: String, trim: true, default: null, index: true },
    convertedInvoiceNo: { type: String, trim: true, default: null },
    invoiceStatus: { type: String, trim: true, default: null },
    createdBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    /** Customer / contact details when this record was created (CRM 3.35.0); never rewritten later. */
    customerSnapshot: { type: Schema.Types.Mixed, default: null },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_sales_orders',
    timestamps: true
  }
);

SalesOrderSchema.index(
  { tenantId: 1, orderNumber: 1 },
  { unique: true, name: 'sales_orders_tenant_order_no' }
);
SalesOrderSchema.index({ tenantId: 1, clientId: 1 }, { name: 'sales_orders_tenant_client' });
SalesOrderSchema.index({ tenantId: 1, status: 1 }, { name: 'sales_orders_tenant_status' });

module.exports = {
  name: 'SalesOrder',
  schema: SalesOrderSchema,
  SalesOrderLineItemSchema,
  SalesOrderShipmentSchema,
  SalesOrderReturnSchema
};

