'use strict';

const SalesOrderService = require('../services/sales-order.service');

function sendError(res, status, error, details = [], extra = {}) {
  res.status(status).json({
    success: false,
    error,
    details,
    ...extra
  });
}

/**
 * Controller endpoint for listing sales orders.
 * 
 * Usecase: GET /sales-orders
 */
async function list(req, res) {
  try {
    const data = await SalesOrderService.list(req);
    res.json({
      success: true,
      data: data.items,
      pagination: data.pagination,
      unlinkedClient: Boolean(data.unlinkedClient),
      message: data.message || 'Sales orders loaded'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.list:', error);
    sendError(res, error.status || 500, error.message || 'Failed to fetch sales orders');
  }
}

/**
 * Controller endpoint for fetching a single sales order.
 * 
 * Usecase: GET /sales-orders/:id
 */
async function get(req, res) {
  try {
    const data = await SalesOrderService.getById(req, req.params.id);
    res.json({
      success: true,
      data,
      message: 'Sales order loaded'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.get:', error);
    sendError(res, error.status || 500, error.message || 'Failed to fetch sales order');
  }
}

/**
 * Controller endpoint for creating a sales order.
 * 
 * Usecase: POST /sales-orders
 */
async function create(req, res) {
  try {
    const data = await SalesOrderService.create(req, req.body);
    res.status(201).json({
      success: true,
      data,
      message: 'Sales order created successfully'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.create:', error);
    const extra = {};
    if (error.code) extra.code = error.code;
    if (error.salesOrderId) {
      extra.data = { salesOrderId: String(error.salesOrderId) };
    }
    sendError(
      res,
      error.status || 500,
      error.message || 'Failed to create sales order',
      [],
      extra
    );
  }
}

/**
 * Controller endpoint for converting an accepted quotation into a sales order.
 * 
 * Usecase: POST /quotations/:id/convert-to-sales-order
 */
async function convertQuotation(req, res) {
  try {
    const data = await SalesOrderService.createFromQuotation(req, req.params.id);
    res.status(201).json({
      success: true,
      data,
      message: 'Quotation converted to Sales Order successfully'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.convertQuotation:', error);
    sendError(res, error.status || 500, error.message || 'Failed to convert quotation to Sales Order');
  }
}

/**
 * Controller endpoint for converting a Won Opportunity into a Sales Order.
 *
 * Usecase: POST /sales-orders/from-opportunity/:id
 */
async function convertOpportunity(req, res) {
  try {
    const data = await SalesOrderService.createFromOpportunity(req, req.params.id);
    res.status(201).json({
      success: true,
      data: { salesOrderId: data._id ? data._id.toString() : data.id, order: data },
      message: 'Sales Order created from opportunity'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.convertOpportunity:', error);
    const extra = {};
    if (error.code) extra.code = error.code;
    if (error.salesOrderId) {
      extra.data = { salesOrderId: String(error.salesOrderId) };
    }
    sendError(
      res,
      error.status || 500,
      error.message || 'Failed to convert opportunity to Sales Order',
      [],
      extra
    );
  }
}

/**
 * Controller endpoint for generating a Tax Invoice from a Sales Order.
 * 
 * Usecase: POST /sales-orders/:id/generate-invoice
 */
async function generateInvoice(req, res) {
  try {
    const data = await SalesOrderService.createInvoiceFromSalesOrder(req, req.params.id);
    res.status(201).json({
      success: true,
      data,
      message: 'Tax Invoice generated successfully from Sales Order'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.generateInvoice:', error);
    sendError(res, error.status || 500, error.message || 'Failed to generate invoice from sales order');
  }
}

/**
 * Controller endpoint for updating sales order status.
 * 
 * Usecase: POST /sales-orders/:id/status
 */
async function updateStatus(req, res) {
  try {
    const status = String(req.body?.status || '').trim();
    if (!status) return sendError(res, 400, 'status is required');

    const data = await SalesOrderService.updateStatus(req, req.params.id, status);
    res.json({
      success: true,
      data,
      message: `Sales order status updated to ${status}`
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.updateStatus:', error);
    sendError(res, error.status || 500, error.message || 'Failed to update sales order status');
  }
}

/**
 * Controller endpoint for dispatching a sales order via courier.
 * 
 * Usecase: POST /sales-orders/:id/dispatch
 */
async function dispatch(req, res) {
  try {
    const data = await SalesOrderService.dispatch(req, req.params.id, req.body);
    res.json({
      success: true,
      data,
      message: 'Sales order dispatched successfully'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.dispatch:', error);
    sendError(res, error.status || 500, error.message || 'Failed to dispatch sales order');
  }
}

/**
 * Controller endpoint for confirming delivery fulfillment.
 * 
 * Usecase: POST /sales-orders/:id/delivery-confirm
 */
async function confirmDelivery(req, res) {
  try {
    const data = await SalesOrderService.confirmDelivery(req, req.params.id, req.body);
    res.json({
      success: true,
      data,
      message: 'Sales order delivery confirmed successfully'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.confirmDelivery:', error);
    sendError(res, error.status || 500, error.message || 'Failed to confirm sales order delivery');
  }
}

/**
 * Controller endpoint for removing a sales order.
 * 
 * Usecase: DELETE /sales-orders/:id
 */
async function remove(req, res) {
  try {
    const data = await SalesOrderService.remove(req, req.params.id);
    res.json({
      success: true,
      data,
      message: 'Sales order deleted'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.remove:', error);
    sendError(res, error.status || 500, error.message || 'Failed to delete sales order');
  }
}

/**
 * Controller endpoint for adding a shipment to a sales order.
 * 
 * Usecase: POST /sales-orders/:id/shipments
 */
async function addShipment(req, res) {
  try {
    const data = await SalesOrderService.addShipment(req, req.params.id, req.body);
    res.status(201).json({
      success: true,
      data,
      message: 'Shipment added and dispatched successfully'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.addShipment:', error);
    sendError(res, error.status || 500, error.message || 'Failed to add shipment');
  }
}

/**
 * Controller endpoint for updating an individual shipment status.
 * 
 * Usecase: PATCH /sales-orders/:id/shipments/:shipmentId
 */
async function updateShipmentStatus(req, res) {
  try {
    const data = await SalesOrderService.updateShipmentStatus(req, req.params.id, req.params.shipmentId, req.body);
    res.json({
      success: true,
      data,
      message: 'Shipment status updated successfully'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.updateShipmentStatus:', error);
    sendError(res, error.status || 500, error.message || 'Failed to update shipment status');
  }
}

/**
 * Controller endpoint for creating a return/replacement (RMA) request.
 * 
 * Usecase: POST /sales-orders/:id/returns
 */
async function createReturn(req, res) {
  try {
    const data = await SalesOrderService.createReturn(req, req.params.id, req.body);
    res.status(201).json({
      success: true,
      data,
      message: 'Return/replacement request created successfully'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.createReturn:', error);
    sendError(res, error.status || 500, error.message || 'Failed to create return request');
  }
}

/**
 * Controller endpoint for updating an RMA return status.
 * 
 * Usecase: PATCH /sales-orders/:id/returns/:returnId
 */
async function updateReturnStatus(req, res) {
  try {
    const data = await SalesOrderService.updateReturnStatus(req, req.params.id, req.params.returnId, req.body);
    res.json({
      success: true,
      data,
      message: 'RMA status updated successfully'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.updateReturnStatus:', error);
    sendError(res, error.status || 500, error.message || 'Failed to update return status');
  }
}

/**
 * Controller endpoint for safely cancelling a sales order.
 * 
 * Usecase: POST /sales-orders/:id/cancel
 */
async function cancel(req, res) {
  try {
    const data = await SalesOrderService.cancel(req, req.params.id, req.body);
    res.json({
      success: true,
      data,
      message: 'Sales order cancelled successfully'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.cancel:', error);
    sendError(res, error.status || 500, error.message || 'Failed to cancel sales order');
  }
}

/**
 * Controller endpoint for reserving inventory stock for a sales order.
 * 
 * Usecase: POST /sales-orders/:id/reserve-stock
 */
async function reserveStock(req, res) {
  try {
    const data = await SalesOrderService.reserveStock(req, req.params.id);
    res.json({
      success: true,
      data,
      message: 'Stock reserved successfully for sales order'
    });
  } catch (error) {
    console.error('[plugin:openext-crm-suite] salesOrder.reserveStock:', error);
    sendError(res, error.status || 500, error.message || 'Failed to reserve stock');
  }
}

async function exportSalesOrders(req, res) {
  try {
    const result = await SalesOrderService.exportSalesOrders(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(result.content);
    } else {
      res.status(200).send(result.content);
    }
  } catch (error) {
    sendError(res, error.status || 500, error.message || 'Failed to export sales orders');
  }
}

module.exports = {
  list,
  exportSalesOrders,
  get,
  create,
  convertQuotation,
  convertOpportunity,
  generateInvoice,
  updateStatus,
  dispatch,
  confirmDelivery,
  addShipment,
  updateShipmentStatus,
  createReturn,
  updateReturnStatus,
  cancel,
  reserveStock,
  remove
};

