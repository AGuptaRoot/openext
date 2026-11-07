'use strict';

/**
 * Itinerary / day plan generated from a proposal (spec §6.10), then edited by the agent.
 *
 * POST /itineraries/from-quotation   record action "Generate itinerary" { recordId, replace?, from_itinerary_id? }
 *                                    Draft exists → opened (replace:true regenerates it); from_itinerary_id copies
 *                                    a version into a new draft; otherwise a new version. Not for Rejected quotations.
 * GET  /itineraries?quotation_id=|lead_id=|booking_id=
 * GET  /itineraries/:id               the plan, its versions, booking, trip facts (route, travellers, nights)
 * PUT  /itineraries/:id               edit a Draft (title, days, items, notes; checked by itinerary.cleanEdit)
 * POST /itineraries/:id/finalize      Draft → Final with PDF; guest / travellers kept as a snapshot; the older
 *                                     Final of the quotation → Superseded, redrawn from its own snapshot
 * GET  /itineraries/:id/file          the PDF (audited)
 *
 * Customer-facing: no prices, budgets, fares or document numbers (line descriptions are scrubbed first).
 */

const Itin = require('../services/itinerary.js');
const store = require('../services/booking-store.js');
const rules = require('../services/traveller-rules.js');

const { str, ID_RE } = store;
const ALLOWED = ['Draft', 'Sent', 'Accepted', 'Expired', 'Converted'];
const PAGE = store.ITINERARY_PAGE;

const ITINERARY_PROPOSED_STAGE = 'travel_itinerary_proposed';

/** The quotation's trip opportunity moves forward to "Itinerary Proposed" (never back; best-effort). */
async function markItineraryProposed(sdk, quotationId) {
  try {
    if (!sdk.workflow || typeof sdk.workflow.opportunityStage !== 'function') return;
    const q = ID_RE.test(str(quotationId)) ? await sdk.crm.quotations.findById(str(quotationId)) : null;
    const opportunityId = str(q && (q.opportunityId || q.dealId));
    if (!ID_RE.test(opportunityId)) return;
    await sdk.workflow.opportunityStage(opportunityId, ITINERARY_PROPOSED_STAGE, 'itinerary finalized');
  } catch (error) {
    if (sdk.logger) sdk.logger.warn('itinerary stage update failed:', error && error.message);
  }
}

function summary(row) {
  return {
    id: row._id,
    version: Number(row.version) || 1,
    status: str(row.status) || 'Draft',
    title: str(row.title),
    quotation_id: str(row.quotation_id),
    quotation_no: str(row.quotation_no),
    quotation_version: Number(row.quotation_version) || 1,
    lead_id: str(row.lead_id),
    booking_id: str(row.booking_id),
    start_date: str(row.start_date).slice(0, 10),
    end_date: str(row.end_date).slice(0, 10),
    edited: row.edited === true,
    generated_at: str(row.generated_at),
    finalized_at: str(row.finalized_at),
    has_file: Boolean(row.file_id),
    updatedAt: row.updatedAt
  };
}

function full(row) {
  return {
    ...summary(row),
    reference: referenceOf(row),
    days: Array.isArray(row.days) ? row.days : [],
    unscheduled: Array.isArray(row.unscheduled) ? row.unscheduled : [],
    notes: str(row.notes)
  };
}

function referenceOf(row) {
  return `ITN-${str(row.quotation_no)}-v${Number(row.version) || 1}`.replace('ITN--', 'ITN-');
}

const isDuplicate = (error) => Boolean(error && (error.status === 409 || error.code === 'DUPLICATE'));

async function loadItinerary(sdk, id) {
  const key = str(id);
  const row = ID_RE.test(key) ? await sdk.models.Itinerary.findById(key) : null;
  if (!row) throw sdk.error(404, 'Itinerary not found', 'NOT_FOUND');
  await require('../services/lead-access.js').assertLeadVisible(sdk, row.lead_id, 'Itinerary');
  return row;
}

