'use strict';

/**
 * Client-side plugin-extension data.
 *
 * Division of ownership (see documentation/guides/CRM-EXTENSION-SLOTS.md):
 *   - The *enquiry* payload stays on the source lead. The client reads it
 *     through `Company.leadId` so there is a single source of truth and
 *     later lead edits are always reflected.
 *   - Field definitions, labels and display logic come from the extension
 *     package; the CRM only reads and passes the data through.
 */

const { resolveTenantId } = require('../utils/tenant.util');
const ClientService = require('./client.service');

function appError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getLeadModel(req) {
  const Lead = req.cms?.models.get('Lead');
  if (!Lead) throw new Error('Lead model is not registered');
  return Lead;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Mongoose `Mixed` round-trips can hand back Maps or JSON strings.
 * Normalize one level deep so callers always see plain objects.
 */
function normalizeBag(raw) {
  if (raw == null || raw === '') return {};
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (value instanceof Map) {
    const out = {};
    value.forEach((v, k) => {
      out[String(k)] = v;
    });
    return out;
  }
  if (!isPlainObject(value)) return {};

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child instanceof Map) {
      const nested = {};
      child.forEach((v, k) => {
        nested[String(k)] = v;
      });
      out[key] = nested;
    } else if (typeof child === 'string') {
      try {
        const parsed = JSON.parse(child);
        out[key] = isPlainObject(parsed) || Array.isArray(parsed) ? parsed : child;
      } catch {
        out[key] = child;
      }
    } else {
      out[key] = child;
    }
  }
  return out;
}

/** Locate the lead this client was converted from, if any. */
async function findSourceLead(req, client) {
  const Lead = getLeadModel(req);
  const tenantId = resolveTenantId(req);
  const leadId = String(client?.leadId || '').trim();

  if (leadId) {
    const byId = await Lead.findOne({ tenantId, _id: leadId }).lean();
    if (byId) return byId;
  }

  return Lead.findOne({
    tenantId,
    convertedClientId: String(client?._id || '')
  }).lean();
}

/**
 * Resolve the request type of the client's source lead.
 * The lead stores a display name + id; the stable `key` lives on RequestType,
 * and extension slots may match on either.
 */
async function resolveRequestType(req, lead) {
  const name = String(lead?.requestType || '').trim();
  const id = String(lead?.requestTypeId || '').trim();
  if (!name && !id) return { key: '', name: '', id: '' };

  try {
    const RequestTypeService = require('./request-type.service');
    const row = await RequestTypeService.getByKeyOrId(req, id || name);
    if (row) {
      return {
        key: String(row.key || '').trim(),
        name: String(row.name || name).trim(),
        id: String(row._id || row.id || id).trim()
      };
    }
  } catch {
    /* fall through to the lead's own values */
  }

  return { key: '', name, id };
}

/**
 * Read-through view of a client's extension context.
 *
 * @returns {Promise<{
 *   clientId: string,
 *   leadId: string|null,
 *   requestType: { key: string, name: string, id: string },
 *   extension: Record<string, unknown>,
 *   clientExtension: Record<string, unknown>
 * }>}
 */
async function getExtensionData(req, clientId) {
  const client = await ClientService.getById(req, clientId, { includeQuality: false });
  const lead = await findSourceLead(req, client);
  const requestType = await resolveRequestType(req, lead);

  return {
    clientId: String(clientId),
    leadId: lead ? String(lead._id) : null,
    leadName: lead?.name || '',
    requestType,
    /** Enquiry data, read live from the source lead (never copied). */
    extension: normalizeBag(lead?.extension),
    /** Data stored on the client by older extension versions (read-only). */
    clientExtension: normalizeBag(client?.extension)
  };
}

module.exports = {
  getExtensionData,
  findSourceLead,
  resolveRequestType,
  normalizeBag
};
