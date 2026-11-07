'use strict';

/**
 * Shared traveller logic for the traveller routes (travellers.js, traveller-tools.js):
 * loading the lead / traveller through sdk.crm (tenant and permission checks), the
 * trip date ages are worked out on, the passport rule of the lead, and the shape
 * a traveller is shown in. Document numbers never leave this file in clear except
 * through the explicit edit-form route.
 */

const rules = require('./traveller-rules.js');
const { readServices } = require('./catalog.js');

const ID_RE = /^[a-f0-9]{24}$/i;
const str = (v) => (v === null || v === undefined ? '' : String(v));

async function loadLead(sdk, leadId) {
  const id = String(leadId || '');
  if (!ID_RE.test(id)) throw sdk.error(404, 'Lead not found', 'NOT_FOUND');
  const lead = await sdk.crm.leads.findById(id);
  if (!lead) throw sdk.error(404, 'Lead not found', 'NOT_FOUND');
  return lead;
}

async function loadTraveller(req, sdk) {
  const id = String((req.params && req.params.traveller_id) || '');
  const row = ID_RE.test(id) ? await sdk.models.Traveller.findById(id) : null;
  if (!row) throw sdk.error(404, 'Traveller not found', 'NOT_FOUND');
  const lead = await loadLead(sdk, row.lead_id);
  return { row, lead };
}

// Per request (the sandbox hands every request its own sdk object): settings read once.
const zoneCache = new WeakMap();

/** The workspace time zone (Settings → Travel → Time zone; default Asia/Kolkata). */
async function timeZone(sdk) {
  if (sdk && typeof sdk === 'object' && zoneCache.has(sdk)) return zoneCache.get(sdk);
  let zone = rules.DEFAULT_TZ;
  try {
    zone = rules.cleanTimeZone(await sdk.settings.get('timezone'));
  } catch {
    zone = rules.DEFAULT_TZ;
  }
  if (sdk && typeof sdk === 'object') zoneCache.set(sdk, zone);
  return zone;
}

/**
 * Trip facts from a lead's travel values: start date (or today in the workspace time zone),
 * the lead's traveller counts and selected services.
 */
function referenceFromValues(values, zone) {
  const v = values && typeof values === 'object' ? values : {};
  const start = String(v.travel_start_date || '').slice(0, 10);
  const num = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
  const expected = [v.adults, v.children, v.infants].some((x) => num(x) !== null)
    ? { adults: num(v.adults) || 0, children: num(v.children) || 0, infants: num(v.infants) || 0 }
    : null;
  const selected = Array.isArray(v.required_services) ? v.required_services.map(String) : [];
  const today = rules.todayIso(undefined, zone);
  return rules.isValidDate(start)
    ? { referenceDate: start, referenceSource: 'travel_start_date', expected, selected, timeZone: zone, today }
    : { referenceDate: today, referenceSource: 'today', expected, selected, timeZone: zone, today };
}

/** Trip start date from the lead's travel fields (or today), the lead's traveller counts and services. */
async function referenceFor(sdk, leadId) {
  const [values, zone] = await Promise.all([sdk.values.get('lead', leadId), timeZone(sdk)]);
  return referenceFromValues(values, zone);
}

/** The person a traveller record belongs to (copies on other leads share it). Older rows: their own id. */
function profileOf(row) {
  return str(row && row.profile_id) || str(row && row._id);
}

/**
 * Lazy migration: rows saved before profiles existed get profile_id = their own _id (in place, and
 * stored). A failed write never fails the read; the next read tries again.
 */
async function ensureProfiles(sdk, rows) {
  for (const row of rows || []) {
    if (!row || str(row.profile_id) || !row._id) continue;
    row.profile_id = str(row._id);
    try {
      await sdk.models.Traveller.updateById(row._id, { profile_id: row.profile_id });
    } catch (error) {
      if (sdk.logger) sdk.logger.warn('traveller profile_id fill failed:', error && error.message);
    }
  }
  return rows;
}

