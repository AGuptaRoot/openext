'use strict';

const {
  asObject,
  trimString,
  trimLowerEmail,
  normalizeMobile,
  normalizePan,
  ok,
  fail,
  assertEmail,
  assertRequired,
  assertOptionalBoolean,
  assertMobile,
  assertPan,
  assertMaxLength,
  assertOptionalDate
} = require('./common.util');

const GENDERS = ['', 'Male', 'Female', 'Other', 'Prefer not to say'];
const EVENT_TYPES = ['Call', 'Meeting', 'Follow up', 'Other'];
const EVENT_STATUSES = ['Open', 'Completed'];
const EVENT_KINDS = ['logged', 'scheduled'];
const EVENT_SOURCES = ['manual', 'commercial_requirement'];

/**
 * Validate an optional browser geolocation reading. Returns null when nothing
 * usable was sent; a reading the browser refused is kept (with its reason) so
 * the Activity Location report can tell "denied" apart from "never captured".
 */
function normalizeLocationInput(errors, raw, label) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  const hasLat = raw.latitude !== undefined && raw.latitude !== null && raw.latitude !== '';
  const hasLng = raw.longitude !== undefined && raw.longitude !== null && raw.longitude !== '';
  const out = {
    address: trimString(raw.address),
    unavailableReason: trimString(raw.unavailableReason),
    capturedAt: raw.capturedAt || null
  };
  assertMaxLength(errors, out.address, 400, `${label} address`);
  assertMaxLength(errors, out.unavailableReason, 200, `${label} reason`);

  if (hasLat || hasLng) {
    const lat = Number(raw.latitude);
    const lng = Number(raw.longitude);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
      errors.push(`${label} latitude must be between -90 and 90`);
    }
    if (!Number.isFinite(lng) || Math.abs(lng) > 180) {
      errors.push(`${label} longitude must be between -180 and 180`);
    }
    out.latitude = lat;
    out.longitude = lng;
    if (raw.accuracy !== undefined && raw.accuracy !== null && raw.accuracy !== '') {
      const acc = Number(raw.accuracy);
      if (!Number.isFinite(acc) || acc < 0) errors.push(`${label} accuracy must be a positive number`);
      out.accuracy = acc;
    }
  } else if (!out.unavailableReason) {
    return null;
  }

  return out;
}

function parseTags(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.includes(',')) {
      return [...new Set(trimmed.split(',').map((x) => x.trim()).filter(Boolean))];
    }
    return [trimmed];
  }
  return [];
}

/** Normalize lead-specific selectable options map. */
function normalizeLeadCustomOptions(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [fieldKey, list] of Object.entries(source)) {
    const key = String(fieldKey || '').trim();
    if (!key || !Array.isArray(list)) continue;
    const seen = new Set();
    const options = [];
    for (const item of list) {
      let label = '';
      let value = '';
      if (typeof item === 'string') {
        label = item.trim();
        value = label;
      } else if (item && typeof item === 'object') {
        label = String(item.label || item.value || '').trim();
        value = String(item.value || item.label || '').trim() || label;
      }
      if (!label || !value) continue;
      const dedupe = value.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      options.push({ label: label.slice(0, 120), value: value.slice(0, 120) });
    }
    if (options.length) out[key] = options;
  }
  return out;
}

function parseCustomFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const sanitized = {};
  for (const [k, v] of Object.entries(raw)) {
    const cleanKey = String(k || '').trim().replace(/\s+/g, '_');
    if (cleanKey) {
      sanitized[cleanKey] = v;
    }
  }
  return sanitized;
}

/** Extension JSON bag persisted on the lead, keyed by extension id. */
function parseExtension(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  try {
    return JSON.parse(JSON.stringify(raw));
  } catch {
    return {};
  }
}

