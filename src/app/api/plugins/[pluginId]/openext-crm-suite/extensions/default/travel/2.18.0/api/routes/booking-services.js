'use strict';

/**
 * Booking services: Request, Confirm Service (spec §6.6), Cancel, provider documents.
 *
 * POST /booking-services/:id/request            Not Requested / Unavailable / Confirmed → Requested
 * POST /booking-services/:id/confirm            the Confirm Service dialog (Requested / Confirmed / Unavailable / Cancelled)
 * POST /booking-services/:id/cancel             reason required
 * PUT  /booking-services/:id/documents          { add: { data, name } } | { remove: fileId }  (provider tickets etc.)
 * GET  /booking-services/:id/files/:file_id     an evidence file or provider document of this service
 *
 * Every change writes a history row (ServiceConfirmation) and rolls the booking status up. Changing one
 * service never changes another. A service leaving Confirmed cancels its live vouchers ("Service no longer
 * confirmed"); re-confirming with changed details marks them outdated (the UI offers "Reissue").
 * Closed bookings (Cancelled / Completed) refuse every change — checked again right before writing.
 */

const store = require('../services/booking-store.js');
const voucherDoc = require('../services/voucher-doc.js');
const { canMove } = require('../services/booking-status.js');

const { str } = store;
const CONFIRM_STATUSES = ['Requested', 'Confirmed', 'Unavailable', 'Cancelled'];
const EVIDENCE_RULES = ['reference_or_file', 'reference', 'file', 'none'];
const MAX_DOCUMENTS = 10;

function moveError(sdk, from, to) {
  if (from === to) return sdk.error(409, `This service is already ${from}`, 'INVALID_STATUS');
  return sdk.error(409, `A ${from} service cannot become ${to}`, 'INVALID_STATUS');
}

function cleanUpload(sdk, raw, what) {
  if (raw === undefined || raw === null || raw === '') return null;
  const src = typeof raw === 'string' ? { data: raw } : raw && typeof raw === 'object' ? raw : null;
  if (!src || typeof src.data !== 'string' || !src.data) throw sdk.error(400, `${what} must be a PDF, JPG, PNG or WEBP file`, 'INVALID_FILE');
  return { data: src.data, name: str(src.name).slice(0, 120) || `${what.toLowerCase().replace(/\s+/g, '-')}` };
}

/** Re-reads booking and service right before a write; refuses if the booking closed meanwhile. */
async function fresh(sdk, bookingId, serviceId) {
  const [booking, service] = await Promise.all([sdk.models.Booking.findById(bookingId), sdk.models.BookingService.findById(serviceId)]);
  if (!booking || !service) throw sdk.error(404, 'Booking service not found', 'NOT_FOUND');
  store.assertOpen(sdk, booking);
  return { booking, service };
}

async function respond(sdk, service, bookingId) {
  const status = await store.rollupBooking(sdk, bookingId);
  return { service: store.presentService(service, { finance: store.permissionsOf(sdk).finance }), booking: { id: bookingId, status } };
}

/* -------------------------------------------------------------- request */

exports.request = async (req, sdk) => {
  const first = await store.loadService(sdk, store.idParam(req));
  const firstBooking = await store.loadBooking(sdk, first.booking_id);
  store.assertOpen(sdk, firstBooking);
  if (!canMove(first.status, 'Requested')) throw moveError(sdk, first.status, 'Requested');
  const notes = str(req.body && req.body.notes);
  if (notes.length > 2000) throw sdk.error(400, 'Notes must be 2000 characters or fewer', 'INVALID_INPUT');
  // Re-read right before writing: the booking may have closed or the service moved meanwhile.
  const { booking, service } = await fresh(sdk, firstBooking._id, first._id);
  if (!canMove(service.status, 'Requested')) throw moveError(sdk, service.status, 'Requested');
  const updated = await sdk.models.BookingService.updateById(service._id, { status: 'Requested', requested_at: store.nowIso() });
  await store.addHistory(sdk, updated, { action: 'request', status: 'Requested', provider: str(updated.provider), notes });
  if (service.status === 'Confirmed') await voucherDoc.cancelLiveVouchers(sdk, service._id, 'Service no longer confirmed');
  await sdk.audit('updated', `booking_service.requested — booking ${booking.number}`, { bookingId: booking._id, serviceId: service._id });
  return respond(sdk, updated, booking._id);
};

