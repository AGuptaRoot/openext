'use strict';

/**
 * Travellers of a lead, with their passport and Aadhaar details and photos.
 *
 * GET    /leads/:lead_id/travellers                       list (numbers masked) + counts + passport rule
 * POST   /leads/:lead_id/travellers                       add a traveller
 * POST   /leads/:lead_id/travellers/copy                  add an existing traveller (their profile) to this lead
 * GET    /travellers/:traveller_id                        one traveller with full numbers (for the edit form; logged)
 * PUT    /travellers/:traveller_id                        change a traveller (only the keys sent)
 * POST   /travellers/duplicates-check                     the form: values another person has (+ who, masked)
 * DELETE /travellers/:traveller_id                        delete a traveller and its photos (not while on a booking;
 *                                                         a photo another record still uses stays)
 * PUT    /travellers/:traveller_id/documents/:kind        store / replace the passport or Aadhaar photo
 * GET    /travellers/:traveller_id/documents/:kind        the photo (logged; edit permission: it shows the full number)
 * DELETE /travellers/:traveller_id/documents/:kind        delete the photo
 *
 * Rows live in this extension's own table (model Traveller), linked to the
 * core lead by lead_id; every route first reads the lead through sdk.crm, so
 * the CRM's tenant and permission checks apply. Document numbers are stored
 * encrypted (sdk.crypto) with a fingerprint for duplicate checks; photos are
 * stored encrypted (sdk.files). Age and Adult / Child / Infant are worked out
 * here, never taken from the client. Audit entries never contain the numbers.
 *
 * Checks on every save: phone and relation required; passport details required
 * when the lead's Travel Requirement has a "Passport required" service; an expired
 * passport or one expiring before the trip is refused. Search, export, import,
 * detail and contact views are in traveller-tools.js.
 *
 * Travellers are reusable profiles: every record has a profile_id (a new person: its own _id;
 * older rows get it when first read). Adding an existing traveller to another lead ("Add Existing
 * Traveller") links the person to that lead: a record on the lead with the same profile_id, so the
 * person stays one profile and their trips span leads; the source record is not changed. The new
 * record takes the profile columns as stored. The document numbers are taken as their ciphertext and
 * keyed fingerprint (never decrypted, never re-encrypted): every record of the lead tab, the booking
 * and the readiness checks reads its own row, so the row carries them; the ciphertext is the same
 * stored value, not a new copy of the number. The passport / Aadhaar photos are not copied: the new
 * record references the same stored files, and a file is deleted only when no record still references
 * it (delete, photo replace / remove, orphan cleanup). Already on the lead: 409 TRAVELLER_ON_LEAD
 * "This Traveller is already added.".
 */

const rules = require('../services/traveller-rules.js');
const store = require('../services/traveller-store.js');
const { notifyIfReady } = require('../services/readiness.js');
const passportAlerts = require('../services/passport-alerts.js');
const { assertLeadOpen } = require('../services/lead-access.js');

const { str, ID_RE } = store;
const KINDS = { passport: 'passport_file_id', aadhaar: 'aadhaar_file_id' };
const KIND_LABEL = { passport: 'passport', aadhaar: 'Aadhaar' };

/* ------------------------------------------------------------------ routes */

exports.listForLead = async (req, sdk) => {
  const leadId = String((req.params && req.params.lead_id) || '');
  const lead = await store.loadLead(sdk, leadId);
  const [ref, rows, storage, options] = await Promise.all([
    store.referenceFor(sdk, leadId),
    sdk.models.Traveller.find({ lead_id: leadId }, { limit: 200, sort: { createdAt: 1 } }),
    store.aadhaarStorage(sdk),
    store.fieldOptions(sdk)
  ]);
  await store.ensureProfiles(sdk, rows);
  const rule = await store.passportRule(sdk, ref.selected);
  const travellers = rows.map((row) => store.present(row, ref.referenceDate, rule, ref.timeZone));
  const counts = { Adult: 0, Child: 0, Infant: 0, total: travellers.length };
  for (const t of travellers) if (counts[t.ageCategory] !== undefined) counts[t.ageCategory] += 1;
  // Same rule as the quotation: a traveller without a known age counts as an Adult.
  const { counted, unknownAge } = rules.travellerGroups(travellers.map((t) => t.ageCategory), ref.expected);
  return {
    travellers,
    counts,
    groups: { ...counted, unknownAge },
    expected: ref.expected,
    referenceDate: ref.referenceDate,
    referenceSource: ref.referenceSource,
    leadContact: lead.contactId ? { contactId: String(lead.contactId), name: String(lead.name || '') } : null,
    passportRequired: rule.required,
    passportRequiredBy: rule.services,
    aadhaarStorage: storage,
    nationalityOptions: options.nationalityOptions,
    relationOptions: options.relationOptions,
    canEdit: sdk.permissions.has('crm.leads.write')
  };
};