function parseExtendedLeadFields(source, includeAll = false) {
  const value = {};
  if (includeAll || source.name !== undefined) value.name = trimString(source.name);
  if (includeAll || source.title !== undefined) value.title = trimString(source.title);
  if (includeAll || source.email !== undefined) value.email = trimLowerEmail(source.email);
  if (includeAll || source.phone !== undefined) value.phone = normalizeMobile(source.phone);
  if (includeAll || source.company !== undefined) value.company = trimString(source.company);
  if (includeAll || source.pan !== undefined) value.pan = normalizePan(source.pan);
  if (includeAll || source.stage !== undefined) value.stage = trimString(source.stage);
  if (includeAll || source.source !== undefined) value.source = trimString(source.source);
  if (includeAll || source.status !== undefined) value.status = trimString(source.status) || 'Hot';
  if (includeAll || source.tags !== undefined) value.tags = parseTags(source.tags);
  if (includeAll || source.customFields !== undefined) value.customFields = parseCustomFields(source.customFields);
  if (includeAll || source.extension !== undefined) value.extension = parseExtension(source.extension);
  if (includeAll || source.assignedTo !== undefined) value.assignedTo = trimString(source.assignedTo);
  if (includeAll || source.notes !== undefined) value.notes = trimString(source.notes);
  if (includeAll || source.salutation !== undefined) value.salutation = trimString(source.salutation);
  if (includeAll || source.jobTitle !== undefined) value.jobTitle = trimString(source.jobTitle);
  if (includeAll || source.leadType !== undefined) value.leadType = trimString(source.leadType);
  if (includeAll || source.requestType !== undefined) value.requestType = trimString(source.requestType);
  if (includeAll || source.requestTypeId !== undefined) {
    value.requestTypeId = trimString(source.requestTypeId) || null;
  }
  if (includeAll || source.priority !== undefined) value.priority = trimString(source.priority);
  if (includeAll || source.contactId !== undefined) value.contactId = trimString(source.contactId);
  if (includeAll || source.nextFollowUp !== undefined) value.nextFollowUp = source.nextFollowUp || null;
  if (includeAll || source.photoUrl !== undefined) value.photoUrl = trimString(source.photoUrl);
  if (includeAll || source.address !== undefined) value.address = trimString(source.address);
  if (includeAll || source.formattedAddress !== undefined) {
    value.formattedAddress = trimString(source.formattedAddress);
  }
  if (includeAll || source.city !== undefined) value.city = trimString(source.city);
  if (includeAll || source.state !== undefined) value.state = trimString(source.state);
  if (includeAll || source.country !== undefined) value.country = trimString(source.country);
  if (includeAll || source.postalCode !== undefined) value.postalCode = trimString(source.postalCode);
  if (includeAll || source.placeId !== undefined) value.placeId = trimString(source.placeId);
  if (includeAll || source.gender !== undefined) value.gender = trimString(source.gender);
  if (includeAll || source.latitude !== undefined) value.latitude = source.latitude;
  if (includeAll || source.longitude !== undefined) value.longitude = source.longitude;
  if (source.allowSimilarCompany !== undefined) value.allowSimilarCompany = source.allowSimilarCompany;
  if (source.allowExactDuplicate !== undefined) value.allowExactDuplicate = source.allowExactDuplicate;
  if (source.value !== undefined) value.value = source.value;
  if (source.currency !== undefined) value.currency = trimString(source.currency);
  return value;
}

/** Deal Value: empty → null, else a number 0 … 1e12. Currency: 3-letter code or empty. */
function checkDealValue(errors, value) {
  if (value.value !== undefined) {
    if (value.value === null || (typeof value.value === 'string' && value.value.trim() === '')) {
      value.value = null;
    } else {
      const raw = typeof value.value === 'string' ? value.value.trim() : value.value;
      const n = typeof raw === 'number' || (typeof raw === 'string' && raw !== '' && /^-?\d+(\.\d+)?$/.test(raw)) ? Number(raw) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 1e12) errors.push('Deal value must be a number between 0 and 1,000,000,000,000');
      else value.value = Math.round(n * 100) / 100;
    }
  }
  if (value.currency !== undefined) {
    const code = String(value.currency || '').toUpperCase();
    if (code && !/^[A-Z]{3}$/.test(code)) errors.push('Currency must be a 3-letter code');
    else value.currency = code;
  }
}