/* -------------------------------------------------------------- confirm */

exports.confirm = async (req, sdk) => {
  const serviceId = store.idParam(req);
  const first = await store.loadService(sdk, serviceId);
  const firstBooking = await store.loadBooking(sdk, first.booking_id);
  store.assertOpen(sdk, firstBooking);
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const status = str(body.status);
  if (!CONFIRM_STATUSES.includes(status)) throw sdk.error(400, `Status must be one of ${CONFIRM_STATUSES.join(', ')}`, 'INVALID_INPUT');
  if (!canMove(first.status, status)) throw moveError(sdk, first.status, status);
  const provider = str(body.provider) || str(first.provider);
  if (provider.length > 120) throw sdk.error(400, 'Provider must be 120 characters or fewer', 'INVALID_INPUT');
  const ref = str(body.confirmation_ref);
  if (ref.length > 80) throw sdk.error(400, 'Confirmation reference must be 80 characters or fewer', 'INVALID_INPUT');
  const finalDetails = str(body.final_details);
  if (finalDetails.length > 2000) throw sdk.error(400, 'Final confirmed details must be 2000 characters or fewer', 'INVALID_INPUT');
  const notes = str(body.notes);
  if (notes.length > 2000) throw sdk.error(400, 'Notes must be 2000 characters or fewer', 'INVALID_INPUT');
  let confirmedAt = '';
  if (status === 'Confirmed') {
    const raw = str(body.confirmed_at);
    const t = raw ? Date.parse(raw) : Date.now();
    if (Number.isNaN(t)) throw sdk.error(400, 'Confirmed at must be a date and time', 'INVALID_INPUT');
    if (t > Date.now() + 5 * 60 * 1000) throw sdk.error(400, 'Confirmed at cannot be in the future', 'INVALID_INPUT');
    confirmedAt = new Date(t).toISOString();
  }
  const upload = cleanUpload(sdk, body.evidence, 'Evidence file');

  // Evidence rule (Settings → Travel → Bookings & vouchers).
  const ruleSetting = str(await sdk.settings.get('confirmation_evidence'));
  const rule = EVIDENCE_RULES.includes(ruleSetting) ? ruleSetting : 'reference_or_file';
  const hasFile = Boolean(upload) || (first.status === 'Confirmed' && Boolean(first.evidence_file_id));
  if (status === 'Confirmed') {
    if (rule === 'reference_or_file' && !ref && !hasFile) {
      throw sdk.error(400, 'Add the provider’s confirmation reference or an evidence file', 'EVIDENCE_REQUIRED');
    }
    if (rule === 'reference' && !ref) throw sdk.error(400, 'Add the provider’s confirmation reference', 'EVIDENCE_REQUIRED');
    if (rule === 'file' && !hasFile) throw sdk.error(400, 'Attach an evidence file (the provider’s confirmation)', 'EVIDENCE_REQUIRED');
  }
  if ((status === 'Unavailable' || status === 'Cancelled') && !notes) {
    throw sdk.error(400, `Add a note: why is the service ${status.toLowerCase()}?`, 'NOTES_REQUIRED');
  }

  let evidenceId = '';
  if (upload) {
    const saved = await sdk.files.save({ data: upload.data, name: upload.name, recordType: 'booking_service', recordId: first._id });
    evidenceId = saved.id;
  }

  // Re-read right before writing: the booking may have been cancelled / completed, or the service changed.
  let current;
  try {
    current = await fresh(sdk, firstBooking._id, serviceId);
    if (!canMove(current.service.status, status)) throw moveError(sdk, current.service.status, status);
  } catch (error) {
    if (evidenceId) await sdk.files.remove(evidenceId);
    throw error;
  }
  const { booking, service: before } = current;

  const patch = { status, provider };
  if (status === 'Confirmed') {
    patch.confirmation_ref = ref;
    patch.confirmed_at = confirmedAt;
    patch.final_details = finalDetails;
    if (evidenceId) patch.evidence_file_id = evidenceId;
    else if (before.status !== 'Confirmed') patch.evidence_file_id = '';
  }
  if (status === 'Requested' && !before.requested_at) patch.requested_at = store.nowIso();
  if (status === 'Cancelled') patch.cancel_reason = notes;
  const updated = await sdk.models.BookingService.updateById(before._id, patch);
  await store.addHistory(sdk, updated, {
    action: 'confirm',
    status,
    provider,
    confirmation_ref: status === 'Confirmed' ? ref : '',
    confirmed_at: confirmedAt,
    final_details: status === 'Confirmed' ? finalDetails : '',
    evidence_file_id: evidenceId,
    notes
  });

  let vouchers = { cancelled: 0, outdated: 0 };
  if (before.status === 'Confirmed' && status !== 'Confirmed') {
    vouchers.cancelled = await voucherDoc.cancelLiveVouchers(sdk, before._id, 'Service no longer confirmed');
  } else if (before.status === 'Confirmed' && status === 'Confirmed') {
    const changed =
      str(before.confirmation_ref) !== ref ||
      str(before.final_details) !== finalDetails ||
      str(before.provider) !== provider ||
      Boolean(evidenceId) ||
      str(before.confirmed_at).slice(0, 16) !== confirmedAt.slice(0, 16);
    if (changed) {
      const live = await sdk.models.Voucher.find({ booking_service_id: before._id, status: { $in: ['Issued', 'Sent'] } }, { limit: 100 });
      for (const v of live) if (v.outdated !== true) await sdk.models.Voucher.updateById(v._id, { outdated: true });
      vouchers.outdated = live.length;
    }
  }
  await sdk.audit('updated', `booking_service.${status.toLowerCase().replace(/\s+/g, '_')} — booking ${booking.number}`, {
    bookingId: booking._id,
    serviceId: before._id,
    status,
    evidence: Boolean(evidenceId)
  });
  return { ...(await respond(sdk, updated, booking._id)), vouchers };
};

