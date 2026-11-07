'use strict';

let mongoose = null;
try {
  mongoose = require('mongoose');
} catch (_) {
  mongoose = null;
}
const { decryptCredential } = require('../utils/razorpay-credential.util');
const { isClientUser } = require('../utils/tenant.util');
const { attachTenantFromRecord } = require('../utils/portal.util');
const InvoiceService = require('./invoice.service');
const PaymentService = require('./payment.service');

const RAZORPAY_PLUGIN_ID = 'razorpay-payment-gateway';
const RAZORPAY_API = 'https://api.razorpay.com/v1';
const SOURCE_PLUGIN = 'openext-crm-suite';

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function getUserDbConnection(req) {
  if (req?.cms?.database?.user) {
    try {
      const conn = await req.cms.database.user();
      if (conn) return conn;
    } catch {
      /* continue */
    }
  }
  return mongoose?.connection || null;
}

function getPluginModel(req, userDb) {
  if (req?.cms?.models?.get) {
    const Plugin = req.cms.models.get('Plugin');
    if (Plugin) return Plugin;
  }
  if (userDb?.models?.Plugin) {
    return userDb.models.Plugin;
  }
  if (!userDb || typeof userDb.model !== 'function') return null;
  const Schema = userDb.base?.Schema || mongoose?.Schema;
  if (!Schema) return null;
  const pluginSchema = new Schema(
    {
      pluginId: { type: String, required: true },
      isActive: { type: Boolean, default: false }
    },
    { collection: 'plugins' }
  );
  return userDb.model('Plugin', pluginSchema);
}

function getRazorpayConfigModel(userDb) {
  if (!userDb || typeof userDb.model !== 'function') return null;
  const modelName = `${RAZORPAY_PLUGIN_ID}_RazorpayConfig`;
  if (userDb.models && userDb.models[modelName]) {
    return userDb.models[modelName];
  }
  const Schema = userDb.base?.Schema || mongoose?.Schema;
  if (!Schema) return null;
  const schema = new Schema(
    {
      keyId: { type: String, default: '', trim: true },
      keySecret: { type: String, default: '', select: false },
      secretStored: { type: Boolean, default: false },
      secretEncrypted: { type: Boolean, default: false },
      businessName: { type: String, default: '', trim: true },
      defaultCurrency: { type: String, default: 'INR', trim: true },
      mode: { type: String, default: 'test', trim: true },
      credentialsUpdatedAt: { type: Date },
      credentialsUpdatedBy: { type: String, default: '', trim: true }
    },
    { timestamps: true }
  );
  return userDb.model(modelName, schema);
}

function isConfigured(doc) {
  const keyId = String(doc?.keyId || '').trim();
  if (!keyId) return false;
  if (doc?.secretStored) return true;
  return Boolean(String(doc?.keySecret || '').trim());
}

function buildAuthHeader(keyId, keySecret) {
  const token = Buffer.from(`${String(keyId).trim()}:${String(keySecret).trim()}`).toString('base64');
  return `Basic ${token}`;
}

