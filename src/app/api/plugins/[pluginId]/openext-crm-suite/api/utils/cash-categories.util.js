'use strict';

/**
 * Cash book categories (GST suite, CRM 3.53.0; documentation/gst-planning/02 §3). Generic base list;
 * the enabled extension adds its own (manifest salesFlow.gst.cashCategories). Not a schema enum.
 */
const BASE_CASH_CATEGORIES = Object.freeze([
  'Opening balance',
  'Customer advance',
  'Balance payment',
  'Office petty cash',
  'Deposit to bank',
  'Withdrawal from bank',
  'Owner drawing',
  'Other'
]);

module.exports = { BASE_CASH_CATEGORIES };