async function leadIdOf(sdk, q) {
  if (ID_RE.test(str(q.leadId))) return str(q.leadId);
  if (ID_RE.test(str(q.opportunityId))) {
    try {
      const opp = await sdk.crm.opportunities.findById(q.opportunityId);
      if (opp && ID_RE.test(str(opp.leadId))) return str(opp.leadId);
    } catch {
      /* no opportunity access */
    }
  }
  return '';
}

/** A fresh plan from the quotation (pure generate() over the lines, requirements and service settings). */
async function planFor(sdk, q, leadId) {
  const raw = (Array.isArray(q.lineItems) ? q.lineItems : []).map((l) => ({
    name: str(l && l.name),
    description: str(l && l.description),
    sourceRef: str(l && l.sourceRef).slice(0, 64)
  }));
  const reqIds = [...new Set(raw.map((l) => l.sourceRef.split(':')[0]).filter((id) => ID_RE.test(id)))];
  const [services, requirements, leadValues] = await Promise.all([
    store.readServicesFull(sdk),
    reqIds.length ? sdk.models.TravelRequirement.find({ _id: { $in: reqIds } }, { limit: 200 }) : [],
    leadId ? sdk.values.get('lead', leadId) : {}
  ]);
  const own = requirements.filter((r) => !leadId || str(r.lead_id) === leadId);
  const reqById = new Map(own.map((r) => [str(r._id), r]));
  const byKey = new Map(services.map((s) => [s.key, s]));
  // Customer-facing details: a requirement's line → its structured, filtered values (never the line's
  // free text, which may name hidden fields); a line added by hand → its text, scrubbed.
  const lines = raw.map((l) => {
    const requirement = reqById.get(l.sourceRef.split(':')[0]) || null;
    const service = requirement ? byKey.get(str(requirement.service_key)) || null : null;
    const description = service
      ? store.customerSummary(service, requirement.values, { max: 4, skipTypes: ['textarea', 'date'] })
      : store.scrubText(l.description);
    return { ...l, description };
  });
  // The plan's titles read some values (hotel name, from / to): internal fields (hide on voucher,
  // money, document numbers) are left out before generate() sees them.
  const customerValues = (r) => {
    const service = byKey.get(str(r.service_key));
    const values = r.values && typeof r.values === 'object' ? r.values : {};
    if (!service) return values;
    const hidden = new Set((service.fields || []).filter((f) => store.isInternalField(f)).map((f) => f.key));
    return Object.fromEntries(Object.entries(values).filter(([k]) => !hidden.has(k)));
  };
  return Itin.generate({
    quotation: { lineItems: lines, title: str(q.title) },
    leadValues: leadValues || {},
    requirements: new Map(own.map((r) => [str(r._id), { ...r, values: customerValues(r) }])),
    services
  });
}

