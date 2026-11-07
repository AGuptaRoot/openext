'use strict';

/**
 * Per-record currency helpers.
 *
 * Global Settings `default_currency` is ONLY the default for NEW records.
 * It must never rewrite existing documents.
 *
 * Stored field name on documents: `currency` (ISO 4217 code, e.g. USD).
 * APIs also accept `currencyCode` as an alias for the same value.
 * Responses may include both `currency` and `currencyCode` (same value).
 */

function normalizeCurrencyCode(value, fallback = 'INR') {
  const code = String(value || '')
    .trim()
    .toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) return code;
  const fb = String(fallback || '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(fb) ? fb : 'INR';
}

/**
 * Resolve currency for a create/update payload.
 * Priority: input.currencyCode / input.currency → sourceCurrency → settings.default_currency → fallback.
 *
 * @param {Object} input
 * @param {Object} [settings]
 * @param {string|null} [sourceCurrency] Currency inherited from parent document
 * @param {string} [fallback]
 */
function resolveRecordCurrency(input = {}, settings = {}, sourceCurrency = null, fallback = 'INR') {
  const fromInput = input.currencyCode || input.currency;
  if (fromInput) return normalizeCurrencyCode(fromInput, fallback);
  if (sourceCurrency) return normalizeCurrencyCode(sourceCurrency, fallback);
  const fromSettings = settings && settings.default_currency;
  return normalizeCurrencyCode(fromSettings, fallback);
}

function resolveExchangeRate(input = {}, sourceExchangeRate = null) {
  const raw = input.exchangeRate !== undefined && input.exchangeRate !== null
    ? Number(input.exchangeRate)
    : sourceExchangeRate != null
      ? Number(sourceExchangeRate)
      : 1;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return raw;
}

/**
 * When a downstream document currency differs from its source, exchange rate is required
 * for base-currency reporting.
 */
function assertCurrencyChangeExchangeRate(recordCurrency, sourceCurrency, exchangeRate) {
  const record = normalizeCurrencyCode(recordCurrency);
  const source = sourceCurrency ? normalizeCurrencyCode(sourceCurrency) : '';
  if (!source || record === source) return null;
  const rate = Number(exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    const err = new Error(
      `Currency differs from source document (${source} → ${record}). Provide a valid exchange rate for base-currency reporting.`
    );
    err.status = 400;
    err.code = 'EXCHANGE_RATE_REQUIRED';
    return err;
  }
  return null;
}

/** Attach currencyCode alias without mutating unrelated fields. */
function withCurrencyCode(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const code = doc.currency ? normalizeCurrencyCode(doc.currency) : null;
  if (!code) return { ...doc, currencyCode: doc.currencyCode || null };
  return { ...doc, currency: code, currencyCode: code };
}

module.exports = {
  normalizeCurrencyCode,
  resolveRecordCurrency,
  resolveExchangeRate,
  assertCurrencyChangeExchangeRate,
  withCurrencyCode,
};
