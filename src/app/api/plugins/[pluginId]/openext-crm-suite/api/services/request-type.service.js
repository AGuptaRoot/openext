'use strict';

const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const AuditService = require('./audit.service');
const { makeId, slugifyKey } = require('../validation/request-type.schema');

function getModel(req) {
  const RequestType = req.cms?.models.get('RequestType');
  if (!RequestType) throw new Error('RequestType model is not registered');
  return RequestType;
}

function getLeadModel(req) {
  return req.cms?.models.get('Lead') || null;
}

function appError(message, status = 400, extras = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extras);
  return error;
}

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function serialize(doc, leadCount = 0) {
  if (!doc) return null;
  const item = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  item.leadCount = Number(leadCount) || 0;
  item.canDelete = item.leadCount === 0;
  item.fieldCount = Array.isArray(item.fields) ? item.fields.length : 0;
  return item;
}

async function countLeadsUsingRequestType(req, requestType) {
  const Lead = getLeadModel(req);
  if (!Lead || !requestType) return 0;
  const tenantId = resolveTenantId(req);
  const id = String(requestType._id);
  const name = String(requestType.name || '').trim();
  const key = String(requestType.key || '').trim();
  const or = [{ requestTypeId: id }, { 'commercialRequirement.requestTypeId': id }];
  if (name) or.push({ requestType: name });
  if (key) or.push({ 'commercialRequirement.requestTypeKey': key });
  return Lead.countDocuments({ tenantId, isDeleted: false, $or: or });
}

