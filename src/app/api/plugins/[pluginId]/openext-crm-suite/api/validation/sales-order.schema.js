'use strict';

const ORDER_STATUSES = ['Draft', 'Approved', 'Processing', 'Partially Shipped', 'Shipped', 'Completed', 'Cancelled', 'Returned'];
const SHIPMENT_STATUSES = ['Dispatched', 'In-Transit', 'Delivered', 'Failed'];
const RETURN_TYPES = ['Return', 'Replacement'];
const RETURN_STATUSES = ['Requested', 'Approved', 'Received', 'Inspected', 'Refunded', 'Replaced', 'Rejected'];

function validateSalesOrderCreate(body) {
  const source = body && typeof body === 'object' ? body : {};
  const errors = [];

  if (!source.clientId && !source.leadId) {
    errors.push('clientId or leadId is required');
  }

  if (source.clientId && typeof source.clientId !== 'string') {
    errors.push('clientId must be a string');
  }

  if (!Array.isArray(source.lineItems) || source.lineItems.length === 0) {
    errors.push('At least one line item is required');
  } else if (source.lineItems.length > 100) {
    errors.push('A maximum of 100 line items is allowed');
  } else {
    source.lineItems.forEach((item, idx) => {
      if (!item || typeof item !== 'object') {
        errors.push(`lineItems[${idx}] must be an object`);
        return;
      }
      if (!String(item.description || '').trim()) {
        errors.push(`lineItems[${idx}].description is required`);
      }
      const qty = typeof item.qty === 'number' ? item.qty : Number(item.qty);
      if (isNaN(qty) || qty <= 0) {
        errors.push(`lineItems[${idx}].qty must be greater than zero`);
      } else {
        item.qty = qty;
      }
      const rate = typeof item.rate === 'number' ? item.rate : Number(item.rate);
      if (isNaN(rate) || rate < 0) {
        errors.push(`lineItems[${idx}].rate must be zero or positive`);
      } else {
        item.rate = rate;
      }
    });
  }

  if ('status' in source && source.status) {
    const matched = ORDER_STATUSES.find((s) => s.toLowerCase() === String(source.status).toLowerCase().trim());
    if (matched) {
      source.status = matched;
    } else {
      errors.push(`status must be one of: ${ORDER_STATUSES.join(', ')}`);
    }
  }

  if ('notes' in source && String(source.notes || '').length > 2000) {
    errors.push('notes must be 2000 characters or fewer');
  }

  return { ok: errors.length === 0, errors };
}