/* --------------------------------------------------------------- cancel */

exports.cancel = async (req, sdk) => {
  const first = await store.loadService(sdk, store.idParam(req));
  const firstBooking = await store.loadBooking(sdk, first.booking_id);
  store.assertOpen(sdk, firstBooking);
  const reason = str(req.body && req.body.reason);
  if (!reason) throw sdk.error(400, 'A reason is required to cancel this service', 'REASON_REQUIRED');
  if (reason.length > 1000) throw sdk.error(400, 'The reason must be 1000 characters or fewer', 'INVALID_INPUT');
  if (!canMove(first.status, 'Cancelled')) throw moveError(sdk, first.status, 'Cancelled');
  // Re-read right before writing: the booking may have closed or the service moved meanwhile.
  const { booking, service } = await fresh(sdk, firstBooking._id, first._id);
  if (!canMove(service.status, 'Cancelled')) throw moveError(sdk, service.status, 'Cancelled');
  const updated = await sdk.models.BookingService.updateById(service._id, { status: 'Cancelled', cancel_reason: reason });
  await store.addHistory(sdk, updated, { action: 'cancel', status: 'Cancelled', provider: str(updated.provider), notes: reason });
  const cancelled = await voucherDoc.cancelLiveVouchers(sdk, service._id, 'Service no longer confirmed');
  await sdk.audit('updated', `booking_service.cancelled — booking ${booking.number}`, { bookingId: booking._id, serviceId: service._id, vouchers: cancelled });
  return respond(sdk, updated, booking._id);
};

/* ------------------------------------------------------------ documents */