function defaultSystemTypes(catalog = {}) {
  const pick = (arr, fallback) =>
    Array.isArray(arr) && arr.length
      ? arr.map((v) => String(v || '').trim()).filter(Boolean)
      : fallback;

  const softwareTypes = pick(catalog.projectSoftwareTypes, [
    'Web App',
    'Mobile App',
    'Embedded System',
    'Desktop Software',
    'Other'
  ]);
  const technologies = pick(catalog.projectTechnologies, [
    'React',
    'Next.js',
    'Node.js',
    'Python',
    '.NET',
    'Java',
    'Flutter'
  ]);
  const userBands = pick(catalog.projectUserBands, [
    '1-10',
    '11-50',
    '51-200',
    '201-1000',
    '1000+'
  ]);
  const integrations = pick(catalog.projectIntegrations, [
    'CRM',
    'ERP',
    'Payment Gateway',
    'Email / SMS',
    'Accounting',
    'Custom API'
  ]);
  const categories = pick(catalog.productCategories, [
    'Hardware',
    'Software License',
    'SaaS Subscription',
    'Accessory',
    'Spare Part'
  ]);
  const specs = pick(catalog.productSpecifications, [
    'Standard',
    'Premium',
    'Custom',
    'Industrial Grade'
  ]);
  const certifications = pick(catalog.productCertifications, [
    'ISO',
    'CE',
    'BIS',
    'RoHS',
    'None'
  ]);

  const toOptions = (values) =>
    values.map((label, index) => ({
      id: makeId(`opt_${index}`),
      label,
      value: label
    }));

  return [
    {
      key: 'project_software',
      name: 'Project (software)',
      description: 'Software / application project commercial requirements',
      isSystem: true,
      isEnabled: true,
      sortOrder: 10,
      fields: [
        {
          id: makeId('fld'),
          key: 'software_type',
          label: 'Application Type',
          type: 'select',
          required: true,
          placeholder: 'Select application type',
          helpText: '',
          options: toOptions(softwareTypes),
          matchValues: [...softwareTypes],
          matchNumberMin: null,
          matchNumberMax: null,
          matchEnabled: true
        },
        {
          id: makeId('fld'),
          key: 'technologies',
          label: 'Technology',
          type: 'multiselect',
          required: false,
          placeholder: '',
          helpText: 'Select all relevant technologies',
          options: toOptions(technologies),
          matchValues: [...technologies],
          matchNumberMin: null,
          matchNumberMax: null,
          matchEnabled: true
        },
        {
          id: makeId('fld'),
          key: 'number_of_users',
          label: 'Number of Users',
          type: 'select',
          required: false,
          placeholder: 'Select user band',
          helpText: '',
          options: toOptions(userBands),
          matchValues: [...userBands],
          matchNumberMin: null,
          matchNumberMax: null,
          matchEnabled: true
        },
        {
          id: makeId('fld'),
          key: 'integrations',
          label: 'Required Integrations',
          type: 'multiselect',
          required: false,
          placeholder: '',
          helpText: '',
          options: toOptions(integrations),
          matchValues: [...integrations],
          matchNumberMin: null,
          matchNumberMax: null,
          matchEnabled: true
        },
        {
          id: makeId('fld'),
          key: 'budget',
          label: 'Budget',
          type: 'number',
          required: false,
          placeholder: 'Estimated budget',
          helpText: '',
          options: [],
          matchValues: [],
          matchNumberMin: null,
          matchNumberMax: null,
          matchEnabled: false
        },
        {
          id: makeId('fld'),
          key: 'modules_features',
          label: 'Modules / Features',
          type: 'text',
          required: false,
          placeholder: 'Key modules or features',
          helpText: '',
          options: [],
          matchValues: [],
          matchNumberMin: null,
          matchNumberMax: null,
          matchEnabled: false
        }
      ]
    },
    {
      key: 'product',
      name: 'Product',
      description: 'Hardware / product commercial requirements',
      isSystem: true,
      isEnabled: true,
      sortOrder: 20,
      fields: [
        {
          id: makeId('fld'),
          key: 'product_name',
          label: 'Product Name',
          type: 'text',
          required: true,
          placeholder: 'Product name',
          helpText: '',
          options: [],
          matchValues: [],
          matchNumberMin: null,
          matchNumberMax: null,
          matchEnabled: false
        },
        {
          id: makeId('fld'),
          key: 'category',
          label: 'Category',
          type: 'select',
          required: true,
          placeholder: 'Select category',
          helpText: '',
          options: toOptions(categories),
          matchValues: [...categories],
          matchNumberMin: null,
          matchNumberMax: null,
          matchEnabled: true
        },
        {
          id: makeId('fld'),
          key: 'specification',
          label: 'Specification',
          type: 'select',
          required: false,
          placeholder: 'Select specification',
          helpText: '',
          options: toOptions(specs),
          matchValues: [...specs],
          matchNumberMin: null,
          matchNumberMax: null,
          matchEnabled: true
        },
        {
          id: makeId('fld'),
          key: 'certifications',
          label: 'Certifications',
          type: 'multiselect',
          required: false,
          placeholder: '',
          helpText: '',
          options: toOptions(certifications),
          matchValues: [...certifications],
          matchNumberMin: null,
          matchNumberMax: null,
          matchEnabled: true
        },
        {
          id: makeId('fld'),
          key: 'target_price',
          label: 'Target Price',
          type: 'text',
          required: false,
          placeholder: 'Target unit price',
          helpText: '',
          options: [],
          matchValues: [],
          matchNumberMin: null,
          matchNumberMax: null,
          matchEnabled: false
        },
        {
          id: makeId('fld'),
          key: 'quantity',
          label: 'Quantity',
          type: 'number',
          required: false,
          placeholder: 'Quantity',
          helpText: '',
          options: [],
          matchValues: [],
          matchNumberMin: null,
          matchNumberMax: null,
          matchEnabled: false
        }
      ]
    }
  ];
}

/**
 * Ensure tenant has seeded system Request Types (Project / Product).
 */
async function ensureDefaults(req) {
  const RequestType = getModel(req);
  const tenantId = resolveTenantId(req);
  const existingCount = await RequestType.countDocuments({ tenantId, isDeleted: false });
  if (existingCount > 0) return;

  let catalog = {};
  try {
    const SettingService = require('./setting.service');
    const settings = await SettingService.getAll(req);
    catalog = settings.qualification_match || {};
  } catch {
    /* use built-in defaults */
  }

  const userId = resolveUserId(req) || 'system';
  const seeds = defaultSystemTypes(catalog);
  await RequestType.insertMany(
    seeds.map((seed) => ({
      ...seed,
      tenantId,
      createdBy: userId,
      updatedBy: userId
    }))
  );
}

/**
 * Seed Request Types declared by any enabled extension
 * (contributions.fields where fieldType === "requestType").
 */
