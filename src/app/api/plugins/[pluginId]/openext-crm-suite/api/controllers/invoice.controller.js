'use strict';

const InvoiceService = require('../services/invoice.service');
const InvoiceTemplateService = require('../services/invoice-template.service');
const RazorpayGatewayService = require('../services/razorpay-gateway.service');
const FinancePdfOcrService = require('../services/finance-pdf-ocr.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] invoice error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Invoice operation failed',
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const result = await InvoiceService.list(req);
    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      unlinkedClient: Boolean(result.unlinkedClient),
      message: result.message || 'Invoices loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const doc = await InvoiceService.getById(req, req.params.id);
    // Total, verified paid, advance carried from the proforma and balance, from the payment records.
    let paymentSummary = null;
    try {
      paymentSummary = await require('../services/proforma.service').invoicePaymentSummary(req, doc);
    } catch {
      paymentSummary = null;
    }
    res.json({ success: true, data: { ...doc, paymentSummary }, message: 'Invoice loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const doc = await InvoiceService.create(req, req.validatedBody || req.body);
    res.status(201).json({ success: true, data: doc, message: 'Invoice created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const doc = await InvoiceService.update(req, req.params.id, req.validatedBody || req.body);
    res.json({ success: true, data: doc, message: 'Invoice updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const result = await InvoiceService.remove(req, req.params.id);
    res.json({ success: true, data: result, message: 'Invoice deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function send(req, res) {
  try {
    const { doc, emailDelivery } = await InvoiceService.send(req, req.params.id);
    const message = emailDelivery?.sent
      ? `Invoice emailed to ${emailDelivery.to}`
      : 'Invoice marked as sent';
    res.json({ success: true, data: doc, email: emailDelivery, message });
  } catch (error) {
    sendError(res, error);
  }
}

async function markAsViewed(req, res) {
  try {
    const doc = await InvoiceService.markAsViewed(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Invoice marked as viewed' });
  } catch (error) {
    sendError(res, error);
  }
}

async function writeOff(req, res) {
  try {
    const doc = await InvoiceService.writeOff(req, req.params.id, req.validatedBody || req.body);
    res.json({ success: true, data: doc, message: 'Invoice marked as written off' });
  } catch (error) {
    sendError(res, error);
  }
}

async function archive(req, res) {
  try {
    const doc = await InvoiceService.archive(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Invoice archived' });
  } catch (error) {
    sendError(res, error);
  }
}

async function restore(req, res) {
  try {
    const doc = await InvoiceService.restore(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Invoice restored' });
  } catch (error) {
    sendError(res, error);
  }
}

async function saveAsTemplate(req, res) {
  try {
    const doc = await InvoiceTemplateService.saveAsTemplate(req, req.params.id, req.body);
    res.status(201).json({ success: true, data: doc, message: 'Invoice saved as template' });
  } catch (error) {
    sendError(res, error);
  }
}

async function cancel(req, res) {
  try {
    const doc = await InvoiceService.cancel(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Invoice cancelled' });
  } catch (error) {
    sendError(res, error);
  }
}

async function listPayments(req, res) {
  try {
    const payments = await InvoiceService.listPayments(req, req.params.id);
    res.json({
      success: true,
      data: payments,
      message: payments.length ? 'Payments loaded' : 'No payments recorded yet'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function printHtml(req, res) {
  try {
    const { html } = await InvoiceService.exportPrintHtml(req, req.params.id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(html);
  } catch (error) {
    sendError(res, error);
  }
}

async function getNextInvoiceNumber(req, res) {
  try {
    const nextNumber = await InvoiceService.getNextInvoiceNumber(req);
    res.json({ success: true, data: { nextNumber }, message: 'Next invoice number generated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportInvoices(req, res) {
  try {
    const result = await InvoiceService.exportInvoices(req, req.query || {});
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    if (result.contentType.includes('json')) {
      res.status(200).send(result.content);
    } else {
      res.status(200).send(result.content);
    }
  } catch (error) {
    sendError(res, error);
  }
}

async function getRazorpayStatus(req, res) {
  try {
    const data = await RazorpayGatewayService.getStatus(req);
    res.json({ success: true, data, message: data.configured ? 'Razorpay is ready' : 'Razorpay is not configured' });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Convert a paid proforma into the tax invoice for the full value, carrying
 * the advance across so only the balance remains due.
 */
async function convertProforma(req, res) {
  try {
    const ProformaService = require('../services/proforma.service');
    const options = req.validatedBody || req.body || {};
    const data = await ProformaService.convertProformaToTaxInvoice(req, req.params.id, options);
    res.status(201).json({
      success: true,
      data,
      message: `Tax invoice ${data.invoice.invoiceNo} created from proforma`
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function createRazorpayOrder(req, res) {
  try {
    const body = req.validatedBody || req.body || {};
    const data = await RazorpayGatewayService.createOrderForInvoice(req, req.params.id, body);
    res.json({ success: true, data, message: 'Razorpay order created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function confirmRazorpayPayment(req, res) {
  try {
    const body = req.validatedBody || req.body || {};
    const data = await RazorpayGatewayService.confirmPaymentForInvoice(req, req.params.id, body);
    res.json({
      success: true,
      data,
      message: `Payment recorded for invoice ${data.invoice?.invoiceNo || ''}`.trim()
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function generatePayToken(req, res) {
  try {
    const data = await InvoiceService.generatePayToken(req, req.params.id);
    res.json({ success: true, data, message: 'Invoice payment link generated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function getPublicPortal(req, res) {
  try {
    const result = await InvoiceService.getPublicPortalInvoice(req, req.params.token);
    res.json({
      success: true,
      data: result.invoice,
      company: result.company,
      razorpay: result.razorpay,
      message: 'Invoice loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function createPublicRazorpayOrder(req, res) {
  try {
    const body = req.validatedBody || req.body || {};
    const data = await RazorpayGatewayService.createOrderForPublicToken(req, req.params.token, body);
    res.json({ success: true, data, message: 'Razorpay order created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function confirmPublicRazorpayPayment(req, res) {
  try {
    const body = req.validatedBody || req.body || {};
    const data = await RazorpayGatewayService.confirmPaymentForPublicToken(req, req.params.token, body);
    res.json({
      success: true,
      data,
      message: `Payment recorded for invoice ${data.invoice?.invoiceNo || ''}`.trim()
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function downloadPdf(req, res) {
  try {
    const FinanceDocumentUtil = require('../utils/finance-document.util');
    const { generateFinanceDocumentPdf } = require('../utils/pdf-generator.util');
    const loadInvoice =
      typeof InvoiceService.getById === 'function'
        ? InvoiceService.getById.bind(InvoiceService)
        : InvoiceService.get.bind(InvoiceService);
    const invoice = await loadInvoice(req, req.params.id);
    if (!invoice) {
      throw Object.assign(new Error('Invoice not found'), { status: 404 });
    }
    const payload = await FinanceDocumentUtil.buildInvoicePayload(req, invoice);
    const pdfBuffer = generateFinanceDocumentPdf(payload);
    const filename = `Invoice-${invoice.invoiceNo || invoice._id}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (error) {
    sendError(res, error);
  }
}

async function downloadPublicPdf(req, res) {
  try {
    const FinanceDocumentUtil = require('../utils/finance-document.util');
    const { generateFinanceDocumentPdf } = require('../utils/pdf-generator.util');
    const invoice = await InvoiceService.getInvoiceIdByPayToken(req, req.params.token);
    const payload = await FinanceDocumentUtil.buildInvoicePayload(req, invoice);
    const pdfBuffer = generateFinanceDocumentPdf(payload);
    const filename = `Invoice-${invoice.invoiceNo || invoice._id}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (error) {
    sendError(res, error);
  }
}

/** POST /invoices/ocr/extract — AI scan PDF page images into create-form fields */
async function extractPdfOcr(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const data = await FinancePdfOcrService.extractFromPdfPages(req, {
      documentType: 'invoice',
      imageDataUrls: body.imageDataUrls,
      imageDataUrl: body.imageDataUrl
    });
    res.json({
      success: true,
      data,
      message: 'Invoice data extracted from PDF'
    });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  exportInvoices,
  get,
  create,
  update,
  remove,
  send,
  markAsViewed,
  writeOff,
  archive,
  restore,
  saveAsTemplate,
  cancel,
  listPayments,
  printHtml,
  downloadPdf,
  getNextInvoiceNumber,
  getRazorpayStatus,
  convertProforma,
  createRazorpayOrder,
  confirmRazorpayPayment,
  generatePayToken,
  getPublicPortal,
  downloadPublicPdf,
  createPublicRazorpayOrder,
  confirmPublicRazorpayPayment,
  extractPdfOcr
};