exports.fromQuotation = async (req, sdk) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const qid = str(body.recordId);
  if (!ID_RE.test(qid) || (body.recordType && body.recordType !== 'quotation')) throw sdk.error(400, 'recordId must be a quotation id', 'INVALID_INPUT');
  const q = await sdk.crm.quotations.findById(qid);
  if (!q) throw sdk.error(404, 'Quotation not found', 'NOT_FOUND');
  if (q.status === 'Rejected') throw sdk.error(400, 'A rejected quotation cannot get an itinerary', 'QUOTATION_REJECTED');
  if (!ALLOWED.includes(q.status || 'Draft')) throw sdk.error(400, `An itinerary cannot be made for a ${q.status} quotation`, 'INVALID_STATUS');
  const leadId = await leadIdOf(sdk, q);
  const [all, booking] = await Promise.all([
    sdk.models.Itinerary.find({ quotation_id: qid }, { limit: 100, sort: { version: -1 } }),
    sdk.models.Booking.findOne({ quotation_id: qid })
  ]);
  const draft = all.find((r) => r.status === 'Draft') || null;
  const nextVersion = all.reduce((max, r) => Math.max(max, Number(r.version) || 0), 0) + 1;
  const open = (row, message) => ({ message, navigate: `${PAGE}?id=${row._id}`, itinerary: full(row) });
  const base = {
    quotation_id: qid,
    quotation_no: str(q.quotationNo),
    quotation_version: Number(q.version) || 1,
    lead_id: leadId,
    booking_id: booking ? booking._id : ''
  };

  // Every row carries the unique quotation_version_key "<quotationId>:<version>": two "Generate" clicks at
  // the same moment cannot both make Draft v<n>; the loser opens the draft the winner made.
  const versionKey = (v) => `${qid}:${v}`;
  for (const r of all) {
    const key = versionKey(Number(r.version) || 1);
    if (str(r.quotation_version_key) === key) continue;
    try {
      await sdk.models.Itinerary.updateById(r._id, { quotation_version_key: key }); // older rows
    } catch (error) {
      if (!isDuplicate(error)) throw error;
    }
  }
  const createVersion = async (data) => {
    try {
      return { row: await sdk.models.Itinerary.create({ ...data, quotation_version_key: versionKey(data.version) }) };
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const winner = await sdk.models.Itinerary.findOne({ quotation_version_key: versionKey(data.version) });
      if (!winner) throw error;
      return { existing: winner };
    }
  };

  const fromId = str(body.from_itinerary_id);
  if (fromId) {
    const source = all.find((r) => r._id === fromId);
    if (!source) throw sdk.error(404, 'Itinerary not found for this quotation', 'NOT_FOUND');
    if (draft) return open(draft, `Draft v${draft.version} already exists — opened it`);
    const made = await createVersion({
      ...base,
      title: str(source.title),
      start_date: str(source.start_date),
      end_date: str(source.end_date),
      version: nextVersion,
      status: 'Draft',
      days: Array.isArray(source.days) ? source.days : [],
      unscheduled: Array.isArray(source.unscheduled) ? source.unscheduled : [],
      notes: str(source.notes),
      generated_at: str(source.generated_at) || store.nowIso(),
      edited: source.edited === true
    });
    if (made.existing) return open(made.existing, `Draft v${made.existing.version} already exists — opened it`);
    const row = made.row;
    await sdk.audit('created', `Itinerary v${nextVersion} started from v${source.version} (quotation ${q.quotationNo || qid})`, { itineraryId: row._id, quotationId: qid });
    return open(row, `Itinerary v${nextVersion} created`);
  }
  if (draft && body.replace !== true) return open(draft, `Draft itinerary v${draft.version} opened`);

  const plan = await planFor(sdk, q, leadId);
  const fields = {
    title: plan.title,
    start_date: plan.start_date,
    end_date: plan.end_date,
    days: plan.days,
    unscheduled: plan.unscheduled,
    generated_at: store.nowIso(),
    edited: false
  };
  if (draft) {
    const row = await sdk.models.Itinerary.updateById(draft._id, { ...fields, booking_id: base.booking_id || str(draft.booking_id) });
    await sdk.audit('updated', `Itinerary v${draft.version} regenerated from quotation ${q.quotationNo || qid}`, { itineraryId: draft._id, quotationId: qid });
    return open(row, `Itinerary v${draft.version} regenerated`);
  }
  const made = await createVersion({ ...base, ...fields, version: nextVersion, status: 'Draft', notes: '' });
  if (made.existing) return open(made.existing, `Draft itinerary v${made.existing.version} opened`);
  const row = made.row;
  await sdk.audit('created', `Itinerary v${nextVersion} generated from quotation ${q.quotationNo || qid}`, { itineraryId: row._id, quotationId: qid });
  return open(row, `Itinerary v${nextVersion} generated`);
};

exports.list = async (req, sdk) => {
  const query = req.query || {};
  const where = {};
  for (const key of ['quotation_id', 'lead_id', 'booking_id']) {
    const v = str(query[key]);
    if (ID_RE.test(v)) where[key] = v;
  }
  if (!Object.keys(where).length) throw sdk.error(400, 'Give quotation_id, lead_id or booking_id', 'INVALID_INPUT');
  const rows = await sdk.models.Itinerary.find(where, { limit: 50, sort: { version: -1, createdAt: -1 } });
  return { itineraries: rows.map(summary) };
};

/**
 * Trip facts for the page header (from the lead's travel fields; read only): route, destination,
 * travellers, days / nights of the plan. No document numbers, prices or contact details.
 */
