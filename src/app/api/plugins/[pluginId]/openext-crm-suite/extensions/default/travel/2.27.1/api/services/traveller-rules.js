'use strict';

/**
 * Traveller rules: age and Adult / Child / Infant, passport expiry warning,
 * masking, and the checks done before a traveller is saved.
 * Pure functions (no SDK calls) so they are easy to test.
 */

const { todayIn, DEFAULT_TZ } = require('./availability.js');

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const GENDERS = ['Male', 'Female', 'Other'];

function isValidDate(value) {
  const m = DATE_RE.exec(String(value || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * Today's date (YYYY-MM-DD) in the workspace time zone (Settings → Travel → Time zone, IANA name;
 * default Asia/Kolkata), so "today" for passport expiry and age checks does not jump at UTC midnight.
 */
function todayIso(now, timeZone) {
  const d = now ? new Date(now) : new Date();
  return todayIn(timeZone || DEFAULT_TZ, d);
}

/** A usable IANA time zone name, or the default. */
function cleanTimeZone(value) {
  const zone = String(value === undefined || value === null ? '' : value).trim();
  if (!zone) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return zone;
  } catch {
    return DEFAULT_TZ;
  }
}

function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  return date.toISOString().slice(0, 10);
}

/** Full years from `dob` to `ref` (both YYYY-MM-DD). */
function yearsBetween(dob, ref) {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ry, rm, rd] = ref.split('-').map(Number);
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;
  return age;
}

function categoryForAge(age) {
  if (age === null || age === undefined || !Number.isFinite(age) || age < 0) return '';
  if (age < 2) return 'Infant';
  if (age < 12) return 'Child';
  return 'Adult';
}

/**
 * Age on the reference date (the trip's start date, or today).
 * @returns {{ age: number|null, ageApproximate: boolean, ageCategory: string }}
 */
function ageInfo({ dob, yearOfBirth }, referenceDate) {
  if (isValidDate(dob)) {
    const age = yearsBetween(dob, referenceDate);
    return { age: age >= 0 ? age : null, ageApproximate: false, ageCategory: categoryForAge(age) };
  }
  const yob = Number(yearOfBirth);
  if (Number.isInteger(yob) && yob > 1880) {
    const age = Number(referenceDate.slice(0, 4)) - yob;
    return { age: age >= 0 ? age : null, ageApproximate: true, ageCategory: categoryForAge(age) };
  }
  return { age: null, ageApproximate: false, ageCategory: '' };
}

/**
 * Adult / Child / Infant groups the way the quotation counts them: a traveller whose age is not
 * known (no date / year of birth) counts as an Adult. While fewer travellers are added than the
 * lead says travel (`expected` = { adults, children, infants }), the lead's own counts are used.
 * @param {string[]} categories  age category per traveller ('' = unknown)
 * @returns {{ groups: object, counted: object, unknownAge: number, source: 'travellers'|'lead' }}
 */
function travellerGroups(categories, expected) {
  const counted = { Adult: 0, Child: 0, Infant: 0 };
  let unknownAge = 0;
  for (const cat of Array.isArray(categories) ? categories : []) {
    if (counted[cat] !== undefined) counted[cat] += 1;
    else {
      counted.Adult += 1;
      unknownAge += 1;
    }
  }
  const n = (v) => Math.max(0, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : 0);
  const lead = expected ? { Adult: n(expected.adults), Child: n(expected.children), Infant: n(expected.infants) } : null;
  const added = counted.Adult + counted.Child + counted.Infant;
  const leadTotal = lead ? lead.Adult + lead.Child + lead.Infant : 0;
  const useLead = Boolean(lead) && added < leadTotal;
  return { groups: useLead ? lead : { ...counted }, counted, unknownAge, source: useLead ? 'lead' : 'travellers' };
}

/** '' | 'expired' | 'before_travel' | 'within_6_months' */
function expiryWarning(expiryDate, referenceDate, now, timeZone) {
  if (!isValidDate(expiryDate)) return '';
  if (expiryDate < todayIso(now, timeZone)) return 'expired';
  if (expiryDate < referenceDate) return 'before_travel';
  if (expiryDate < addMonths(referenceDate, 6)) return 'within_6_months';
  return '';
}

function maskPassport(last4) {
  return last4 ? `XXXXX${last4}` : '';
}

function maskAadhaar(last4) {
  return last4 ? `XXXX XXXX ${last4}` : '';
}

