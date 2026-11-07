'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const { isAdmin, isSalesManager } = require('../utils/sales-access.util');
const { normalizeTenantRoleKey } = require('../utils/tenant-role.util');
const { isMissedActivity, activityDisplayStatus } = require('../utils/lead-event.constants');

const GOAL_REACHED_THRESHOLD_METERS = 50;

/**
 * Calculate distance between two coordinates in metres using the Haversine formula.
 */
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const R = 6371e3; // Earth radius in metres
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) *
    Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function formatReachedAtTime(val) {
  if (!val) return '';
  const d = val instanceof Date ? val : new Date(val);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDistance(meters) {
  if (meters == null || Number.isNaN(meters)) return '';
  if (meters >= 1000) {
    const km = meters / 1000;
    return km % 1 === 0 ? `${km} km` : `${km.toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

function collectRoleTokens(req) {
  const collect = [];
  if (Array.isArray(req?.user?.roles)) collect.push(...req.user.roles);
  if (Array.isArray(req?.roles)) collect.push(...req.roles);
  if (req?.tenantMembership?.role) collect.push(req.tenantMembership.role);
  if (req?.tenantMembership?.roles) collect.push(...req.tenantMembership.roles);
  if (req?.user?.role) collect.push(req.user.role);
  if (req?.user?.roleName) collect.push(req.user.roleName);
  if (req?.user?.userType) collect.push(req.user.userType);
  if (req?.tenantRole) collect.push(req.tenantRole);
  if (req?.role) collect.push(req.role);
  return collect;
}

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getLeadEventModel(req) {
  let model = req.cms?.models?.get?.('LeadEvent');
  if (!model) {
    try {
      const mongoose = require('mongoose');
      model = mongoose.models?.LeadEvent || (typeof mongoose.model === 'function' ? mongoose.model('LeadEvent') : null);
    } catch {
      // ignore
    }
  }
  if (!model) throw new Error('LeadEvent model is not registered');
  return model;
}

function getActivityLocationLogModel(req) {
  let model = req.cms?.models?.get?.('ActivityLocationLog');
  if (!model) {
    try {
      const mongoose = require('mongoose');
      model = mongoose.models?.ActivityLocationLog || (typeof mongoose.model === 'function' ? mongoose.model('ActivityLocationLog') : null);
    } catch {
      // ignore
    }
  }
  if (!model) throw new Error('ActivityLocationLog model is not registered');
  return model;
}

function hasActivityAccess(req, event) {
  if (!event) return false;
  const userId = resolveUserId(req);
  const isAssigned = Boolean(
    event.assignedTo && (
      event.assignedTo === userId ||
      (req.user?.username && event.assignedTo === req.user.username)
    )
  );
  const isCreator = Boolean(
    event.createdBy && (
      event.createdBy === userId ||
      (req.user?.username && event.createdBy === req.user.username)
    )
  );
  if (isAssigned || isCreator) return true;
  if (isAdmin(req) || isSalesManager(req)) return true;

  const roles = collectRoleTokens(req).map(normalizeTenantRoleKey);
  if (roles.includes('crm-manager') || roles.includes('sales-manager')) return true;

  return false;
}

async function findActivityEvent(req, activityId) {
  const LeadEvent = getLeadEventModel(req);
  const tenantId = req.tenantId || resolveTenantId(req);
  const query = LeadEvent.findOne({
    tenantId,
    _id: activityId,
    isDeleted: false
  });
  const event = query && typeof query.then === 'function'
    ? await query
    : (query && typeof query.lean === 'function' ? await query.lean() : query);
  return event;
}

async function enrichWithLeadDetails(req, event) {
  const raw = typeof event.toObject === 'function' ? event.toObject() : { ...event };
  const enriched = { ...raw };

  if (enriched.leadId) {
    try {
      let lead = null;
      try {
        const LeadService = require('./lead.service');
        lead = await LeadService.getById(req, enriched.leadId, { includeQuality: false });
      } catch {
        lead = null;
      }
      if (!lead && req.cms?.models?.get) {
        const Lead = req.cms.models.get('Lead');
        if (Lead) {
          const lq = Lead.findOne({ tenantId: enriched.tenantId, _id: enriched.leadId, isDeleted: false });
          lead = lq && typeof lq.lean === 'function' ? await lq.lean() : (lq && typeof lq.then === 'function' ? await lq : lq);
        }
      }
      if (lead) {
        enriched.leadName = lead.name || '';
        enriched.leadCompany = lead.company || '';
        enriched.leadEmail = lead.email || '';
        enriched.leadPhone = lead.phone || lead.mobile || '';
        enriched.lead = {
          id: lead._id || lead.id || enriched.leadId,
          _id: lead._id || lead.id || enriched.leadId,
          name: lead.name || '',
          company: lead.company || '',
          email: lead.email || '',
          phone: lead.phone || lead.mobile || ''
        };
      }
    } catch {
      // enrich is best effort
    }
  }

  try {
    const { enrichLeadAssignee, resolveUsernames } = require('../utils/user.util');
    const [withAssignee] = await enrichLeadAssignee(req, [enriched]);
    const finalEnriched = withAssignee || enriched;

    const userIds = [
      finalEnriched.assignedTo,
      finalEnriched.createdBy,
      finalEnriched.acceptedBy,
      finalEnriched.completedBy
    ].filter(Boolean);

    if (userIds.length > 0) {
      const userMap = await resolveUsernames(req, userIds).catch(() => ({}));
      if (finalEnriched.assignedTo && userMap[finalEnriched.assignedTo]) {
        finalEnriched.assignedToName = userMap[finalEnriched.assignedTo];
      }
      if (finalEnriched.createdBy) {
        finalEnriched.createdByName = userMap[finalEnriched.createdBy] || (finalEnriched.createdBy === 'system' ? 'System' : 'Staff');
      }
      if (finalEnriched.acceptedBy) {
        finalEnriched.acceptedByName = userMap[finalEnriched.acceptedBy] || finalEnriched.assignedToName || 'Assigned Representative';
      }
      if (finalEnriched.completedBy) {
        finalEnriched.completedByName = userMap[finalEnriched.completedBy] || finalEnriched.assignedToName || 'Assigned Representative';
      }
    }

    // Attach comprehensive locationReport and convenience properties
    const tenantId = req.tenantId || resolveTenantId(req);
    let latestLocation = finalEnriched.latestUserLocation || null;
    let latestDistance = finalEnriched.latestDistanceFromGoal != null ? finalEnriched.latestDistanceFromGoal : null;

    if (!latestLocation) {
      try {
        const ActivityLocationLog = getActivityLocationLogModel(req);
        const query = ActivityLocationLog.find({
          tenantId,
          activityId: String(finalEnriched._id || finalEnriched.id)
        }).sort({ loggedAt: -1 }).limit(1);
        const items = query && typeof query.lean === 'function'
          ? await query.lean()
          : (query && typeof query.then === 'function' ? await query : query);
        const lastLog = Array.isArray(items) ? items[0] : (items || null);
        if (lastLog) {
          latestLocation = {
            latitude: lastLog.latitude,
            longitude: lastLog.longitude,
            accuracy: lastLog.accuracy,
            address: lastLog.address,
            capturedAt: lastLog.loggedAt
          };
          if (latestDistance == null && lastLog.distanceFromGoal != null) {
            latestDistance = lastLog.distanceFromGoal;
          }
        }
      } catch {
        // best-effort
      }
    }

    const goalLat = finalEnriched.goalLocation?.latitude != null && finalEnriched.goalLocation.latitude !== ''
      ? Number(finalEnriched.goalLocation.latitude)
      : null;
    const goalLng = finalEnriched.goalLocation?.longitude != null && finalEnriched.goalLocation.longitude !== ''
      ? Number(finalEnriched.goalLocation.longitude)
      : null;
    const hasGoal = goalLat != null && goalLng != null && Number.isFinite(goalLat) && Number.isFinite(goalLng);

    if (latestDistance == null && hasGoal && latestLocation?.latitude != null && latestLocation?.longitude != null) {
      latestDistance = calculateDistanceMeters(goalLat, goalLng, latestLocation.latitude, latestLocation.longitude);
    }

    const isReached = Boolean(
      finalEnriched.reachedGoalArea ||
      (latestDistance != null && latestDistance <= GOAL_REACHED_THRESHOLD_METERS)
    );

    const reachedAtDate = finalEnriched.reachedGoalAt || (isReached && latestLocation?.capturedAt ? latestLocation.capturedAt : null);
    const reachedAtFormatted = formatReachedAtTime(reachedAtDate);

    const locationReport = {
      hasGoal: Boolean(hasGoal),
      goalLocation: finalEnriched.goalLocation || null,
      latestUserLocation: latestLocation || null,
      distanceFromGoal: latestDistance,
      distanceFormatted: formatDistance(latestDistance),
      reachedGoalArea: isReached,
      reachedGoalAreaText: isReached ? 'Yes' : 'No',
      statusText: isReached ? 'Reached Goal Area' : 'Not Reached Goal Area',
      reachedAt: reachedAtDate,
      reachedAtFormatted: reachedAtFormatted
    };

    const isMissed = isMissedActivity(finalEnriched);
    const displayStatus = activityDisplayStatus(finalEnriched);

    locationReport.isMissed = isMissed;
    locationReport.displayStatus = displayStatus;
    locationReport.timeStatusText = isMissed ? 'Time Over · Missed' : (finalEnriched.status === 'Completed' ? 'Completed' : 'On Schedule');

    finalEnriched.locationReport = locationReport;
    finalEnriched.isMissed = isMissed;
    finalEnriched.displayStatus = displayStatus;
    finalEnriched.reachedGoalArea = isReached;
    finalEnriched.reachedGoalAreaText = locationReport.reachedGoalAreaText;
    finalEnriched.statusText = locationReport.statusText;
    finalEnriched.distanceFromGoal = latestDistance;
    finalEnriched.distanceFormatted = locationReport.distanceFormatted;
    finalEnriched.reachedAt = reachedAtDate;
    finalEnriched.reachedAtFormatted = reachedAtFormatted;
    if (!finalEnriched.latestUserLocation && latestLocation) {
      finalEnriched.latestUserLocation = latestLocation;
    }

    const hasStartingCoords = (loc) => Boolean(loc && loc.latitude != null && loc.longitude != null && !isNaN(Number(loc.latitude)) && !isNaN(Number(loc.longitude)));
    let startingLocation = hasStartingCoords(finalEnriched.acceptedLocation)
      ? finalEnriched.acceptedLocation
      : (hasStartingCoords(finalEnriched.createdLocation)
          ? finalEnriched.createdLocation
          : (hasStartingCoords(finalEnriched.startingLocation) ? finalEnriched.startingLocation : null));

    if (!startingLocation) {
      try {
        const ActivityLocationLog = getActivityLocationLogModel(req);
        const qFirst = ActivityLocationLog.find({
          tenantId,
          activityId: String(finalEnriched._id || finalEnriched.id)
        }).sort({ loggedAt: 1 }).limit(1);
        const firstItems = qFirst && typeof qFirst.lean === 'function'
          ? await qFirst.lean()
          : (qFirst && typeof qFirst.then === 'function' ? await qFirst : qFirst);
        const firstLog = Array.isArray(firstItems) ? firstItems[0] : (firstItems || null);
        if (firstLog && hasStartingCoords(firstLog)) {
          startingLocation = {
            latitude: firstLog.latitude,
            longitude: firstLog.longitude,
            accuracy: firstLog.accuracy,
            address: firstLog.address,
            capturedAt: firstLog.loggedAt
          };
        }
      } catch {}
    }

    finalEnriched.startingLocation = startingLocation || finalEnriched.acceptedLocation || finalEnriched.createdLocation || null;

    return finalEnriched;
  } catch {
    return enriched;
  }
}

/**
 * Log periodic location for an in-progress activity.
 */
async function createLocationLog(req, activityId, payload = {}) {
  const event = await findActivityEvent(req, activityId);
  if (!event) throw appError('Activity not found', 404);

  const userId = resolveUserId(req);
  const isAssigned = Boolean(
    event.assignedTo && (
      event.assignedTo === userId ||
      (req.user?.username && event.assignedTo === req.user.username)
    )
  );
  if (!isAssigned && !isAdmin(req)) {
    throw appError('Only the assigned sales representative can log location', 403);
  }

  if (event.status === 'Completed') {
    throw appError('Cannot log location for completed activity', 400);
  }

  const lat = payload.latitude != null && payload.latitude !== '' ? Number(payload.latitude) : NaN;
  const lng = payload.longitude != null && payload.longitude !== '' ? Number(payload.longitude) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw appError('Valid latitude and longitude are required', 400);
  }

  const accuracy = payload.accuracy != null && !Number.isNaN(Number(payload.accuracy)) ? Number(payload.accuracy) : null;
  const address = payload.address ? String(payload.address).trim() : '';
  const loggedAt = payload.loggedAt ? new Date(payload.loggedAt) : new Date();
  const tenantId = req.tenantId || resolveTenantId(req);

  // Goal Location Check
  const goalLat = event.goalLocation?.latitude != null && event.goalLocation.latitude !== ''
    ? Number(event.goalLocation.latitude)
    : null;
  const goalLng = event.goalLocation?.longitude != null && event.goalLocation.longitude !== ''
    ? Number(event.goalLocation.longitude)
    : null;
  const hasGoalCoords = goalLat != null && goalLng != null && Number.isFinite(goalLat) && Number.isFinite(goalLng);

  let distance = null;
  let isReached = false;
  if (hasGoalCoords) {
    distance = calculateDistanceMeters(goalLat, goalLng, lat, lng);
    isReached = distance != null && distance <= GOAL_REACHED_THRESHOLD_METERS;
  }

  const ActivityLocationLog = getActivityLocationLogModel(req);
  const logData = {
    tenantId,
    activityId: String(activityId),
    leadId: event.leadId ? String(event.leadId) : '',
    salesRepId: userId,
    salesRepName: req.user?.fullName || req.user?.name || req.user?.username || '',
    activityType: event.eventType || 'Other',
    activityTitle: event.title || '',
    latitude: Math.round(lat * 1e6) / 1e6,
    longitude: Math.round(lng * 1e6) / 1e6,
    accuracy: accuracy != null && accuracy >= 0 ? Math.round(accuracy) : null,
    address,
    distanceFromGoal: distance,
    distanceFormatted: formatDistance(distance),
    reachedGoalArea: isReached,
    reachedGoalAreaText: isReached ? 'Yes' : 'No',
    statusText: isReached ? 'Reached Goal Area' : 'Not Reached Goal Area',
    reachedAt: isReached ? loggedAt : null,
    loggedAt
  };

  let saved;
  if (typeof ActivityLocationLog.create === 'function') {
    saved = await ActivityLocationLog.create(logData);
  } else {
    const inst = new ActivityLocationLog(logData);
    saved = await inst.save();
  }

  // Update the activity (LeadEvent)
  // CRITICAL: DO NOT automatically complete the Activity! Status must NOT be changed to Completed.
  const latestLocation = {
    latitude: Math.round(lat * 1e6) / 1e6,
    longitude: Math.round(lng * 1e6) / 1e6,
    accuracy: accuracy != null && accuracy >= 0 ? Math.round(accuracy) : null,
    address,
    capturedAt: loggedAt
  };

  const updateFields = {
    latestUserLocation: latestLocation,
    latestDistanceFromGoal: distance
  };

  if (isReached) {
    if (!event.reachedGoalArea) {
      updateFields.reachedGoalArea = true;
    }
    if (!event.reachedGoalAt) {
      updateFields.reachedGoalAt = loggedAt || new Date();
    }
    if (!event.reachedAt) {
      updateFields.reachedAt = loggedAt || new Date();
    }
  }

  const LeadEvent = getLeadEventModel(req);
  if (typeof LeadEvent.updateOne === 'function') {
    await LeadEvent.updateOne({ tenantId, _id: activityId }, { $set: updateFields });
  } else if (typeof LeadEvent.findOneAndUpdate === 'function') {
    await LeadEvent.findOneAndUpdate({ tenantId, _id: activityId }, { $set: updateFields });
  } else if (typeof event.save === 'function') {
    Object.assign(event, updateFields);
    await event.save();
  }
  Object.assign(event, updateFields);

  return typeof saved?.toObject === 'function' ? saved.toObject() : saved;
}

/**
 * List periodic location logs for an activity in chronological order.
 */
async function listLocationLogs(req, activityId) {
  const event = await findActivityEvent(req, activityId);
  if (!event) throw appError('Activity not found', 404);

  if (!hasActivityAccess(req, event)) {
    throw appError('Forbidden: Insufficient permissions to view location logs', 403);
  }

  const tenantId = req.tenantId || resolveTenantId(req);
  const ActivityLocationLog = getActivityLocationLogModel(req);
  const query = ActivityLocationLog.find({
    tenantId,
    activityId: String(activityId)
  }).sort({ loggedAt: 1 });

  const items = query && typeof query.lean === 'function'
    ? await query.lean()
    : (query && typeof query.then === 'function' ? await query : query);

  const logsList = Array.isArray(items) ? items : [];

  const goalLat = event.goalLocation?.latitude != null && event.goalLocation.latitude !== ''
    ? Number(event.goalLocation.latitude)
    : null;
  const goalLng = event.goalLocation?.longitude != null && event.goalLocation.longitude !== ''
    ? Number(event.goalLocation.longitude)
    : null;
  const hasGoalCoords = goalLat != null && goalLng != null && Number.isFinite(goalLat) && Number.isFinite(goalLng);

  return logsList.map((item) => {
    const raw = typeof item.toObject === 'function' ? item.toObject() : { ...item };
    let distance = raw.distanceFromGoal != null ? raw.distanceFromGoal : null;
    let reached = Boolean(raw.reachedGoalArea);

    if (distance == null && hasGoalCoords && raw.latitude != null && raw.longitude != null) {
      distance = calculateDistanceMeters(goalLat, goalLng, raw.latitude, raw.longitude);
      reached = distance != null && distance <= GOAL_REACHED_THRESHOLD_METERS;
    }

    return {
      ...raw,
      distanceFromGoal: distance,
      distanceFormatted: raw.distanceFormatted || formatDistance(distance),
      reachedGoalArea: reached,
      reachedGoalAreaText: reached ? 'Yes' : 'No',
      statusText: reached ? 'Reached Goal Area' : 'Not Reached Goal Area',
      reachedAt: raw.reachedAt || (reached ? raw.loggedAt : null)
    };
  });
}

/**
 * Get single activity by ID with lead enrichment and role restriction.
 */
async function getActivityById(req, activityId) {
  const event = await findActivityEvent(req, activityId);
  if (!event) throw appError('Activity not found', 404);

  if (!hasActivityAccess(req, event)) {
    throw appError('Forbidden: Insufficient permissions to view activity details', 403);
  }

  return enrichWithLeadDetails(req, event);
}

/**
 * Update Goal Location for an activity.
 */
async function updateGoalLocation(req, activityId, payload = {}) {
  const event = await findActivityEvent(req, activityId);
  if (!event) throw appError('Activity not found', 404);

  if (!hasActivityAccess(req, event)) {
    throw appError('Forbidden: Insufficient permissions to update activity goal location', 403);
  }

  const raw = payload.goalLocation || payload;
  const lat = raw.latitude != null && raw.latitude !== '' ? Number(raw.latitude) : (raw.goalLatitude != null && raw.goalLatitude !== '' ? Number(raw.goalLatitude) : NaN);
  const lng = raw.longitude != null && raw.longitude !== '' ? Number(raw.longitude) : (raw.goalLongitude != null && raw.goalLongitude !== '' ? Number(raw.goalLongitude) : NaN);
  const address = raw.address != null ? String(raw.address).trim() : (raw.goalAddress != null ? String(raw.goalAddress).trim() : '');

  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (!hasCoords && !address && raw.unavailableReason === undefined) {
    throw appError('Valid latitude and longitude or address are required for goal location', 400);
  }

  const goalLocation = {
    latitude: hasCoords ? Math.round(lat * 1e6) / 1e6 : null,
    longitude: hasCoords ? Math.round(lng * 1e6) / 1e6 : null,
    accuracy: raw.accuracy != null && !Number.isNaN(Number(raw.accuracy)) ? Math.round(Number(raw.accuracy)) : null,
    address: address.slice(0, 400),
    capturedAt: raw.capturedAt ? new Date(raw.capturedAt) : new Date(),
    unavailableReason: String(raw.unavailableReason || '').trim().slice(0, 200)
  };

  const tenantId = req.tenantId || resolveTenantId(req);
  const userId = resolveUserId(req);
  const LeadEvent = getLeadEventModel(req);

  const updates = {
    goalLocation,
    updatedBy: userId
  };

  // If activity already has latestUserLocation, recompute latestDistanceFromGoal and reachedGoalArea
  if (hasCoords && event.latestUserLocation?.latitude != null && event.latestUserLocation?.longitude != null) {
    const dist = calculateDistanceMeters(goalLocation.latitude, goalLocation.longitude, event.latestUserLocation.latitude, event.latestUserLocation.longitude);
    updates.latestDistanceFromGoal = dist;
    if (dist != null && dist <= GOAL_REACHED_THRESHOLD_METERS) {
      updates.reachedGoalArea = true;
      if (!event.reachedGoalArea) {
        updates.reachedGoalAt = new Date();
      }
    }
  }

  let updated;
  if (typeof LeadEvent.findOneAndUpdate === 'function') {
    const query = LeadEvent.findOneAndUpdate(
      { tenantId, _id: activityId },
      { $set: updates },
      { new: true }
    );
    updated = query && typeof query.lean === 'function'
      ? await query.lean()
      : (query && typeof query.then === 'function' ? await query : query);
  } else if (typeof event.save === 'function') {
    Object.assign(event, updates);
    await event.save();
    updated = event;
  }

  return enrichWithLeadDetails(req, updated || event);
}

/**
 * Update an activity via LeadEventService.update.
 */
async function updateActivity(req, activityId, payload = {}) {
  const event = await findActivityEvent(req, activityId);
  if (!event) throw appError('Activity not found', 404);

  if (!hasActivityAccess(req, event)) {
    throw appError('Forbidden: Insufficient permissions to update activity', 403);
  }

  const LeadEventService = require('./lead-event.service');
  const updated = await LeadEventService.update(req, event.leadId, activityId, payload);
  return enrichWithLeadDetails(req, updated);
}

module.exports = {
  createLocationLog,
  listLocationLogs,
  getActivityById,
  updateGoalLocation,
  updateActivity,
  hasActivityAccess,
  findActivityEvent,
  calculateDistanceMeters,
  formatDistance,
  GOAL_REACHED_THRESHOLD_METERS
};