async function tripFacts(sdk, row) {
  let v = {};
  try {
    v = ID_RE.test(str(row.lead_id)) ? (await sdk.values.get('lead', str(row.lead_id))) || {} : {};
  } catch {
    v = {};
  }
  const count = (x) => (Number.isFinite(Number(x)) && x !== '' && x !== null && x !== undefined ? Math.max(0, Math.round(Number(x))) : 0);
  const start = str(row.start_date).slice(0, 10);
  const end = str(row.end_date).slice(0, 10);
  const span = rules.isValidDate(start) && rules.isValidDate(end) ? Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) : null;
  const days = Array.isArray(row.days) ? row.days.length : 0;
  return {
    from: str(v.from).slice(0, 120),
    to: str(v.to).slice(0, 120),
    destination: str(v.destination).slice(0, 120),
    adults: count(v.adults),
    children: count(v.children),
    infants: count(v.infants),
    days: span !== null && span >= 0 ? span + 1 : days,
    nights: span !== null && span >= 0 ? span : Math.max(0, days - 1)
  };
}

exports.getOne = async (req, sdk) => {
  const row = await loadItinerary(sdk, store.idParam(req));
  let booking = null;
  if (ID_RE.test(str(row.booking_id))) {
    const b = await sdk.models.Booking.findById(row.booking_id);
    if (b) booking = { id: b._id, number: str(b.number), status: str(b.status) };
  }
  const versions = await sdk.models.Itinerary.find({ quotation_id: row.quotation_id }, { limit: 50, sort: { version: -1 } });
  return {
    itinerary: full(row),
    versions: versions.map(summary),
    booking,
    trip: await tripFacts(sdk, row),
    can: { edit: Boolean(sdk.permissions.has('crm.leads.write')) }
  };
};

exports.update = async (req, sdk) => {
  const row = await loadItinerary(sdk, store.idParam(req));
  if (row.status !== 'Draft') throw sdk.error(409, `This itinerary is ${row.status} — start a new version to change it`, 'ITINERARY_NOT_DRAFT');
  const clean = Itin.cleanEdit(req.body && typeof req.body === 'object' ? req.body : {}, { start_date: str(row.start_date).slice(0, 10), end_date: str(row.end_date).slice(0, 10) });
  const updated = await sdk.models.Itinerary.updateById(row._id, {
    title: clean.title || str(row.title),
    days: clean.days,
    unscheduled: clean.unscheduled,
    notes: clean.notes,
    edited: true
  });
  await sdk.audit('updated', `Itinerary ${referenceOf(row)} edited`, { itineraryId: row._id, quotationId: row.quotation_id });
  return { itinerary: full(updated) };
};

function groupsText(rows, referenceDate) {
  const groups = { Adult: 0, Child: 0, Infant: 0 };
  let other = 0;
  for (const t of rows) {
    const cat = rules.ageInfo({ dob: str(t.dob).slice(0, 10), yearOfBirth: t.year_of_birth }, referenceDate).ageCategory;
    if (groups[cat] !== undefined) groups[cat] += 1;
    else other += 1;
  }
  const parts = [];
  if (groups.Adult) parts.push(`${groups.Adult} Adult${groups.Adult === 1 ? '' : 's'}`);
  if (groups.Child) parts.push(`${groups.Child} ${groups.Child === 1 ? 'Child' : 'Children'}`);
  if (groups.Infant) parts.push(`${groups.Infant} Infant${groups.Infant === 1 ? '' : 's'}`);
  if (other) parts.push(`${other} other`);
  return parts.join(', ') || `${rows.length} traveller${rows.length === 1 ? '' : 's'}`;
}

