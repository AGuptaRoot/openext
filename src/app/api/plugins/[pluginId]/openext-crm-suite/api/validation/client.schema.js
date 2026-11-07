'use strict';

const {
  asObject,
  trimString,
  trimLowerEmail,
  normalizeMobile,
  ok,
  fail,
  assertEmail,
  assertMobile,
  assertRequired,
  assertOptionalBoolean,
  assertMaxLength,
  assertOptionalHttpUrl,
  normalizeBillingAddress
} = require('./common.util');

function parseTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t || '').trim()).filter(Boolean);
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

function parseCustomFields(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const cleaned = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k || '').trim().replace(/\s+/g, '_');
    if (key && v !== undefined && v !== null) {
      cleaned[key] = typeof v === 'string' ? v.trim() : v;
    }
  }
  return cleaned;
}

function normalizeAddressItem(raw) {
  const source = asObject(raw);
  const type = String(source.type || 'shipping').trim().toLowerCase();
  const validTypes = ['billing', 'shipping', 'branch', 'warehouse', 'headquarters'];
  return {
    id: source.id || source._id || undefined,
    type: validTypes.includes(type) ? type : 'shipping',
    label: trimString(source.label),
    street: trimString(source.street),
    city: trimString(source.city),
    state: trimString(source.state),
    country: trimString(source.country) || 'India',
    zip: trimString(source.zip),
    isDefault: Boolean(source.isDefault),
    taxNumber: trimString(source.taxNumber),
    contactPerson: trimString(source.contactPerson),
    phone: trimString(source.phone),
    notes: trimString(source.notes)
  };
}

function validateClientAddress(body, isUpdate = false) {
  const source = asObject(body);
  const errors = [];
  const item = normalizeAddressItem(source);

  if (!isUpdate || source.street !== undefined) {
    if (!item.street && !item.city && !item.label) {
      errors.push('Street address, city, or label is required');
    }
  }

  assertMaxLength(errors, item.label, 100, 'Address label');
  assertMaxLength(errors, item.street, 200, 'Street');
  assertMaxLength(errors, item.city, 80, 'City');
  assertMaxLength(errors, item.state, 80, 'State');
  assertMaxLength(errors, item.country, 80, 'Country');
  assertMaxLength(errors, item.zip, 20, 'ZIP / Postal code');
  assertMaxLength(errors, item.taxNumber, 50, 'Tax Number');
  assertMaxLength(errors, item.contactPerson, 100, 'Contact Person');
  assertMaxLength(errors, item.phone, 20, 'Phone');
  assertMaxLength(errors, item.notes, 500, 'Notes');

  if (errors.length) return fail(errors);
  return ok(item);
}

function parseCompanyFields(source) {
  const fields = {
    name: trimString(source.name),
    email: trimLowerEmail(source.email),
    phone: normalizeMobile(source.phone),
    website: trimString(source.website),
    avatarUrl: source.avatarUrl !== undefined ? trimString(source.avatarUrl) : '',
    status: source.status !== undefined ? (String(source.status).trim() === 'Inactive' ? 'Inactive' : 'Active') : 'Active',
    category: source.category !== undefined ? trimString(source.category) : '',
    tags: source.tags !== undefined ? parseTags(source.tags) : [],
    customFields: source.customFields !== undefined ? parseCustomFields(source.customFields) : {}
  };

  if (source.billingAddress !== undefined) {
    fields.billingAddress = normalizeBillingAddress(source.billingAddress);
  }
  if (source.shippingAddress !== undefined) {
    fields.shippingAddress = normalizeBillingAddress(source.shippingAddress);
  }
  if (source.addresses !== undefined && Array.isArray(source.addresses)) {
    fields.addresses = source.addresses.map(normalizeAddressItem);
  }
  if (source.allowSimilarCompany !== undefined) fields.allowSimilarCompany = source.allowSimilarCompany;
  if (source.allowExactDuplicate !== undefined) fields.allowExactDuplicate = source.allowExactDuplicate;

  return fields;
}

