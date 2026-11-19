'use strict';

const CashbookService = require('../services/cashbook.service');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] cash book error:', error?.message || error);
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'Cash book operation failed' : error.message,
    ...(error.code ? { code: error.code } : {}),
    details: error.details || []
  });
}

const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
const wrap = (fn, status = 200) => async (req, res) => {
  try {
    // The cash book is the agency's own money: never for client-portal logins (they hold crm.finance.read
    // for their own invoices only).
    if (require('../utils/tenant.util').isClientUser(req)) {
      const error = new Error('The cash book is not available in the client portal');
      error.status = 403;
      throw error;
    }
    res.status(status).json({ success: true, data: await fn(req) });
  } catch (error) {
    sendError(res, error);
  }
};

module.exports = {
  book: wrap((req) => CashbookService.book(req, {
    from: String(req.query?.from || ''),
    to: String(req.query?.to || ''),
    search: String(req.query?.search || '')
  })),
  summary: wrap((req) => CashbookService.summary(req)),
  categories: wrap((req) => CashbookService.categories(req)),
  addEntry: wrap((req) => CashbookService.addEntry(req, body(req)), 201),
  updateEntry: wrap((req) => CashbookService.updateEntry(req, req.params.id, body(req))),
  removeEntry: wrap((req) => CashbookService.removeEntry(req, req.params.id)),
  contra: wrap((req) => CashbookService.contra(req, body(req)), 201)
};