exports.create = async (req, sdk) => {
  const leadId = String((req.params && req.params.lead_id) || '');
  await store.loadLead(sdk, leadId);
  await assertLeadOpen(sdk, leadId);
  const { values, errors } = rules.checkInput(req.body, { create: true, timeZone: await store.timeZone(sdk) });
  if (errors.length) throw store.inputError(sdk, errors);
  const [ref, storage] = await Promise.all([store.referenceFor(sdk, leadId), store.aadhaarStorage(sdk)]);
  const rule = await store.passportRule(sdk, ref.selected);
  const patch = store.toPatch(sdk, values, {}, storage, ref.referenceDate);
  store.checkPassport(sdk, patch, rule, ref.referenceDate, { timeZone: ref.timeZone });
  await store.assertNoDuplicatePassport(sdk, leadId, patch, null);
  await store.assertNotSamePerson(sdk, leadId, values, null);
  await store.assertNoDuplicates(sdk, values, patch, {}, null, '');
  const created = await sdk.models.Traveller.create({ lead_id: leadId, ...patch });
  // A new person: the record is its own profile.
  const row = (await sdk.models.Traveller.updateById(created._id, { profile_id: created._id })) || { ...created, profile_id: created._id };
  await sdk.audit('created', `Traveller added to lead ${leadId}`, {
    travellerId: row._id,
    leadId,
    ocrUsed: values.ocrUsed,
    ...(values.docMismatchConfirmed ? { docMismatchConfirmed: true } : {})
  });
  // A passport already inside the 6-month window: the responsible user hears at once (once only).
  await passportAlerts.afterSave(sdk, row);
  // A new traveller may make the lead ready (CRM lead workflow, e.g. move to Qualified).
  const workflow = await notifyIfReady(sdk, leadId);
  return { traveller: store.present(row, ref.referenceDate, rule, ref.timeZone), workflow };
};

/**
 * POST /travellers/duplicates-check { leadId?, travellerId?, email?, phone?, aadhaarNumber?, passportNumber? }
 * The form asks while the user types (leaving a field): which of these values another person in the
 * workspace already has → { duplicates: [{ field, message }], possible: [{ field, message }] }. Saving
 * checks the same again (the create / update routes refuse a duplicate whatever the form showed).
 *
 * The add form (leadId, no travellerId) also gets who it is, so the existing traveller can be added:
 *  - match: { travellerId, name, phone, email, aadhaar, passport, fields, alreadyOnLead } when every
 *    found field points at one person. Numbers masked only (phone "+91 98••• ••210", Aadhaar / passport
 *    by their last 4), never a full number. Only when the user may read the lead of a record of that
 *    person (a sales agent: their own leads, as loadTraveller / the search route); otherwise just the
 *    generic duplicate messages above, never a name or a masked value.
 *  - conflict: true + message when the fields point at different people (nobody named).
 */