function validateLeadCreate(body) {
  const source = asObject(body);
  const errors = [];
  const value = parseExtendedLeadFields(source, true);

  assertRequired(errors, value.name, 'Name');
  assertRequired(errors, value.email, 'Email');
  assertEmail(errors, value.email);
  assertRequired(errors, value.phone, 'Mobile number');
  assertMobile(errors, value.phone);
  assertRequired(errors, value.company, 'Company name');
  assertPan(errors, value.pan);
  assertRequired(errors, value.stage, 'Stage');
  checkDealValue(errors, value);
  // assignedTo is optional — empty means unassigned (admins / sales managers assign later)
  if (value.assignedTo === undefined) value.assignedTo = '';
  assertMaxLength(errors, value.name, 120, 'Name');
  assertMaxLength(errors, value.title, 200, 'Lead title');
  assertMaxLength(errors, value.email, 120, 'Email');
  assertMaxLength(errors, value.company, 120, 'Company name');
  assertOptionalBoolean(errors, source.allowSimilarCompany, 'allowSimilarCompany');
  assertOptionalBoolean(errors, source.allowExactDuplicate, 'allowExactDuplicate');
  if (value.gender && !GENDERS.includes(value.gender)) {
    errors.push(`Invalid gender. Allowed: ${GENDERS.filter(Boolean).join(', ')}`);
  }
  if (value.nextFollowUp) {
    const d = new Date(value.nextFollowUp);
    if (Number.isNaN(d.getTime())) errors.push('Next follow-up date is invalid');
    else value.nextFollowUp = d.toISOString();
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateLeadUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = parseExtendedLeadFields(source, false);

  assertEmail(errors, value.email);
  assertMobile(errors, value.phone);
  assertPan(errors, value.pan);
  if (source.email !== undefined) assertRequired(errors, value.email, 'Email');
  if (source.phone !== undefined) assertRequired(errors, value.phone, 'Mobile number');
  if (source.company !== undefined) assertRequired(errors, value.company, 'Company name');
  if (source.name !== undefined) assertRequired(errors, value.name, 'Name');
  checkDealValue(errors, value);
  assertMaxLength(errors, value.name, 120, 'Name');
  assertMaxLength(errors, value.email, 120, 'Email');
  assertMaxLength(errors, value.company, 120, 'Company name');
  assertOptionalBoolean(errors, source.allowSimilarCompany, 'allowSimilarCompany');
  assertOptionalBoolean(errors, source.allowExactDuplicate, 'allowExactDuplicate');
  if (value.gender !== undefined && value.gender && !GENDERS.includes(value.gender)) {
    errors.push(`Invalid gender. Allowed: ${GENDERS.filter(Boolean).join(', ')}`);
  }
  if (value.latitude !== undefined && value.latitude !== null && value.latitude !== '') {
    const lat = Number(value.latitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.push('Latitude must be between -90 and 90');
    else value.latitude = lat;
  }
  if (value.longitude !== undefined && value.longitude !== null && value.longitude !== '') {
    const lng = Number(value.longitude);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) errors.push('Longitude must be between -180 and 180');
    else value.longitude = lng;
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateLeadDuplicateCheck(body) {
  const source = asObject(body);
  const errors = [];
  const value = {
    email: trimLowerEmail(source.email) || '',
    phone: normalizeMobile(source.phone) || '',
    pan: normalizePan(source.pan) || '',
    company: trimString(source.company) || '',
    excludeId: trimString(source.excludeId) || ''
  };
  assertEmail(errors, value.email);
  assertMobile(errors, value.phone);
  assertPan(errors, value.pan);
  assertMaxLength(errors, value.company, 120, 'Company name');
  assertMaxLength(errors, value.excludeId, 128, 'Excluded lead ID');
  if (!value.email && !value.phone && !value.pan && !value.company) {
    errors.push('Email, mobile number, PAN, or company name is required');
  }
  return errors.length ? fail(errors) : ok(value);
}

function validateLeadStageChange(body) {
  const source = asObject(body);
  const errors = [];
  const stage = trimString(source.stage ?? source.newStage);

  assertRequired(errors, stage, 'stage');

  if (errors.length) return fail(errors);
  return ok({ stage });
}

function validateLeadEventCreate(body) {
  const source = asObject(body);
  const errors = [];
  const title = trimString(source.title);
  assertRequired(errors, title, 'Title');
  if (!source.eventDate) errors.push('Event date is required');
  const eventDate = source.eventDate ? new Date(source.eventDate) : null;
  if (source.eventDate && Number.isNaN(eventDate.getTime())) errors.push('Event date is invalid');
  // Activity types are tenant-configurable (Settings -> Leads & Funnels), so the
  // allowed list lives in settings and is enforced by LeadEventService.
  const eventType = trimString(source.eventType) || 'Other';
  assertMaxLength(errors, eventType, 80, 'Activity type');
  assertMaxLength(errors, title, 200, 'Title');
  assertMaxLength(errors, trimString(source.description), 2000, 'Description');

  const kind = trimString(source.kind) || 'logged';
  if (!EVENT_KINDS.includes(kind)) {
    errors.push(`Invalid activity kind. Allowed: ${EVENT_KINDS.join(', ')}`);
  }
  const eventSource = trimString(source.source) || 'manual';
  if (!EVENT_SOURCES.includes(eventSource)) {
    errors.push(`Invalid activity source. Allowed: ${EVENT_SOURCES.join(', ')}`);
  }
  const createdLocation = normalizeLocationInput(
    errors,
    source.createdLocation !== undefined ? source.createdLocation : source.location,
    'Created location'
  );
  const rawGoal = source.goalLocation !== undefined
    ? source.goalLocation
    : (source.goalLatitude !== undefined || source.goalLongitude !== undefined || source.goalAddress !== undefined)
      ? { latitude: source.goalLatitude, longitude: source.goalLongitude, address: source.goalAddress }
      : undefined;
  const goalLocation = normalizeLocationInput(
    errors,
    rawGoal,
    'Goal location'
  );
  const acceptedLocation = normalizeLocationInput(
    errors,
    source.acceptedLocation,
    'Accepted location'
  );

  let status;
  if (source.status !== undefined) {
    status = trimString(source.status);
    if (!EVENT_STATUSES.includes(status)) {
      errors.push(`Invalid event status. Allowed: ${EVENT_STATUSES.join(', ')}`);
    }
  }

  if (errors.length) return fail(errors);
  const value = {
    title,
    eventType,
    eventDate: source.eventDate,
    description: trimString(source.description) || '',
    assignedTo: trimString(source.assignedTo) || '',
    kind,
    source: eventSource,
    createdLocation,
    goalLocation,
    acceptedLocation
  };
  if (status !== undefined) value.status = status;
  return ok(value);
}

function validateLeadEventUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};
  if (source.title !== undefined) value.title = trimString(source.title);
  if (source.eventType !== undefined) value.eventType = trimString(source.eventType);
  if (source.eventDate !== undefined) value.eventDate = source.eventDate;
  if (source.description !== undefined) value.description = trimString(source.description);
  if (source.assignedTo !== undefined) value.assignedTo = trimString(source.assignedTo);
  if (source.status !== undefined) value.status = trimString(source.status);
  if (source.goalLocation !== undefined || source.goalLatitude !== undefined || source.goalLongitude !== undefined || source.goalAddress !== undefined) {
    const rawGoal = source.goalLocation !== undefined
      ? source.goalLocation
      : { latitude: source.goalLatitude, longitude: source.goalLongitude, address: source.goalAddress };
    value.goalLocation = normalizeLocationInput(
      errors,
      rawGoal,
      'Goal location'
    );
  }
  if (source.reachedGoalArea !== undefined) {
    value.reachedGoalArea = Boolean(source.reachedGoalArea);
  }
  if (source.reachedGoalAt !== undefined) {
    value.reachedGoalAt = source.reachedGoalAt ? new Date(source.reachedGoalAt) : null;
  }
  if (source.latestDistanceFromGoal !== undefined) {
    value.latestDistanceFromGoal = source.latestDistanceFromGoal != null ? Number(source.latestDistanceFromGoal) : null;
  }
  if (source.latestUserLocation !== undefined) {
    value.latestUserLocation = normalizeLocationInput(
      errors,
      source.latestUserLocation,
      'Latest user location'
    );
  }
  if (source.acceptedLocation !== undefined) {
    value.acceptedLocation = normalizeLocationInput(
      errors,
      source.acceptedLocation,
      'Accepted location'
    );
  }
  if (source.completedLocation !== undefined || source.location !== undefined) {
    value.completedLocation = normalizeLocationInput(
      errors,
      source.completedLocation !== undefined ? source.completedLocation : source.location,
      'Completed location'
    );
  }
  if (source.title !== undefined) assertRequired(errors, value.title, 'Title');
  assertMaxLength(errors, value.title, 200, 'Title');
  assertMaxLength(errors, value.description, 2000, 'Description');
  if (value.eventType !== undefined) {
    assertMaxLength(errors, value.eventType, 80, 'Activity type');
  }
  if (value.status !== undefined && !EVENT_STATUSES.includes(value.status)) {
    errors.push(`Invalid event status. Allowed: ${EVENT_STATUSES.join(', ')}`);
  }
  if (value.eventDate !== undefined && Number.isNaN(new Date(value.eventDate).getTime())) {
    errors.push('Event date is invalid');
  }
  if (!Object.keys(value).length && !errors.length) errors.push('No supported fields were provided');
  return errors.length ? fail(errors) : ok(value);
}

/**
 * Body for POST /leads/:id/events/:eventId/accept — an optional geolocation
 * reading taken at the moment the assigned rep accepts the activity.
 */
function validateLeadEventAccept(body) {
  const source = asObject(body);
  const errors = [];
  const acceptedLocation = normalizeLocationInput(
    errors,
    source.acceptedLocation !== undefined ? source.acceptedLocation : source.location,
    'Accepted location'
  );
  if (errors.length) return fail(errors);
  return ok({ acceptedLocation });
}

/**
 * Body for POST /leads/:id/events/:eventId/complete — an optional geolocation
 * reading taken at the moment the rep pressed Completed.
 */
function validateLeadEventComplete(body) {
  const source = asObject(body);
  const errors = [];
  const completedLocation = normalizeLocationInput(
    errors,
    source.completedLocation !== undefined ? source.completedLocation : source.location,
    'Completed location'
  );
  if (errors.length) return fail(errors);
  return ok({ completedLocation });
}

/**
 * Body for PUT /activities/:id/goal-location
 */
function validateGoalLocationUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const rawGoal = source.goalLocation !== undefined
    ? source.goalLocation
    : (source.goalLatitude !== undefined || source.goalLongitude !== undefined || source.goalAddress !== undefined)
      ? { latitude: source.goalLatitude, longitude: source.goalLongitude, address: source.goalAddress }
      : source;
  const goalLocation = normalizeLocationInput(errors, rawGoal, 'Goal location');
  if (errors.length) return fail(errors);
  return ok({ goalLocation });
}

