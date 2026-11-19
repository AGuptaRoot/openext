'use strict';

const GstReports = require('../services/gst-reports.service');

/**
 * GST reports (GST suite, Step 5; documentation/gst-planning/03 §6). Read-only.
 * The agency's own returns: never for client-portal logins (they hold crm.finance.read for their own
 * invoices only). File downloads use res.setHeader + res.send (the CMS response has no res.set).
 */

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] GST report error:', error?.message || error);
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'GST report failed' : error.message,
    ...(error.code ? { code: error.code } : {}),
    details: error.details || []
  });
}

function assertStaff(req) {
  if (require('../utils/tenant.util').isClientUser(req)) {
    const error = new Error('GST reports are not available in the client portal');
    error.status = 403;
    throw error;
  }
}

const q = (req, key) => String((req.query && req.query[key]) || '').trim();
const safeName = (name) => String(name || 'export').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

function sendFile(res, { filename, body }, type) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(filename)}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200);
  // 3.54.0: sent as bytes. The CMS JSON-encodes a STRING body sent as application/json again, which turned
  // the portal file into one quoted string with escaped newlines and quotes. Bytes are passed through
  // exactly as built (pretty-printed JSON, 2-space indent).
  res.send(Buffer.from(String(body), 'utf8'));
}

const json = (fn) => async (req, res) => {
  try {
    assertStaff(req);
    res.json({ success: true, data: await fn(req) });
  } catch (error) {
    sendError(res, error);
  }
};

const CSV = 'text/csv; charset=utf-8';

module.exports = {
  gstr1: json((req) => GstReports.gstr1(req, { fy: q(req, 'fy'), period: q(req, 'period') })),

  async gstr1Export(req, res) {
    try {
      assertStaff(req);
      const format = q(req, 'format') || 'json';
      const args = { fy: q(req, 'fy'), period: q(req, 'period') };
      if (format === 'json') return sendFile(res, await GstReports.gstr1Json(req, args), 'application/json; charset=utf-8');
      if (format === 'csv') return sendFile(res, await GstReports.gstr1Csv(req, { ...args, table: q(req, 'table') }), CSV);
      const error = new Error('format must be json or csv');
      error.status = 400;
      throw error;
    } catch (error) {
      return sendError(res, error);
    }
  },

  advances: json((req) => GstReports.advances(req, { from: q(req, 'from'), to: q(req, 'to') })),

  async creditNotes(req, res) {
    try {
      assertStaff(req);
      const args = { from: q(req, 'from'), to: q(req, 'to') };
      if (q(req, 'format') === 'csv') return sendFile(res, await GstReports.creditNotesCsv(req, args), CSV);
      return res.json({ success: true, data: await GstReports.creditNotes(req, args) });
    } catch (error) {
      return sendError(res, error);
    }
  },

  async tcs(req, res) {
    try {
      assertStaff(req);
      const args = { fy: q(req, 'fy'), quarter: q(req, 'quarter'), rule: q(req, 'rule') };
      if (q(req, 'format') === 'csv') return sendFile(res, await GstReports.tcsCsv(req, args), CSV);
      return res.json({ success: true, data: await GstReports.tcs(req, args) });
    } catch (error) {
      return sendError(res, error);
    }
  }
};
