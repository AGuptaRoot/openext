'use strict';

const salesOrderController = require('../controllers/sales-order.controller.js');
const { requirePermission, requireAnyPermission } = require('../middleware/permission.middleware');
const { validateBody } = require('../middleware/validation.middleware');
const {
  validateSalesOrderCreate,
  validateSalesOrderUpdate,
  validateShipmentCreate,
  validateShipmentStatusUpdate,
  validateReturnCreate,
  validateReturnStatusUpdate,
  validateOrderCancel
} = require('../validation/sales-order.schema');

/**
 * Sales Order routes.
 * Mounted at /api/plugins/openext-crm-suite/sales-orders
 */
module.exports = function registerSalesOrderRoutes(app) {
  app.get(
    '/sales-orders/export',
    requireAnyPermission('crm.orders.export', 'crm.orders.read', 'crm.orders.write'),
    salesOrderController.exportSalesOrders
  );

  app.get(
    '/sales-orders',
    requirePermission('crm.orders.read'),
    salesOrderController.list
  );

  app.post(
    '/sales-orders',
    requirePermission('crm.orders.write'),
    validateBody(validateSalesOrderCreate),
    salesOrderController.create
  );

  app.post(
    '/quotations/:id/convert-to-sales-order',
    requirePermission('crm.orders.write'),
    salesOrderController.convertQuotation
  );

  app.post(
    '/sales-orders/from-opportunity/:id',
    requireAnyPermission('crm.orders.write', 'crm.finance.write'),
    salesOrderController.convertOpportunity
  );

  app.get(
    '/sales-orders/:id',
    requirePermission('crm.orders.read'),
    salesOrderController.get
  );

  app.post(
    '/sales-orders/:id/status',
    requirePermission('crm.orders.write'),
    salesOrderController.updateStatus
  );

  app.post(
    '/sales-orders/:id/dispatch',
    requirePermission('crm.orders.write'),
    salesOrderController.dispatch
  );

  app.post(
    '/sales-orders/:id/delivery-confirm',
    requirePermission('crm.orders.write'),
    salesOrderController.confirmDelivery
  );

  app.post(
    '/sales-orders/:id/generate-invoice',
    requireAnyPermission('crm.invoices.write', 'crm.orders.write'),
    salesOrderController.generateInvoice
  );

  // Multi-Shipment Endpoints
  app.post(
    '/sales-orders/:id/shipments',
    requirePermission('crm.orders.write'),
    validateBody(validateShipmentCreate),
    salesOrderController.addShipment
  );

  app.patch(
    '/sales-orders/:id/shipments/:shipmentId',
    requirePermission('crm.orders.write'),
    validateBody(validateShipmentStatusUpdate),
    salesOrderController.updateShipmentStatus
  );

  // Return / Replacement (RMA) Endpoints
  // A client raises returns on their own order with crm.orders.return; staff
  // use their normal order write permission.
  app.post(
    '/sales-orders/:id/returns',
    requireAnyPermission('crm.orders.write', 'crm.orders.return'),
    validateBody(validateReturnCreate),
    salesOrderController.createReturn
  );

  app.patch(
    '/sales-orders/:id/returns/:returnId',
    requirePermission('crm.orders.write'),
    validateBody(validateReturnStatusUpdate),
    salesOrderController.updateReturnStatus
  );

  // Safe Order Cancellation (staff write, or client with orders.read on their own order)
  app.post(
    '/sales-orders/:id/cancel',
    requireAnyPermission('crm.orders.write', 'crm.orders.read'),
    validateBody(validateOrderCancel),
    salesOrderController.cancel
  );

  // Stock Reservation
  app.post(
    '/sales-orders/:id/reserve-stock',
    requirePermission('crm.orders.write'),
    salesOrderController.reserveStock
  );

  app.delete(
    '/sales-orders/:id',
    requirePermission('crm.orders.delete'),
    salesOrderController.remove
  );
};