/**
 * Body for POST /leads/:id/events/:eventId/convert-opportunity.
 * Items carry a name and a description only - no quantity or price.
 */
function validateLeadEventConvert(body) {
  const source = asObject(body);
  const errors = [];

  const rawItems = Array.isArray(source.items) ? source.items : [];
  if (!rawItems.length) errors.push('Add at least one item for the opportunity');
  if (rawItems.length > 100) errors.push('An opportunity cannot be created with more than 100 items');

  const items = [];
  rawItems.forEach((raw, index) => {
    const item = asObject(raw);
    const name = trimString(item.name || item.productName);
    const description = trimString(item.description);
    if (!name) {
      errors.push(`Item ${index + 1}: name is required`);
      return;
    }
    assertMaxLength(errors, name, 200, `Item ${index + 1} name`);
    assertMaxLength(errors, description, 2000, `Item ${index + 1} description`);
    items.push({ name, description });
  });

  const title = trimString(source.title);
  assertMaxLength(errors, title, 200, 'Opportunity title');

  const expectedCloseDate = assertOptionalDate(
    errors,
    source.expectedCloseDate,
    'Expected close date'
  );
  const closedAt = assertOptionalDate(errors, source.closedAt, 'Closed at');
  // A close date in the future is a forecast, which is what expectedCloseDate is for.
  if (closedAt && new Date(closedAt).getTime() > Date.now()) {
    errors.push('Closed at cannot be in the future — use the expected close date instead');
  }

  // Null means "not supplied": the service then falls back to the lead's budget.
  let estimatedDealValue = null;
  const rawValue = source.estimatedDealValue !== undefined
    ? source.estimatedDealValue
    : source.expectedRevenue;
  if (rawValue !== undefined && rawValue !== null && String(rawValue).trim() !== '') {
    const amount = Number(rawValue);
    if (!Number.isFinite(amount) || amount < 0) {
      errors.push('Estimated deal value must be zero or a positive number');
    } else {
      estimatedDealValue = Math.round(amount * 100) / 100;
    }
  }

  if (errors.length) return fail(errors);
  return ok({ items, title, expectedCloseDate, closedAt, estimatedDealValue });
}