exports.duplicatesCheck = async (req, sdk) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const input = {};
  for (const key of ['email', 'phone', 'aadhaarNumber', 'passportNumber']) {
    if (str(body[key])) input[key] = body[key];
  }
  if (!Object.keys(input).length) return { duplicates: [], possible: [] };
  // Normalised and checked like a save; a value that is not valid yet is simply not looked up.
  const { values } = rules.checkInput(input, { create: false, timeZone: await store.timeZone(sdk) });
  const valid = {};
  for (const key of Object.keys(input)) if (values[key] && (key !== 'phone' || /^\+?\d{7,15}$/.test(values[key]))) valid[key] = values[key];
  if (!Object.keys(valid).length) return { duplicates: [], possible: [] };
  let current = {};
  let selfId = null;
  let profileId = '';
  if (ID_RE.test(str(body.travellerId))) {
    const { row } = await store.loadTraveller({ params: { traveller_id: str(body.travellerId) } }, sdk);
    current = row;
    selfId = row._id;
    profileId = store.profileOf(row);
  }
  const patch = {};
  if (valid.passportNumber) patch.passport_number_hash = sdk.crypto.hash(valid.passportNumber);
  if (valid.aadhaarNumber) patch.aadhaar_number_hash = sdk.crypto.hash(valid.aadhaarNumber);
  const { found, possible, rowsByField } = await store.findDuplicates(sdk, valid, patch, current, selfId, profileId);
  const FIELD = store.FIELD_KEY;
  const out = {
    duplicates: found.map((f) => ({ field: FIELD[f], message: store.DUPLICATE_TEXT[f] })),
    possible: possible.map((f) => ({ field: FIELD[f], message: store.POSSIBLE_TEXT[f] }))
  };
  const leadId = str(body.leadId);
  if (found.length && !selfId && ID_RE.test(leadId) && (await store.canReadLead(sdk, leadId))) {
    Object.assign(out, await store.duplicateMatch(sdk, rowsByField, leadId));
  }
  return out;
};


exports.getOne = async (req, sdk) => {
  const { row } = await store.loadTraveller(req, sdk);
  const ref = await store.referenceFor(sdk, row.lead_id);
  const rule = await store.passportRule(sdk, ref.selected);
  const traveller = store.present(row, ref.referenceDate, rule, ref.timeZone);
  traveller.passport.number = row.passport_number_enc ? sdk.crypto.decrypt(row.passport_number_enc) : '';
  traveller.aadhaar.number = row.aadhaar_number_enc ? sdk.crypto.decrypt(row.aadhaar_number_enc) : '';
  traveller.aadhaar.last4 = str(row.aadhaar_last4);
  await sdk.audit('viewed', `Traveller details opened for editing (lead ${row.lead_id})`, { travellerId: row._id, leadId: row.lead_id });
  return { traveller };
};

exports.update = async (req, sdk) => {
  const { row } = await store.loadTraveller(req, sdk);
  await assertLeadOpen(sdk, row.lead_id);
  const { values, errors } = rules.checkInput(req.body, { create: false, timeZone: await store.timeZone(sdk) });
  if (errors.length) throw store.inputError(sdk, errors);
  const [ref, storage] = await Promise.all([store.referenceFor(sdk, row.lead_id), store.aadhaarStorage(sdk)]);
  const rule = await store.passportRule(sdk, ref.selected);
  const patch = store.toPatch(sdk, values, row, storage, ref.referenceDate);
  store.checkPassport(sdk, { ...row, ...patch }, rule, ref.referenceDate, { timeZone: ref.timeZone });
  await store.assertNoDuplicatePassport(sdk, row.lead_id, patch, row._id, store.profileOf(row));
  await store.assertNotSamePerson(
    sdk,
    row.lead_id,
    {
      firstName: 'firstName' in values ? values.firstName : store.str(row.first_name),
      lastName: 'lastName' in values ? values.lastName : store.str(row.last_name),
      dob: 'dob' in values ? values.dob : store.str(row.dob).slice(0, 10),
      phone: 'phone' in values ? values.phone : store.str(row.phone)
    },
    row._id,
    store.profileOf(row)
  );
  await store.assertNoDuplicates(sdk, values, patch, row, row._id, store.profileOf(row));
  const updated = await sdk.models.Traveller.updateById(row._id, patch);
  if ('passportExpiryDate' in values) await passportAlerts.afterSave(sdk, updated || { ...row, ...patch });
  await sdk.audit('updated', `Traveller changed (lead ${row.lead_id})`, {
    travellerId: row._id,
    leadId: row.lead_id,
    fields: Object.keys(values).filter((k) => k !== 'ocrUsed' && k !== 'docMismatchConfirmed'),
    ocrUsed: values.ocrUsed,
    ...(values.docMismatchConfirmed ? { docMismatchConfirmed: true } : {})
  });
  return { traveller: store.present(updated, ref.referenceDate, rule, ref.timeZone) };
};

