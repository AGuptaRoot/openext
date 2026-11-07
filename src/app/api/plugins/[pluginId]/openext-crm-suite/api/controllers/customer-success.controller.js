'use strict';

const CustomerSuccessService = require('../services/customer-success.service');

/**
 * Endpoint: GET /customer-success/summary
 */
async function getSummary(req, res, next) {
  try {
    const data = await CustomerSuccessService.getHealthSummary(req);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

/**
 * Endpoint: GET /customer-success/accounts
 */
async function listAccounts(req, res, next) {
  try {
    const data = await CustomerSuccessService.listAccountHealth(req);
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
}

/**
 * Endpoint: GET /customer-success/accounts/:clientId
 */
async function getAccountHealth(req, res, next) {
  try {
    const data = await CustomerSuccessService.computeClientHealthScore(req, req.params.clientId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
}

async function exportCustomerSuccess(req, res, next) {
  try {
    const result = await CustomerSuccessService.exportCustomerSuccess(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(result.content);
    } else {
      res.status(200).send(result.content);
    }
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getSummary,
  listAccounts,
  getAccountHealth,
  exportCustomerSuccess
};
