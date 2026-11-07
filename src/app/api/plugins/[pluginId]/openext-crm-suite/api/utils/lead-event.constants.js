'use strict';

/**
 * Lead activity constants.
 *
 * Kept separate from `models/LeadEvent.js` so services (and tests) can read the
 * allowed values without pulling in mongoose.
 */

/**
 * Seed activity types. Tenants add their own in Settings → Leads & Funnels, so
 * this is the default list rather than a closed set — `eventType` is
 * deliberately not a schema enum.
 */
const EVENT_TYPES = ['Call', 'Meeting', 'Follow up', 'WhatsApp', 'Other'];

const EVENT_STATUSES = ['Open', 'Assigned', 'Accepted', 'Completed'];

/** "logged" = already done when recorded; "scheduled" = booked, completed later. */
const EVENT_KINDS = ['logged', 'scheduled'];

/** Where the row came from, so the UI can offer the right actions. */
const EVENT_SOURCES = ['manual', 'commercial_requirement'];

/**
 * A scheduled activity that was never completed by the time it was due.
 *
 * Single definition on purpose: the lead Activities tab, the dashboard agenda,
 * the Activity Location report and the Leads list all show this status, and
 * they must agree. A *logged* activity is recorded as already done, so it can
 * never be missed.
 */
function isMissedActivity(event, now = Date.now()) {
  if (!event) return false;
  const raw = event.eventDate || event.dueDate || event.date;
  const due = raw ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(due)) return false;

  const status = String(event.status || '');
  if (['Cancelled'].includes(status)) return false;
  if (status === 'Missed') return true;

  const hasGoal = Boolean(
    event.goalLocation &&
    (event.goalLocation.latitude != null || event.goalLatitude != null)
  );

  // If activity has a goal location that was not reached and scheduled time is over:
  if (hasGoal && !event.reachedGoalArea && due < now) {
    return true;
  }

  if (String(event.kind || 'logged') !== 'scheduled') return false;
  if (!['Open', 'Assigned', 'Accepted'].includes(status)) return false;

  return due < now;
}

/** Display status for one activity: Missed / Completed / Assigned / Accepted / Scheduled / Open. */
function activityDisplayStatus(event, now = Date.now()) {
  if (isMissedActivity(event, now)) return 'Missed';
  const status = String(event?.status || '');
  if (status === 'Completed') return 'Completed';
  if (status === 'Assigned') return 'Assigned';
  if (status === 'Accepted') return 'Accepted';
  return String(event?.kind || 'logged') === 'scheduled' ? 'Scheduled' : 'Open';
}

module.exports = {
  EVENT_TYPES,
  EVENT_STATUSES,
  EVENT_KINDS,
  EVENT_SOURCES,
  isMissedActivity,
  activityDisplayStatus
};