exports.remove = async (req, sdk) => {
  const { row } = await store.loadTraveller(req, sdk);
  await assertLeadOpen(sdk, row.lead_id);
  // A traveller on a booking stays until it is taken off the booking (bookings keep their people).
  // Never delete blind: when the bookings cannot be checked, refuse (503) and let the user retry.
  let bookings;
  try {
    bookings = await store.bookingsFor(sdk, [row._id]);
  } catch (error) {
    if (sdk.logger) sdk.logger.warn('traveller delete: booking check failed:', error && error.message);
    throw store.bookingCheckFailed(sdk);
  }
  if (bookings.length) {
    const numbers = bookings.map((b) => str(b.number || b.booking_number || b.reference) || 'a booking').slice(0, 3).join(', ');
    throw sdk.error(409, `On booking ${numbers}; remove it from the booking first`, 'TRAVELLER_ON_BOOKING');
  }
  // A photo another record of the person (another lead) still shows stays; only this record's link goes.
  let photosKept = 0;
  for (const column of Object.values(KINDS)) {
    if (row[column] && !(await store.releaseFile(sdk, row[column], [row._id]))) photosKept += 1;
  }
  await sdk.models.Traveller.deleteById(row._id);
  await sdk.audit('deleted', `Traveller deleted with their document photos (lead ${row.lead_id})`, {
    travellerId: row._id,
    leadId: row.lead_id,
    ...(photosKept ? { photosKept } : {})
  });
  return { deleted: true };
};

/* ----------------------------------------------- add an existing traveller */

// Profile fields a copy takes over as stored (document numbers stay encrypted; never decrypted here).
const COPY_COLUMNS = [
  'contact_id', 'first_name', 'last_name', 'phone', 'email', 'dob', 'year_of_birth', 'gender', 'nationality', 'relation',
  'passport_number_enc', 'passport_number_hash', 'passport_last4', 'passport_issue_date', 'passport_expiry_date', 'passport_country',
  'aadhaar_number_enc', 'aadhaar_number_hash', 'aadhaar_last4', 'ocr_used'
];

exports.copy = async (req, sdk) => {
  const leadId = String((req.params && req.params.lead_id) || '');
  await store.loadLead(sdk, leadId);
  await assertLeadOpen(sdk, leadId);
  const sourceId = str(req.body && req.body.travellerId);
  if (!ID_RE.test(sourceId)) throw sdk.error(400, 'travellerId is required', 'INVALID_INPUT');
  // The source is read like any traveller: its own lead must exist and be readable.
  const { row: source } = await store.loadTraveller({ params: { traveller_id: sourceId } }, sdk);
  await store.ensureProfiles(sdk, [source]);
  const profileId = store.profileOf(source);
  const here = await sdk.models.Traveller.find({ lead_id: leadId, profile_id: profileId }, { limit: 1 });
  if (here.length || str(source.lead_id) === leadId) {
    throw sdk.error(409, 'This Traveller is already added.', 'TRAVELLER_ON_LEAD');
  }

  const ref = await store.referenceFor(sdk, leadId);
  const rule = await store.passportRule(sdk, ref.selected);
  const patch = {};
  for (const column of COPY_COLUMNS) if (source[column] !== undefined && source[column] !== null) patch[column] = source[column];
  patch.age_category = rules.ageInfo({ dob: str(patch.dob).slice(0, 10), yearOfBirth: patch.year_of_birth }, ref.referenceDate).ageCategory;
  // A passport that cannot be used for this trip is refused, as on any save. Missing details are only
  // flagged (like an import): the agent adds them in the form.
  store.checkPassport(sdk, patch, rule, ref.referenceDate, { requireDetails: false, timeZone: ref.timeZone });
  await store.assertNoDuplicatePassport(sdk, leadId, patch, null, profileId);

  // Photos: the new record points at the same stored files (no second copy of the documents). Deleting
  // or replacing a photo on one record removes the file only when no other record still uses it.
  let photosShared = 0;
  for (const column of Object.values(KINDS)) {
    if (!str(source[column])) continue;
    patch[column] = str(source[column]);
    photosShared += 1;
  }
  const row = await sdk.models.Traveller.create({ lead_id: leadId, ...patch, profile_id: profileId });
  await sdk.audit('created', `Existing traveller added to lead ${leadId} (from lead ${source.lead_id})`, {
    travellerId: row._id,
    leadId,
    sourceTravellerId: source._id,
    profileId,
    photosShared
  });
  const workflow = await notifyIfReady(sdk, leadId);
  // photoErrors: kept for older screens (photos are no longer copied, so nothing can fail there).
  return { traveller: store.present(row, ref.referenceDate, rule, ref.timeZone), workflow, photoErrors: [] };
};