async function ensureExtensionRequestTypes(req) {
  let contributed = [];
  try {
    const { listContributedRequestTypes } = require('../extension-host');
    contributed = listContributedRequestTypes();
  } catch {
    return;
  }
  if (!contributed.length) return;

  const RequestType = getModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req) || 'system';

  for (const item of contributed) {
    const key = String(item.key || '')
      .trim()
      .toLowerCase();
    if (!key) continue;
    const existing = await RequestType.findOne({
      tenantId,
      key,
      isDeleted: false
    }).lean();
    if (existing) {
      if (!existing.isEnabled) {
        await RequestType.updateOne(
          { _id: existing._id },
          { $set: { isEnabled: true, updatedBy: userId } }
        );
      }
      continue;
    }
    await RequestType.create({
      tenantId,
      key,
      name: item.name || key,
      description:
        item.description ||
        `Provided by extension ${item.extensionId}. Detail forms are owned by that extension.`,
      isEnabled: true,
      isSystem: true,
      fields: [],
      sortOrder: 50,
      createdBy: userId,
      updatedBy: userId,
      isDeleted: false
    });
  }
}

/**
 * Request type keys owned by CRM extensions that are NOT the active one.
 * They stay in the database (leads may reference them) but never appear as
 * selectable: the active extension fixes the Request Type.
 */
async function inactiveExtensionRequestTypeKeys(req) {
  try {
    const CrmExtensionService = require('./crm-extension.service');
    const [allKeys, active] = await Promise.all([
      CrmExtensionService.getRequestTypeKeys(req),
      CrmExtensionService.getActive(req)
    ]);
    return new Set([...allKeys].filter((key) => key !== active.requestTypeKey));
  } catch {
    return new Set();
  }
}

async function list(req, { includeDisabled = true } = {}) {
  await ensureDefaults(req);
  await ensureExtensionRequestTypes(req);
  const RequestType = getModel(req);
  const filter = { ...baseFilter(req) };
  if (!includeDisabled) filter.isEnabled = true;

  const items = await RequestType.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
  const hiddenKeys = includeDisabled ? new Set() : await inactiveExtensionRequestTypeKeys(req);
  return Promise.all(
    items
      .filter((item) => !hiddenKeys.has(String(item.key || '').trim().toLowerCase()))
      .map(async (item) => {
        const count = await countLeadsUsingRequestType(req, item);
        return serialize(item, count);
      })
  );
}

async function listEnabled(req) {
  return list(req, { includeDisabled: false });
}

async function getById(req, id) {
  await ensureDefaults(req);
  const RequestType = getModel(req);
  const doc = await RequestType.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!doc) throw appError('Request type not found', 404);
  const count = await countLeadsUsingRequestType(req, doc);
  return serialize(doc, count);
}

async function getByKeyOrId(req, keyOrId) {
  await ensureDefaults(req);
  const RequestType = getModel(req);
  const value = String(keyOrId || '').trim();
  if (!value) return null;
  let doc = null;
  if (/^[a-fA-F0-9]{24}$/.test(value)) {
    doc = await RequestType.findOne({ ...baseFilter(req), _id: value }).lean();
  }
  if (!doc) {
    doc = await RequestType.findOne({ ...baseFilter(req), key: value }).lean();
  }
  if (!doc) {
    doc = await RequestType.findOne({
      ...baseFilter(req),
      name: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
    }).lean();
  }
  return doc ? serialize(doc, await countLeadsUsingRequestType(req, doc)) : null;
}