function validateClientCreate(body) {
  const source = asObject(body);
  const errors = [];
  const fields = parseCompanyFields(source);

  assertRequired(errors, fields.name, 'Company name');
  assertEmail(errors, fields.email);
  assertMobile(errors, fields.phone, 'Company mobile number');
  assertOptionalHttpUrl(errors, fields.website, 'Website');
  if (fields.category) {
    assertMaxLength(errors, fields.category, 100, 'Category');
  }
  validateCompanyLengths(errors, fields);
  assertOptionalBoolean(errors, source.allowSimilarCompany, 'allowSimilarCompany');
  assertOptionalBoolean(errors, source.allowExactDuplicate, 'allowExactDuplicate');

  if (errors.length) return fail(errors);
  return ok(fields);
}

function validateClientUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.name !== undefined) value.name = trimString(source.name);
  if (source.email !== undefined) value.email = trimLowerEmail(source.email);
  if (source.phone !== undefined) value.phone = normalizeMobile(source.phone);
  if (source.website !== undefined) value.website = trimString(source.website);
  if (source.avatarUrl !== undefined) value.avatarUrl = trimString(source.avatarUrl);
  if (source.status !== undefined) {
    const rawStatus = trimString(source.status);
    if (rawStatus && rawStatus !== 'Active' && rawStatus !== 'Inactive') {
      errors.push('Status must be either "Active" or "Inactive"');
    } else {
      value.status = rawStatus === 'Inactive' ? 'Inactive' : 'Active';
    }
  }
  if (source.category !== undefined) {
    value.category = trimString(source.category);
    assertMaxLength(errors, value.category, 100, 'Category');
  }
  if (source.tags !== undefined) {
    value.tags = parseTags(source.tags);
  }
  if (source.customFields !== undefined) {
    value.customFields = parseCustomFields(source.customFields);
  }
  if (source.billingAddress !== undefined) {
    value.billingAddress = normalizeBillingAddress(source.billingAddress);
  }
  if (source.allowSimilarCompany !== undefined) value.allowSimilarCompany = source.allowSimilarCompany;
  if (source.allowExactDuplicate !== undefined) value.allowExactDuplicate = source.allowExactDuplicate;

  assertEmail(errors, value.email);
  assertMobile(errors, value.phone, 'Company mobile number');
  assertOptionalHttpUrl(errors, value.website, 'Website');
  if (source.name !== undefined) assertRequired(errors, value.name, 'Company name');
  validateCompanyLengths(errors, value);
  assertOptionalBoolean(errors, source.allowSimilarCompany, 'allowSimilarCompany');
  assertOptionalBoolean(errors, source.allowExactDuplicate, 'allowExactDuplicate');
  if (!['name', 'email', 'phone', 'website', 'avatarUrl', 'billingAddress', 'status', 'category', 'tags', 'customFields'].some((field) => source[field] !== undefined) && !errors.length) {
    errors.push('No supported fields were provided');
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

function parseContactFields(source) {
  const personContactId = trimString(source.personContactId) || null;
  return {
    name: trimString(source.name),
    email: trimLowerEmail(source.email),
    phone: normalizeMobile(source.phone),
    designation: trimString(source.designation),
    isPrimary: source.isPrimary !== undefined ? Boolean(source.isPrimary) : undefined,
    /** Links this client-company contact row to a PersonContact directory entry. */
    personContactId
  };
}

function validateContactCreate(body) {
  const source = asObject(body);
  const errors = [];
  const fields = parseContactFields(source);

  assertRequired(errors, fields.name, 'Contact name');
  assertEmail(errors, fields.email);
  assertMobile(errors, fields.phone, 'Contact mobile number');
  validateContactLengths(errors, fields);
  assertOptionalBoolean(errors, source.isPrimary, 'isPrimary');
  if (fields.personContactId) {
    assertMaxLength(errors, fields.personContactId, 128, 'Person contact ID');
  }

  if (errors.length) return fail(errors);
  return ok(fields);
}

function validateContactUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.name !== undefined) value.name = trimString(source.name);
  if (source.email !== undefined) value.email = trimLowerEmail(source.email);
  if (source.phone !== undefined) value.phone = normalizeMobile(source.phone);
  if (source.designation !== undefined) value.designation = trimString(source.designation);
  if (source.isPrimary !== undefined) value.isPrimary = Boolean(source.isPrimary);
  if (source.personContactId !== undefined) {
    value.personContactId = trimString(source.personContactId) || null;
  }

  assertEmail(errors, value.email);
  assertMobile(errors, value.phone, 'Contact mobile number');
  if (source.name !== undefined) assertRequired(errors, value.name, 'Contact name');
  validateContactLengths(errors, value);
  assertOptionalBoolean(errors, source.isPrimary, 'isPrimary');
  if (value.personContactId) {
    assertMaxLength(errors, value.personContactId, 128, 'Person contact ID');
  }
  if (!Object.keys(value).length && !errors.length) errors.push('No supported fields were provided');

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateClientDuplicateCheck(body) {
  const source = asObject(body);
  const errors = [];
  const value = {
    name: trimString(source.name) || '',
    email: trimLowerEmail(source.email) || '',
    phone: normalizeMobile(source.phone) || '',
    excludeId: trimString(source.excludeId) || ''
  };
  assertEmail(errors, value.email);
  assertMobile(errors, value.phone, 'Company mobile number');
  assertMaxLength(errors, value.name, 120, 'Company name');
  assertMaxLength(errors, value.excludeId, 128, 'Excluded client ID');
  if (!value.name && !value.email && !value.phone) {
    errors.push('Company name, email, or mobile number is required');
  }
  return errors.length ? fail(errors) : ok(value);
}

