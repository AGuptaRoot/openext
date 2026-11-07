'use strict';

/**
 * Passport and Aadhaar reading rules for the Traveller form.
 *
 * The image is read by the CRM's OCR engine (sdk.ai.readImage, same engine as
 * the lead visiting-card scan). This file says WHAT to read and checks the
 * answer:
 *   - Passport: the machine-readable zone (MRZ, two lines of 44 characters at
 *     the bottom of the photo page) has check digits. When they pass, MRZ
 *     values win for number, date of birth, expiry, sex and nationality.
 *     The issue date is not in the MRZ, so it comes from the printed page.
 *   - Aadhaar: the number has a Verhoeff check digit.
 * A value that fails a check is still offered but marked "review"; a value
 * that cannot be read is left out ("missing"). Nothing is ever invented.
 */

const { isValidDate, todayIso, isValidAadhaar, cleanPassportNumber, GENDERS } = require('./traveller-rules.js');

const PASSPORT_FIELDS = [
  'firstName', 'lastName', 'dob', 'gender', 'nationality',
  'passportNumber', 'passportIssueDate', 'passportExpiryDate', 'passportCountry'
];
const AADHAAR_FIELDS = ['firstName', 'lastName', 'dob', 'yearOfBirth', 'gender', 'aadhaarNumber', 'nationality'];

const MIN_CONFIDENCE = 0.75;

const PASSPORT_INSTRUCTIONS = `You read the photo page of a passport.
Return this JSON object:
{
  "surname": "", "given_names": "",
  "passport_number": "", "nationality": "", "issuing_country": "",
  "date_of_birth": "", "sex": "",
  "date_of_issue": "", "date_of_expiry": "",
  "mrz_line1": "", "mrz_line2": "",
  "confidence": { "surname": 0, "given_names": 0, "passport_number": 0, "nationality": 0, "issuing_country": 0,
                  "date_of_birth": 0, "sex": 0, "date_of_issue": 0, "date_of_expiry": 0 }
}
Rules:
- Copy only what is printed. Use "" for anything you cannot read clearly. Never guess or invent.
- Dates as YYYY-MM-DD. Day comes before month on passports (15/03/2019 is 15 March 2019).
- sex: "M", "F" or "X" as printed.
- nationality and issuing_country: the 3-letter code if printed (e.g. IND), otherwise the printed text.
- mrz_line1 / mrz_line2: the two machine-readable lines at the bottom, exactly as printed,
  44 characters each, keeping every "<". "" if not visible.
- date_of_issue is the issue date, date_of_expiry the expiry date (the later one). Never put the date of birth there.
- confidence: 0 to 1 for how sure you are of each value.`;

const AADHAAR_INSTRUCTIONS = `You read an Indian Aadhaar card (front side).
Return this JSON object:
{
  "name": "", "date_of_birth": "", "year_of_birth": "", "gender": "",
  "aadhaar_number": "", "aadhaar_last4": "",
  "confidence": { "name": 0, "date_of_birth": 0, "year_of_birth": 0, "gender": 0, "aadhaar_number": 0 }
}
Rules:
- Copy only what is printed. Use "" for anything you cannot read clearly. Never guess or invent.
- name: the card holder's name in English.
- date_of_birth as YYYY-MM-DD when the card shows a full date (DOB 12/05/1990 = 1990-05-12, day first).
  If the card shows only "Year of Birth", put it in year_of_birth (4 digits) and leave date_of_birth "".
- gender: "Male", "Female" or "Other" (cards print MALE / FEMALE / पुरुष / महिला).
- aadhaar_number: the 12-digit number without spaces. If the card is masked (XXXX XXXX 1234),
  leave aadhaar_number "" and put the 4 visible digits in aadhaar_last4.
- Do not read the address, the VID, the QR code or the photo.
- confidence: 0 to 1 for how sure you are of each value.`;

/* ------------------------------------------------------------------ MRZ */

const MRZ_VALUES = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function checkDigit(text) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const v = ch === '<' ? 0 : MRZ_VALUES.indexOf(ch);
    if (v < 0) return -1;
    sum += v * weights[i % 3];
  }
  return sum % 10;
}

const checks = (field, digit) => /^\d$/.test(digit) && checkDigit(field) === Number(digit);

