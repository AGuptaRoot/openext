'use strict';

/**
 * @fileoverview Shared CRM validation utilities and helpers.
 * 
 * Use case: All domain schema validators (lead, client, finance, project, etc.)
 * import these low-level helpers to sanitize inputs, check format rules,
 * accumulate errors, and build ok/fail result objects consumed by services
 * and route middleware before persisting records to the database.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MOBILE_RE = /^\+?\d{7,15}$/;
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const HTTP_URL_RE = /^https?:\/\/[^\s]+$/i;

/**
 * Use case: Safely coerce unknown request bodies / nested payloads to plain
 * objects so that downstream field extraction never throws on null/arrays.
 * Called at the top of every validate*() function before reading properties.
 * 
 * @param {*} value Arbitrary input from request body or nested field
 * @returns {Object} value if it is a non-null non-array object, else {}
 */
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Use case: Trim whitespace from user-entered text fields (names, addresses,
 * notes) before length checks and persistence. Preserves undefined so optional
 * fields can be distinguished from empty strings.
 * 
 * @param {*} value Raw string-like field from request body
 * @returns {string|undefined} Trimmed string, or undefined if input was null/undefined
 */
function trimString(value) {
  if (value === undefined || value === null) return undefined;
  return String(value).trim();
}

/**
 * Use case: Normalize CRM contact email addresses (lead, client, contact person)
 * by trimming and lowercasing so that duplicate detection works consistently.
 * 
 * @param {*} value Raw email input from create/update payload
 * @returns {string|undefined} Lowercased trimmed email, or undefined if absent
 */
function trimLowerEmail(value) {
  const email = trimString(value);
  if (email === undefined) return undefined;
  return email.toLowerCase();
}

/**
 * Use case: Normalize Indian and international mobile/phone numbers before
 * duplicate checks and persistence. Strips spaces/dashes/parens and converts
 * 00-prefixed numbers to + country-code form used by MOBILE_RE validator.
 * 
 * @param {*} value Raw phone/mobile string (e.g. "+91 98-765-43210" or "00919876543210")
 * @returns {string|undefined} Compact number like "+919876543210", '' if falsy, or undefined if absent
 */
function normalizeMobile(value) {
  const mobile = trimString(value);
  if (mobile === undefined) return undefined;
  if (!mobile) return '';
  const compact = mobile.replace(/[\s().-]/g, '');
  return compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
}

/**
 * Use case: Normalize Indian PAN (tax ID) strings to uppercase so
 * isValidPan() matches the format ABCDE1234F reliably regardless of input case.
 * 
 * @param {*} value Raw PAN input from lead/client onboarding form
 * @returns {string|undefined} Uppercased trimmed PAN, or undefined if absent
 */
function normalizePan(value) {
  const pan = trimString(value);
  return pan === undefined ? undefined : pan.toUpperCase();
}

/**
 * Use case: Wrap a successfully validated and sanitized value object so
 * callers (service layer / route middleware) can destructure `ok` and `value`.
 * 
 * @param {*} value Sanitized field map / scalar after validation
 * @returns {{ok: true, value: *}} Standard success envelope
 */
function ok(value) {
  return { ok: true, value };
}

/**
 * Use case: Wrap validation failures with an array of human-readable error
 * messages that route handlers return to the CRM frontend for toast/inline display.
 * 
 * @param {string|string[]} errors Single error string or array of messages
 * @returns {{ok: false, errors: string[]}} Standard failure envelope
 */
function fail(errors) {
  return { ok: false, errors: Array.isArray(errors) ? errors : [String(errors)] };
}

/**
 * Use case: Before persisting a lead / client / contact person, services call
 * this to ensure the email conforms to RFC-lite rules (no double dots,
 * valid label lengths, allowed characters) and fits within the 120-char DB column.
 * Empty string / undefined is considered valid (optional field semantics).
 * 
 * @param {string|undefined} email Trimmed+lowercased email to check
 * @returns {boolean} True if email is absent or well-formed
 */
function isValidEmail(email) {
  if (!email) return true;
  if (email.length > 120 || !EMAIL_RE.test(email) || email.includes('..')) return false;
  const [local, domain] = email.split('@');
  if (!local || local.startsWith('.') || local.endsWith('.')) return false;
  return domain.split('.').every(
    (label) => label && label.length <= 63 && /^[A-Za-z0-9-]+$/.test(label) && !label.startsWith('-') && !label.endsWith('-')
  );
}

/**
 * Use case: Assert helper that pushes an error into the shared errors array
 * if an email is present AND malformed. Called from every create/update validator
 * that accepts email fields (leads, clients, contacts).
 * 
 * @param {string[]} errors Mutable list of error messages accumulated by caller
 * @param {string|undefined} email Field value (usually after trimLowerEmail)
 * @param {string} [fieldLabel='Email'] Label to interpolate into the error message
 * @returns {void} Mutates errors array by reference
 */
