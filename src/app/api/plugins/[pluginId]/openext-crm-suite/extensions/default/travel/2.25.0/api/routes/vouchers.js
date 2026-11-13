'use strict';

/**
 * Vouchers (spec §6.7): issued for a Confirmed hotel / transport / excursion service once the quotation is
 * paid in full (CRM verified payments; setting voucher_requires_full_payment), drawn by the CRM
 * (sdk.documents.pdf) and kept as a private file. Never edited: a change means a new version
 * (same number, "HTV-0001 v2"); the older live version becomes Superseded and is redrawn with a watermark.
 *
 * POST /booking-services/:id/vouchers   issue / reissue
 * GET  /vouchers/:id/file               the PDF (data URL)
 * POST /vouchers/:id/sent               { channel, to }   Issued → Sent
 * POST /vouchers/:id/used               Issued / Sent → Used
 * POST /vouchers/:id/cancel             { reason }        → Cancelled, redrawn "CANCELLED"
 *
 * Concurrency: every voucher row carries service_version "<serviceId>:<version>" (unique), claimed
 * before the number and the PDF — a second issue at the same moment gets 409 VOUCHER_BUSY.
 */

const store = require('../services/booking-store.js');
const voucherDoc = require('../services/voucher-doc.js');

const { str } = store;
const CHANNELS = ['WhatsApp', 'Email', 'Printed', 'In person', 'Other'];
const STALE_DRAFT_MS = 2 * 60 * 1000;

exports.issue = async (req, sdk) => {
  const service = await store.loadService(sdk, store.idParam(req));
  const booking = await store.loadBooking(sdk, service.booking_id);
  store.assertOpen(sdk, booking);
  if (!store.ISSUABLE_TYPES.includes(service.voucher_type)) {
    throw sdk.error(400, `${service.name} has no voucher (${service.voucher_type === 'ticket' ? 'tickets come from the provider — upload them on the service' : 'voucher type: none'})`, 'VOUCHER_NOT_AVAILABLE');
  }
  if (service.status !== 'Confirmed') throw sdk.error(400, 'Confirm the service before issuing a voucher', 'SERVICE_NOT_CONFIRMED');
  // Confirmed service AND the full payment verified by the CRM (setting voucher_requires_full_payment).
  if ((await sdk.settings.get('voucher_requires_full_payment')) !== false && !(await store.paymentGate(sdk, booking.quotation_id)).fullyPaid) {
    throw sdk.error(409, 'Vouchers are issued once the full payment of the quotation is verified', 'PAYMENT_REQUIRED');
  }

  const existing = await sdk.models.Voucher.find({ booking_service_id: service._id }, { limit: 200, sort: { version: -1 } });
  const now = Date.now();
  for (const d of existing.filter((v) => v.status === 'Draft')) {
    if (now - Date.parse(d.createdAt || 0) < STALE_DRAFT_MS) {
      throw sdk.error(409, 'A voucher for this service is being issued right now — reload the booking in a moment', 'VOUCHER_BUSY');
    }
    await sdk.models.Voucher.deleteById(d._id); // left over from a failed attempt
  }
  const version = existing.reduce((max, v) => Math.max(max, Number(v.version) || 0), 0) + 1;
  const reuse = existing.find((v) => str(v.number));
  const type = service.voucher_type;

  // Claim "<service>:<version>" first (unique): a second issue at the same moment stops here.
  let draft;
  try {
    draft = await sdk.models.Voucher.create({
      booking_id: booking._id,
      booking_service_id: service._id,
      service_version: `${service._id}:${version}`,
      type,
      version,
      status: 'Draft',
      number: reuse ? reuse.number : '',
      outdated: false
    });
  } catch (error) {
    if (error && (error.status === 409 || error.code === 'DUPLICATE')) {
      throw sdk.error(409, 'Another voucher for this service was issued at the same moment — reload the booking to see it', 'VOUCHER_BUSY');
    }
    throw error;
  }

  let voucher;
  let file = null;
  try {
    const [prefix, terms, timeZone, services, travellers] = await Promise.all([
      sdk.settings.get(`voucher_prefix_${type}`),
      sdk.settings.get(`voucher_terms_${type}`),
      store.timeZoneOf(sdk),
      store.readServicesFull(sdk),
      (async () => {
        const ids = (Array.isArray(booking.traveller_ids) ? booking.traveller_ids : []).map(String).filter((id) => store.ID_RE.test(id)).slice(0, 200);
        if (!ids.length) return [];
        const rows = await sdk.models.Traveller.find({ _id: { $in: ids } }, { limit: 200 });
        const byId = new Map(rows.map((r) => [str(r._id), r]));
        return ids.map((id) => byId.get(id)).filter(Boolean);
      })()
    ]);
    const number = reuse ? reuse.number : voucherDoc.voucherNumber(voucherDoc.prefixFor(type, prefix), await sdk.sequence.next(`voucher_${type}`));
    const user = sdk.user || {};
    const snapshot = voucherDoc.buildSnapshot({
      booking,
      service,
      travellers,
      currentService: services.find((s) => s.key === service.service_key) || null,
      number,
      version,
      terms,
      user: str(user.name || user.email),
      timeZone
    });
    file = await sdk.documents.pdf(voucherDoc.toDocument(snapshot, { recordId: draft._id }));
    // Drawing takes a while: the booking may have closed, the service left Confirmed, or the claimed
    // draft been cancelled / cleaned up meanwhile — then nothing is issued (409).
    const [nowBooking, nowService, nowDraft] = await Promise.all([
      sdk.models.Booking.findById(booking._id),
      sdk.models.BookingService.findById(service._id),
      sdk.models.Voucher.findById(draft._id)
    ]);
    if (!nowBooking || !store.isOpen(nowBooking)) {
      throw sdk.error(409, `Booking ${booking.number} was ${nowBooking ? str(nowBooking.status).toLowerCase() : 'removed'} while the voucher was drawn — no voucher was issued`, 'BOOKING_CLOSED');
    }
    if (!nowService || nowService.status !== 'Confirmed') {
      throw sdk.error(409, `${service.name} is no longer Confirmed — no voucher was issued`, 'SERVICE_NOT_CONFIRMED');
    }
    if (!nowDraft || nowDraft.status !== 'Draft') {
      throw sdk.error(409, 'This voucher was cancelled while it was drawn — reload the booking', 'VOUCHER_BUSY');
    }
    voucher = await sdk.models.Voucher.updateById(draft._id, {
      number,
      status: 'Issued',
      file_id: file.id,
      issued_at: store.nowIso(),
      issued_by: str(user.name || user.email).slice(0, 120),
      snapshot
    });
  } catch (error) {
    await sdk.models.Voucher.deleteById(draft._id);
    if (file && file.id) {
      try {
        await sdk.files.remove(file.id);
      } catch {
        /* an unreferenced private file is harmless */
      }
    }
    throw error;
  }

  let superseded = 0;
  for (const old of existing.filter((v) => v.status === 'Issued' || v.status === 'Sent')) {
    await voucherDoc.redraw(sdk, old, 'SUPERSEDED', { status: 'Superseded', superseded_by: voucher._id });
    superseded += 1;
  }
  await sdk.audit('created', `Voucher ${voucher.number} v${version} issued — booking ${booking.number}`, {
    bookingId: booking._id,
    serviceId: service._id,
    voucherId: voucher._id,
    version,
    superseded
  });
  return { voucher: store.presentVoucher(voucher), superseded };
};

