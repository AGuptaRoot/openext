'use strict';

const LEAD_FIELDS = new Set([
  'name', 'salutation', 'jobTitle', 'gender', 'leadType', 'requestType', 'email', 'phone',
  'company', 'pan', 'stage', 'source', 'assignedTo', 'notes', 'photoUrl', 'address',
  'latitude', 'longitude', 'locationCapturedAt'
]);
const CLIENT_FIELDS = new Set(['name', 'email', 'phone', 'website', 'billingAddress', 'leadId']);

function validateMerge(body, allowedFields) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = [];
  const secondaryId = String(source.secondaryId || '').trim();
  const reason = String(source.reason || '').trim();
  const rawSources = source.fieldSources;
  const fieldSources = {};

  if (!secondaryId || secondaryId.length > 100) errors.push('A valid secondary record is required');
  if (!reason) errors.push('Merge reason is required');
  if (reason.length > 500) errors.push('Merge reason must be 500 characters or fewer');
  if (rawSources !== undefined && (!rawSources || typeof rawSources !== 'object' || Array.isArray(rawSources))) {
    errors.push('fieldSources must be an object');
  } else {
    for (const [field, choice] of Object.entries(rawSources || {})) {
      if (!allowedFields.has(field)) errors.push(`Unsupported merge field: ${field}`);
      else if (!['primary', 'secondary'].includes(choice)) errors.push(`${field} must select primary or secondary`);
      else fieldSources[field] = choice;
    }
  }

  return { ok: errors.length === 0, errors, value: { secondaryId, reason, fieldSources } };
}

function validateLeadMerge(body) {
  return validateMerge(body, LEAD_FIELDS);
}

function validateClientMerge(body) {
  return validateMerge(body, CLIENT_FIELDS);
}

module.exports = {
  LEAD_FIELDS,
  CLIENT_FIELDS,
  validateLeadMerge,
  validateClientMerge
};