function assertEmail(errors, email, fieldLabel = 'Email') {
  if (email !== undefined && email && !isValidEmail(email)) {
    errors.push(`${fieldLabel} is invalid`);
  }
}

/**
 * Use case: Checks that a normalized phone/mobile is empty or matches the
 * Indian + international 7–15 digit format accepted across the CRM
 * (leads, clients, contacts, company phone).
 * 
 * @param {string|undefined} mobile Value after normalizeMobile() pipeline
 * @returns {boolean} True if absent or matches /^\+?\d{7,15}$/
 */
function isValidMobile(mobile) {
  return !mobile || MOBILE_RE.test(mobile);
}

/**
 * Use case: Assert helper — before persisting a lead/client record this ensures
 * phone/mobile matches Indian +7–15 digit format; pushes a user-facing error
 * if validation fails.
 * 
 * @param {string[]} errors Mutable error list from parent validator
 * @param {string|undefined} mobile Normalized mobile number
 * @param {string} [fieldLabel='Mobile number'] Label for error text
 * @returns {void} Mutates errors array by reference
 */
function assertMobile(errors, mobile, fieldLabel = 'Mobile number') {
  if (mobile !== undefined && mobile && !isValidMobile(mobile)) {
    errors.push(`${fieldLabel} must contain 7 to 15 digits and may start with +`);
  }
}

/**
 * Use case: Validates that a PAN field (after normalizePan uppercase) either is
 * empty or matches the Indian income-tax format: 5 letters, 4 digits, 1 letter.
 * 
 * @param {string|undefined} pan Uppercased PAN string
 * @returns {boolean} True if absent or conforms to PAN pattern
 */
function isValidPan(pan) {
  return !pan || PAN_RE.test(pan);
}

/**
 * Use case: Assert helper used on lead onboarding and client KYC forms to make
 * sure the PAN number follows the ABCDE1234F format when provided.
 * 
 * @param {string[]} errors Mutable error list from parent validator
 * @param {string|undefined} pan Uppercased PAN value
 * @param {string} [fieldLabel='PAN number'] Label for error text
 * @returns {void} Mutates errors array by reference
 */
function assertPan(errors, pan, fieldLabel = 'PAN number') {
  if (pan !== undefined && pan && !isValidPan(pan)) {
    errors.push(`${fieldLabel} must use the format ABCDE1234F`);
  }
}

/**
 * Use case: Enforces column-size limits on text fields (names, notes, URLs)
 * before the persistence layer throws a DB length error; shows a friendly
 * message in the CRM UI.
 * 
 * @param {string[]} errors Mutable error list from parent validator
 * @param {string|undefined} value Field value to measure
 * @param {number} maximum Allowed character count
 * @param {string} fieldLabel Human-readable field name for the error message
 * @returns {void} Mutates errors array by reference
 */
function assertMaxLength(errors, value, maximum, fieldLabel) {
  if (value !== undefined && value && value.length > maximum) {
    errors.push(`${fieldLabel} must be ${maximum} characters or fewer`);
  }
}

/**
 * Use case: Checks optional website / receipt URLs pasted into the CRM
 * (company website, expense receipt upload URLs). Only http/https protocols
 * are accepted; also validates via URL constructor to catch malformed hosts.
 * 
 * @param {string|undefined} value Raw URL string
 * @returns {boolean} True if non-empty valid http(s) URL of at most 1000 chars
 */