/** Guest name and traveller count printed on the PDF, as they are at finalize time. */
async function snapshotFor(sdk, row, booking) {
  const reference = rules.isValidDate(str(row.start_date).slice(0, 10)) ? str(row.start_date).slice(0, 10) : rules.todayIso(undefined, await store.timeZoneOf(sdk));
  let guest = booking ? str(booking.guest_name) : '';
  let travellers = [];
  if (booking && Array.isArray(booking.traveller_ids) && booking.traveller_ids.length) {
    const ids = booking.traveller_ids.map(String).filter((id) => ID_RE.test(id)).slice(0, 200);
    travellers = ids.length ? await sdk.models.Traveller.find({ _id: { $in: ids } }, { limit: 200 }) : [];
  } else if (ID_RE.test(str(row.lead_id))) {
    travellers = await sdk.models.Traveller.find({ lead_id: row.lead_id }, { limit: 200 });
  }
  if (!guest && ID_RE.test(str(row.lead_id))) {
    try {
      const lead = await sdk.crm.leads.findById(row.lead_id);
      guest = str(lead && lead.name);
    } catch {
      guest = '';
    }
  }
  // Booking number and the trip's From / To are printed too (snapshots stored before the branded PDF have guest / travellers only).
  const trip = await tripFacts(sdk, row);
  const extra = {};
  if (booking && str(booking.number)) extra.booking_number = str(booking.number).slice(0, 40);
  if (trip.from) extra.from = trip.from;
  if (trip.to) extra.to = trip.to;
  return { guest: guest.slice(0, 120), travellers: travellers.length ? groupsText(travellers, reference) : '', ...extra };
}

function documentFor(row, status, snapshot) {
  return {
    ...Itin.toDocument({ ...row, status, days: Array.isArray(row.days) ? row.days : [], unscheduled: Array.isArray(row.unscheduled) ? row.unscheduled : [] }, snapshot),
    recordType: 'itinerary',
    recordId: row._id,
    name: referenceOf(row)
  };
}

exports.finalize = async (req, sdk) => {
  const row = await loadItinerary(sdk, store.idParam(req));
  if (row.status !== 'Draft') throw sdk.error(409, `This itinerary is already ${row.status}`, 'ITINERARY_NOT_DRAFT');
  const booking = await sdk.models.Booking.findOne({ quotation_id: row.quotation_id });
  const snapshot = await snapshotFor(sdk, row, booking);
  const file = await sdk.documents.pdf(documentFor(row, 'Final', snapshot));
  const updated = await sdk.models.Itinerary.updateById(row._id, {
    status: 'Final',
    file_id: file.id,
    finalized_at: store.nowIso(),
    snapshot,
    booking_id: booking ? booking._id : str(row.booking_id)
  });
  // The older Final of this quotation is superseded and redrawn from what it printed (its own snapshot).
  const older = await sdk.models.Itinerary.find({ quotation_id: row.quotation_id, status: 'Final' }, { limit: 50 });
  let superseded = 0;
  for (const old of older) {
    if (old._id === row._id) continue;
    await sdk.models.Itinerary.updateById(old._id, { status: 'Superseded' });
    superseded += 1;
    try {
      const redrawn = await sdk.documents.pdf(documentFor(old, 'Superseded', old.snapshot && typeof old.snapshot === 'object' ? old.snapshot : null));
      await sdk.models.Itinerary.updateById(old._id, { file_id: redrawn.id });
      if (old.file_id && old.file_id !== redrawn.id) await sdk.files.remove(old.file_id);
    } catch (error) {
      if (sdk.logger) sdk.logger.warn('itinerary redraw failed:', error && error.message);
    }
  }
  await sdk.audit('updated', `Itinerary ${referenceOf(row)} finalized`, { itineraryId: row._id, quotationId: row.quotation_id, superseded });
  await markItineraryProposed(sdk, row.quotation_id);
  return { itinerary: full(updated), superseded };
};

exports.getFile = async (req, sdk) => {
  const row = await loadItinerary(sdk, store.idParam(req));
  const file = row.file_id ? await sdk.files.read(row.file_id) : null;
  if (!file || file.recordType !== 'itinerary' || str(file.recordId) !== row._id) throw sdk.error(404, 'Finalize the itinerary to get its PDF', 'NOT_FOUND');
  await sdk.audit('viewed', `Itinerary PDF ${referenceOf(row)} opened`, { itineraryId: row._id, quotationId: row.quotation_id });
  return { dataUrl: file.dataUrl, name: `${referenceOf(row)}.pdf`, mimeType: file.mimeType, size: file.size };
};

exports._summary = summary;
