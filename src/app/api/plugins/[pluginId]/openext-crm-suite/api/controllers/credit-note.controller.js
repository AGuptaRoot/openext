'use strict';

const CreditNoteService = require('../services/credit-note.service');

function sendError(res, error) {
  if (error?.name === 'CastError') {
    res.status(400).json({ success: false, error: 'Invalid ID', details: [] });
    return;
  }
  const status = error.status || 500;
  if (status >= 500) console.error('[plugin:openext-crm-suite] credit note error:', error);
  res.status(status).json({
    success: false,
    error: error.message || 'Credit Note operation failed',
    details: error.details || []
  });
}

async function list(req, res) {
  try {
    const result = await CreditNoteService.list(req);
    res.json({
      success: true,
      data: result.items,
      pagination: result.pagination,
      message: 'Credit Notes loaded'
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function get(req, res) {
  try {
    const doc = await CreditNoteService.getById(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Credit Note loaded' });
  } catch (error) {
    sendError(res, error);
  }
}

async function create(req, res) {
  try {
    const doc = await CreditNoteService.create(req, req.validatedBody || req.body);
    res.status(201).json({ success: true, data: doc, message: 'Credit Note created' });
  } catch (error) {
    sendError(res, error);
  }
}

async function createFromInvoice(req, res) {
  try {
    const doc = await CreditNoteService.createFromInvoice(req, req.params.invoiceId || req.body?.invoiceId, req.validatedBody || req.body);
    res.status(201).json({ success: true, data: doc, message: 'Credit Note created from invoice' });
  } catch (error) {
    sendError(res, error);
  }
}

async function apply(req, res) {
  try {
    const doc = await CreditNoteService.applyToInvoice(req, req.params.id, req.validatedBody || req.body);
    res.json({ success: true, data: doc, message: 'Credit Note applied to invoice' });
  } catch (error) {
    sendError(res, error);
  }
}

async function refund(req, res) {
  try {
    const doc = await CreditNoteService.refund(req, req.params.id, req.validatedBody || req.body);
    res.json({ success: true, data: doc, message: 'Refund recorded for Credit Note' });
  } catch (error) {
    sendError(res, error);
  }
}

async function voidNote(req, res) {
  try {
    const doc = await CreditNoteService.voidCreditNote(req, req.params.id, req.body);
    res.json({ success: true, data: doc, message: 'Credit Note voided' });
  } catch (error) {
    sendError(res, error);
  }
}

async function remove(req, res) {
  try {
    const result = await CreditNoteService.remove(req, req.params.id);
    res.json({ success: true, data: result, message: 'Credit Note deleted' });
  } catch (error) {
    sendError(res, error);
  }
}

async function archive(req, res) {
  try {
    const doc = await CreditNoteService.archive(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Credit Note archived' });
  } catch (error) {
    sendError(res, error);
  }
}

async function restore(req, res) {
  try {
    const doc = await CreditNoteService.restore(req, req.params.id);
    res.json({ success: true, data: doc, message: 'Credit Note restored' });
  } catch (error) {
    sendError(res, error);
  }
}

async function printHtml(req, res) {
  try {
    const { html } = await CreditNoteService.exportPrintHtml(req, req.params.id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(html);
  } catch (error) {
    sendError(res, error);
  }
}

module.exports = {
  list,
  get,
  create,
  createFromInvoice,
  apply,
  refund,
  voidNote,
  remove,
  archive,
  restore,
  printHtml
};