async function create(req, input) {
  await ensureDefaults(req);
  const RequestType = getModel(req);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req);

  const key = slugifyKey(input.key || input.name);
  const duplicateKey = await RequestType.findOne({
    tenantId,
    isDeleted: false,
    key
  }).lean();
  if (duplicateKey) throw appError('A request type with this key already exists', 409);

  const duplicateName = await RequestType.findOne({
    tenantId,
    isDeleted: false,
    name: new RegExp(`^${String(input.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
  }).lean();
  if (duplicateName) throw appError('A request type with this name already exists', 409);

  const created = await RequestType.create({
    tenantId,
    key,
    name: input.name,
    description: input.description || '',
    isEnabled: input.isEnabled !== false,
    isSystem: false,
    fields: input.fields || [],
    sortOrder: input.sortOrder || 0,
    createdBy: userId,
    updatedBy: userId
  });

  const doc = created.toObject();
  await AuditService.log(req, {
    action: 'created',
    module: 'request_type',
    recordId: String(doc._id),
    description: `Request type created: ${doc.name}`
  });
  return serialize(doc, 0);
}

async function update(req, id, input) {
  const RequestType = getModel(req);
  const userId = resolveUserId(req);
  const existing = await RequestType.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Request type not found', 404);

  const updates = { updatedBy: userId };

  if (input.name !== undefined) {
    const name = String(input.name || '').trim();
    if (!name) throw appError('Request type name is required');
    const duplicateName = await RequestType.findOne({
      tenantId: existing.tenantId,
      isDeleted: false,
      _id: { $ne: id },
      name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
    }).lean();
    if (duplicateName) throw appError('A request type with this name already exists', 409);
    updates.name = name;
  }

  if (input.description !== undefined) updates.description = String(input.description || '').trim();
  if (input.isEnabled !== undefined) updates.isEnabled = Boolean(input.isEnabled);
  if (input.sortOrder !== undefined) updates.sortOrder = Number(input.sortOrder) || 0;
  if (input.fields !== undefined) updates.fields = input.fields;

  const updated = await RequestType.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: updates },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'request_type',
    recordId: String(id),
    description: `Request type updated: ${updated.name}`
  });

  const count = await countLeadsUsingRequestType(req, updated);
  return serialize(updated, count);
}

async function remove(req, id) {
  const RequestType = getModel(req);
  const userId = resolveUserId(req);
  const existing = await RequestType.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Request type not found', 404);

  const count = await countLeadsUsingRequestType(req, existing);
  if (count > 0) {
    throw appError(
      `Cannot delete "${existing.name}" because ${count} lead${count === 1 ? ' is' : 's are'} using it. Disable it instead.`,
      409,
      { code: 'REQUEST_TYPE_IN_USE', leadCount: count }
    );
  }

  await RequestType.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    {
      $set: {
        isDeleted: true,
        isEnabled: false,
        deletedAt: new Date(),
        deletedBy: userId,
        updatedBy: userId
      }
    }
  );

  await AuditService.log(req, {
    action: 'deleted',
    module: 'request_type',
    recordId: String(id),
    description: `Request type deleted: ${existing.name}`
  });

  return { deleted: true, id: String(id) };
}

/**
 * Promote a lead-specific option into the Request Type global field catalog.
 * Does not automatically add to Qualification Match (matchValues) unless requested.
 */
async function addFieldOption(req, id, fieldKey, input = {}) {
  const RequestType = getModel(req);
  const userId = resolveUserId(req);
  const existing = await RequestType.findOne({ ...baseFilter(req), _id: id }).lean();
  if (!existing) throw appError('Request type not found', 404);

  const key = String(fieldKey || '').trim();
  if (!key) throw appError('Field key is required');

  const label = String(input.label || input.value || '').trim();
  const value = String(input.value || input.label || '').trim() || label;
  if (!label || !value) throw appError('Option label is required');

  const fields = Array.isArray(existing.fields) ? existing.fields.map((f) => ({ ...f })) : [];
  const fieldIndex = fields.findIndex((f) => String(f.key) === key);
  if (fieldIndex < 0) throw appError(`Field "${key}" not found on this request type`, 404);

  const field = { ...fields[fieldIndex] };
  const selectable = ['select', 'radio', 'multiselect'];
  if (!selectable.includes(String(field.type || '').toLowerCase())) {
    throw appError('Only select / multi-select / checkbox fields support catalog options', 400);
  }

  const options = Array.isArray(field.options) ? [...field.options] : [];
  const exists = options.some(
    (o) => String(o.value || '').trim().toLowerCase() === value.toLowerCase()
  );
  if (!exists) {
    options.push({
      id: `opt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      label: label.slice(0, 120),
      value: value.slice(0, 120)
    });
  }
  field.options = options;

  if (input.addToMatchCatalog) {
    const matchValues = Array.isArray(field.matchValues) ? [...field.matchValues] : [];
    if (!matchValues.some((v) => String(v).trim().toLowerCase() === value.toLowerCase())) {
      matchValues.push(value.slice(0, 120));
    }
    field.matchValues = matchValues;
    field.matchEnabled = true;
  }

  fields[fieldIndex] = field;

  const updated = await RequestType.findOneAndUpdate(
    { ...baseFilter(req), _id: id },
    { $set: { fields, updatedBy: userId } },
    { new: true }
  ).lean();

  await AuditService.log(req, {
    action: 'updated',
    module: 'request_type',
    recordId: String(id),
    description: `Added global option "${value}" to field "${field.label || key}" on ${existing.name}`,
    metadata: {
      fieldKey: key,
      option: value,
      addToMatchCatalog: Boolean(input.addToMatchCatalog)
    }
  });

  const count = await countLeadsUsingRequestType(req, updated);
  return serialize(updated, count);
}

module.exports = {
  ensureDefaults,
  list,
  listEnabled,
  getById,
  getByKeyOrId,
  create,
  update,
  remove,
  addFieldOption,
  countLeadsUsingRequestType,
  defaultSystemTypes,
  serialize
};