async function razorpayRequest(keyId, keySecret, path, options = {}) {
  const url = `${RAZORPAY_API}${path}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: buildAuthHeader(keyId, keySecret),
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.error?.description ||
      data?.error?.reason ||
      data?.message ||
      `Razorpay API error (${response.status})`;
    const err = new Error(message);
    err.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw err;
  }

  return data;
}

async function isPluginActive(req) {
  const userDb = await getUserDbConnection(req);
  const Plugin = getPluginModel(req, userDb);
  if (!Plugin) return false;
  try {
    const query = Plugin.findOne({ pluginId: RAZORPAY_PLUGIN_ID, isActive: true });
    const plugin = typeof query?.lean === 'function' ? await query.lean() : await query;
    return Boolean(plugin);
  } catch {
    return false;
  }
}

async function getCredentials(req) {
  const active = await isPluginActive(req);
  if (!active) {
    throw appError('Razorpay Payment Gateway plugin is not installed or enabled.', 503);
  }

  const userDb = await getUserDbConnection(req);
  const RazorpayConfig = getRazorpayConfigModel(userDb);
  if (!RazorpayConfig) {
    throw appError('Razorpay configuration is unavailable.', 503);
  }

  const doc = await RazorpayConfig.findOne({}).select('+keySecret').exec();
  if (!doc || !isConfigured(doc)) {
    throw appError('Razorpay is not configured. Connect your account in Payment Gateway settings.', 503);
  }

  const keySecret = decryptCredential(doc.keySecret);
  if (!keySecret) {
    throw appError('Razorpay Key Secret could not be decrypted. Check CREDENTIAL_ENCRYPTION_KEY.', 503);
  }

  return {
    keyId: String(doc.keyId).trim(),
    keySecret,
    currency: String(doc.defaultCurrency || 'INR').trim().toUpperCase(),
    businessName: String(doc.businessName || '').trim()
  };
}

async function getStatus(req) {
  try {
    const active = await isPluginActive(req);
    if (!active) {
      return { configured: false, available: false, keyId: '', businessName: '', currency: 'INR' };
    }

    const userDb = await getUserDbConnection(req);
    const RazorpayConfig = getRazorpayConfigModel(userDb);
    if (!RazorpayConfig) {
      return { configured: false, available: false, keyId: '', businessName: '', currency: 'INR' };
    }

    const doc = await (async () => {
      try {
        const q = RazorpayConfig.findOne({});
        return typeof q?.lean === 'function' ? await q.lean() : await q;
      } catch {
        return null;
      }
    })();
    const configured = isConfigured(doc);
    return {
      available: true,
      configured,
      keyId: configured ? String(doc.keyId).trim() : '',
      businessName: String(doc?.businessName || '').trim(),
      currency: String(doc?.defaultCurrency || 'INR').trim().toUpperCase()
    };
  } catch {
    return { configured: false, available: false, keyId: '', businessName: '', currency: 'INR' };
  }
}

function assertInvoicePayable(invoice, req = null) {
  if (!invoice) throw appError('Invoice not found', 404);
  if (invoice.status === 'Draft') {
    throw appError('Cannot collect payment for a draft invoice. Send the invoice first.', 409);
  }
  if (['Cancelled', 'Written Off', 'Paid', 'Converted'].includes(invoice.status)) {
    throw appError(`Cannot collect payment for a ${invoice.status} invoice`, 409);
  }
  if (invoice.documentType === 'proforma' && invoice.convertedInvoiceId) {
    throw appError('This payment request was converted to a tax invoice: pay the tax invoice.', 409);
  }
  const balance = Number(invoice.balanceDue != null ? invoice.balanceDue : invoice.grandTotal);
  if (balance <= 0) {
    throw appError('This invoice has no balance due', 409);
  }
  if (req && isClientUser(req)) {
    // Logged-in clients may pay any open invoice with balance (Sent / Viewed / Partially Paid / Overdue).
    const blocked = ['Draft', 'Cancelled', 'Written Off', 'Paid'];
    if (blocked.includes(String(invoice.status))) {
      throw appError(`Cannot collect payment for a ${invoice.status} invoice`, 409);
    }
  }
}

/**
 * Public pay-token checkout requires an authenticated client session first.
 * Token proves invoice identity; login proves who is paying.
 */
async function assertAuthenticatedClientForPublicPay(req, invoice) {
  if (!req?.user) {
    throw appError('Please log in to pay this invoice', 401);
  }
  if (!isClientUser(req)) {
    throw appError('Please log in with your client portal account to pay', 403);
  }

  const { resolveClientIdAsync, resolveClientId } = require('../utils/tenant.util');
  const clientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
  if (!clientId) {
    throw appError('Client account is not linked. Contact support before paying.', 403);
  }
  if (invoice?.clientId && String(invoice.clientId) !== String(clientId)) {
    throw appError('This invoice does not belong to your account', 403);
  }
}

function toPaise(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw appError('Payment amount must be greater than zero');
  }
  const cur = String(currency || 'INR').toUpperCase();
  const multiplier = ['JPY', 'KRW'].includes(cur) ? 1 : 100;
  return Math.round(value * multiplier);
}

function fromPaise(paise, currency) {
  const value = Number(paise);
  if (!Number.isFinite(value) || value <= 0) {
    throw appError('Invalid payment amount from Razorpay');
  }
  const cur = String(currency || 'INR').toUpperCase();
  const divisor = ['JPY', 'KRW'].includes(cur) ? 1 : 100;
  return Math.round((value / divisor) * 100) / 100;
}

function mapRazorpayMethod(method) {
  const m = String(method || '').toLowerCase();
  if (m === 'upi' || m === 'wallet') return 'UPI';
  if (m === 'card' || m === 'emi') return 'Card';
  if (m === 'netbanking') return 'Bank Transfer';
  return 'Other';
}

async function createOrderForInvoice(req, invoiceId, options = {}) {
  const invoice = await InvoiceService.getById(req, invoiceId);
  assertInvoicePayable(invoice, req);

  const creds = await getCredentials(req);
  // The invoice's own currency: a request may not switch it (an order in another currency would
  // record the wrong money against the invoice).
  const currency = String(invoice.currency || creds.currency || 'INR').trim().toUpperCase();
  if (options.currency && String(options.currency).trim().toUpperCase() !== currency) {
    throw appError(`This invoice is payable in ${currency} only`, 409);
  }

  const balanceDue = Math.round(Number(invoice.balanceDue != null ? invoice.balanceDue : invoice.grandTotal || 0) * 100) / 100;
  let payAmount = options.amount != null ? Math.round(Number(options.amount) * 100) / 100 : balanceDue;

  if (!Number.isFinite(payAmount) || payAmount <= 0) {
    throw appError('Payment amount must be greater than zero');
  }
  if (payAmount > balanceDue + 0.05) {
    throw appError(`Payment amount (${payAmount}) exceeds invoice balance due (${balanceDue})`, 409);
  }
  if (Math.abs(payAmount - balanceDue) <= 0.05 || payAmount > balanceDue) {
    payAmount = balanceDue;
  }

  const amountPaise = toPaise(payAmount, currency);
  const receipt = String(invoice.invoiceNo || `inv_${invoice._id}`).slice(0, 40);

  const order = await razorpayRequest(creds.keyId, creds.keySecret, '/orders', {
    method: 'POST',
    body: {
      amount: amountPaise,
      currency,
      receipt,
      notes: {
        invoiceId: String(invoice._id),
        invoiceNo: String(invoice.invoiceNo || ''),
        clientId: String(invoice.clientId || ''),
        tenantId: String(invoice.tenantId || ''),
        sourcePlugin: SOURCE_PLUGIN
      },
      partial_payment: payAmount < balanceDue
    }
  });

  return {
    order,
    keyId: creds.keyId,
    currency,
    businessName: creds.businessName,
    amount: amountPaise,
    amountDue: payAmount,
    invoice: {
      id: invoice._id,
      invoiceNo: invoice.invoiceNo,
      balanceDue: invoice.balanceDue,
      currency: invoice.currency
    }
  };
}

async function verifyPaymentSignature(creds, { razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const orderId = String(razorpay_order_id || '').trim();
  const paymentId = String(razorpay_payment_id || '').trim();
  const signature = String(razorpay_signature || '').trim();

  if (!orderId || !paymentId || !signature) {
    throw appError('razorpay_order_id, razorpay_payment_id, and razorpay_signature are required');
  }

  const crypto = require('crypto');
  const expected = crypto
    .createHmac('sha256', creds.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  if (expected !== signature) {
    throw appError('Invalid Razorpay payment signature', 400);
  }

  return { orderId, paymentId };
}

/**
 * Start a Razorpay payment for a quotation.
 *
 * A payment needs an invoice to belong to — Payment.invoiceId is required and
 * the gateway's receipt is the invoice number — so the proforma is raised (or
 * reused) first and the ordinary invoice order path does the rest. Refused
 * while proforma & advance payment is off.
 */
async function createOrderForQuotation(req, quotationId, options = {}) {
  const ProformaService = require('./proforma.service');
  const invoiced = await payableQuotationInvoice(req, quotationId);
  if (invoiced) {
    const order = await createOrderForInvoice(req, String(invoiced.invoice._id), { currency: options.currency });
    return {
      ...order,
      proformaId: String(invoiced.invoice._id),
      proformaNo: invoiced.invoice.invoiceNo,
      quotationId: String(quotationId),
      quotationNo: invoiced.quotation.quotationNo || '',
      isAdvance: false,
      isBalance: true
    };
  }
  const { proforma, quotation } = await ProformaService.ensureProformaForQuotation(
    req,
    quotationId,
    options
  );

  const order = await createOrderForInvoice(req, String(proforma._id), {
    currency: options.currency || proforma.currency
  });

  return {
    ...order,
    proformaId: String(proforma._id),
    proformaNo: proforma.invoiceNo,
    quotationId: String(quotationId),
    quotationNo: quotation.quotationNo || '',
    isAdvance: Number(proforma.grandTotal) < Number(quotation.grandTotal),
    isBalance: /^Balance /.test(String(proforma.notes || ''))
  };
}

/** A quotation already invoiced (staff converted it) whose invoice still has a balance: pay that invoice. */
async function payableQuotationInvoice(req, quotationId) {
  const QuotationService = require('./quotation.service');
  const quotation = await QuotationService.getById(req, quotationId);
  const invoiceId = String(quotation.convertedInvoiceId || '');
  if (!invoiceId || invoiceId.startsWith('pending:')) return null;
  const invoice = await InvoiceService.getById(req, invoiceId).catch(() => null);
  if (!invoice || !(Number(invoice.balanceDue) > 0)) return null;
  return { quotation, invoice };
}

/** A payment on a quotation's request may never take more than the quotation still owes. */
async function assertWithinQuotationBalance(req, invoice, amount) {
  if (!invoice || invoice.documentType !== 'proforma') return;
  const quotationId = String(invoice.quotationId || invoice.convertedQuotationId || '').trim();
  const Estimate = req.cms?.models.get('Estimate');
  if (!quotationId || !Estimate) return;
  const quotation = await Estimate.findOne({ tenantId: invoice.tenantId, _id: quotationId, isDeleted: false }).lean();
  if (!quotation) return;
  const ProformaService = require('./proforma.service');
  const state = await ProformaService.quotationPaymentState(req, quotation);
  if (state.status === 'Paid') throw appError('This quotation is already paid in full', 409);
  if (state.advanceSatisfied) throw appError('The advance is already paid; the rest is payable on the Tax Invoice', 409);
  // What the quotation asks for now (the advance, or the request's balance), never the whole balance.
  const payableNow = state.nextPayment ? state.nextPayment.amount : 0;
  if (amount > payableNow + 0.05) {
    throw appError(`Paid amount (${amount}) exceeds what is payable now (${payableNow})`, 409);
  }
}

// Confirmations in progress, by gateway payment id: a second one (refresh, retried callback) waits for the first.
const confirming = new Map();

async function confirmPaymentForInvoice(req, invoiceId, payload = {}) {
  const creds = await getCredentials(req);
  const { paymentId } = await verifyPaymentSignature(creds, payload);
  const key = String(paymentId);
  if (confirming.has(key)) {
    await confirming.get(key).catch(() => {});
  }
  const run = confirmVerifiedPayment(req, invoiceId, payload, creds, paymentId);
  confirming.set(key, run);
  try {
    return await run;
  } finally {
    if (confirming.get(key) === run) confirming.delete(key);
  }
}

async function confirmVerifiedPayment(req, invoiceId, payload, creds, paymentId) {
  let invoice = await InvoiceService.getById(req, invoiceId);

  const Payment = req.cms?.models.get('Payment');
  if (Payment) {
    const existing = await Payment.findOne({
      tenantId: invoice.tenantId,
      transactionId: paymentId,
      isDeleted: false
    }).lean();
    if (existing) {
      // Already recorded (a refresh or a repeated callback): the same result, nothing recorded twice.
      invoice = await InvoiceService.getById(req, String(existing.invoiceId || invoiceId)).catch(() => invoice);
      return {
        payment: existing,
        invoice,
        alreadyRecorded: true,
        autoAccept: { accepted: false },
        autoInvoice: { invoiced: false },
        razorpay: { paymentId, orderId: payload.razorpay_order_id || '' }
      };
    }
  }
  assertInvoicePayable(invoice, req);

  const razorpayPayment = await razorpayRequest(creds.keyId, creds.keySecret, `/payments/${paymentId}`);
  const currency = String(razorpayPayment.currency || invoice.currency || creds.currency).toUpperCase();
  const amount = fromPaise(razorpayPayment.amount, currency);

  const balanceDue = Math.round(Number(invoice.balanceDue != null ? invoice.balanceDue : invoice.grandTotal || 0) * 100) / 100;
  if (amount > balanceDue + 0.05) {
    throw appError(`Paid amount (${amount}) exceeds invoice balance due (${balanceDue})`, 409);
  }
  if (invoice.currency && currency !== String(invoice.currency).toUpperCase()) {
    throw appError(`The payment was made in ${currency}, but this invoice is in ${String(invoice.currency).toUpperCase()}`, 409);
  }
  if (String(razorpayPayment.status || '') && !['captured', 'authorized'].includes(String(razorpayPayment.status))) {
    throw appError(`The payment is ${razorpayPayment.status}, not completed`, 409);
  }
  await assertWithinQuotationBalance(req, invoice, amount);

  const payment = await PaymentService.recordRazorpayPayment(req, {
    invoiceId: String(invoiceId),
    amount,
    currency,
    transactionId: paymentId,
    orderId: String(payload.razorpay_order_id || razorpayPayment.order_id || '').trim(),
    method: mapRazorpayMethod(razorpayPayment.method),
    remark: `Razorpay payment ${paymentId}`
  });

  const updatedInvoice = await InvoiceService.getById(req, invoiceId);

  /*
   * A paid proforma may accept its quotation, when the tenant switched that on.
   * It is deliberately after the payment is recorded and never fatal: the money
   * is in, and acceptance also marks the deal Won and locks it.
   */
  // The follow-up already ran when the payment was recorded (PaymentService).
  const followUp = (payment && payment.proformaFollowUp) || null;
  const autoAccept = (followUp && followUp.autoAccept) || { accepted: false };
  const autoInvoice = (followUp && followUp.autoInvoice) || { invoiced: false };
  const finalInvoice = autoInvoice.invoiced ? await InvoiceService.getById(req, invoiceId) : updatedInvoice;

  return {
    payment,
    invoice: finalInvoice,
    autoAccept,
    autoInvoice,
    razorpay: {
      paymentId,
      orderId: payload.razorpay_order_id || razorpayPayment.order_id,
      method: razorpayPayment.method,
      status: razorpayPayment.status
    }
  };
}

async function createOrderForPublicToken(req, token, options = {}) {
  const invoice = await InvoiceService.getInvoiceIdByPayToken(req, token);
  await assertAuthenticatedClientForPublicPay(req, invoice);
  assertInvoicePayable(invoice, req);
  // Reuse staff order builder, but keep public-portal ACL skip from pay-token attach.
  return createOrderForInvoice(req, invoice._id, options);
}

async function confirmPaymentForPublicToken(req, token, payload = {}) {
  const invoice = await InvoiceService.getInvoiceIdByPayToken(req, token);
  await assertAuthenticatedClientForPublicPay(req, invoice);
  return confirmPaymentForInvoice(req, invoice._id, payload);
}

async function createOrderForPublicQuotationToken(req, token, options = {}) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw appError('Portal token is required', 400);

  const Estimate = req.cms?.models.get('Estimate');
  if (!Estimate) throw new Error('Estimate model is not registered');

  const quotation = await Estimate.findOne({ portalToken: cleanToken, isDeleted: false }).lean();
  if (!quotation) throw appError('Quotation not found', 404);

  if (['Rejected', 'Cancelled'].includes(String(quotation.status))) {
    throw appError(`Cannot pay a ${String(quotation.status).toLowerCase()} quotation`, 409);
  }

  attachTenantFromRecord(req, quotation);

  // ensureProformaForQuotation refuses a quotation already paid in full (from the payment records)
  // and raises the balance request after an advance.
  const ProformaService = require('./proforma.service');
  const { proforma } = await ProformaService.ensureProformaForQuotation(
    req,
    quotation._id,
    { ...options, source: 'portal', allowPayment: true }
  );

  const order = await createOrderForInvoice(req, String(proforma._id), {
    amount: options.amount,
    currency: options.currency || proforma.currency
  });

  return {
    ...order,
    proformaId: String(proforma._id),
    proformaNo: proforma.invoiceNo,
    quotationId: String(quotation._id),
    quotationNo: quotation.quotationNo || '',
    isAdvance: Number(proforma.grandTotal) < Number(quotation.grandTotal),
    payableAmount: proforma.balanceDue != null ? proforma.balanceDue : proforma.grandTotal
  };
}

async function confirmPaymentForPublicQuotationToken(req, token, payload = {}) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw appError('Portal token is required', 400);

  const Estimate = req.cms?.models.get('Estimate');
  if (!Estimate) throw new Error('Estimate model is not registered');

  const quotation = await Estimate.findOne({ portalToken: cleanToken, isDeleted: false }).lean();
  if (!quotation) throw appError('Quotation not found', 404);

  if (['Rejected', 'Cancelled'].includes(String(quotation.status))) {
    throw appError(`Cannot pay a ${String(quotation.status).toLowerCase()} quotation`, 409);
  }

  attachTenantFromRecord(req, quotation);

  const Invoice = req.cms?.models.get('Invoice');
  let proforma = null;
  if (quotation.proformaInvoiceId && Invoice) {
    proforma = await Invoice.findOne({ _id: quotation.proformaInvoiceId, isDeleted: false }).lean();
  }
  if (!proforma && Invoice) {
    proforma = await Invoice.findOne({ quotationId: String(quotation._id), isDeleted: false }).lean();
  }

  if (!proforma) {
    throw appError('Proforma invoice not found for quotation', 404);
  }

  return confirmPaymentForInvoice(req, proforma._id, payload);
}

module.exports = {
  getStatus,
  assertInvoicePayable,
  createOrderForInvoice,
  createOrderForQuotation,
  confirmPaymentForInvoice,
  createOrderForPublicToken,
  confirmPaymentForPublicToken,
  createOrderForPublicQuotationToken,
  confirmPaymentForPublicQuotationToken
};
