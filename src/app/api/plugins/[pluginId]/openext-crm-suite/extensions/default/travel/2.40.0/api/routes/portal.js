'use strict';

/**
 * Client portal — Bookings (client logins only).
 *
 *   GET /portal/bookings                               the client's own bookings with their payment status
 *   GET /portal/bookings/:id                           one booking: services, vouchers, tickets / documents
 *   GET /portal/vouchers/:id/file                      voucher PDF            — only when paid in full
 *   GET /portal/booking-services/:id/files/:file_id    ticket / confirmation  — only when paid in full
 *
 * Ownership: the booking's lead must be one of the login's own leads (sdk.access.portal()).
 * Payment: read from the CRM's verified payment records (sdk.finance.quotationPayment) — never from
 * the request. A download needs: the quotation paid in full, its tax invoice Paid, the booking not
 * cancelled, and the voucher / file belonging to that booking and still valid (not cancelled,
 * superseded or outdated). Client views never carry prices, supplier details or internal notes.
 */

const store = require('../services/booking-store.js');

const { str, ID_RE } = store;
const PAYMENT_REQUIRED = 'Complete the remaining payment to download tickets and vouchers.';
const DOWNLOADABLE_VOUCHER = ['Issued', 'Sent', 'Used'];
const TICKET_SERVICE = /(air|flight|train|rail|bus|cruise|ferry|ticket)/i;

/** The client-portal login, or a 403 for staff (they use the Bookings page). */
async function portalLogin(sdk) {
  const portal = sdk.access && typeof sdk.access.portal === 'function' ? await sdk.access.portal() : null;
  if (!portal) throw sdk.error(403, 'This page is for client portal logins', 'PORTAL_ONLY');
  return portal;
}

/**
 * 2.28.0: a booking belongs to this login when it is on one of its leads, or it is a client trip (no lead)
 * of its client — the same for every portal contact of the client.
 */
function ownsBooking(portal, booking) {
  if (!booking) return false;
  const leadId = str(booking.lead_id);
  if (leadId) return portal.leadIds.includes(leadId);
  return Boolean(portal.clientId) && str(booking.client_id) === str(portal.clientId);
}

/** The booking, if it is this login's; otherwise "not found". */
async function ownBooking(sdk, portal, bookingId) {
  const id = str(bookingId);
  const booking = ID_RE.test(id) ? await sdk.models.Booking.findById(id) : null;
  if (!ownsBooking(portal, booking)) throw sdk.error(404, 'Booking not found', 'NOT_FOUND');
  return booking;
}

/** Payment of the booking's quotation and whether its documents may be downloaded. */
async function downloadGate(sdk, booking) {
  const payment = booking.quotation_id ? await sdk.finance.quotationPayment(str(booking.quotation_id)) : null;
  const paidInFull = Boolean(
    payment &&
      payment.status === 'Paid' &&
      Number(payment.balance) <= 0.05 &&
      payment.invoiceId &&
      payment.invoiceStatus === 'Paid'
  );
  const cancelled = str(booking.status) === 'Cancelled';
  return {
    payment: payment
      ? { status: payment.status, total: payment.total, paid: payment.paid, balance: payment.balance, currency: payment.currency }
      : { status: 'Unpaid', total: Number(booking.total) || 0, paid: 0, balance: Number(booking.total) || 0, currency: str(booking.currency) || 'INR' },
    allowed: paidInFull && !cancelled,
    reason: cancelled ? 'This booking is cancelled.' : paidInFull ? '' : PAYMENT_REQUIRED
  };
}

async function assertDownloadAllowed(sdk, booking) {
  const gate = await downloadGate(sdk, booking);
  if (!gate.allowed) {
    throw sdk.error(403, gate.reason || PAYMENT_REQUIRED, str(booking.status) === 'Cancelled' ? 'BOOKING_CANCELLED' : 'PAYMENT_REQUIRED');
  }
  return gate;
}

async function travellerNames(sdk, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(str).filter((id) => ID_RE.test(id)).slice(0, 50);
  if (!list.length) return [];
  const rows = await sdk.models.Traveller.find({ _id: { $in: list } }, { limit: 50 });
  return rows.map((t) => `${str(t.first_name)} ${str(t.last_name)}`.trim()).filter(Boolean);
}

function bookingSummary(booking, travellers, gate) {
  return {
    id: booking._id,
    number: str(booking.number),
    destination: str(booking.destination),
    title: str(booking.title),
    travel_start_date: str(booking.travel_start_date).slice(0, 10),
    travel_end_date: str(booking.travel_end_date).slice(0, 10),
    dates: store.dateRange(booking.travel_start_date, booking.travel_end_date),
    travellers,
    status: str(booking.status),
    quotation_no: str(booking.quotation_no),
    payment: gate.payment,
    downloads_allowed: gate.allowed,
    downloads_note: gate.reason
  };
}

exports.list = async (req, sdk) => {
  const portal = await portalLogin(sdk);
  // 2.28.0: the bookings of its leads and of its client's trips (no lead).
  const or = [];
  if (portal.leadIds.length) or.push({ lead_id: { $in: portal.leadIds } });
  if (portal.clientId) or.push({ client_id: str(portal.clientId) });
  if (!or.length) return { items: [] };
  const rows = await sdk.models.Booking.find({ $or: or }, { limit: 100, sort: { createdAt: -1 } });
  const items = [];
  for (const booking of rows) {
    const [travellers, gate] = await Promise.all([travellerNames(sdk, booking.traveller_ids), downloadGate(sdk, booking)]);
    items.push(bookingSummary(booking, travellers, gate));
  }
  return { items };
};