function isValidHttpUrl(value) {
  if (!value || value.length > 1000 || !HTTP_URL_RE.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Use case: Assert helper — validates optional website / receipt URL fields on
 * client profiles and expense forms; errors only when the user provided a value
 * that is not a valid http(s) URL.
 * 
 * @param {string[]} errors Mutable error list from parent validator
 * @param {string|undefined} value URL field value
 * @param {string} [fieldLabel='URL'] Label to use in the error message
 * @returns {void} Mutates errors array by reference
 */
function assertOptionalHttpUrl(errors, value, fieldLabel = 'URL') {
  if (value !== undefined && value && !isValidHttpUrl(value)) {
    errors.push(`${fieldLabel} must be a valid http:// or https:// URL`);
  }
}

/**
 * Use case: Ensures chronological order for paired date fields across the CRM —
 * quotation issue vs due date, project start vs deadline, invoice dates.
 * 
 * @param {string[]} errors Mutable error list from parent validator
 * @param {string|Date|undefined} startValue Earlier date (string/Date)
 * @param {string|Date|undefined} endValue Later date (string/Date)
 * @param {string} startLabel Label for the start field (e.g. "Issue date")
 * @param {string} endLabel Label for the end field (e.g. "Due date")
 * @returns {void} Mutates errors array by reference when end < start
 */
function assertDateOrder(errors, startValue, endValue, startLabel, endLabel) {
  if (!startValue || !endValue) return;
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end < start) {
    errors.push(`${endLabel} cannot be before ${startLabel.toLowerCase()}`);
  }
}

/**
 * Use case: Enforces presence of required CRM fields on create operations
 * (lead name, client company, project id, etc.) before the service attempts
 * to write them.
 * 
 * @param {string[]} errors Mutable error list from parent validator
 * @param {*} value Field value after normalization
 * @param {string} label Human readable field name for error message
 * @returns {void} Mutates errors array by reference when value is falsy
 */
function assertRequired(errors, value, label) {
  if (!value) errors.push(`${label} is required`);
}

/**
 * Use case: Validates CRM toggle/checkbox payload fields like allowSimilarCompany,
 * isBillable, submit flags — ensures they are real booleans when provided, so
 * the storage layer never receives truthy strings such as "true".
 * 
 * @param {string[]} errors Mutable error list from parent validator
 * @param {*} value Raw payload value (should be boolean if present)
 * @param {string} label Key name shown in the error
 * @returns {void} Mutates errors array by reference
 */
function assertOptionalBoolean(errors, value, label) {
  if (value !== undefined && typeof value !== 'boolean') {
    errors.push(`${label} must be true or false`);
  }
}

/**
 * Use case: Validates and rounds monetary amounts across finance modules —
 * invoice line items, expense reimbursements, payment records. Accepts only
 * finite positive numbers and rounds to 2 decimals for rupee currency storage.
 * 
 * @param {string[]} errors Mutable error list from parent validator
 * @param {*} value Raw numeric input (may be string from form)
 * @param {string} [label='Amount'] Label for error text
 * @returns {number|null} Amount rounded to 2 decimals, or null when invalid
 */
function assertPositiveAmount(errors, value, label = 'Amount') {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    errors.push(`${label} must be greater than zero`);
    return null;
  }
  return Math.round(amount * 100) / 100;
}

/**
 * Use case: Validates hours fields on time-log create/update forms. Ensures
 * values are between (0, 24] hours so daily timesheets cannot exceed one day.
 * 
 * @param {string[]} errors Mutable error list from parent validator
 * @param {*} value Raw hour input from task timer / manual entry
 * @param {string} [label='Hours'] Label for error message
 * @returns {number|null} Coerced number of hours, or null when invalid
 */
function assertNonNegativeHours(errors, value, label = 'Hours') {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    errors.push(`${label} must be greater than zero and no more than 24`);
    return null;
  }
  return hours;
}

/**
 * Use case: Coerces optional date fields (expense date, work date, issue date)
 * to a real Date or undefined. Used by callers that need Date objects, and by
 * assertOptionalDate below which returns the ISO-ish string form for storage.
 * 
 * @param {*} value Date-like string, Date, or null/undefined/empty
 * @returns {Date|undefined|null} Valid Date, undefined when empty, null when unparseable
 */
function optionalDate(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/**
 * Use case: Assert helper for optional CRM date picker fields — when user
 * provides a value it must parse as a real date; otherwise returns undefined so
 * the field is skipped during partial (PATCH) updates.
 * 
 * @param {string[]} errors Mutable error list from parent validator
 * @param {*} value Raw date value from form
 * @param {string} label Human label for error messages
 * @returns {*} Original string form when valid / undefined when empty / undefined when invalid
 */
function assertOptionalDate(errors, value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const date = optionalDate(value);
  if (date === null) errors.push(`${label} is invalid`);
  return date === null ? undefined : value;
}

/**
 * Use case: Sanitizes and defaultizes the nested billingAddress object
 * carried on Client (company) records. Ensures every sub-field (street, city,
 * state, country, zip) is a trimmed string, defaulting '' when missing so that
 * downstream services and DB inserts don't see undefined holes.
 * 
 * @param {*} input Raw billingAddress from client create/update body
 * @returns {{street: string, city: string, state: string, country: string, zip: string}}
 *   Clean address object guaranteed to have all five keys
 */
function normalizeBillingAddress(input) {
  const source = asObject(input);
  return {
    street: trimString(source.street) || '',
    city: trimString(source.city) || '',
    state: trimString(source.state) || '',
    country: trimString(source.country) || '',
    zip: trimString(source.zip) || ''
  };
}

module.exports = {
  EMAIL_RE,
  MOBILE_RE,
  PAN_RE,
  HTTP_URL_RE,
  asObject,
  trimString,
  trimLowerEmail,
  normalizeMobile,
  normalizePan,
  ok,
  fail,
  isValidEmail,
  assertEmail,
  isValidMobile,
  assertMobile,
  isValidPan,
  assertPan,
  assertMaxLength,
  isValidHttpUrl,
  assertOptionalHttpUrl,
  assertDateOrder,
  assertRequired,
  assertOptionalBoolean,
  assertPositiveAmount,
  assertNonNegativeHours,
  optionalDate,
  assertOptionalDate,
  normalizeBillingAddress
};