/** The masks above with dots for the screen: "•••• •••• 4582", "•••••4567" (still only the last 4). */
const dotMask = (masked) => String(masked || '').replace(/X/g, '•');

/**
 * A stored phone (cleanPhone form) shown with most digits hidden: "+919812345210" → "+91 98••• ••210".
 * The country code stays, then the first 2 and the last 3 digits of the national number.
 */
function maskPhone(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return digits ? '•'.repeat(digits.length) : '';
  const national = digits.length > 10 ? digits.slice(-10) : digits;
  const cc = digits.length > 10 ? digits.slice(0, -10) : '';
  const hidden = national.length - 5;
  const middle = hidden === 5 ? '••• ••' : '•'.repeat(hidden);
  const body = `${national.slice(0, 2)}${middle}${national.slice(-3)}`;
  return cc ? `+${cc} ${body}` : raw.startsWith('+') ? `+${body}` : body;
}

/* ---------------------------------------------------------------- Aadhaar */

// Verhoeff checksum (the check digit scheme used by Aadhaar numbers).
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];

function verhoeffValid(digits) {
  let c = 0;
  const list = String(digits).split('').reverse().map(Number);
  for (let i = 0; i < list.length; i += 1) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][list[i]]];
  return c === 0;
}

/** 12 digits, not starting with 0 or 1, valid Verhoeff check digit. */
function isValidAadhaar(value) {
  const digits = String(value || '').replace(/\s+/g, '');
  return /^[2-9]\d{11}$/.test(digits) && verhoeffValid(digits);
}

