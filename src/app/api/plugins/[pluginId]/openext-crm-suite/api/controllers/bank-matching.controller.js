'use strict';

const BankMatching = require('../services/bank-matching.service');
const GatewayFees = require('../services/gateway-fee.service');
const { isClientUser } = require('../utils/tenant.util');
const { hasPermission } = require('../utils/sales-access.util');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] bank matching error:', error?.message || error);
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'Bank matching failed' : error.message,
    ...(error.code ? { code: error.code } : {}),
    details: error.details || []
  });
}

const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
const wrap = (fn, status = 200) => async (req, res) => {
  try {
    // The agency's bank: never for client-portal logins (they hold crm.finance.read for their own invoices).
    if (isClientUser(req)) {
      const error = new Error('Bank matching is not available in the client portal');
      error.status = 403;
      throw error;
    }
    res.status(status).json({ success: true, data: await fn(req) });
  } catch (error) {
    sendError(res, error);
  }
};

module.exports = {
  importStatement: wrap((req) => BankMatching.importStatement(req, body(req)), 201),
  lines: wrap((req) => BankMatching.lines(req, { status: String(req.query?.status || 'open'), account: String(req.query?.account || '') })),
  pick: wrap((req) => BankMatching.pick(req, { statementId: req.query?.statementId, lineId: req.query?.lineId, search: req.query?.search })),
  match: wrap((req) => BankMatching.match(req, body(req))),
  unmatch: wrap(async (req) => {
    // Undoing a match that recorded a payment deletes that payment: that needs the delete permission.
    if (await BankMatching.unmatchDeletesPayment(req, body(req)) && !hasPermission(req, 'crm.finance.delete')) {
      const error = new Error('Undoing this match deletes the payment it recorded: that needs permission to delete finance records');
      error.status = 403;
      throw error;
    }
    return BankMatching.unmatch(req, body(req));
  }),
  ignore: wrap((req) => BankMatching.ignore(req, body(req))),
  gatewayFees: wrap((req) => GatewayFees.summary(req, { month: String(req.query?.month || '') })),
  refreshGatewayFees: wrap((req) => GatewayFees.refresh(req))
};