/** Body for creating or editing one timestamped lead note. */
/**
 * Portal credentials typed by the rep on the lead page.
 *
 * The email defaults to the lead's own address in the UI but is still checked
 * here, because these details are emailed to a real person.
 */
function validateLeadPortalInvite(body) {
  const source = asObject(body);
  const errors = [];
  const value = {
    email: trimLowerEmail(source.email),
    username: trimString(source.username),
    password: trimString(source.password || source.initialPassword),
    phone: trimString(source.phone)
  };

  assertRequired(errors, value.email, 'Email');
  assertEmail(errors, value.email);
  assertMaxLength(errors, value.email, 120, 'Email');
  assertRequired(errors, value.username, 'Username');
  assertMaxLength(errors, value.username, 80, 'Username');
  if (value.username && value.username.length < 3) {
    errors.push('Username must be at least 3 characters');
  }
  assertRequired(errors, value.password, 'Password');
  if (value.password && value.password.length < 6) {
    errors.push('Password must be at least 6 characters');
  }
  assertMaxLength(errors, value.password, 72, 'Password');

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateLeadNoteWrite(body) {
  const source = asObject(body);
  const errors = [];
  const content = trimString(source.content);
  assertRequired(errors, content, 'Note');
  assertMaxLength(errors, content, 5000, 'Note');
  if (errors.length) return fail(errors);
  return ok({ content });
}

function validateFollowUpCreate(body) {
  const source = asObject(body);
  const errors = [];
  const title = trimString(source.title) || 'Follow up';
  if (!source.dueDate) errors.push('Due date is required');
  if (source.dueDate && Number.isNaN(new Date(source.dueDate).getTime())) errors.push('Due date is invalid');
  assertMaxLength(errors, title, 200, 'Title');
  assertMaxLength(errors, trimString(source.notes), 2000, 'Notes');
  assertOptionalBoolean(errors, source.send, 'send');

  if (errors.length) return fail(errors);
  return ok({
    title,
    dueDate: source.dueDate,
    notes: trimString(source.notes) || ''
  });
}

function validateFollowUpUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};
  if (source.title !== undefined) value.title = trimString(source.title);
  if (source.dueDate !== undefined) value.dueDate = source.dueDate;
  if (source.notes !== undefined) value.notes = trimString(source.notes);
  if (source.status !== undefined) value.status = trimString(source.status);
  if (source.title !== undefined) assertRequired(errors, value.title, 'Title');
  assertMaxLength(errors, value.title, 200, 'Title');
  assertMaxLength(errors, value.notes, 2000, 'Notes');
  if (value.status !== undefined && !EVENT_STATUSES.includes(value.status)) {
    errors.push(`Invalid follow-up status. Allowed: ${EVENT_STATUSES.join(', ')}`);
  }
  if (value.dueDate !== undefined && Number.isNaN(new Date(value.dueDate).getTime())) {
    errors.push('Due date is invalid');
  }
  if (!Object.keys(value).length && !errors.length) errors.push('No supported fields were provided');
  return errors.length ? fail(errors) : ok(value);
}

function validateLeadProposalCreate(body) {
  const source = asObject(body);
  const errors = [];
  const lineItems = Array.isArray(source.lineItems) ? source.lineItems : [];
  if (!lineItems.length) errors.push('At least one line item is required');
  if (lineItems.length > 100) errors.push('A maximum of 100 line items is allowed');
  lineItems.forEach((item, index) => {
    const description = trimString(item?.description) || '';
    const qty = Number(item?.qty);
    const rate = Number(item?.rate);
    const tax = item?.tax === undefined || item?.tax === '' ? 0 : Number(item.tax);
    if (!description) errors.push(`Line item ${index + 1}: description is required`);
    if (description.length > 500) errors.push(`Line item ${index + 1}: description must be 500 characters or fewer`);
    if (!Number.isFinite(qty) || qty <= 0) errors.push(`Line item ${index + 1}: qty must be greater than zero`);
    if (!Number.isFinite(rate) || rate < 0) errors.push(`Line item ${index + 1}: rate must be zero or greater`);
    if (!Number.isFinite(tax) || tax < 0 || tax > 100) errors.push(`Line item ${index + 1}: tax must be between 0 and 100`);
  });
  assertMaxLength(errors, trimString(source.notes), 2000, 'Notes');
  if (errors.length) return fail(errors);
  return ok({
    lineItems,
    notes: trimString(source.notes) || '',
    send: Boolean(source.send)
  });
}