function cleanPassportNumber(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const PHONE_RE = /^\+?\d{7,15}$/;
// A person's name: letters of any language, with spaces, dots, apostrophes and hyphens.
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
// A country name may also have "&", commas and brackets ("Bosnia & Herzegovina", "Korea (South)").
const COUNTRY_RE = /^[\p{L}\p{M}][\p{L}\p{M} .,&()'’-]*$/u;

/** '' when `value` is a usable name (or empty), else why not. */
function nameProblem(value, label, { country = false } = {}) {
  if (!value || (country ? COUNTRY_RE : NAME_RE).test(value)) return '';
  return country
    ? `${label} can only have letters, spaces and . , & ( ) ' -`
    : `${label} can only have letters, spaces, dots, apostrophes and hyphens`;
}

/** Same person on a lead: same full name and the same date of birth or phone number. */
function samePerson(a, b) {
  const name = (x) => `${x.firstName || ''} ${x.lastName || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!name(a) || name(a) !== name(b)) return false;
  return Boolean((a.dob && a.dob === b.dob) || (a.phone && a.phone === b.phone));
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** "+91 98765-43210" → "+919876543210" */
function cleanPhone(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  return (raw.startsWith('+') ? '+' : '') + raw.replace(/\D/g, '');
}

/**
 * A passport that cannot be used for the trip blocks saving:
 * already expired, or expiring before the travel start date.
 * (Less than 6 months after the trip is only a warning — expiryWarning.)
 * @returns {string} the reason, or '' when the date is fine or empty
 */
function passportExpiryBlock(expiryDate, referenceDate, now, timeZone) {
  if (!isValidDate(expiryDate)) return '';
  if (expiryDate < todayIso(now, timeZone)) return 'Passport has expired. Renew it before adding this traveller.';
  if (isValidDate(referenceDate) && expiryDate < referenceDate) {
    return `Passport expires before the trip starts (${referenceDate}). Renew it before adding this traveller.`;
  }
  return '';
}

/* ------------------------------------------------------------------ input */

const text = (value, max) => String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Check a TravellerInput. Only keys present in `input` are returned (a PUT
 * changes only what it sends); on create `firstName` is required.
 * @returns {{ values: object, errors: string[] }}
 */
function checkInput(input, { create, now, timeZone } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(src, key);
  const values = {};
  const errors = [];

  if (create || has('firstName')) {
    values.firstName = text(src.firstName, 60);
    if (!values.firstName) errors.push('First name is required');
    else if (nameProblem(values.firstName, 'First name')) errors.push(nameProblem(values.firstName, 'First name'));
  }
  if (has('lastName')) {
    values.lastName = text(src.lastName, 60);
    if (nameProblem(values.lastName, 'Last name')) errors.push(nameProblem(values.lastName, 'Last name'));
  }
  if (has('nationality')) values.nationality = text(src.nationality, 60);
  if (create || has('relation')) {
    values.relation = text(src.relation, 60);
    if (!values.relation) errors.push('Relation is required');
  }
  if (create || has('phone')) {
    values.phone = cleanPhone(src.phone);
    if (!values.phone) errors.push('Phone number is required');
    else if (!PHONE_RE.test(values.phone)) errors.push('Phone number must be 7–15 digits (a leading + is allowed)');
  }
  if (has('email')) {
    values.email = text(src.email, 120).toLowerCase();
    if (values.email && !EMAIL_RE.test(values.email)) errors.push('Email address is not valid');
  }
  if (has('contactId')) {
    values.contactId = text(src.contactId, 24);
    if (values.contactId && !/^[a-f0-9]{24}$/i.test(values.contactId)) errors.push('Contact is not valid');
  }
  if (has('gender')) {
    values.gender = text(src.gender, 20);
    if (values.gender && !GENDERS.includes(values.gender)) errors.push('Gender must be Male, Female or Other');
  }

  const today = todayIso(now, timeZone);
  const dateKeys = { dob: 'Date of birth', passportIssueDate: 'Passport issue date', passportExpiryDate: 'Passport expiry date' };
  for (const [key, label] of Object.entries(dateKeys)) {
    if (!has(key)) continue;
    values[key] = text(src[key], 10);
    if (values[key] && !isValidDate(values[key])) errors.push(`${label} must be a valid date`);
  }
  if (values.dob && isValidDate(values.dob)) {
    if (values.dob > today) errors.push('Date of birth cannot be in the future');
    else if (yearsBetween(values.dob, today) > 120) errors.push('Check the date of birth');
  }
  if (values.passportIssueDate && values.passportIssueDate > today) errors.push('Passport issue date cannot be in the future');
  if (values.passportIssueDate && values.passportExpiryDate && values.passportIssueDate >= values.passportExpiryDate) {
    errors.push('Passport issue date must be before the expiry date');
  }

  if (has('yearOfBirth')) {
    const raw = src.yearOfBirth;
    // A full date of birth wins over a year of birth.
    if (raw === null || raw === '' || raw === undefined || (values.dob && isValidDate(values.dob))) values.yearOfBirth = null;
    else {
      // "1990", 1990 or "1990.0" (spreadsheets) are all the year 1990.
      const yob = Number(String(raw).trim());
      const year = Number(today.slice(0, 4));
      if (!Number.isInteger(yob) || yob < year - 120 || yob > year) errors.push('Year of birth is not valid');
      else values.yearOfBirth = yob;
    }
  }

  if (has('passportNumber')) {
    values.passportNumber = cleanPassportNumber(src.passportNumber);
    if (values.passportNumber && !/^[A-Z0-9]{6,15}$/.test(values.passportNumber)) {
      errors.push('Passport number must be 6–15 letters or digits');
    }
  }
  if (has('passportCountry')) {
    values.passportCountry = text(src.passportCountry, 60);
    const problem = nameProblem(values.passportCountry, 'Issuing country', { country: true });
    if (problem) errors.push(problem);
  }
  // A passport number is only usable with its expiry date and issuing country.
  if (values.passportNumber) {
    if (!values.passportExpiryDate && (create || has('passportExpiryDate'))) errors.push('Passport expiry date is required with a passport number');
    if (!values.passportCountry && (create || has('passportCountry'))) errors.push('Issuing country is required with a passport number');
  }

  if (has('aadhaarNumber')) {
    values.aadhaarNumber = String(src.aadhaarNumber || '').replace(/\s+/g, '');
    if (values.aadhaarNumber && !isValidAadhaar(values.aadhaarNumber)) {
      errors.push('Aadhaar number is not valid (12 digits with a correct check digit)');
    }
  }

  // Saved although the passport and the Aadhaar card read different details (audit only).
  if (src.docMismatchConfirmed === true) values.docMismatchConfirmed = true;

  const ocrUsed = src.ocrUsed === true;
  if (ocrUsed && src.ocrConfirmed !== true) errors.push('OCR_NOT_CONFIRMED');
  values.ocrUsed = ocrUsed;

  return { values, errors };
}

module.exports = {
  GENDERS,
  DEFAULT_TZ,
  isValidDate,
  todayIso,
  cleanTimeZone,
  travellerGroups,
  yearsBetween,
  categoryForAge,
  ageInfo,
  expiryWarning,
  maskPassport,
  maskAadhaar,
  dotMask,
  maskPhone,
  verhoeffValid,
  isValidAadhaar,
  cleanPassportNumber,
  cleanPhone,
  passportExpiryBlock,
  nameProblem,
  samePerson,
  checkInput
};