/* --------------------------------------------------------------- documents */

function kindOf(req, sdk) {
  const kind = String((req.params && req.params.kind) || '');
  if (!KINDS[kind]) throw sdk.error(404, 'Document type must be passport or aadhaar', 'NOT_FOUND');
  return kind;
}

async function presentFor(sdk, row) {
  const ref = await store.referenceFor(sdk, row.lead_id);
  const rule = await store.passportRule(sdk, ref.selected);
  return store.present(row, ref.referenceDate, rule, ref.timeZone);
}

exports.putDocument = async (req, sdk) => {
  const kind = kindOf(req, sdk);
  const { row } = await store.loadTraveller(req, sdk);
  await assertLeadOpen(sdk, row.lead_id);
  const body = req.body || {};
  if (typeof body.image !== 'string' || !body.image) throw sdk.error(400, 'image is required (a JPG, PNG or WEBP data URL)', 'INVALID_IMAGE');
  const saved = await sdk.files.save({
    data: body.image,
    name: String(body.name || `${kind}.jpg`),
    recordType: 'traveller',
    recordId: row._id
  });
  const column = KINDS[kind];
  const old = row[column];
  const updated = await sdk.models.Traveller.updateById(row._id, { [column]: saved.id });
  // The old file may still be another record's photo (a linked lead): then it stays there.
  if (old && old !== saved.id) await store.releaseFile(sdk, old, [row._id]);
  await sdk.audit('updated', `${KIND_LABEL[kind]} photo ${old ? 'replaced' : 'uploaded'} (lead ${row.lead_id})`, {
    travellerId: row._id,
    leadId: row.lead_id,
    document: kind
  });
  return { traveller: await presentFor(sdk, updated) };
};

exports.getDocument = async (req, sdk) => {
  const kind = kindOf(req, sdk);
  // The photo shows the full document number: the edit permission, like the edit form (routes.json too).
  if (sdk.permissions && typeof sdk.permissions.has === 'function' && !sdk.permissions.has('crm.leads.write')) {
    throw sdk.error(403, 'Only users who can edit travellers can open document photos', 'FORBIDDEN');
  }
  const { row } = await store.loadTraveller(req, sdk);
  const fileId = row[KINDS[kind]];
  const file = fileId ? await sdk.files.read(fileId) : null;
  if (!file) throw sdk.error(404, `No ${KIND_LABEL[kind]} photo is stored for this traveller`, 'NOT_FOUND');
  await sdk.audit('viewed', `${KIND_LABEL[kind]} photo viewed (lead ${row.lead_id})`, { travellerId: row._id, leadId: row.lead_id, document: kind });
  return { dataUrl: file.dataUrl, name: file.name, mimeType: file.mimeType, size: file.size };
};

exports.removeDocument = async (req, sdk) => {
  const kind = kindOf(req, sdk);
  const { row } = await store.loadTraveller(req, sdk);
  await assertLeadOpen(sdk, row.lead_id);
  const column = KINDS[kind];
  let updated = row;
  if (row[column]) {
    // Only this record's link is dropped; the file goes when no other record (linked lead) uses it.
    await store.releaseFile(sdk, row[column], [row._id]);
    updated = await sdk.models.Traveller.updateById(row._id, { [column]: '' });
    await sdk.audit('deleted', `${KIND_LABEL[kind]} photo deleted (lead ${row.lead_id})`, { travellerId: row._id, leadId: row.lead_id, document: kind });
  }
  return { traveller: await presentFor(sdk, updated) };
};

// For tests.
exports._present = store.present;