const QUALIFICATION_STATUSES = ['Not Started', 'In Review', 'Qualified', 'Rejected'];

function validateLeadQualification(body) {
  const source = asObject(body);
  const errors = [];

  const status = trimString(source.status) || 'Not Started';
  const industry = trimString(source.industry);
  const customerType = trimString(source.customerType);
  const businessPotential = trimString(source.businessPotential);
  const annualRequirement = trimString(source.annualRequirement);
  const geographicCoverage = trimString(source.geographicCoverage);
  const targetPrice = trimString(source.targetPrice);
  const paymentTerms = trimString(source.paymentTerms);
  const technicalFeasibility = trimString(source.technicalFeasibility);
  const qualificationNotes = trimString(source.qualificationNotes);
  const rejectionReason = trimString(source.rejectionReason);
  const sampleRequired = Boolean(source.sampleRequired);
  const qualityApproved = Boolean(source.qualityApproved);

  let expectedRevenue = null;
  if (source.expectedRevenue !== undefined && source.expectedRevenue !== null && source.expectedRevenue !== '') {
    const rev = Number(source.expectedRevenue);
    if (!Number.isFinite(rev) || rev < 0) {
      errors.push('Expected revenue must be zero or a positive number');
    } else {
      expectedRevenue = rev;
    }
  }

  if (!QUALIFICATION_STATUSES.includes(status)) {
    errors.push(`Invalid qualification status. Allowed: ${QUALIFICATION_STATUSES.join(', ')}`);
  }

  if (status === 'Rejected') {
    if (!rejectionReason) {
      errors.push('Rejection reason is required when status is Rejected');
    }
  }

  if (status === 'Qualified') {
    const missing = [];
    if (!industry) missing.push('Industry');
    if (!customerType) missing.push('Customer type');
    if (!businessPotential) missing.push('Business potential');
    if (!annualRequirement) missing.push('Annual requirement');
    if (!geographicCoverage) missing.push('Geographic coverage');
    if (expectedRevenue == null || expectedRevenue <= 0) missing.push('Expected revenue');
    if (!targetPrice) missing.push('Target price');
    if (!paymentTerms) missing.push('Payment terms');
    if (!technicalFeasibility) missing.push('Technical feasibility');

    if (missing.length) {
      errors.push(`Required qualification checklist fields must be completed before selecting Qualified: ${missing.join(', ')}`);
    }
  }

  assertMaxLength(errors, industry, 120, 'Industry');
  assertMaxLength(errors, customerType, 120, 'Customer type');
  assertMaxLength(errors, businessPotential, 120, 'Business potential');
  assertMaxLength(errors, annualRequirement, 200, 'Annual requirement');
  assertMaxLength(errors, geographicCoverage, 200, 'Geographic coverage');
  assertMaxLength(errors, targetPrice, 120, 'Target price');
  assertMaxLength(errors, paymentTerms, 120, 'Payment terms');
  assertMaxLength(errors, technicalFeasibility, 120, 'Technical feasibility');
  assertMaxLength(errors, qualificationNotes, 2000, 'Qualification notes');
  assertMaxLength(errors, rejectionReason, 2000, 'Rejection reason');

  if (errors.length) return fail(errors);

  return ok({
    status,
    industry,
    customerType,
    businessPotential,
    annualRequirement,
    geographicCoverage,
    expectedRevenue,
    targetPrice,
    paymentTerms,
    technicalFeasibility,
    sampleRequired,
    qualityApproved,
    qualificationNotes,
    rejectionReason
  });
}

function cleanStringList(list, maxItems = 40) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const value = trimString(item);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= maxItems) break;
  }
  return out;
}