function validateCompanyLengths(errors, fields) {
  assertMaxLength(errors, fields.name, 120, 'Company name');
  assertMaxLength(errors, fields.email, 120, 'Company email');
  assertMaxLength(errors, fields.website, 200, 'Website');
  const address = fields.billingAddress;
  if (!address) return;
  assertMaxLength(errors, address.street, 200, 'Street');
  assertMaxLength(errors, address.city, 80, 'City');
  assertMaxLength(errors, address.state, 80, 'State');
  assertMaxLength(errors, address.country, 80, 'Country');
  assertMaxLength(errors, address.zip, 20, 'ZIP / Postal code');
}

function validateContactLengths(errors, fields) {
  assertMaxLength(errors, fields.name, 120, 'Contact name');
  assertMaxLength(errors, fields.email, 120, 'Contact email');
  assertMaxLength(errors, fields.designation, 80, 'Designation');
}

function validateClientImportPreview(body) {
  const source = asObject(body);
  const errors = [];
  const rows = Array.isArray(source.rows) ? source.rows : (Array.isArray(source.data) ? source.data : []);
  if (!rows.length) {
    errors.push('rows must be a non-empty array of client/company objects');
  }
  if (rows.length > 1000) {
    errors.push('Maximum 1,000 clients can be previewed per batch');
  }
  if (errors.length) return fail(errors);
  return ok({
    rows,
    options: asObject(source.options)
  });
}

function validateClientImport(body) {
  const source = asObject(body);
  const errors = [];
  const rows = Array.isArray(source.rows) ? source.rows : (Array.isArray(source.data) ? source.data : []);
  if (!rows.length) {
    errors.push('rows must be a non-empty array of client/company objects');
  }
  if (rows.length > 1000) {
    errors.push('Maximum 1,000 clients can be imported per batch');
  }
  if (errors.length) return fail(errors);
  return ok({
    rows,
    options: {
      skipDuplicates: source.options?.skipDuplicates !== false,
      allowSimilarCompany: source.options?.allowSimilarCompany !== false,
      allowExactDuplicate: Boolean(source.options?.allowExactDuplicate),
      defaultCategory: trimString(source.options?.defaultCategory),
      defaultStatus: trimString(source.options?.defaultStatus) || 'Active',
      createPrimaryContact: source.options?.createPrimaryContact !== false
    }
  });
}