/** YYMMDD → YYYY-MM-DD. Birth dates are never in the future; expiry dates are 20YY. */
function mrzDate(yymmdd, kind, now) {
  if (!/^\d{6}$/.test(yymmdd)) return '';
  const yy = Number(yymmdd.slice(0, 2));
  let year = 2000 + yy;
  if (kind === 'birth' && `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}` > todayIso(now)) year -= 100;
  const iso = `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  return isValidDate(iso) ? iso : '';
}

function cleanMrzLine(line) {
  return String(line || '').toUpperCase().replace(/\s+/g, '').replace(/[«‹]/g, '<');
}

/**
 * Parse a TD3 (passport) MRZ.
 * @returns {null | { valid: boolean, surname, givenNames, number, numberOk, nationality, dob, dobOk, sex, expiry, expiryOk, issuer }}
 */
function parseMrz(line1Raw, line2Raw, now) {
  const line1 = cleanMrzLine(line1Raw);
  const line2 = cleanMrzLine(line2Raw);
  if (line1.length !== 44 || line2.length !== 44 || line1[0] !== 'P') return null;

  const issuer = line1.slice(2, 5).replace(/</g, '');
  const [surnameRaw = '', givenRaw = ''] = line1.slice(5).split('<<');
  const number = line2.slice(0, 9).replace(/</g, '');
  const numberOk = checks(line2.slice(0, 9), line2[9]);
  const nationality = line2.slice(10, 13).replace(/</g, '');
  const dobOk = checks(line2.slice(13, 19), line2[19]);
  const sex = line2[20];
  const expiryOk = checks(line2.slice(21, 27), line2[27]);
  const composite = line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 43);
  const compositeOk = checks(composite, line2[43]);

  return {
    valid: numberOk && dobOk && expiryOk && compositeOk,
    surname: surnameRaw.replace(/</g, ' ').trim(),
    givenNames: givenRaw.replace(/</g, ' ').trim(),
    number,
    numberOk,
    nationality,
    dob: mrzDate(line2.slice(13, 19), 'birth', now),
    dobOk,
    sex: sex === 'M' ? 'Male' : sex === 'F' ? 'Female' : sex === 'X' ? 'Other' : '',
    expiry: mrzDate(line2.slice(21, 27), 'expiry', now),
    expiryOk,
    issuer
  };
}

/* ------------------------------------------------------------ cleaning */

const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

/** Printed date → YYYY-MM-DD, or '' when it cannot be read safely. Day comes first. */
function cleanDate(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  if (isValidDate(raw)) return raw;
  let m = raw.match(/^(\d{1,2})[\s./-]+(\d{1,2})[\s./-]+(\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isValidDate(iso) ? iso : '';
  }
  m = raw.match(/^(\d{1,2})[\s./-]*([A-Z]{3})[A-Z]*[\s./-]*(\d{4})$/);
  if (m && MONTHS[m[2]]) {
    const iso = `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`;
    return isValidDate(iso) ? iso : '';
  }
  return '';
}

function cleanText(value, max = 60) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanGender(value) {
  const raw = cleanText(value, 20).toUpperCase();
  if (raw === 'M' || raw === 'MALE' || raw.includes('पुरुष')) return 'Male';
  if (raw === 'F' || raw === 'FEMALE' || raw.includes('महिला')) return 'Female';
  if (raw === 'X' || raw === 'OTHER' || raw === 'TRANSGENDER') return 'Other';
  return GENDERS.includes(cleanText(value)) ? cleanText(value) : '';
}

const confidenceOf = (raw, key) => {
  const n = Number(raw && raw.confidence && raw.confidence[key]);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
};

/** Split "PRIYA K SHARMA" → first "PRIYA K", last "SHARMA". */
function splitName(full) {
  const parts = cleanText(full, 120).split(' ').filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] || '', lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/* ------------------------------------------------------- nationality */

// ICAO 9303 nationality codes (passport MRZ) and printed country names → the usual English demonym.
const NATIONALITY_BY_CODE = {
  IND: 'Indian', NPL: 'Nepalese', BGD: 'Bangladeshi', LKA: 'Sri Lankan', PAK: 'Pakistani', BTN: 'Bhutanese',
  MDV: 'Maldivian', AFG: 'Afghan', USA: 'American', GBR: 'British', CAN: 'Canadian', AUS: 'Australian',
  NZL: 'New Zealander', IRL: 'Irish', ARE: 'Emirati', SAU: 'Saudi', QAT: 'Qatari', OMN: 'Omani', KWT: 'Kuwaiti',
  BHR: 'Bahraini', SGP: 'Singaporean', MYS: 'Malaysian', THA: 'Thai', IDN: 'Indonesian', PHL: 'Filipino',
  VNM: 'Vietnamese', CHN: 'Chinese', JPN: 'Japanese', KOR: 'South Korean', DEU: 'German', D: 'German',
  FRA: 'French', ITA: 'Italian', ESP: 'Spanish', PRT: 'Portuguese', NLD: 'Dutch', BEL: 'Belgian', CHE: 'Swiss',
  AUT: 'Austrian', SWE: 'Swedish', NOR: 'Norwegian', DNK: 'Danish', FIN: 'Finnish', POL: 'Polish', RUS: 'Russian',
  UKR: 'Ukrainian', TUR: 'Turkish', EGY: 'Egyptian', ZAF: 'South African', KEN: 'Kenyan', NGA: 'Nigerian',
  BRA: 'Brazilian', MEX: 'Mexican', ARG: 'Argentine'
};
const NATIONALITY_BY_COUNTRY = {
  INDIA: 'Indian', NEPAL: 'Nepalese', BANGLADESH: 'Bangladeshi', 'SRI LANKA': 'Sri Lankan', PAKISTAN: 'Pakistani',
  'UNITED STATES OF AMERICA': 'American', 'UNITED STATES': 'American', USA: 'American', 'UNITED KINGDOM': 'British',
  'GREAT BRITAIN': 'British', CANADA: 'Canadian', AUSTRALIA: 'Australian', 'UNITED ARAB EMIRATES': 'Emirati',
  UAE: 'Emirati', SINGAPORE: 'Singaporean', MALAYSIA: 'Malaysian', THAILAND: 'Thai', CHINA: 'Chinese',
  JAPAN: 'Japanese', GERMANY: 'German', FRANCE: 'French'
};

/**
 * Match an OCR nationality ("IND", "INDIAN", "India", "BRITISH CITIZEN") to an entry of the
 * workspace's Nationalities list (Settings → Travel). Returns the list entry, or '' when none fits.
 */
function matchNationality(raw, options) {
  const list = Array.isArray(options) ? options : [];
  const byLower = new Map(list.map((o) => [String(o).trim().toLowerCase(), String(o).trim()]));
  const value = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ').replace(/\s+CITIZEN$/, '');
  if (!value) return '';
  const candidates = [value, NATIONALITY_BY_CODE[value], NATIONALITY_BY_COUNTRY[value]].filter(Boolean);
  for (const c of candidates) {
    const hit = byLower.get(String(c).toLowerCase());
    if (hit) return hit;
  }
  return '';
}

/**
 * Put the OCR nationality in the workspace's own words. A value that is not in the list is
 * still offered, but marked for review with a note — never silently dropped or invented.
 */
function resolveNationality(result, options) {
  const raw = result.fields.nationality;
  if (raw === undefined || raw === '') return result;
  const match = matchNationality(raw, options);
  if (match) {
    result.fields.nationality = match;
  } else {
    result.status.nationality = 'review';
    result.notes.push(`Nationality "${raw}" is not in your Nationalities list (Settings → Travel). Choose one or add it there.`);
  }
  return result;
}

/* ---------------------------------------------------------- results */

function result(kind, fieldNames) {
  const out = { kind, fields: {}, status: {}, notes: [] };
  for (const name of fieldNames) out.status[name] = 'missing';
  return out;
}

function put(out, field, value, sure) {
  if (value === '' || value === null || value === undefined) return;
  out.fields[field] = value;
  out.status[field] = sure ? 'ocr' : 'review';
}

/** Model answer for a passport → OcrResult. */
function passportResult(raw, now) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = result('passport', PASSPORT_FIELDS);
  const sure = (key) => confidenceOf(src, key) >= MIN_CONFIDENCE;
  const mrz = parseMrz(src.mrz_line1, src.mrz_line2, now);
  out.mrz = { found: Boolean(mrz), valid: Boolean(mrz && mrz.valid) };

  const printed = {
    surname: cleanText(src.surname),
    given: cleanText(src.given_names),
    number: cleanPassportNumber(src.passport_number),
    nationality: cleanText(src.nationality),
    issuer: cleanText(src.issuing_country),
    dob: cleanDate(src.date_of_birth),
    sex: cleanGender(src.sex),
    issue: cleanDate(src.date_of_issue),
    expiry: cleanDate(src.date_of_expiry)
  };

  // Names: printed names keep spaces and are complete; MRZ names may be cut short.
  put(out, 'firstName', printed.given || (mrz && mrz.givenNames) || '', printed.given ? sure('given_names') : Boolean(mrz && mrz.valid));
  put(out, 'lastName', printed.surname || (mrz && mrz.surname) || '', printed.surname ? sure('surname') : Boolean(mrz && mrz.valid));

  // MRZ fields win when their own check digit passes (then they are sure even if the printed text differs).
  const pick = (mrzValue, mrzOk, printedValue, key) => {
    if (mrz && mrzOk && mrzValue) return { value: mrzValue, sure: true };
    if (printedValue) return { value: printedValue, sure: sure(key) && !(mrz && mrzValue && mrzValue !== printedValue) };
    return { value: mrz ? mrzValue : '', sure: false };
  };
  const number = pick(mrz && mrz.number, mrz && mrz.numberOk, printed.number, 'passport_number');
  put(out, 'passportNumber', /^[A-Z0-9]{6,15}$/.test(number.value) ? number.value : '', number.sure);
  const dob = pick(mrz && mrz.dob, mrz && mrz.dobOk, printed.dob, 'date_of_birth');
  put(out, 'dob', dob.value, dob.sure);
  const expiry = pick(mrz && mrz.expiry, mrz && mrz.expiryOk, printed.expiry, 'date_of_expiry');
  put(out, 'passportExpiryDate', expiry.value, expiry.sure);
  const gender = pick(mrz && mrz.sex, mrz && mrz.valid, printed.sex, 'sex');
  put(out, 'gender', gender.value, gender.sure);
  const nationality = pick(mrz && mrz.nationality, mrz && mrz.valid, printed.nationality, 'nationality');
  put(out, 'nationality', nationality.value, nationality.sure);
  const issuer = pick(mrz && mrz.issuer, mrz && mrz.valid, printed.issuer, 'issuing_country');
  put(out, 'passportCountry', issuer.value, issuer.sure);

  // Issue date: printed only; must be before expiry and not in the future.
  let issue = printed.issue;
  if (issue && ((expiry.value && issue >= expiry.value) || issue > todayIso(now) || (dob.value && issue <= dob.value))) issue = '';
  put(out, 'passportIssueDate', issue, sure('date_of_issue'));

  if (!mrz) out.notes.push('The machine-readable lines at the bottom of the page were not readable. Check every value.');
  else if (mrz.valid) out.notes.push('The machine-readable lines were found and their check digits match.');
  else out.notes.push('The machine-readable lines were found but some check digits do not match. Check the highlighted values.');
  if (!Object.keys(out.fields).length) out.notes.push('Nothing could be read. Try a sharper photo or enter the details yourself.');
  return out;
}

/** Model answer for an Aadhaar card → OcrResult. */
function aadhaarResult(raw, now) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = result('aadhaar', AADHAAR_FIELDS);
  const sure = (key) => confidenceOf(src, key) >= MIN_CONFIDENCE;

  const { firstName, lastName } = splitName(src.name);
  put(out, 'firstName', firstName, sure('name'));
  put(out, 'lastName', lastName, sure('name'));

  const dob = cleanDate(src.date_of_birth);
  const validDob = dob && dob <= todayIso(now) ? dob : '';
  put(out, 'dob', validDob, sure('date_of_birth'));
  if (!validDob) {
    const yob = Number(String(src.year_of_birth || '').trim());
    const year = Number(todayIso(now).slice(0, 4));
    if (Number.isInteger(yob) && yob > year - 120 && yob <= year) put(out, 'yearOfBirth', yob, sure('year_of_birth'));
  }
  put(out, 'gender', cleanGender(src.gender), sure('gender'));

  const number = String(src.aadhaar_number || '').replace(/\D/g, '');
  if (number.length === 12) {
    const valid = isValidAadhaar(number);
    put(out, 'aadhaarNumber', number, valid && sure('aadhaar_number'));
    if (!valid) out.notes.push('The Aadhaar number does not pass its check digit. Compare it with the card.');
  }
  // Aadhaar prints no nationality and is issued to residents of India, not only citizens:
  // suggest Indian for the user to confirm, never as a sure value.
  if (Object.keys(out.fields).length) {
    put(out, 'nationality', 'IND', false);
    out.notes.push('Aadhaar does not show nationality and is not proof of citizenship. Indian is suggested — please confirm it.');
  }

  const last4 = String(src.aadhaar_last4 || '').replace(/\D/g, '');
  if (!out.fields.aadhaarNumber && last4.length === 4) {
    out.fields.aadhaarLast4 = last4;
    out.notes.push(`The card shows only the last 4 digits (${last4}). Type the full number if you have it.`);
  }
  if (!Object.keys(out.fields).length) out.notes.push('Nothing could be read. Try a sharper photo or enter the details yourself.');
  return out;
}

module.exports = {
  PASSPORT_FIELDS,
  AADHAAR_FIELDS,
  PASSPORT_INSTRUCTIONS,
  AADHAAR_INSTRUCTIONS,
  checkDigit,
  parseMrz,
  cleanDate,
  splitName,
  passportResult,
  aadhaarResult,
  matchNationality,
  resolveNationality
};