function validateLeadCommercialRequirement(body) {
  const source = asObject(body);
  const errors = [];
  let kind = trimString(source.kind).toLowerCase();
  // Dynamic = Request Type builder form (custom commercial fields).
  if (kind !== 'project' && kind !== 'product' && kind !== 'dynamic') kind = '';

  const requestTypeId = trimString(source.requestTypeId) || null;
  const requestType = trimString(source.requestType);
  assertMaxLength(errors, requestTypeId || '', 128, 'Request type ID');
  assertMaxLength(errors, requestType, 120, 'Request type');

  // Preserve dynamic field answers keyed by RequestType field.key.
  // Without this, validateBody stripped `values` and scoring always saw empties
  // → false "Required value missing" for custom request types.
  let values = undefined;
  if (source.values !== undefined) {
    if (source.values == null) {
      values = {};
    } else if (typeof source.values === 'object' && !Array.isArray(source.values)) {
      values = source.values;
    } else {
      errors.push('Commercial requirement values must be an object');
    }
  }

  // Lead-only selectable options: { [fieldKey]: [{ value, label }] | string[] }
  let customOptions = undefined;
  if (source.customOptions !== undefined) {
    if (source.customOptions == null) {
      customOptions = {};
    } else if (typeof source.customOptions === 'object' && !Array.isArray(source.customOptions)) {
      customOptions = normalizeLeadCustomOptions(source.customOptions);
    } else {
      errors.push('Commercial requirement customOptions must be an object');
    }
  }

  let needsSampleRequest = undefined;
  if (source.needsSampleRequest !== undefined) {
    needsSampleRequest = Boolean(source.needsSampleRequest);
  }

  const projectIn = asObject(source.project);
  const productIn = asObject(source.product);

  const softwareType = trimString(projectIn.softwareType);
  const technologies = cleanStringList(projectIn.technologies);
  const modulesFeatures = cleanStringList(projectIn.modulesFeatures);
  const numberOfUsers = trimString(projectIn.numberOfUsers);
  const integrations = cleanStringList(projectIn.integrations);
  const expectedDelivery = trimString(projectIn.expectedDelivery);

  let budget = null;
  if (projectIn.budget !== undefined && projectIn.budget !== null && projectIn.budget !== '') {
    const n = Number(projectIn.budget);
    if (!Number.isFinite(n) || n < 0) errors.push('Budget must be zero or a positive number');
    else budget = n;
  }

  const productName = trimString(productIn.productName);
  const category = trimString(productIn.category);
  const specification = trimString(productIn.specification);
  const targetPrice = trimString(productIn.targetPrice);
  const certifications = cleanStringList(productIn.certifications);

  let quantity = null;
  if (productIn.quantity !== undefined && productIn.quantity !== null && productIn.quantity !== '') {
    const n = Number(productIn.quantity);
    if (!Number.isFinite(n) || n < 0) errors.push('Quantity must be zero or a positive number');
    else quantity = n;
  }

  assertMaxLength(errors, softwareType, 120, 'Software type');
  assertMaxLength(errors, numberOfUsers, 80, 'Number of users');
  assertMaxLength(errors, expectedDelivery, 40, 'Expected delivery');
  assertMaxLength(errors, productName, 200, 'Product name');
  assertMaxLength(errors, category, 120, 'Product category');
  assertMaxLength(errors, specification, 120, 'Specification');
  assertMaxLength(errors, targetPrice, 120, 'Target price');

  if (errors.length) return fail(errors);

  // If dynamic values / request type are present, treat as dynamic even when kind omitted.
  if (!kind && (requestTypeId || (values && Object.keys(values).length))) {
    kind = 'dynamic';
  }

  const payload = {
    kind,
    requestTypeId,
    requestType,
    project: {
      softwareType,
      technologies,
      modulesFeatures,
      numberOfUsers,
      integrations,
      budget,
      expectedDelivery
    },
    product: {
      productName,
      category,
      specification,
      targetPrice,
      certifications,
      quantity
    }
  };
  if (values !== undefined) payload.values = values;
  if (customOptions !== undefined) payload.customOptions = customOptions;
  if (needsSampleRequest !== undefined) payload.needsSampleRequest = needsSampleRequest;
  if (source.isOptionOnly) payload.isOptionOnly = true;
  if (source.partial) payload.partial = true;
  return ok(payload);
}

function validateLeadImportPreview(body) {
  const source = asObject(body);
  const errors = [];
  const rows = Array.isArray(source.rows) ? source.rows : (Array.isArray(source.data) ? source.data : []);
  if (!rows.length) {
    errors.push('rows must be a non-empty array of lead objects');
  }
  if (errors.length) return fail(errors);
  return ok({
    rows,
    options: asObject(source.options)
  });
}

function validateLeadImport(body) {
  const source = asObject(body);
  const errors = [];
  const rows = Array.isArray(source.rows) ? source.rows : (Array.isArray(source.data) ? source.data : []);
  if (!rows.length) {
    errors.push('rows must be a non-empty array of lead objects');
  }
  if (rows.length > 1000) {
    errors.push('Maximum 1,000 leads can be imported per batch');
  }
  if (errors.length) return fail(errors);
  return ok({
    rows,
    options: {
      skipDuplicates: source.options?.skipDuplicates !== false,
      allowSimilarCompany: source.options?.allowSimilarCompany !== false,
      allowExactDuplicate: Boolean(source.options?.allowExactDuplicate),
      defaultStage: trimString(source.options?.defaultStage),
      defaultStatus: trimString(source.options?.defaultStatus),
      defaultSource: trimString(source.options?.defaultSource),
      defaultAssignedTo: trimString(source.options?.defaultAssignedTo),
      defaultRequestType: trimString(source.options?.defaultRequestType || source.options?.defaultRequiredType)
    }
  });
}