function validateClientExport(query) {
  const source = asObject(query);
  const format = String(source.format || 'csv').trim().toLowerCase();
  const allowedFormats = ['csv', 'json'];
  if (!allowedFormats.includes(format)) {
    return fail([`Format must be one of: ${allowedFormats.join(', ')}`]);
  }
  return ok({
    format,
    status: trimString(source.status) || '',
    category: trimString(source.category) || '',
    tag: trimString(source.tag) || '',
    search: trimString(source.search) || '',
    from: trimString(source.from) || '',
    to: trimString(source.to) || ''
  });
}

function validateClientNoteCreate(body) {
  const source = asObject(body);
  const errors = [];
  const title = trimString(source.title);
  const content = trimString(source.content);
  const category = trimString(source.category) || 'General';
  const color = trimString(source.color) || 'blue';

  assertRequired(errors, title, 'Note title');
  assertRequired(errors, content, 'Note content');
  assertMaxLength(errors, title, 200, 'Note title');
  assertMaxLength(errors, content, 5000, 'Note content');

  const { NOTE_CATEGORIES, NOTE_COLORS } = require('../models/ClientNote');
  if (category && !NOTE_CATEGORIES.includes(category)) {
    errors.push(`Category must be one of: ${NOTE_CATEGORIES.join(', ')}`);
  }
  if (color && !NOTE_COLORS.includes(color)) {
    errors.push(`Color must be one of: ${NOTE_COLORS.join(', ')}`);
  }

  if (errors.length) return fail(errors);
  return ok({
    title,
    content,
    category,
    color,
    isPinned: Boolean(source.isPinned),
    isPrivate: Boolean(source.isPrivate)
  });
}

function validateClientNoteUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.title !== undefined) {
    value.title = trimString(source.title);
    assertRequired(errors, value.title, 'Note title');
    assertMaxLength(errors, value.title, 200, 'Note title');
  }
  if (source.content !== undefined) {
    value.content = trimString(source.content);
    assertRequired(errors, value.content, 'Note content');
    assertMaxLength(errors, value.content, 5000, 'Note content');
  }
  if (source.category !== undefined) {
    value.category = trimString(source.category);
    const { NOTE_CATEGORIES } = require('../models/ClientNote');
    if (!NOTE_CATEGORIES.includes(value.category)) {
      errors.push(`Category must be one of: ${NOTE_CATEGORIES.join(', ')}`);
    }
  }
  if (source.color !== undefined) {
    value.color = trimString(source.color);
    const { NOTE_COLORS } = require('../models/ClientNote');
    if (!NOTE_COLORS.includes(value.color)) {
      errors.push(`Color must be one of: ${NOTE_COLORS.join(', ')}`);
    }
  }
  if (source.isPinned !== undefined) value.isPinned = Boolean(source.isPinned);
  if (source.isPrivate !== undefined) value.isPrivate = Boolean(source.isPrivate);

  if (!Object.keys(value).length && !errors.length) {
    errors.push('No supported fields were provided');
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

function validateClientEventCreate(body) {
  const source = asObject(body);
  const errors = [];
  const title = trimString(source.title);
  const eventType = trimString(source.eventType) || 'Other';
  const description = trimString(source.description) || '';
  const nextAction = trimString(source.nextAction) || '';
  const durationMinutes = Number(source.durationMinutes) || 0;

  assertRequired(errors, title, 'Event title');
  assertMaxLength(errors, title, 200, 'Event title');
  assertMaxLength(errors, description, 2000, 'Event description');
  assertMaxLength(errors, nextAction, 500, 'Next action');

  const eventDate = source.eventDate ? new Date(source.eventDate) : null;
  if (!eventDate || Number.isNaN(eventDate.getTime())) {
    errors.push('A valid event date/time is required');
  }

  const { CLIENT_EVENT_TYPES, CLIENT_EVENT_STATUSES } = require('../models/ClientEvent');
  if (eventType && !CLIENT_EVENT_TYPES.includes(eventType)) {
    errors.push(`Event type must be one of: ${CLIENT_EVENT_TYPES.join(', ')}`);
  }

  const status = trimString(source.status) || 'Open';
  if (status && !CLIENT_EVENT_STATUSES.includes(status)) {
    errors.push(`Status must be one of: ${CLIENT_EVENT_STATUSES.join(', ')}`);
  }

  const attendees = Array.isArray(source.attendees)
    ? source.attendees.map((a) => String(a || '').trim()).filter(Boolean)
    : [];

  if (errors.length) return fail(errors);
  return ok({
    title,
    eventType,
    eventDate,
    durationMinutes: Math.max(0, Math.min(1440, durationMinutes)),
    status,
    description,
    attendees,
    nextAction
  });
}

function validateClientEventUpdate(body) {
  const source = asObject(body);
  const errors = [];
  const value = {};

  if (source.title !== undefined) {
    value.title = trimString(source.title);
    assertRequired(errors, value.title, 'Event title');
    assertMaxLength(errors, value.title, 200, 'Event title');
  }
  if (source.eventType !== undefined) {
    value.eventType = trimString(source.eventType);
    const { CLIENT_EVENT_TYPES } = require('../models/ClientEvent');
    if (!CLIENT_EVENT_TYPES.includes(value.eventType)) {
      errors.push(`Event type must be one of: ${CLIENT_EVENT_TYPES.join(', ')}`);
    }
  }
  if (source.eventDate !== undefined) {
    const d = new Date(source.eventDate);
    if (Number.isNaN(d.getTime())) {
      errors.push('A valid event date is required');
    } else {
      value.eventDate = d;
    }
  }
  if (source.durationMinutes !== undefined) {
    value.durationMinutes = Math.max(0, Math.min(1440, Number(source.durationMinutes) || 0));
  }
  if (source.status !== undefined) {
    value.status = trimString(source.status);
    const { CLIENT_EVENT_STATUSES } = require('../models/ClientEvent');
    if (!CLIENT_EVENT_STATUSES.includes(value.status)) {
      errors.push(`Status must be one of: ${CLIENT_EVENT_STATUSES.join(', ')}`);
    }
  }
  if (source.description !== undefined) {
    value.description = trimString(source.description);
    assertMaxLength(errors, value.description, 2000, 'Event description');
  }
  if (source.nextAction !== undefined) {
    value.nextAction = trimString(source.nextAction);
    assertMaxLength(errors, value.nextAction, 500, 'Next action');
  }
  if (source.attendees !== undefined) {
    value.attendees = Array.isArray(source.attendees)
      ? source.attendees.map((a) => String(a || '').trim()).filter(Boolean)
      : [];
  }

  if (!Object.keys(value).length && !errors.length) {
    errors.push('No supported fields were provided');
  }

  if (errors.length) return fail(errors);
  return ok(value);
}

module.exports = {
  parseTags,
  parseCustomFields,
  validateClientCreate,
  validateClientUpdate,
  validateClientDuplicateCheck,
  validateContactCreate,
  validateContactUpdate,
  validateClientImportPreview,
  validateClientImport,
  validateClientExport,
  normalizeAddressItem,
  validateClientAddress,
  validateClientNoteCreate,
  validateClientNoteUpdate,
  validateClientEventCreate,
  validateClientEventUpdate
};