exports.get = async (req, sdk) => {
  const portal = await portalLogin(sdk);
  const booking = await ownBooking(sdk, portal, store.idParam(req));
  const [travellers, gate] = await Promise.all([travellerNames(sdk, booking.traveller_ids), downloadGate(sdk, booking)]);
  const services = await sdk.models.BookingService.find({ booking_id: booking._id }, { limit: 200, sort: { line_index: 1 } });
  const vouchers = await sdk.models.Voucher.find({ booking_id: booking._id }, { limit: 200, sort: { createdAt: -1 } });
  const liveVouchers = vouchers.filter((v) => DOWNLOADABLE_VOUCHER.includes(str(v.status)) && !v.outdated && !v.superseded_by);

  return {
    booking: {
      ...bookingSummary(booking, travellers, gate),
      services: services.map((s) => {
        const confirmed = str(s.status) === 'Confirmed';
        const isTicket = TICKET_SERVICE.test(str(s.service_key)) || TICKET_SERVICE.test(str(s.name));
        return {
          id: s._id,
          name: str(s.name),
          start_date: str(s.start_date).slice(0, 10),
          end_date: str(s.end_date).slice(0, 10),
          dates: store.dateRange(s.start_date, s.end_date),
          status: str(s.status),
          // A ticket or booking reference is part of the document: shown only once it can be downloaded.
          reference: confirmed && gate.allowed ? str(s.confirmation_ref) : '',
          documents:
            str(s.status) === 'Cancelled'
              ? []
              : store.presentDocuments(s.documents).map((d) => ({
                  id: d.id,
                  name: d.name,
                  kind: isTicket ? 'ticket' : 'confirmation',
                  downloadable: gate.allowed
                }))
        };
      }),
      vouchers: liveVouchers.map((v) => ({
        id: v._id,
        number: str(v.number),
        type: str(v.type),
        version: Number(v.version) || 1,
        status: str(v.status),
        service_id: str(v.booking_service_id),
        downloadable: gate.allowed && Boolean(v.file_id)
      }))
    }
  };
};

exports.voucherFile = async (req, sdk) => {
  const portal = await portalLogin(sdk);
  const id = store.idParam(req);
  const voucher = ID_RE.test(id) ? await sdk.models.Voucher.findById(id) : null;
  if (!voucher) throw sdk.error(404, 'Voucher not found', 'NOT_FOUND');
  const booking = await ownBooking(sdk, portal, voucher.booking_id);
  await assertDownloadAllowed(sdk, booking);
  if (!DOWNLOADABLE_VOUCHER.includes(str(voucher.status)) || voucher.outdated || voucher.superseded_by) {
    throw sdk.error(409, `This voucher is ${str(voucher.status).toLowerCase() || 'not valid'} and cannot be downloaded`, 'VOUCHER_NOT_VALID');
  }
  const service = voucher.booking_service_id ? await sdk.models.BookingService.findById(str(voucher.booking_service_id)) : null;
  if (!service || str(service.booking_id) !== str(booking._id) || str(service.status) === 'Cancelled') {
    throw sdk.error(409, 'This voucher is no longer valid', 'VOUCHER_NOT_VALID');
  }
  const file = voucher.file_id ? await sdk.files.read(str(voucher.file_id)) : null;
  if (!file || file.recordType !== 'voucher' || str(file.recordId) !== str(voucher._id)) {
    throw sdk.error(404, 'The voucher PDF is not available', 'NOT_FOUND');
  }
  await sdk.audit('viewed', `Voucher ${voucher.number} downloaded in the client portal`, { voucherId: voucher._id, bookingId: booking._id });
  return { dataUrl: file.dataUrl, name: `${voucher.number}-v${voucher.version}.pdf`, mimeType: file.mimeType, size: file.size };
};

exports.serviceFile = async (req, sdk) => {
  const portal = await portalLogin(sdk);
  const id = store.idParam(req);
  const service = ID_RE.test(id) ? await sdk.models.BookingService.findById(id) : null;
  if (!service) throw sdk.error(404, 'File not found', 'NOT_FOUND');
  const booking = await ownBooking(sdk, portal, service.booking_id);
  await assertDownloadAllowed(sdk, booking);
  if (str(service.status) === 'Cancelled') throw sdk.error(409, 'This service is cancelled', 'SERVICE_CANCELLED');
  const fileId = store.idParam(req, 'file_id');
  // Only the provider documents (tickets, confirmations) — never the agency's own evidence files.
  const listed = ID_RE.test(fileId) && store.presentDocuments(service.documents).some((d) => d.id === fileId);
  if (!listed) throw sdk.error(404, 'File not found', 'NOT_FOUND');
  const file = await sdk.files.read(fileId);
  if (!file || file.recordType !== 'booking_service' || str(file.recordId) !== str(service._id)) {
    throw sdk.error(404, 'File not found', 'NOT_FOUND');
  }
  await sdk.audit('viewed', `Booking document downloaded in the client portal (booking ${booking.number})`, { serviceId: service._id, fileId });
  return { dataUrl: file.dataUrl, name: file.name, mimeType: file.mimeType, size: file.size };
};

exports.PAYMENT_REQUIRED = PAYMENT_REQUIRED;