exports.putDocuments = async (req, sdk) => {
  const service = await store.loadService(sdk, store.idParam(req));
  const booking = await store.loadBooking(sdk, service.booking_id);
  store.assertOpen(sdk, booking);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const user = sdk.user || {};
  if (body.add) {
    const upload = cleanUpload(sdk, body.add, 'Document');
    const active = (Array.isArray(service.documents) ? service.documents : []).filter((d) => d && !d.removed);
    if (active.length >= MAX_DOCUMENTS) throw sdk.error(400, `At most ${MAX_DOCUMENTS} documents per service`, 'TOO_MANY_FILES');
    const saved = await sdk.files.save({ data: upload.data, name: upload.name, recordType: 'booking_service', recordId: service._id });
    let current;
    try {
      current = (await fresh(sdk, booking._id, service._id)).service;
    } catch (error) {
      await sdk.files.remove(saved.id);
      throw error;
    }
    const documents = [
      ...(Array.isArray(current.documents) ? current.documents : []),
      { id: saved.id, name: saved.name, mimeType: saved.mimeType, size: saved.size, added_at: store.nowIso(), added_by: str(user.name || user.email).slice(0, 120) }
    ];
    const updated = await sdk.models.BookingService.updateById(service._id, { documents });
    await store.addHistory(sdk, updated, { action: 'document_added', status: str(updated.status), notes: `Document added: ${saved.name}` });
    await sdk.audit('updated', `Provider document added — booking ${booking.number}`, { bookingId: booking._id, serviceId: service._id, fileId: saved.id });
    return { service: store.presentService(updated, { finance: store.permissionsOf(sdk).finance }) };
  }
  if (body.remove) {
    const fileId = str(body.remove);
    const { service: current } = await fresh(sdk, booking._id, service._id);
    const list = Array.isArray(current.documents) ? current.documents : [];
    const doc = list.find((d) => d && str(d.id) === fileId && !d.removed);
    if (!doc) throw sdk.error(404, 'Document not found on this service', 'NOT_FOUND');
    // Soft removal: the file is kept and the removal is recorded in the history.
    const documents = list.map((d) => (d === doc ? { ...d, removed: true, removed_at: store.nowIso(), removed_by: str(user.name || user.email).slice(0, 120) } : d));
    const updated = await sdk.models.BookingService.updateById(service._id, { documents });
    await store.addHistory(sdk, updated, { action: 'document_removed', status: str(updated.status), notes: `Document removed: ${str(doc.name)}` });
    await sdk.audit('updated', `Provider document removed — booking ${booking.number}`, { bookingId: booking._id, serviceId: service._id, fileId });
    return { service: store.presentService(updated, { finance: store.permissionsOf(sdk).finance }) };
  }
  throw sdk.error(400, 'Send { add: { data, name } } or { remove: fileId }', 'INVALID_INPUT');
};

exports.getFile = async (req, sdk) => {
  const service = await store.loadService(sdk, store.idParam(req));
  const fileId = store.idParam(req, 'file_id');
  if (!store.ID_RE.test(fileId)) throw sdk.error(404, 'File not found', 'NOT_FOUND');
  const docs = Array.isArray(service.documents) ? service.documents : [];
  let listed = str(service.evidence_file_id) === fileId || docs.some((d) => d && str(d.id) === fileId && !d.removed);
  if (!listed) listed = Boolean(await sdk.models.ServiceConfirmation.findOne({ booking_service_id: service._id, evidence_file_id: fileId }));
  if (!listed) throw sdk.error(404, 'This file does not belong to this service', 'NOT_FOUND');
  const file = await sdk.files.read(fileId);
  if (!file || file.recordType !== 'booking_service' || str(file.recordId) !== service._id) {
    throw sdk.error(404, 'This file does not belong to this service', 'NOT_FOUND');
  }
  await sdk.audit('viewed', `Booking service file opened (booking ${service.booking_id})`, { serviceId: service._id, fileId });
  return { dataUrl: file.dataUrl, name: file.name, mimeType: file.mimeType, size: file.size };
};
