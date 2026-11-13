'use strict';

/**
 * Booking and booking-service statuses (spec §3.2 / §6.5).
 *
 * A booking's status follows its services: every active service Confirmed → Confirmed, some → Partially
 * Confirmed, none → Pending; all cancelled → Cancelled. Cancelled and Completed bookings keep their status.
 * Changing one service never changes another service's status.
 */

const BOOKING_STATUSES = ['Pending', 'Partially Confirmed', 'Confirmed', 'Cancelled', 'Completed'];
const SERVICE_STATUSES = ['Not Requested', 'Requested', 'Confirmed', 'Unavailable', 'Cancelled'];
const VOUCHER_STATUSES = ['Draft', 'Issued', 'Sent', 'Used', 'Cancelled', 'Superseded'];

/** Allowed service status changes (from → to). */
const SERVICE_MOVES = {
  'Not Requested': ['Requested', 'Confirmed', 'Unavailable', 'Cancelled'],
  Requested: ['Confirmed', 'Unavailable', 'Cancelled'],
  Confirmed: ['Requested', 'Unavailable', 'Cancelled', 'Confirmed'],
  Unavailable: ['Requested', 'Confirmed', 'Cancelled'],
  Cancelled: []
};

function rollup(currentStatus, services) {
  if (currentStatus === 'Cancelled' || currentStatus === 'Completed') return currentStatus;
  const active = (services || []).filter((s) => s && s.status !== 'Cancelled');
  if (!active.length) return 'Cancelled';
  if (active.every((s) => s.status === 'Confirmed')) return 'Confirmed';
  if (active.some((s) => s.status === 'Confirmed')) return 'Partially Confirmed';
  return 'Pending';
}

function canMove(from, to) {
  return (SERVICE_MOVES[from] || []).includes(to);
}

module.exports = { rollup, canMove, BOOKING_STATUSES, SERVICE_STATUSES, VOUCHER_STATUSES };
