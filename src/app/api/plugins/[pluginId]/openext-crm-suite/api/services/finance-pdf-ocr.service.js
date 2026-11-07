'use strict';

/**
 * Extract invoice / quotation fields from PDF page images via Groq vision.
 * Client converts PDF pages → JPEG data URLs; this service reads them with AI.
 */

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const SettingService = require('./setting.service');
const LeadOcrService = require('./lead-ocr.service');

const GROQ_VISION_MODEL_CANDIDATES = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3.8-27b'
];

function asCleanString(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function asNumber(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const n = Number(String(value).replace(/,/g, '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function normalizeDate(raw) {
  const s = asCleanString(raw);
  if (!s) return '';
  // Already ISO yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // dd/mm/yyyy or dd-mm-yyyy
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (dmy) {
    let y = Number(dmy[3]);
    if (y < 100) y += 2000;
    const m = String(dmy[2]).padStart(2, '0');
    const d = String(dmy[1]).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // mm/dd/yyyy ambiguous — try Date parse
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    const dt = new Date(t);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return '';
}

function normalizeTaxCalculation(raw) {
  const s = asCleanString(raw).toLowerCase().replace(/\s+/g, '_');
  if (!s) return 'after_discount';
  if (
    s.includes('before') ||
    s === 'before_discount' ||
    s === 'before_tax' ||
    s === 'exclusive'
  ) {
    return 'before_discount';
  }
  // default: after discount / after tax (inclusive of form default)
  return 'after_discount';
}

function normalizeCurrency(raw) {
  const s = asCleanString(raw).toUpperCase();
  if (!s) return 'INR';
  if (s.includes('₹') || s.includes('RUPEE') || s === 'RS' || s === 'INR') return 'INR';
  if (s.includes('USD') || s.includes('$') || s === 'US') return 'USD';
  if (s.includes('EUR') || s.includes('€')) return 'EUR';
  if (s.includes('GBP') || s.includes('£')) return 'GBP';
  if (s.includes('AED')) return 'AED';
  if (/^[A-Z]{3}$/.test(s)) return s;
  return 'INR';
}

function normalizeImageDataUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(value)) return value;
  if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.replace(/\s/g, '').length > 100) {
    return `data:image/jpeg;base64,${value.replace(/\s/g, '')}`;
  }
  return '';
}

function stripCodeFences(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return String(fenced[1] || '').trim();
  return raw;
}

function safeParseJson(text) {
  const cleaned = stripCodeFences(text);
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildSystemPrompt(documentType) {
  const kind = documentType === 'quotation' ? 'quotation / estimate / proposal' : 'invoice / tax invoice / bill';
  return `You are reading page images of a ${kind} PDF.
Return ONLY valid JSON (no markdown) with this exact shape:
{
  "documentNumber": "string",
  "issueDate": "YYYY-MM-DD",
  "dueDate": "YYYY-MM-DD",
  "currency": "INR|USD|EUR|GBP|AED|...",
  "exchangeRate": 1,
  "taxCalculation": "after_discount|before_discount",
  "paymentDetails": "string",
  "billingAddress": "string",
  "shippingAddress": "string",
  "clientName": "string",
  "notes": "string",
  "items": [
    {
      "name": "string",
      "description": "string",
      "quantity": 1,
      "price": 0,
      "tax": 0,
      "amount": 0
    }
  ]
}
Rules:
- Read ALL pages carefully (header, dates, addresses, payment section, line items table).
- documentNumber = invoice number / quote number / estimate number.
- issueDate = invoice date / quote date. dueDate = due date / valid till / expiry.
- currency defaults to INR if unclear. exchangeRate defaults to 1.
- taxCalculation: use "after_discount" when tax is applied after discounts (common); "before_discount" when tax is on gross before discount. If document says tax after tax/discount unclear, use after_discount.
- paymentDetails = bank details, UPI, payment terms text.
- billingAddress / shippingAddress = full multi-line addresses when present.
- items: one object per product/service line. name and price are required when the line exists.
- quantity defaults to 1. tax is percent (e.g. 18 for 18%). amount = line total if shown.
- Do not invent products that are not on the document.
- Use empty string "" or 0 when missing.`;
}

function normalizeExtracted(parsed, documentType) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const rawItems = Array.isArray(source.items)
    ? source.items
    : Array.isArray(source.lineItems)
      ? source.lineItems
      : Array.isArray(source.products)
        ? source.products
        : [];

  const items = rawItems
    .map((row) => {
      const r = row && typeof row === 'object' ? row : {};
      const name = asCleanString(r.name || r.productName || r.item || r.description);
      const qty = Math.max(0, asNumber(r.quantity ?? r.qty ?? r.qtyOrdered, 1)) || 1;
      const price = Math.max(0, asNumber(r.price ?? r.rate ?? r.unitPrice ?? r.unit_price, 0));
      const tax = Math.max(0, asNumber(r.tax ?? r.taxRate ?? r.taxPercent ?? r.gst, 0));
      let amount = asNumber(r.amount ?? r.total ?? r.lineTotal, 0);
      if (!amount && price) {
        const base = qty * price;
        amount = tax > 0 ? base + (base * tax) / 100 : base;
      }
      return {
        name,
        description: asCleanString(r.description || ''),
        quantity: qty,
        price,
        tax,
        amount: Math.round(amount * 100) / 100
      };
    })
    .filter((item) => item.name);

  const issueDate = normalizeDate(source.issueDate || source.invoiceDate || source.date || source.quoteDate);
  const dueDate = normalizeDate(
    source.dueDate || source.validTill || source.validUntil || source.expiryDate || source.paymentDue
  );

  return {
    documentType: documentType === 'quotation' ? 'quotation' : 'invoice',
    documentNumber: asCleanString(
      source.documentNumber ||
        source.invoiceNumber ||
        source.invoiceNo ||
        source.quotationNumber ||
        source.quoteNumber ||
        source.estimateNumber
    ),
    issueDate,
    dueDate,
    currency: normalizeCurrency(source.currency),
    exchangeRate: Math.max(0.000001, asNumber(source.exchangeRate ?? source.fxRate, 1) || 1),
    taxCalculation: normalizeTaxCalculation(source.taxCalculation || source.taxMode || source.calculateTax),
    paymentDetails: asCleanString(source.paymentDetails || source.paymentInfo || source.bankDetails),
    billingAddress: asCleanString(source.billingAddress || source.billTo || source.billing),
    shippingAddress: asCleanString(source.shippingAddress || source.shipTo || source.shipping),
    clientName: asCleanString(source.clientName || source.customerName || source.billToName || source.company),
    notes: asCleanString(source.notes || source.terms || source.remarks),
    items
  };
}

async function callGroqVisionMultiPage(apiKey, model, imageDataUrls, documentType) {
  const content = [
    {
      type: 'text',
      text:
        `Extract all fields and line items from this ${documentType} PDF (images are sequential pages). ` +
        'Return JSON only as specified in the system prompt.'
    },
    ...imageDataUrls.slice(0, 6).map((url) => ({
      type: 'image_url',
      image_url: { url }
    }))
  ];

  const response = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt(documentType) },
        { role: 'user', content }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

/**
 * @param {object} req
 * @param {{ documentType?: 'invoice'|'quotation', imageDataUrls?: string[], imageDataUrl?: string }} input
 */
async function extractFromPdfPages(req, input = {}) {
  const documentType = input.documentType === 'quotation' ? 'quotation' : 'invoice';
  const urls = [];
  if (Array.isArray(input.imageDataUrls)) {
    for (const raw of input.imageDataUrls) {
      const url = normalizeImageDataUrl(raw);
      if (url) urls.push(url);
    }
  }
  const single = normalizeImageDataUrl(input.imageDataUrl || input.image || input.dataUrl);
  if (single) urls.push(single);

  if (!urls.length) {
    const err = new Error('PDF page images are required (imageDataUrls)');
    err.status = 400;
    throw err;
  }

  const totalChars = urls.reduce((sum, u) => sum + u.length, 0);
  if (totalChars > 20_000_000) {
    const err = new Error('PDF image payload is too large. Try fewer pages or a smaller file.');
    err.status = 400;
    throw err;
  }

  const { apiKey, source } = await SettingService.resolveGroqApiKey(req);
  if (!apiKey) {
    const status = await SettingService.getGroqIntegration(req).catch(() => null);
    const hint = status?.hint ? ` (saved hint: ${status.hint})` : '';
    const err = new Error(
      `Groq API key is not configured${hint}. Open Settings → Integrations, paste your gsk_ key, Save, then retry. Source: ${source || 'none'}.`
    );
    err.status = 503;
    throw err;
  }

  const preferred = await SettingService.resolveGroqOcrModel(req);
  const accessible = await LeadOcrService.listAccessibleModelIds(apiKey);
  const tryList = LeadOcrService.buildModelTryList(preferred, accessible, { visionOnly: true });
  const tried = [];
  let lastErrorMessage = '';

  for (const model of tryList.length ? tryList : GROQ_VISION_MODEL_CANDIDATES) {
    tried.push(model);
    let response;
    let payload;
    try {
      ({ response, payload } = await callGroqVisionMultiPage(apiKey, model, urls, documentType));
    } catch (networkError) {
      lastErrorMessage = networkError?.message || 'network error';
      continue;
    }

    if (!response.ok) {
      lastErrorMessage =
        payload?.error?.message || payload?.message || `Groq API error (HTTP ${response.status})`;
      if (
        /does not exist|do not have access|model_not_found|invalid_model|decommissioned|not available|forbidden/i.test(
          lastErrorMessage
        )
      ) {
        continue;
      }
      const err = new Error(lastErrorMessage);
      err.status = response.status >= 400 && response.status < 500 ? 400 : 502;
      throw err;
    }

    const content = payload?.choices?.[0]?.message?.content;
    const parsed = safeParseJson(content);
    if (!parsed) {
      lastErrorMessage = `Groq vision model ${model} returned unreadable JSON`;
      continue;
    }

    const normalized = normalizeExtracted(parsed, documentType);
    return {
      ...normalized,
      model,
      triedModels: tried,
      pageCount: urls.length,
      extractionMode: 'pdf-vision'
    };
  }

  const err = new Error(
    lastErrorMessage ||
      `No accessible Groq vision model found. Tried: ${tried.join(', ') || '(none)'}.`
  );
  err.status = 502;
  throw err;
}

module.exports = {
  extractFromPdfPages,
  normalizeExtracted
};