exports.getFile = async (req, sdk) => {
  const voucher = await store.loadVoucher(sdk, store.idParam(req));
  const file = voucher.file_id ? await sdk.files.read(voucher.file_id) : null;
  if (!file || file.recordType !== 'voucher' || str(file.recordId) !== voucher._id) throw sdk.error(404, 'The voucher PDF is not available', 'NOT_FOUND');
  await sdk.audit('viewed', `Voucher ${voucher.number} v${voucher.version} PDF opened`, { voucherId: voucher._id, bookingId: voucher.booking_id });
  return { dataUrl: file.dataUrl, name: `${voucher.number}-v${voucher.version}.pdf`, mimeType: file.mimeType, size: file.size };
};

async function loadWithBooking(req, sdk) {
  const voucher = await store.loadVoucher(sdk, store.idParam(req));
  const booking = await store.loadBooking(sdk, voucher.booking_id);
  if (booking.status === 'Cancelled') throw sdk.error(409, `Booking ${booking.number} is cancelled`, 'BOOKING_CLOSED');
  return { voucher, booking };
}

exports.sent = async (req, sdk) => {
  const { voucher, booking } = await loadWithBooking(req, sdk);
  if (voucher.status !== 'Issued' && voucher.status !== 'Sent') throw sdk.error(409, `A ${voucher.status} voucher cannot be marked sent`, 'INVALID_STATUS');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const channel = str(body.channel) || 'Other';
  if (!CHANNELS.includes(channel)) throw sdk.error(400, `Channel must be one of ${CHANNELS.join(', ')}`, 'INVALID_INPUT');
  const to = str(body.to);
  if (to.length > 120) throw sdk.error(400, '"Sent to" must be 120 characters or fewer', 'INVALID_INPUT');
  const updated = await sdk.models.Voucher.updateById(voucher._id, { status: 'Sent', sent_at: store.nowIso(), sent_channel: channel, sent_to: to });
  await sdk.audit('sent', `Voucher ${voucher.number} v${voucher.version} sent (${channel}) — booking ${booking.number}`, { voucherId: voucher._id, bookingId: booking._id, channel });
  return { voucher: store.presentVoucher(updated) };
};

exports.used = async (req, sdk) => {
  const { voucher, booking } = await loadWithBooking(req, sdk);
  if (voucher.status !== 'Issued' && voucher.status !== 'Sent') throw sdk.error(409, `A ${voucher.status} voucher cannot be marked used`, 'INVALID_STATUS');
  const updated = await sdk.models.Voucher.updateById(voucher._id, { status: 'Used', used_at: store.nowIso() });
  await sdk.audit('updated', `Voucher ${voucher.number} v${voucher.version} used — booking ${booking.number}`, { voucherId: voucher._id, bookingId: booking._id });
  return { voucher: store.presentVoucher(updated) };
};

exports.cancel = async (req, sdk) => {
  const voucher = await store.loadVoucher(sdk, store.idParam(req));
  if (!store.LIVE_VOUCHER.includes(voucher.status)) throw sdk.error(409, `A ${voucher.status} voucher cannot be cancelled`, 'INVALID_STATUS');
  const reason = str(req.body && req.body.reason);
  if (!reason) throw sdk.error(400, 'A reason is required to cancel the voucher', 'REASON_REQUIRED');
  if (reason.length > 500) throw sdk.error(400, 'The reason must be 500 characters or fewer', 'INVALID_INPUT');
  const updated = await voucherDoc.redraw(sdk, voucher, 'CANCELLED', { status: 'Cancelled', cancel_reason: reason });
  await sdk.audit('updated', `Voucher ${voucher.number} v${voucher.version} cancelled`, { voucherId: voucher._id, bookingId: voucher.booking_id });
  return { voucher: store.presentVoucher(updated) };
};

exports.CHANNELS = CHANNELS;
