'use strict';

const QuotationService = require('../services/quotation.service');
const EstimateTemplateService = require('../services/estimate-template.service');
const FinancePdfOcrService = require('../services/finance-pdf-ocr.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] quotation error:', error);
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'Quotation operation failed' : error.message || 'Quotation operation failed',
    details: error.details || [],
    ...(error.code ? { code: error.code } : {}),
    // Field-level messages (e.g. { validTill: "Valid Till cannot be after …" }).
    ...(error.fields && typeof error.fields === 'object' ? { fields: error.fields } : {})
  });
}

async function list(req, res) {
  try {
    const result = await QuotationService.list(req);
    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      unlinkedClient: Boolean(result.unlinkedClient),
      message: result.message || 'Quotations loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const doc = await QuotationService.getById(req, req.params.id);
    // Unpaid / Partially Paid / Paid, from the verified payment records.
    let paymentState = null;
    try {
      paymentState = await require('../services/proforma.service').quotationPaymentState(req, doc);
    } catch {
      paymentState = null;
    }
    res.json({ success: true, data: { ...doc, paymentState }, message: 'Quotation loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const doc = await QuotationService.create(req, req.validatedBody || req.body);
    res.status(201).json({ success: true, data: doc, message: 'Quotation created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function update(req, res) {
  try {
    const doc = await QuotationService.update(req, req.params.id, req.validatedBody || req.body);
    res.json({ success: true, data: doc, message: 'Quotation updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const result = await QuotationService.remove(req, req.params.id);
    res.json({ success: true, data: result, message: 'Quotation deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function send(req, res) {
  try {
    const { doc, emailDelivery } = await QuotationService.send(req, req.params.id);
    const message = emailDelivery?.sent
      ? `Quotation emailed to ${emailDelivery.to}`
      : 'Quotation marked as sent';
    res.json({ success: true, data: doc, email: emailDelivery, message });
  } catch (error) {
    sendError(res, error);
  }
}

async function accept(req, res) {
  try {
    const doc = await QuotationService.accept(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Quotation accepted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function reject(req, res) {
  try {
    const doc = await QuotationService.reject(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Quotation rejected' });
  } catch (error) {
    sendError(res, error);
  }
}

async function convertToInvoice(req, res) {
  try {
    const result = await QuotationService.convertToInvoice(req, req.params.id);
    res.status(201).json({
      success: true,
      data: result,
      message: 'Quotation converted to invoice'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function printHtml(req, res) {
  try {
    let html;

    if (typeof QuotationService.exportPrintHtml === 'function') {
      ({ html } = await QuotationService.exportPrintHtml(req, req.params.id));
    } else if (typeof QuotationService.generatePrintHtml === 'function') {
      const rendered = await QuotationService.generatePrintHtml(req, req.params.id);
      html = typeof rendered === 'string' ? rendered : rendered?.html;
    } else {
      // Fallback when a stale Node module cache is missing exportPrintHtml
      const PrintHtmlService = require('../services/print-html.service');
      const FinanceDocumentUtil = require('../utils/finance-document.util');
      const doc = await QuotationService.getById(req, req.params.id);
      const payload = await FinanceDocumentUtil.buildQuotationPayload(req, doc);
      html = PrintHtmlService.renderFinancePrintHtml(payload);
    }

    if (!html) {
      throw Object.assign(new Error('Unable to generate quotation print HTML'), { status: 500 });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(html);
  } catch (error) {
    sendError(res, error);
  }
}

async function downloadPdf(req, res) {
  try {
    const FinanceDocumentUtil = require('../utils/finance-document.util');
    const { generateFinanceDocumentPdf } = require('../utils/pdf-generator.util');
    const doc = await QuotationService.getById(req, req.params.id);
    const payload = await FinanceDocumentUtil.buildQuotationPayload(req, doc);
    const pdfBuffer = generateFinanceDocumentPdf(payload);
    const filename = `Quotation-${doc.quotationNo || doc._id}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (error) {
    sendError(res, error);
  }
}

async function createRevision(req, res) {
  try {
    const doc = await QuotationService.createRevision(req, req.params.id, req.validatedBody || req.body);
    res.status(201).json({ success: true, data: doc, message: 'Quotation revision created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function getRevisions(req, res) {
  try {
    const items = await QuotationService.getRevisionHistory(req, req.params.id);
    res.json({ success: true, data: items, message: 'Revision history loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function archive(req, res) {
  try {
    const doc = await QuotationService.archiveQuotation(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Quotation archived' });
  } catch (error) {
    sendError(res, error);
  }
}

async function restore(req, res) {
  try {
    const doc = await QuotationService.restoreQuotation(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Quotation restored' });
  } catch (error) {
    sendError(res, error);
  }
}

async function generatePortalToken(req, res) {
  try {
    const result = await QuotationService.generatePortalToken(req, req.params.id);
    res.json({ success: true, data: result, message: 'Client portal link generated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function getPublicPortal(req, res) {
  try {
    const result = await QuotationService.getPublicPortalQuotation(req, req.params.token);
    res.json({
      success: true,
      data: result.quotation,
      company: result.company,
      razorpay: result.razorpay,
      paymentTerms: result.paymentTerms,
      message: 'Public proposal loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function createPublicRazorpayOrder(req, res) {
  try {
    const RazorpayGatewayService = require('../services/razorpay-gateway.service');
    const result = await RazorpayGatewayService.createOrderForPublicQuotationToken(
      req,
      req.params.token,
      req.body
    );
    res.json({ success: true, data: result, message: 'Payment order created successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function confirmPublicRazorpayPayment(req, res) {
  try {
    const RazorpayGatewayService = require('../services/razorpay-gateway.service');
    const result = await RazorpayGatewayService.confirmPaymentForPublicQuotationToken(
      req,
      req.params.token,
      req.body
    );
    res.json({ success: true, data: result, message: 'Payment confirmed successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function clientPortalAccept(req, res) {
  try {
    const doc = await QuotationService.clientPortalAccept(req, req.params.token, req.validatedBody || req.body);
    res.json({ success: true, data: doc, message: 'Proposal accepted successfully' });
  } catch (error) {
    sendError(res, error);
  }
}

async function clientPortalReject(req, res) {
  try {
    const doc = await QuotationService.clientPortalReject(req, req.params.token, req.validatedBody || req.body);
    res.json({ success: true, data: doc, message: 'Proposal feedback submitted' });
  } catch (error) {
    sendError(res, error);
  }
}

// Template Controller Methods
async function listTemplates(req, res) {
  try {
    const items = await EstimateTemplateService.listTemplates(req);
    res.json({ success: true, data: items, message: 'Templates loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function getTemplate(req, res) {
  try {
    const doc = await EstimateTemplateService.getTemplateById(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Template loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function createTemplate(req, res) {
  try {
    const doc = await EstimateTemplateService.createTemplate(req, req.validatedBody || req.body);
    res.status(201).json({ success: true, data: doc, message: 'Template created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function updateTemplate(req, res) {
  try {
    const doc = await EstimateTemplateService.updateTemplate(req, req.params.id, req.validatedBody || req.body);
    res.json({ success: true, data: doc, message: 'Template updated' });
  } catch (error) {
    sendError(res, error);
  }
}

async function deleteTemplate(req, res) {
  try {
    const result = await EstimateTemplateService.deleteTemplate(req, req.params.id);
    res.json({ success: true, data: result, message: 'Template deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function saveAsTemplate(req, res) {
  try {
    const doc = await EstimateTemplateService.saveAsTemplate(req, req.params.id, req.body || {});
    res.status(201).json({ success: true, data: doc, message: 'Saved as reusable template' });
  } catch (error) {
    sendError(res, error);
  }
}

async function exportQuotations(req, res) {
  try {
    const result = await QuotationService.exportQuotations(req, req.query || {});
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

/** POST /quotations/ocr/extract — AI scan PDF page images into create-form fields */
async function extractPdfOcr(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const data = await FinancePdfOcrService.extractFromPdfPages(req, {
      documentType: 'quotation',
      imageDataUrls: body.imageDataUrls,
      imageDataUrl: body.imageDataUrl
    });
    res.json({
      success: true,
      data,
      message: 'Quotation data extracted from PDF'
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Start a Razorpay payment for a quotation (full or advance).
 *
 * Raises the proforma if there is not one yet. Refused with 409 while
 * Settings → General → Enable Proforma & Advance Payment is off.
 */
async function createQuotationRazorpayOrder(req, res) {
  try {
    const RazorpayService = require('../services/razorpay-gateway.service');
    const data = await RazorpayService.createOrderForQuotation(req, req.params.id, {
      ...(req.validatedBody || req.body || {}),
      source: 'staff'
    });
    res.json({ success: true, data, message: 'Payment order created' });
  } catch (error) {
    sendError(res, error);
  }
}

/** The proforma for a quotation, raising it on first use. */
async function createQuotationProforma(req, res) {
  try {
    const ProformaService = require('../services/proforma.service');
    const { proforma, reused } = await ProformaService.ensureProformaForQuotation(
      req,
      req.params.id
    );
    res.status(reused ? 200 : 201).json({
      success: true,
      data: proforma,
      message: reused ? 'Proforma already exists' : 'Proforma created'
    });
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  createQuotationRazorpayOrder,
  createQuotationProforma,
  list,
  exportQuotations,
  get,
  create,
  update,
  remove,
  send,
  accept,
  reject,
  createRevision,
  getRevisions,
  archive,
  restore,
  generatePortalToken,
  getPublicPortal,
  clientPortalAccept,
  clientPortalReject,
  createPublicRazorpayOrder,
  confirmPublicRazorpayPayment,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  saveAsTemplate,
  convertToInvoice,
  printHtml,
  downloadPdf,
  extractPdfOcr
};