/**
 * Bookings (crm-travel bookings, model Booking with a traveller_ids list) that list any of these
 * travellers. [] when this release has no bookings. Errors are thrown: callers that guard a delete
 * must refuse on an error, never go ahead.
 */
async function bookingsFor(sdk, travellerIds, limit = 5) {
  const Booking = sdk.models && sdk.models.Booking;
  if (!Booking || typeof Booking.find !== 'function') return [];
  const ids = [...new Set((travellerIds || []).map(str).filter(Boolean))];
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 500) {
    out.push(...(await Booking.find({ traveller_ids: { $in: ids.slice(i, i + 500) } }, { limit: Math.max(1, Math.min(limit, 500)) })));
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/** The 503 a delete answers when the booking check could not be done (never delete blind). */
function bookingCheckFailed(sdk) {
  return sdk.error(503, 'Could not check the bookings of this traveller right now. Nothing was deleted; try again.', 'TRY_AGAIN');
}

/**
 * Passport details are required for a lead's travellers when the lead's Travel
 * Requirement has a service marked "Passport required" (Services & Forms).
 * @returns {{ required: boolean, services: string[] }}
 */
async function passportRule(sdk, selected) {
  const services = await readServices(sdk);
  const names = services
    .filter((s) => s.enabled !== false && s.requiresPassport === true && selected.includes(s.key))
    .map((s) => s.name);
  return { required: names.length > 0, services: names };
}

/** Choices for the Nationality and Relation fields (Settings → Travel). */
async function fieldOptions(sdk) {
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const [nationalities, relations] = await Promise.all([sdk.settings.get('nationalities'), sdk.settings.get('traveller_relations')]);
  return { nationalityOptions: list(nationalities), relationOptions: list(relations) };
}

async function aadhaarStorage(sdk) {
  return (await sdk.settings.get('aadhaar_storage')) === 'full' ? 'full' : 'last4';
}

/** True when a passport-required lead's traveller has no usable passport details. */
function passportMissing(row, rule) {
  if (!rule || !rule.required) return false;
  return !(row.passport_last4 && row.passport_expiry_date && row.passport_country);
}

/** Row → the list shape of functionality.md (numbers masked). `timeZone` decides "today" for expiry. */
function present(row, referenceDate, rule, timeZone) {
  const dob = str(row.dob).slice(0, 10);
  const yearOfBirth = Number.isFinite(Number(row.year_of_birth)) && row.year_of_birth !== null ? Number(row.year_of_birth) : null;
  const age = rules.ageInfo({ dob, yearOfBirth }, referenceDate);
  const firstName = str(row.first_name);
  const lastName = str(row.last_name);
  const expiryDate = str(row.passport_expiry_date).slice(0, 10);
  return {
    id: row._id,
    profileId: profileOf(row),
    leadId: str(row.lead_id),
    contactId: str(row.contact_id),
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    phone: str(row.phone),
    email: str(row.email),
    dob,
    yearOfBirth,
    age: age.age,
    ageApproximate: age.ageApproximate,
    ageCategory: age.ageCategory,
    gender: str(row.gender),
    nationality: str(row.nationality),
    relation: str(row.relation),
    passport: {
      numberMasked: rules.maskPassport(str(row.passport_last4)),
      issueDate: str(row.passport_issue_date).slice(0, 10),
      expiryDate,
      country: str(row.passport_country),
      hasFile: Boolean(row.passport_file_id),
      expiryWarning: rules.expiryWarning(expiryDate, referenceDate, undefined, timeZone),
      missing: passportMissing(row, rule)
    },
    aadhaar: {
      numberMasked: rules.maskAadhaar(str(row.aadhaar_last4)),
      hasFile: Boolean(row.aadhaar_file_id)
    },
    ocrUsed: row.ocr_used === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function inputError(sdk, errors) {
  if (errors.includes('OCR_NOT_CONFIRMED')) {
    return sdk.error(400, 'Tick "I have checked the details read by OCR" before saving.', 'OCR_NOT_CONFIRMED');
  }
  return sdk.error(400, errors.join('. '), 'INVALID_TRAVELLER');
}

/**
 * Checked input → row patch. Numbers are encrypted; in last4 mode only the last
 * 4 Aadhaar digits are kept. Age category is worked out from the final DOB.
 */
function toPatch(sdk, values, current, storage, referenceDate) {
  const patch = {};
  const map = {
    firstName: 'first_name', lastName: 'last_name', dob: 'dob', yearOfBirth: 'year_of_birth', gender: 'gender',
    nationality: 'nationality', relation: 'relation', phone: 'phone', email: 'email', contactId: 'contact_id',
    passportIssueDate: 'passport_issue_date', passportExpiryDate: 'passport_expiry_date', passportCountry: 'passport_country'
  };
  for (const [key, column] of Object.entries(map)) if (key in values) patch[column] = values[key];
  if (values.dob) patch.year_of_birth = null; // a full date of birth replaces a year-only one

  if ('passportNumber' in values) {
    const n = values.passportNumber;
    patch.passport_number_enc = n ? sdk.crypto.encrypt(n) : '';
    patch.passport_number_hash = n ? sdk.crypto.hash(n) : '';
    patch.passport_last4 = n ? n.slice(-4) : '';
  }
  if ('aadhaarNumber' in values) {
    const n = values.aadhaarNumber;
    patch.aadhaar_number_enc = n && storage === 'full' ? sdk.crypto.encrypt(n) : '';
    patch.aadhaar_last4 = n ? n.slice(-4) : '';
    // Keyed fingerprint (HMAC, tenant + extension key) for the duplicate check, kept in every storage mode.
    patch.aadhaar_number_hash = n ? sdk.crypto.hash(n) : '';
  }
  if (values.ocrUsed) patch.ocr_used = true;

  const merged = { ...current, ...patch };
  patch.age_category = rules.ageInfo(
    { dob: str(merged.dob).slice(0, 10), yearOfBirth: merged.year_of_birth },
    referenceDate
  ).ageCategory;
  return patch;
}

/**
 * Passport checks on the row as it will be saved:
 *  - required details (number, expiry, country) when the lead's services need a passport
 *    (skipped for imports, which carry no document numbers — the row is then flagged instead);
 *  - an expired passport, or one expiring before the trip, is never accepted.
 */
function checkPassport(sdk, merged, rule, referenceDate, { requireDetails = true, timeZone } = {}) {
  const errors = [];
  if (requireDetails && rule.required) {
    const missing = [];
    if (!merged.passport_last4) missing.push('passport number');
    if (!merged.passport_expiry_date) missing.push('expiry date');
    if (!merged.passport_country) missing.push('issuing country');
    if (missing.length) {
      errors.push(`Passport details are required for this lead (${rule.services.join(', ')}): add the ${missing.join(', ')}`);
    }
  }
  const block = rules.passportExpiryBlock(str(merged.passport_expiry_date).slice(0, 10), referenceDate, undefined, timeZone);
  if (block) errors.push(block);
  if (errors.length) throw sdk.error(400, errors.join('. '), errors.length === 1 && block ? 'PASSPORT_EXPIRY' : 'PASSPORT_REQUIRED');
}

/**
 * One passport number per lead. Copies of the same person (same profile_id) are the same passport,
 * so they are not counted against each other.
 */
async function assertNoDuplicatePassport(sdk, leadId, patch, selfId, profileId) {
  if (!patch.passport_number_hash) return;
  const same = await sdk.models.Traveller.find({ lead_id: leadId, passport_number_hash: patch.passport_number_hash }, { limit: 5 });
  if (same.some((row) => row._id !== selfId && (!profileId || profileOf(row) !== str(profileId)))) {
    throw sdk.error(409, 'A traveller with this passport number is already on this lead', 'DUPLICATE_PASSPORT');
  }
}

/** "+91 98000-00001", "919800000001", "09800000001" … → the forms one number is stored in. */
function phoneVariants(phone) {
  const raw = str(phone);
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return [];
  const out = new Set([raw, digits, `+${digits}`]);
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    for (const v of [last10, `0${last10}`, `91${last10}`, `+91${last10}`]) out.add(v);
  }
  return [...out].filter(Boolean);
}

/** The national number of a phone (last 10 digits when it has them), for comparing two numbers. */
function phoneKey(phone) {
  const digits = str(phone).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Fills the Aadhaar fingerprint of older records that keep the full number (a few hundred per call). */
async function backfillAadhaarHashes(sdk) {
  let rows = [];
  try {
    rows = await sdk.models.Traveller.find({ aadhaar_number_enc: { $exists: true, $ne: '' }, aadhaar_number_hash: { $exists: false } }, { limit: 200 });
  } catch {
    return;
  }
  for (const row of rows) {
    try {
      const n = sdk.crypto.decrypt(row.aadhaar_number_enc);
      if (n) await sdk.models.Traveller.updateById(row._id, { aadhaar_number_hash: sdk.crypto.hash(n) });
    } catch {
      /* unreadable: left as it is */
    }
  }
}

const DUPLICATE_TEXT = {
  email: 'A traveller with this email already exists.',
  phone: 'A traveller with this phone number already exists.',
  aadhaar: 'A traveller with this Aadhaar number already exists.',
  passport: 'A traveller with this passport number already exists.'
};
const DUPLICATE_CODE = { email: 'DUPLICATE_EMAIL', phone: 'DUPLICATE_PHONE', aadhaar: 'DUPLICATE_AADHAAR', passport: 'DUPLICATE_PASSPORT' };

/**
 * 2.14.0: email, phone, Aadhaar and passport number are unique per person in the whole workspace
 * (tenant). Only values being set are checked (a value the record already has is not); the record
 * itself and copies of the same person (same profile_id, e.g. on another lead) do not count.
 * Aadhaar and passport are found by their keyed fingerprint; the error never shows a number.
 * @param values  checked input (normalised: email lower case, phone digits, passport upper case)
 * @param patch   toPatch(values) (fingerprints)
 * @param current the stored row on edit, {} on create
 */
async function findDuplicates(sdk, values, patch, current = {}, selfId = null, profileId = '') {
  const checks = [];
  const other = (row) => str(row._id) !== str(selfId) && (!profileId || profileOf(row) !== str(profileId));
  if (values.email && values.email !== str(current.email).toLowerCase()) checks.push(['email', { email: values.email }]);
  if (values.phone && phoneKey(values.phone) !== phoneKey(current.phone)) {
    const variants = phoneVariants(values.phone);
    if (variants.length) checks.push(['phone', { phone: { $in: variants } }]);
  }
  if (patch.aadhaar_number_hash && patch.aadhaar_number_hash !== str(current.aadhaar_number_hash)) {
    await backfillAadhaarHashes(sdk);
    checks.push(['aadhaar', { aadhaar_number_hash: patch.aadhaar_number_hash }]);
  }
  if (patch.passport_number_hash && patch.passport_number_hash !== str(current.passport_number_hash)) {
    checks.push(['passport', { passport_number_hash: patch.passport_number_hash }]);
  }
  const found = [];
  // The other people's rows behind each found field (for the duplicates-check card; never sent as they are).
  const rowsByField = {};
  for (const [field, where] of checks) {
    const rows = (await sdk.models.Traveller.find(where, { limit: 20 })).filter(other);
    if (rows.length) {
      found.push(field);
      rowsByField[field] = rows;
    }
  }
  // Records saved before 2.14.0 that keep only the last 4 Aadhaar digits have no fingerprint: the same
  // last 4 there is a possible match (said as a warning, never a block — 4 digits are not proof).
  const possible = [];
  if (!found.includes('aadhaar') && values.aadhaarNumber && patch.aadhaar_number_hash) {
    try {
      const legacy = await sdk.models.Traveller.find(
        { aadhaar_last4: values.aadhaarNumber.slice(-4), aadhaar_number_hash: { $exists: false } },
        { limit: 20 }
      );
      if (legacy.some((row) => other(row) && !row.aadhaar_number_enc)) possible.push('aadhaar');
    } catch {
      /* no warning */
    }
  }
  return { found, possible, rowsByField };
}

const POSSIBLE_TEXT = {
  aadhaar: 'A traveller saved earlier has an Aadhaar number ending in the same 4 digits — check it is not the same person.'
};

async function assertNoDuplicates(sdk, values, patch, current = {}, selfId = null, profileId = '') {
  const { found } = await findDuplicates(sdk, values, patch, current, selfId, profileId);
  if (!found.length) return;
  const message = found.map((f) => DUPLICATE_TEXT[f]).join(' ');
  const error = sdk.error(409, message, found.length === 1 ? DUPLICATE_CODE[found[0]] : 'DUPLICATE_TRAVELLER_DETAILS');
  error.details = found;
  throw error;
}

/**
 * Refuses a second record of the same person on a lead (same full name and the same date of birth
 * or phone). `person` uses the input names: { firstName, lastName, dob, phone }.
 */
async function assertNotSamePerson(sdk, leadId, person, selfId, profileId) {
  const rows = await sdk.models.Traveller.find({ lead_id: leadId }, { limit: 500 });
  const twin = rows.find(
    (row) =>
      row._id !== selfId &&
      (!profileId || profileOf(row) !== str(profileId)) &&
      rules.samePerson(person, {
        firstName: str(row.first_name),
        lastName: str(row.last_name),
        dob: str(row.dob).slice(0, 10),
        phone: str(row.phone)
      })
  );
  if (twin) {
    const name = [str(twin.first_name), str(twin.last_name)].filter(Boolean).join(' ');
    throw sdk.error(409, `${name} is already a traveller on this lead`, 'DUPLICATE_TRAVELLER');
  }
}

/* ------------------------------------------------ duplicates-check card */

const CONFLICT_TEXT = 'The entered details match different existing Travellers. Please review the information before continuing.';
// findDuplicates field → the form's input key.
const FIELD_KEY = { email: 'email', phone: 'phone', aadhaar: 'aadhaarNumber', passport: 'passportNumber' };

/** True when this user may open the lead (sdk.crm: the CRM's tenant and permission checks). */
async function canReadLead(sdk, leadId) {
  if (!ID_RE.test(str(leadId))) return false;
  try {
    return Boolean(await sdk.crm.leads.findById(str(leadId)));
  } catch {
    return false; // no access (or the read failed): treated as not visible, never shown
  }
}

/**
 * The person behind the found duplicates, for the "Existing Traveller Found" card of the add form.
 *  - every found field points at one person (one profile_id) → { match: masked summary }
 *  - the fields point at different people → { conflict: true, message } (no names, no values)
 *  - the person has no record on a lead this user may read (a sales agent: their own leads only;
 *    same check as loadTraveller and the search route) → {}: the form then only shows the generic
 *    field messages, never who has the value.
 * Only masked values leave here: phone "+91 98••• ••210", Aadhaar / passport by their last 4
 * ("•••• •••• 4582", "•••••4567"); the encrypted numbers are never decrypted.
 * @param rowsByField findDuplicates().rowsByField (other people's rows per found field)
 * @param leadId      the lead the form adds to (already read by the caller)
 */
async function duplicateMatch(sdk, rowsByField, leadId) {
  const fields = Object.keys(rowsByField || {});
  if (!fields.length) return {};
  const profiles = new Set();
  for (const f of fields) for (const row of rowsByField[f]) profiles.add(profileOf(row));
  if (profiles.size > 1) return { conflict: true, message: CONFLICT_TEXT };
  const [profileId] = [...profiles];
  const ofProfile = { $or: [{ profile_id: profileId }, { _id: profileId }] };
  // The person's records on leads this user may see, newest first.
  const copies = await sdk.models.Traveller.find(await require('./lead-access.js').withVisibleLeads(sdk, ofProfile), { limit: 50, sort: { createdAt: -1 } });
  const readable = [];
  const leadOk = new Map();
  for (const row of copies) {
    const id = str(row.lead_id);
    if (!leadOk.has(id)) leadOk.set(id, await canReadLead(sdk, id));
    if (leadOk.get(id)) readable.push(row);
  }
  if (!readable.length) return {};
  const here = leadId ? await sdk.models.Traveller.find({ $and: [{ lead_id: leadId }, ofProfile] }, { limit: 1 }) : [];
  const alreadyOnLead = here.length > 0;
  // "Add Existing Traveller" links from a record on another lead (one on this lead cannot be added again).
  const row = readable.find((r) => str(r.lead_id) !== str(leadId)) || readable[0];
  return {
    match: {
      travellerId: str(row._id),
      name: [str(row.first_name), str(row.last_name)].filter(Boolean).join(' '),
      phone: rules.maskPhone(row.phone),
      email: str(row.email),
      aadhaar: rules.dotMask(rules.maskAadhaar(str(row.aadhaar_last4))),
      passport: rules.dotMask(rules.maskPassport(str(row.passport_last4))),
      fields: fields.map((f) => FIELD_KEY[f]),
      alreadyOnLead
    }
  };
}

/* --------------------------------------------------- shared photo files */

/**
 * Records of the same person on several leads share their passport / Aadhaar photo (one stored file,
 * referenced by each record). A file is only deleted when no other Traveller record still uses it.
 */
async function fileInUse(sdk, fileId, exceptIds = []) {
  const id = str(fileId);
  if (!id) return false;
  const except = new Set(exceptIds.map(str));
  const rows = await sdk.models.Traveller.find({ $or: [{ passport_file_id: id }, { aadhaar_file_id: id }] }, { limit: 50 });
  return rows.some((r) => !except.has(str(r._id)));
}

/**
 * Deletes a photo file unless another record (not in `exceptIds`) still references it. When that cannot
 * be checked, the file is kept (never delete a file another record may show). → true when removed.
 */
async function releaseFile(sdk, fileId, exceptIds = []) {
  if (!str(fileId)) return false;
  try {
    if (await fileInUse(sdk, fileId, exceptIds)) return false;
  } catch (error) {
    if (sdk.logger) sdk.logger.warn('traveller photo kept: could not check other records:', error && error.message);
    return false;
  }
  return Boolean(await sdk.files.remove(str(fileId)));
}

/** Contact person shown with a traveller: { id, name, phone, email } or null. Needs crm.contacts.read. */
async function contactSummary(sdk, contactId) {
  if (!ID_RE.test(str(contactId))) return null;
  try {
    const c = await sdk.crm.contacts.findById(contactId);
    return c ? { id: str(c._id), name: str(c.name), phone: str(c.phone), email: str(c.email) } : null;
  } catch {
    return null; // no permission to read contacts: show the traveller without it
  }
}

module.exports = {
  ID_RE,
  str,
  loadLead,
  loadTraveller,
  timeZone,
  referenceFromValues,
  referenceFor,
  profileOf,
  ensureProfiles,
  bookingsFor,
  bookingCheckFailed,
  passportRule,
  fieldOptions,
  aadhaarStorage,
  passportMissing,
  present,
  inputError,
  toPatch,
  checkPassport,
  assertNoDuplicatePassport,
  assertNoDuplicates,
  findDuplicates,
  DUPLICATE_TEXT,
  POSSIBLE_TEXT,
  phoneVariants,
  phoneKey,
  assertNotSamePerson,
  CONFLICT_TEXT,
  FIELD_KEY,
  canReadLead,
  duplicateMatch,
  fileInUse,
  releaseFile,
  contactSummary
};