function validateSalesOrderUpdate(body) {
  const source = body && typeof body === 'object' ? body : {};
  const errors = [];

  if (Object.keys(source).length === 0) {
    errors.push('At least one field is required for update');
  }

  if ('status' in source && source.status) {
    const matched = ORDER_STATUSES.find((s) => s.toLowerCase() === String(source.status).toLowerCase().trim());
    if (matched) {
      source.status = matched;
    } else {
      errors.push(`status must be one of: ${ORDER_STATUSES.join(', ')}`);
    }
  }

  if ('lineItems' in source) {
    if (!Array.isArray(source.lineItems) || source.lineItems.length === 0) {
      errors.push('At least one line item is required');
    } else {
      source.lineItems.forEach((item, idx) => {
        if (!item || typeof item !== 'object') {
          errors.push(`lineItems[${idx}] must be an object`);
          return;
        }
        if (!String(item.description || '').trim()) {
          errors.push(`lineItems[${idx}].description is required`);
        }
        const qty = typeof item.qty === 'number' ? item.qty : Number(item.qty);
        if (isNaN(qty) || qty <= 0) {
          errors.push(`lineItems[${idx}].qty must be greater than zero`);
        } else {
          item.qty = qty;
        }
        const rate = typeof item.rate === 'number' ? item.rate : Number(item.rate);
        if (isNaN(rate) || rate < 0) {
          errors.push(`lineItems[${idx}].rate must be zero or positive`);
        } else {
          item.rate = rate;
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateShipmentCreate(body) {
  const source = body && typeof body === 'object' ? body : {};
  const errors = [];

  if (!String(source.courierName || '').trim()) {
    errors.push('courierName is required');
  }
  // Optional on purpose: the courier often hands over the AWB after the parcel
  // has left, and hand deliveries never have one. It can be filled in later
  // through the shipment update endpoint.
  if (String(source.trackingNumber || '').trim().length > 120) {
    errors.push('trackingNumber must be 120 characters or fewer');
  }

  if ('shippedItems' in source) {
    if (!Array.isArray(source.shippedItems)) {
      errors.push('shippedItems must be an array');
    } else {
      source.shippedItems.forEach((item, idx) => {
        if (!item || typeof item !== 'object') {
          errors.push(`shippedItems[${idx}] must be an object`);
          return;
        }
        if (!String(item.description || '').trim()) {
          errors.push(`shippedItems[${idx}].description is required`);
        }
        if (typeof item.qty !== 'number' || item.qty <= 0) {
          errors.push(`shippedItems[${idx}].qty must be greater than zero`);
        }
      });
    }
  }

  if ('deliveryStatus' in source && !SHIPMENT_STATUSES.includes(source.deliveryStatus)) {
    errors.push(`deliveryStatus must be one of: ${SHIPMENT_STATUSES.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}

function validateShipmentStatusUpdate(body) {
  const source = body && typeof body === 'object' ? body : {};
  const errors = [];

  if (
    !source.deliveryStatus &&
    !source.proofOfDelivery &&
    !source.notes &&
    source.trackingNumber === undefined
  ) {
    errors.push(
      'At least one of deliveryStatus, trackingNumber, proofOfDelivery, or notes is required'
    );
  }

  if (String(source.trackingNumber || '').trim().length > 120) {
    errors.push('trackingNumber must be 120 characters or fewer');
  }

  if ('deliveryStatus' in source && !SHIPMENT_STATUSES.includes(source.deliveryStatus)) {
    errors.push(`deliveryStatus must be one of: ${SHIPMENT_STATUSES.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}

function validateReturnCreate(body) {
  const source = body && typeof body === 'object' ? body : {};
  const errors = [];

  if (!String(source.reason || '').trim()) {
    errors.push('reason is required for return/replacement request');
  }

  if ('type' in source && !RETURN_TYPES.includes(source.type)) {
    errors.push(`type must be one of: ${RETURN_TYPES.join(', ')}`);
  }

  if (!Array.isArray(source.returnedItems) || source.returnedItems.length === 0) {
    errors.push('At least one returnedItem is required');
  } else {
    source.returnedItems.forEach((item, idx) => {
      if (!item || typeof item !== 'object') {
        errors.push(`returnedItems[${idx}] must be an object`);
        return;
      }
      if (!String(item.description || '').trim()) {
        errors.push(`returnedItems[${idx}].description is required`);
      }
      if (typeof item.qty !== 'number' || item.qty <= 0) {
        errors.push(`returnedItems[${idx}].qty must be greater than zero`);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

function validateReturnStatusUpdate(body) {
  const source = body && typeof body === 'object' ? body : {};
  const errors = [];

  if (!source.status) {
    errors.push('status is required');
  } else if (!RETURN_STATUSES.includes(source.status)) {
    errors.push(`status must be one of: ${RETURN_STATUSES.join(', ')}`);
  }

  return { ok: errors.length === 0, errors };
}

function validateOrderCancel(body) {
  const source = body && typeof body === 'object' ? body : {};
  const errors = [];

  if (!String(source.reason || '').trim()) {
    errors.push('reason is required for cancelling an order');
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  ORDER_STATUSES,
  SHIPMENT_STATUSES,
  RETURN_TYPES,
  RETURN_STATUSES,
  validateSalesOrderCreate,
  validateSalesOrderUpdate,
  validateShipmentCreate,
  validateShipmentStatusUpdate,
  validateReturnCreate,
  validateReturnStatusUpdate,
  validateOrderCancel
};