/** Visiting-card vision extract — image sent directly to Groq (no client OCR). */
function validateLeadOcrExtract(body) {
  const source = asObject(body);
  const errors = [];
  const imageDataUrl = trimString(
    source.imageDataUrl || source.image || source.dataUrl || source.imageBase64
  );
  const ocrText = trimString(source.ocrText || source.text || source.ocr_text);

  if (!imageDataUrl && !ocrText) {
    errors.push('imageDataUrl is required (visiting card photo as a data URL)');
  }
  if (imageDataUrl) {
    const okImage =
      /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(imageDataUrl) ||
      /^[A-Za-z0-9+/=\s]+$/.test(imageDataUrl);
    if (!okImage) {
      errors.push('imageDataUrl must be a data:image/...;base64,... URL');
    } else if (imageDataUrl.length > 8_000_000) {
      errors.push('imageDataUrl is too large (max ~6 MB encoded)');
    }
  }
  if (ocrText && ocrText.length > 20000) {
    errors.push('ocrText must be 20,000 characters or fewer');
  }
  if (errors.length) return fail(errors);
  return ok({
    imageDataUrl: imageDataUrl || undefined,
    ocrText: ocrText || undefined
  });
}

function parseLeadIds(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
  }
  if (typeof raw === 'string') {
    return [...new Set(raw.split(',').map((x) => x.trim()).filter(Boolean))];
  }
  return [];
}

function validateLeadBulkAssign(body) {
  const source = asObject(body);
  const errors = [];
  const leadIds = parseLeadIds(source.leadIds || source.ids);
  if (!leadIds.length) {
    errors.push('leadIds must be a non-empty array of lead IDs');
  }
  if (leadIds.length > 500) {
    errors.push('Maximum 500 leads can be assigned in a single bulk operation');
  }
  const assignedTo = trimString(source.assignedTo);
  if (!assignedTo) {
    errors.push('assignedTo is required');
  }
  if (errors.length) return fail(errors);
  return ok({
    leadIds,
    assignedTo
  });
}

function validateLeadBulkStage(body) {
  const source = asObject(body);
  const errors = [];
  const leadIds = parseLeadIds(source.leadIds || source.ids);
  if (!leadIds.length) {
    errors.push('leadIds must be a non-empty array of lead IDs');
  }
  if (leadIds.length > 500) {
    errors.push('Maximum 500 leads can be updated in a single bulk operation');
  }
  const stage = trimString(source.stage);
  if (!stage) {
    errors.push('stage is required');
  }
  if (errors.length) return fail(errors);
  return ok({
    leadIds,
    stage
  });
}

function validateSavedLeadFilterCreate(body) {
  const source = asObject(body);
  const errors = [];

  const name = trimString(source.name);
  if (!name) {
    errors.push('name is required');
  } else if (name.length > 100) {
    errors.push('name must be 100 characters or fewer');
  }

  const rawFilters = asObject(source.filters);
  const filters = {
    stage: trimString(rawFilters.stage) || '',
    status: trimString(rawFilters.status) || '',
    source: trimString(rawFilters.source) || '',
    tag: trimString(rawFilters.tag) || '',
    assignedTo: trimString(rawFilters.assignedTo) || '',
    search: trimString(rawFilters.search) || '',
    from: trimString(rawFilters.from) || '',
    to: trimString(rawFilters.to) || ''
  };

  const isShared = Boolean(source.isShared);
  const isDefault = Boolean(source.isDefault);

  if (errors.length) return fail(errors);
  return ok({
    name,
    filters,
    isShared,
    isDefault
  });
}

function validateSavedLeadFilterUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const result = {};

  if (source.name !== undefined) {
    const name = trimString(source.name);
    if (!name) {
      errors.push('name cannot be empty');
    } else if (name.length > 100) {
      errors.push('name must be 100 characters or fewer');
    } else {
      result.name = name;
    }
  }

  if (source.filters !== undefined) {
    const rawFilters = asObject(source.filters);
    result.filters = {
      stage: trimString(rawFilters.stage) || '',
      status: trimString(rawFilters.status) || '',
      source: trimString(rawFilters.source) || '',
      tag: trimString(rawFilters.tag) || '',
      assignedTo: trimString(rawFilters.assignedTo) || '',
      search: trimString(rawFilters.search) || '',
      from: trimString(rawFilters.from) || '',
      to: trimString(rawFilters.to) || ''
    };
  }

  if (source.isShared !== undefined) {
    result.isShared = Boolean(source.isShared);
  }

  if (source.isDefault !== undefined) {
    result.isDefault = Boolean(source.isDefault);
  }

  if (errors.length) return fail(errors);
  return ok(result);
}

module.exports = {
  parseTags,
  parseCustomFields,
  validateLeadCreate,
  validateLeadUpdate,
  validateLeadDuplicateCheck,
  validateLeadStageChange,
  validateLeadEventCreate,
  validateLeadEventUpdate,
  validateLeadEventAccept,
  validateLeadEventComplete,
  validateGoalLocationUpdate,
  validateLeadEventConvert,
  validateLeadNoteWrite,
  validateLeadPortalInvite,
  validateFollowUpCreate,
  validateFollowUpUpdate,
  validateLeadProposalCreate,
  validateLeadQualification,
  validateLeadCommercialRequirement,
  validateLeadImportPreview,
  validateLeadImport,
  validateLeadOcrExtract,
  validateLeadBulkAssign,
  validateLeadBulkStage,
  validateSavedLeadFilterCreate,
  validateSavedLeadFilterUpdate,
  QUALIFICATION_STATUSES
};
