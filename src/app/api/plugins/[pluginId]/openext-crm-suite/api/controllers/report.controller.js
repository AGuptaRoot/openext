'use strict';

const ReportService = require('../services/report.service');

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] report error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Report operation failed',
    details: error.details || []
  });
}

async function activityLocation(req, res) {
  try {
    const data = await ReportService.getActivityLocationReport(req, req.query || {});
    res.json({ success: true, data, message: 'Activity location report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function sales(req, res) {
  try {
    const data = await ReportService.getSalesReport(req, req.query || {});
    res.json({ success: true, data, message: 'Sales report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function projects(req, res) {
  try {
    const data = await ReportService.getProjectsReport(req, req.query || {});
    res.json({ success: true, data, message: 'Project report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function leadConversion(req, res) {
  try {
    const data = await ReportService.getLeadConversionReport(req, req.query || {});
    res.json({ success: true, data, message: 'Lead conversion report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function invoiceAgeing(req, res) {
  try {
    const data = await ReportService.getInvoiceAgeingReport(req, req.query || {});
    res.json({ success: true, data, message: 'Invoice ageing report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function timeReport(req, res) {
  try {
    const data = await ReportService.getTimeReport(req, req.query || {});
    res.json({ success: true, data, message: 'Time report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function incomeExpense(req, res) {
  try {
    const data = await ReportService.getIncomeExpenseReport(req, req.query || {});
    res.json({ success: true, data, message: 'Income vs expense report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function recurringInvoices(req, res) {
  try {
    const data = await ReportService.getRecurringInvoicesReport(req, req.query || {});
    res.json({ success: true, data, message: 'Recurring invoices report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function creditNotes(req, res) {
  try {
    const data = await ReportService.getCreditNotesReport(req, req.query || {});
    res.json({ success: true, data, message: 'Credit notes report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function paymentReconciliation(req, res) {
  try {
    const data = await ReportService.getPaymentReconciliationReport(req, req.query || {});
    res.json({ success: true, data, message: 'Payment reconciliation report loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportCsv(req, res) {
  try {
    const { csv, filename, contentType } = await ReportService.exportReportCsv(
      req,
      req.query || {}
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csv);
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  activityLocation,
  sales,
  projects,
  leadConversion,
  invoiceAgeing,
  timeReport,
  incomeExpense,
  recurringInvoices,
  creditNotes,
  paymentReconciliation,
  exportCsv
};
