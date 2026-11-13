'use strict';

/**
 * CRM-owned extension registry service (Settings → Extensions).
 *
 * Definitions come from two places and are treated alike:
 *   - built-ins in api/crm-extensions.js (Product Sales, Project Delivery)
 *   - packages a tenant uploaded (CrmExtension collection), validated by
 *     api/validation/crm-extension-package.schema.js
 *
 * Enabling an extension is the one place where the tenant's workspace mode
 * changes. It:
 *   1. records `active_extension` in settings,
 *   2. makes the extension's Request Type the only enabled CRM request type
 *      (creating it from the seed or the package when the tenant lacks it),
 *   3. seeds (if needed) and activates the extension's opportunity pipeline.
 *
 * Only one extension is active at a time. Disabling the active one falls back
 * to the default (`product`); the default itself cannot be disabled, and an
 * uploaded package cannot be uninstalled while it is active.
 */

const crypto = require('crypto');
const { resolveTenantId, resolveUserId } = require('../utils/tenant.util');
const {
  CRM_EXTENSIONS,
  getDefaultExtensionDef,
  resolveActiveExtensionIdFrom,
  toFeaturePayload,
  visibleModulesFor
} = require('../crm-extensions');
const { readZipEntries } = require('../utils/zip-reader.util');
const {
  pickPackageFiles,
  parseJson,
  validatePackageDefinition,
  summarize,
  contentTypeFor
} = require('../validation/crm-extension-package.schema');

/**
 * A full package carries a prebuilt UI bundle, so the zip may reach a few MB.
 * The uncompressed limits are enforced by the zip reader; ui/ and api/ have
 * their own caps in the package schema (8 MB and 1 MB).
 */
const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
const ZIP_LIMITS = { maxEntries: 500, maxTotalBytes: 24 * 1024 * 1024, maxEntryBytes: 6 * 1024 * 1024 };

function appError(message, status = 400, extras = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extras);
  return error;
}

async function leanResult(query) {
  if (!query) return null;
  return typeof query.lean === 'function' ? query.lean() : query;
}

function getUploadModel(req) {
  return req.cms?.models?.get?.('CrmExtension') || null;
}

/* ---------------------------------------------------------------- definitions */

function fromUploadRow(row) {
  const def = row && row.definition && typeof row.definition === 'object' ? row.definition : {};
  return {
    ...def,
    id: String(row.extensionId || def.id || '').toLowerCase(),
    version: row.version || def.version || '1.0.0',
    isInternal: false,
    isDefault: false,
    hiddenModules: Array.isArray(def.hiddenModules) ? def.hiddenModules : [],
    hiddenSettingsTabs: Array.isArray(def.hiddenSettingsTabs) ? def.hiddenSettingsTabs : [],
    conversions: def.conversions && typeof def.conversions === 'object' ? def.conversions : {},
    highlights: Array.isArray(def.highlights) ? def.highlights : [],
    pipelineStages: Array.isArray(def.pipelineStages) ? def.pipelineStages : [],
    uploadId: row._id ? String(row._id) : null,
    installedAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    hasReadme: Boolean(row.readme),
    hasChangelog: Boolean(row.changelog),
    manifestVersion: Number(row.manifestVersion || def.manifestVersion || 1),
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : def.capabilities || [],
    requiresTrust: Boolean(row.requiresTrust ?? def.requiresTrust),
    trust: row.trust || (row.requiresTrust ? 'pending' : 'n/a'),
    approvedChecksum: row.approvedChecksum || '',
    approvedBy: row.approvedBy || null,
    approvedAt: row.approvedAt || null,
    backendStatus: row.backendStatus || 'n/a',
    backendError: row.backendError || '',
    checksum: row.checksum || '',
    fileCount: Number(row.fileCount || 0),
    fileIndex: Array.isArray(row.fileIndex) ? row.fileIndex : []
  };
}

/** Packages this tenant uploaded, newest first. Never throws. */
async function listUploadedDefinitions(req) {
  const Model = getUploadModel(req);
  if (!Model || typeof Model.find !== 'function') return [];
  try {
    const tenantId = resolveTenantId(req);
    let query = Model.find({ tenantId, isDeleted: false });
    if (query && typeof query.sort === 'function') query = query.sort({ createdAt: 1 });
    const rows = (await leanResult(query)) || [];
    const PackageFolder = require('../extension-runtime/package-folder');
    return rows
      .map(fromUploadRow)
      .filter((def) => def.id)
      .map((def) => ({ ...def, filesAvailable: PackageFolder.isAvailable(tenantId, def) }));
  } catch {
    return [];
  }
}

/** Built-ins first, then the tenant's uploads. Built-in ids always win. */
async function listDefinitions(req) {
  const builtinIds = new Set(CRM_EXTENSIONS.map((def) => def.id));
  const uploaded = (await listUploadedDefinitions(req)).filter((def) => !builtinIds.has(def.id));
  return [...CRM_EXTENSIONS, ...uploaded];
}

async function getDefinition(req, id) {
  const key = String(id || '')
    .trim()
    .toLowerCase();
  if (!key) return null;
  const defs = await listDefinitions(req);
  return defs.find((def) => def.id === key) || null;
}

/** Request type keys owned by any extension (built-in or uploaded). */
async function getRequestTypeKeys(req) {
  const defs = await listDefinitions(req);
  return new Set(defs.map((def) => String(def.requestTypeKey || '').toLowerCase()).filter(Boolean));
}

/** Tenants whose workspace is currently being switched back to the default. */
const fallbackInFlight = new Map();

/**
 * The enabled uploaded extension's files are gone (plugin folder wiped by a
 * CMS plugin update or removal, or edited on disk). Switch the workspace back
 * to the default extension so request type, pipeline and modules are
 * consistent again. Runs once per tenant at a time; never throws.
 */
async function fallBackToDefault(req, missingDef) {
  const tenantId = resolveTenantId(req);
  if (fallbackInFlight.has(tenantId)) return fallbackInFlight.get(tenantId);
  const run = (async () => {
    try {
      await enable(req, getDefaultExtensionDef().id);
      await audit(
        req,
        `CRM extension ${missingDef.name} v${missingDef.version} not found in the plugin folder; switched back to ${getDefaultExtensionDef().name}`,
        { extensionId: missingDef.id, version: missingDef.version, reason: 'EXTENSION_FILES_MISSING' }
      );
    } catch (error) {
      console.error('[plugin:openext-crm-suite] fallback to default extension failed:', error?.message || error);
    }
  })();
  fallbackInFlight.set(tenantId, run);
  try {
    await run;
  } finally {
    fallbackInFlight.delete(tenantId);
  }
  return undefined;
}

/**
 * Active definition for an already-loaded settings map; never throws.
 * An uploaded extension whose folder is missing or damaged is "not found":
 * the default extension is returned and the workspace is switched back to it.
 */
async function resolveActiveDefinition(req, settings) {
  try {
    const defs = await listDefinitions(req);
    const id = resolveActiveExtensionIdFrom(settings, defs);
    const def = defs.find((item) => item.id === id) || getDefaultExtensionDef();
    if (def.isInternal === false && def.filesAvailable === false) {
      if (!fallbackInFlight.has(resolveTenantId(req))) await fallBackToDefault(req, def);
      return getDefaultExtensionDef();
    }
    return def;
  } catch {
    return getDefaultExtensionDef();
  }
}

/** Active extension id for this tenant; never throws. */
async function getActiveExtensionId(req) {
  try {
    const SettingService = require('./setting.service');
    const settings = await SettingService.getAll(req);
    const def = await resolveActiveDefinition(req, settings);
    return def.id;
  } catch {
    return getDefaultExtensionDef().id;
  }
}

/**
 * Performance: one HTTP request resolves the active extension once (a few seconds at most;
 * jobs that reuse a req object are not memoised). Changes to extensions clear it.
 */
const ACTIVE_MEMO = Symbol.for('crm.activeExtension.memo');

function forgetActive(req) {
  if (req && typeof req === 'object') req[ACTIVE_MEMO] = null;
}

async function getActive(req) {
  const memoable = Boolean(req && req.headers && typeof req.method === 'string');
  const memo = memoable ? req[ACTIVE_MEMO] : null;
  if (memo && Date.now() - memo.at < 5000) return memo.pending;
  const pending = (async () => {
    const id = await getActiveExtensionId(req);
    return (await getDefinition(req, id)) || getDefaultExtensionDef();
  })();
  if (memoable) {
    req[ACTIVE_MEMO] = { at: Date.now(), pending };
    pending.catch(() => forgetActive(req));
  }
  return pending;
}

/** `/me` payload — safe fallback to the default extension on any failure. */
async function getActiveFeaturePayload(req) {
  const { forViewer } = require('../crm-extensions');
  const viewer = { isClient: require('../utils/tenant.util').isClientUser(req) };
  try {
    return forViewer(toFeaturePayload(await getActive(req)), viewer);
  } catch {
    return forViewer(toFeaturePayload(getDefaultExtensionDef()), viewer);
  }
}

function serialize(def, activeId) {
  const isActive = def.id === activeId;
  return {
    id: def.id,
    name: def.name,
    tagline: def.tagline || '',
    description: def.description || '',
    icon: def.icon || 'blocks',
    accent: def.accent || 'slate',
    version: def.version || '1.0.0',
    publisher: def.publisher || '',
    isDefault: Boolean(def.isDefault),
    isInternal: def.isInternal !== false,
    source: def.isInternal === false ? 'uploaded' : 'builtin',
    isActive,
    canUninstall: def.isInternal === false && !isActive,
    requestTypeKey: def.requestTypeKey,
    requestTypeName: def.requestTypeName,
    pipelineKey: def.pipelineKey,
    pipelineName: def.pipelineName,
    hiddenModules: [...(def.hiddenModules || [])],
    hiddenSettingsTabs: [...(def.hiddenSettingsTabs || [])],
    visibleModules: visibleModulesFor(def),
    conversions: { ...(def.conversions || {}) },
    highlights: [...(def.highlights || [])],
    installedAt: def.installedAt || null,
    updatedAt: def.updatedAt || null,
    hasReadme: Boolean(def.hasReadme),
    hasChangelog: Boolean(def.hasChangelog),
    /* manifestVersion 2 */
    manifestVersion: Number(def.manifestVersion || 1),
    capabilities: [...(def.capabilities || [])],
    requiresTrust: Boolean(def.requiresTrust),
    trust: def.isInternal === false ? def.trust || (def.requiresTrust ? 'pending' : 'n/a') : 'n/a',
    backendStatus: def.isInternal === false ? def.backendStatus || 'n/a' : 'n/a',
    backendError: def.backendError || '',
    checksum: def.checksum || '',
    /** False when an uploaded extension's folder is missing or damaged (re-upload needed). */
    filesAvailable: def.isInternal === false ? def.filesAvailable !== false : true,
    approvedAt: def.approvedAt || null,
    approvedBy: def.approvedBy || null,
    definedPermissions: [...((def.permissions && def.permissions.defines) || [])],
    hasUi: Boolean(def.ui && def.ui.entry),
    hasBackend: Boolean(def.backend),
    summary: def.isInternal === false ? summarize(def, { size: def.fileCount || 0 }) : null
  };
}

async function list(req) {
  const defs = await listDefinitions(req);
  let activeId = getDefaultExtensionDef().id;
  try {
    const SettingService = require('./setting.service');
    const settings = await SettingService.getAll(req);
    activeId = resolveActiveExtensionIdFrom(settings, defs);
  } catch {
    /* default stays */
  }
  return {
    activeExtensionId: activeId,
    extensions: defs.map((def) => serialize(def, activeId))
  };
}

/* ------------------------------------------------------------- request types */

/**
 * Make the extension's Request Type the enabled one and switch the other
 * extension-owned types off. Custom or CMS-extension types are left untouched.
 */
async function syncRequestTypes(req, def) {
  const RequestType = req.cms?.models?.get?.('RequestType');
  if (!RequestType || typeof RequestType.updateMany !== 'function') return;

  const RequestTypeService = require('./request-type.service');
  if (typeof RequestTypeService.ensureDefaults === 'function') {
    await RequestTypeService.ensureDefaults(req);
  }

  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req) || 'system';
  const allKeys = await getRequestTypeKeys(req);
  const otherKeys = [...allKeys].filter((key) => key !== def.requestTypeKey);

  /*
   * A tenant seeded before this extension existed has no row for its request
   * type, and `ensureDefaults` only seeds an empty collection. Create it here
   * from the system seed (same fields as a fresh install) or, for an
   * extension that ships its own form, from `def.requestTypeFields`.
   */
  if (typeof RequestType.findOne === 'function' && typeof RequestType.create === 'function') {
    const existing = await leanResult(
      RequestType.findOne({ tenantId, isDeleted: false, key: def.requestTypeKey })
    );
    if (!existing) {
      let seed = null;
      try {
        const seeds = RequestTypeService.defaultSystemTypes ? RequestTypeService.defaultSystemTypes({}) : [];
        seed = seeds.find((item) => item.key === def.requestTypeKey) || null;
      } catch {
        seed = null;
      }
      const fields = Array.isArray(def.requestTypeFields) && def.requestTypeFields.length
        ? def.requestTypeFields
        : seed?.fields || [];
      await RequestType.create({
        tenantId,
        key: def.requestTypeKey,
        name: def.requestTypeName || seed?.name || def.requestTypeKey,
        description: seed?.description || `Request type of the ${def.name} extension`,
        isEnabled: true,
        isSystem: true,
        fields,
        sortOrder: seed?.sortOrder || 30,
        createdBy: userId,
        updatedBy: userId,
        isDeleted: false
      });
    }
  }

  await RequestType.updateMany(
    { tenantId, isDeleted: false, key: def.requestTypeKey },
    { $set: { isEnabled: true, updatedBy: userId } }
  );
  if (otherKeys.length) {
    await RequestType.updateMany(
      { tenantId, isDeleted: false, key: { $in: otherKeys } },
      { $set: { isEnabled: false, updatedBy: userId } }
    );
  }
}

/* ----------------------------------------------------------------- pipelines */

/**
 * Find or seed the extension's pipeline, then activate it.
 *
 * The product extension adopts the tenant's built-in Default Pipeline (its
 * stages already describe a product sale) so switching back never leaves a
 * duplicate behind. Other extensions get their own keyed pipeline.
 */
async function syncPipeline(req, def) {
  const OpportunityPipeline = req.cms?.models?.get?.('OpportunityPipeline');
  if (!OpportunityPipeline) return null;

  const PipelineService = require('./opportunity-pipeline.service');
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req) || 'system';
  const base = { tenantId, isDeleted: false };

  await PipelineService.ensureDefaultPipeline(req);

  let pipeline = await leanResult(OpportunityPipeline.findOne({ ...base, pipelineKey: def.pipelineKey }));

  if (!pipeline && def.adoptDefaultPipeline) {
    const fallback = await leanResult(OpportunityPipeline.findOne({ ...base, isDefault: true }));
    if (fallback) {
      await OpportunityPipeline.updateOne(
        { _id: fallback._id },
        {
          $set: {
            pipelineKey: def.pipelineKey,
            extensionId: `crm:${def.id}`,
            updatedBy: userId
          }
        }
      );
      pipeline = { ...fallback, pipelineKey: def.pipelineKey, extensionId: `crm:${def.id}` };
    }
  }

  if (!pipeline) {
    const created = await OpportunityPipeline.create({
      tenantId,
      name: def.pipelineName,
      description: def.pipelineDescription || '',
      pipelineKey: def.pipelineKey,
      extensionId: `crm:${def.id}`,
      isDefault: false,
      isActive: false,
      isEnabled: true,
      quotationWorkflowEnabled: true,
      stages: (def.pipelineStages || []).map((stage) => ({ ...stage })),
      createdBy: userId,
      updatedBy: userId
    });
    pipeline = typeof created?.toObject === 'function' ? created.toObject() : created;
  }

  if (!pipeline.isActive) {
    if (pipeline.isEnabled === false) {
      await OpportunityPipeline.updateOne(
        { _id: pipeline._id },
        { $set: { isEnabled: true, updatedBy: userId } }
      );
    }
    return PipelineService.activate(req, pipeline._id);
  }
  return pipeline;
}

/* ------------------------------------------------------------------ enabling */

async function audit(req, description, metadata) {
  try {
    const AuditService = require('./audit.service');
    await AuditService.log(req, {
      action: 'updated',
      module: 'settings',
      recordId: resolveTenantId(req),
      description,
      metadata
    });
  } catch {
    /* audit is best-effort */
  }
}

async function enable(req, id) {
  forgetActive(req);
  const def = await getDefinition(req, id);
  if (!def) throw appError('Unknown CRM extension', 404, { code: 'EXTENSION_NOT_FOUND' });
  if (def.isInternal === false && def.filesAvailable === false) {
    throw appError(
      `The files of ${def.name} v${def.version} are missing from the plugin folder (a plugin update removes them). Upload the package again, then enable it.`,
      409,
      { code: 'EXTENSION_FILES_MISSING' }
    );
  }

  const SettingService = require('./setting.service');
  const previousId = await getActiveExtensionId(req);

  const previousDef = previousId && previousId !== def.id ? await getDefinition(req, previousId) : null;

  await SettingService.upsertSettingValue(req, 'active_extension', def.id);
  await syncRequestTypes(req, def);
  const pipeline = await syncPipeline(req, def);

  // Seam for Step 2 (json/ declarations); owned by crm-extension-declarations.service.js.
  let declarationsApplied = null;
  try {
    const DeclarationsService = require('./crm-extension-declarations.service');
    declarationsApplied = await DeclarationsService.applyOnEnable(req, def, previousDef);
  } catch (error) {
    declarationsApplied = { applied: false, error: error?.message || String(error) };
  }

  require('../extension-runtime/package-folder').writeActive(resolveTenantId(req), def, req.cms?.logger);

  await audit(
    req,
    `CRM extension enabled: ${def.name}${previousId && previousId !== def.id ? ` (replaced ${previousId})` : ''}`,
    { activeExtension: def.id, previousExtension: previousId, declarations: declarationsApplied }
  );

  return {
    ...serialize(def, def.id),
    previousExtensionId: previousId,
    pipelineId: pipeline?._id ? String(pipeline._id) : null
  };
}

/**
 * Disabling the active extension returns the tenant to the default one.
 * Disabling an extension that is not active is a no-op; disabling the
 * default is refused because one extension must always be active.
 */
async function disable(req, id) {
  forgetActive(req);
  const def = await getDefinition(req, id);
  if (!def) throw appError('Unknown CRM extension', 404, { code: 'EXTENSION_NOT_FOUND' });
  if (def.isDefault) {
    throw appError(
      `${def.name} is the default extension and stays enabled whenever no other extension is active.`,
      409,
      { code: 'DEFAULT_EXTENSION_LOCKED' }
    );
  }
  const activeId = await getActiveExtensionId(req);
  if (activeId !== def.id) {
    return { ...serialize(def, activeId), previousExtensionId: activeId, pipelineId: null };
  }
  return enable(req, getDefaultExtensionDef().id);
}

/* ------------------------------------------------------------------- packages */

function decodePackage(body) {
  const fileName = String(body?.fileName || 'extension.zip').trim() || 'extension.zip';
  const raw = String(body?.contentBase64 || '').trim();
  if (!raw) throw appError('No package content received', 400, { code: 'EMPTY_PACKAGE' });
  // Accept a data URL as well as bare base64.
  const base64 = raw.includes(',') && raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  // Base64 inflates by 4/3; reject early before decoding something huge.
  if (base64.length > Math.ceil((MAX_PACKAGE_BYTES * 4) / 3) + 4) {
    throw appError(`Package exceeds the ${MAX_PACKAGE_BYTES / (1024 * 1024)} MB limit`, 413, {
      code: 'PACKAGE_TOO_LARGE'
    });
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw appError('Package content is not valid base64', 400, { code: 'EMPTY_PACKAGE' });
  if (buffer.length > MAX_PACKAGE_BYTES) {
    throw appError(`Package exceeds the ${MAX_PACKAGE_BYTES / (1024 * 1024)} MB limit`, 413, {
      code: 'PACKAGE_TOO_LARGE'
    });
  }
  if (!/\.zip$/i.test(fileName)) {
    throw appError('Only .zip extension packages are supported', 400, { code: 'INVALID_PACKAGE' });
  }
  return { fileName, buffer };
}

function systemRequestTypeKeys() {
  try {
    const RequestTypeService = require('./request-type.service');
    const seeds = RequestTypeService.defaultSystemTypes ? RequestTypeService.defaultSystemTypes({}) : [];
    return new Set(seeds.map((seed) => seed.key));
  } catch {
    return new Set(['product', 'project_software']);
  }
}

/**
 * Validate an uploaded package without storing it.
 * Returns `{ ok, errors, warnings, definition, fileName, fileSize, checksum }`.
 */
async function validatePackage(req, body) {
  const { fileName, buffer } = decodePackage(body);
  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

  let entries;
  try {
    entries = readZipEntries(buffer, ZIP_LIMITS);
  } catch (error) {
    return {
      ok: false,
      errors: [error.message],
      warnings: [],
      definition: null,
      fileName,
      fileSize: buffer.length,
      checksum
    };
  }

  const picked = pickPackageFiles(entries);
  const errors = [...picked.errors];
  const manifest = picked.manifestText ? parseJson(picked.manifestText, 'crm-extension.json', errors) : null;
  const requestType = picked.requestTypeText
    ? parseJson(picked.requestTypeText, 'request-type.json', errors)
    : null;
  if (!manifest || errors.length) {
    return { ok: false, errors, warnings: [], definition: null, fileName, fileSize: buffer.length, checksum };
  }

  const defs = await listDefinitions(req);
  const candidateId = String(manifest.id || '')
    .trim()
    .toLowerCase();
  const existingUpload = defs.find((def) => def.id === candidateId && def.isInternal === false) || null;
  const systemKeys = systemRequestTypeKeys();
  const context = {
    builtinIds: new Set(CRM_EXTENSIONS.map((def) => def.id)),
    takenPipelineKeys: new Set(
      defs
        .filter((def) => def.id !== candidateId)
        .map((def) => String(def.pipelineKey || '').toLowerCase())
        .filter(Boolean)
    ),
    systemRequestTypeKeys: systemKeys,
    knownRequestTypeKeys: new Set([
      ...systemKeys,
      ...defs.map((def) => String(def.requestTypeKey || '').toLowerCase()).filter(Boolean),
      ...(await tenantRequestTypeKeys(req))
    ]),
    existingUpload: existingUpload ? { id: existingUpload.id, version: existingUpload.version } : null
  };

  const result = validatePackageDefinition(manifest, requestType, context, picked.files);
  const readme = picked.files.get('README.md');
  const changelog = picked.files.get('CHANGELOG.md');
  const fileIndex = [...picked.files.entries()].map(([path, data]) => ({
    path,
    area: path.includes('/') ? path.split('/')[0] : 'root',
    size: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    contentType: contentTypeFor(path)
  }));

  return {
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings,
    definition: result.definition,
    summary: result.summary || null,
    requiresTrust: Boolean(result.definition?.requiresTrust),
    fileName,
    fileSize: buffer.length,
    checksum,
    files: fileIndex,
    readme: readme ? readme.toString('utf8').slice(0, 20000) : '',
    changelog: changelog ? changelog.toString('utf8').slice(0, 20000) : '',
    replaces: existingUpload ? existingUpload.version : null,
    // Not serialised to the client; used by installPackage to store the files.
    _files: picked.files
  };
}

/** Request type keys this tenant already has (custom ones included). Never throws. */
async function tenantRequestTypeKeys(req) {
  try {
    const RequestType = req.cms?.models?.get?.('RequestType');
    if (!RequestType || typeof RequestType.find !== 'function') return [];
    const rows = (await leanResult(RequestType.find({ tenantId: resolveTenantId(req), isDeleted: false }))) || [];
    return rows.map((row) => String(row.key || '').toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Strip server-only fields before answering a validate request. */
function toClientValidation(validated) {
  const { _files, ...rest } = validated;
  void _files;
  return rest;
}

/**
 * Write the package files to openext-crm-suite/extensions/<tenant>/<id>/<version>/.
 * The plugin folder is the only place the files are kept. Throws 500 when the
 * folder cannot be written, so nothing is recorded for a package without files.
 */
function writePackageFolder(req, def, validated) {
  const PackageFolder = require('../extension-runtime/package-folder');
  const files = validated._files instanceof Map ? validated._files : new Map();
  const result = PackageFolder.writePackage(
    resolveTenantId(req),
    { ...def, checksum: validated.checksum },
    files,
    req.cms?.logger,
    { keepOtherVersions: true }
  );
  if (!result.ok) {
    throw appError(
      `The extension could not be saved in the plugin folder: ${result.error}. Check that the CMS can write to the plugin directory.`,
      500,
      { code: 'EXTENSION_FOLDER_WRITE_FAILED' }
    );
  }
  return files.size;
}

/** Validate and store the package. The extension is installed as Disabled. */
async function installPackage(req, body) {
  forgetActive(req);
  const Model = getUploadModel(req);
  if (!Model) throw appError('CrmExtension model is not registered', 500);

  const validated = await validatePackage(req, body);
  if (!validated.ok) {
    throw appError('Extension package was rejected', 422, {
      code: 'INVALID_PACKAGE',
      details: validated.errors,
      warnings: validated.warnings
    });
  }

  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req) || 'system';
  const def = validated.definition;

  const existing = await leanResult(Model.findOne({ tenantId, extensionId: def.id, isDeleted: false }));

  // Files first: a record is only written for a package whose folder exists.
  const storedFiles = writePackageFolder(req, def, validated);

  /*
   * Trust gate: backend code loads only after an admin approves this exact
   * checksum. A re-upload keeps "approved" only when the bytes are identical
   * (which the version rule normally prevents), otherwise it is pending again.
   */
  const requiresTrust = Boolean(def.requiresTrust);
  const keepsApproval =
    requiresTrust && existing && existing.trust === 'approved' && existing.approvedChecksum === validated.checksum;
  const trustFields = {
    requiresTrust,
    trust: !requiresTrust ? 'n/a' : keepsApproval ? 'approved' : 'pending',
    backendStatus: requiresTrust ? 'unloaded' : 'n/a',
    backendError: '',
    backendLoadedAt: null,
    ...(keepsApproval ? {} : { approvedChecksum: '', approvedBy: null, approvedAt: null })
  };
  const packageFields = {
    name: def.name,
    version: def.version,
    definition: def,
    manifestVersion: def.manifestVersion || 1,
    capabilities: def.capabilities || [],
    checksum: validated.checksum,
    fileName: validated.fileName,
    fileSize: validated.fileSize,
    fileCount: validated.files.length,
    fileIndex: validated.files,
    readme: validated.readme || '',
    changelog: validated.changelog || '',
    updatedBy: userId,
    ...trustFields
  };

  const PackageFolder = require('../extension-runtime/package-folder');
  let row;
  try {
    if (existing) {
      row = await leanResult(
        Model.findOneAndUpdate(
          { _id: existing._id },
          { $set: { ...packageFields, previousVersion: existing.version || null } },
          { new: true }
        )
      );
    } else {
      const created = await Model.create({
        tenantId,
        extensionId: def.id,
        previousVersion: null,
        installedBy: userId,
        isDeleted: false,
        ...packageFields
      });
      row = typeof created?.toObject === 'function' ? created.toObject() : created;
    }
  } catch (error) {
    // Keep disk and database consistent: drop the folder of the version that was not recorded.
    if (!existing || existing.version !== def.version) {
      PackageFolder.removeVersion(tenantId, def.id, def.version, req.cms?.logger);
    }
    throw error;
  }

  // The new version is recorded; older version folders are no longer needed.
  PackageFolder.pruneOtherVersions(tenantId, def.id, def.version, req.cms?.logger);
  invalidateBackend(tenantId, def.id);

  // Stages the previous version contributed but this one dropped leave the extension's pipeline;
  // their opportunities move to the stage before. Best-effort: never fails the upload.
  let stageChanges = [];
  if (existing) {
    const oldStages = ((existing.definition && existing.definition.pipelineStages) || []).filter((s) => s && s.id);
    const newIds = new Set((def.pipelineStages || []).map((s) => String(s && s.id)));
    const newLabels = new Set((def.pipelineStages || []).map((s) => String((s && s.label) || '').trim().toLowerCase()));
    const dropped = oldStages.filter((s) => !newIds.has(String(s.id)));
    if (dropped.length) {
      try {
        stageChanges = await require('./opportunity-pipeline.service').removeExtensionStages(req, {
          extensionId: def.id,
          pipelineKey: def.pipelineKey,
          stageIds: dropped.map((s) => String(s.id)),
          // Same stage under another id after an admin edit; a label the new version still uses is kept.
          stageLabels: dropped.map((s) => String(s.label || '')).filter((l) => l && !newLabels.has(l.trim().toLowerCase()))
        });
      } catch (error) {
        console.warn('[plugin:openext-crm-suite] could not remove dropped pipeline stages:', (error && error.message) || error);
      }
    }
    // Stages this version adds join the tenant's existing pipeline (after the stage before them).
    const oldIds = new Set(oldStages.map((s) => String(s.id)));
    const addedStages = (def.pipelineStages || []).filter((s) => s && s.id && !oldIds.has(String(s.id)));
    if (addedStages.length) {
      try {
        const added = await require('./opportunity-pipeline.service').addExtensionStages(req, {
          extensionId: def.id,
          pipelineKey: def.pipelineKey,
          stages: def.pipelineStages
        });
        if (added.length) stageChanges = stageChanges.concat(added.map((a) => ({ ...a, kind: 'added' })));
      } catch (error) {
        console.warn('[plugin:openext-crm-suite] could not add new pipeline stages:', (error && error.message) || error);
      }
    }
  }

  await audit(
    req,
    `CRM extension ${existing ? 'updated' : 'installed'}: ${def.name} v${def.version}`,
    {
      extensionId: def.id,
      version: def.version,
      previousVersion: existing?.version || null,
      checksum: validated.checksum,
      files: storedFiles,
      requiresTrust,
      trust: trustFields.trust
    }
  );

  const activeId = await getActiveExtensionId(req);
  return {
    ...serialize(
      fromUploadRow(row || { extensionId: def.id, definition: def, version: def.version, ...packageFields }),
      activeId
    ),
    warnings: validated.warnings,
    summary: validated.summary,
    replacedVersion: existing?.version || null,
    stageChanges,
    storedFiles
  };
}

/** Remove an uploaded package. Built-ins and the active extension are refused. */
async function uninstall(req, id) {
  forgetActive(req);
  const def = await getDefinition(req, id);
  if (!def) throw appError('Unknown CRM extension', 404, { code: 'EXTENSION_NOT_FOUND' });
  if (def.isInternal !== false) {
    throw appError(`${def.name} is built in and cannot be uninstalled`, 409, { code: 'BUILTIN_EXTENSION' });
  }
  const activeId = await getActiveExtensionId(req);
  if (activeId === def.id) {
    throw appError(
      `${def.name} is the active extension. Enable another extension first, then uninstall it.`,
      409,
      { code: 'EXTENSION_ACTIVE' }
    );
  }

  const Model = getUploadModel(req);
  if (!Model) throw appError('CrmExtension model is not registered', 500);
  const tenantId = resolveTenantId(req);
  const userId = resolveUserId(req) || 'system';
  await Model.updateOne(
    { tenantId, extensionId: def.id, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId, updatedBy: userId } }
  );
  require('../extension-runtime/package-folder').removePackage(tenantId, def.id, req.cms?.logger);

  await audit(req, `CRM extension uninstalled: ${def.name} v${def.version}`, {
    extensionId: def.id,
    version: def.version
  });

  invalidateBackend(tenantId, def.id);
  return { id: def.id, name: def.name, version: def.version, uninstalled: true };
}

/* ---------------------------------------------------------------- trust gate */

function invalidateBackend(tenantId, extensionId) {
  try {
    require('../extension-runtime/loader').invalidate(tenantId, extensionId);
  } catch {
    /* the runtime may not be loaded in some tests */
  }
}

async function getUploadRow(req, id) {
  const Model = getUploadModel(req);
  if (!Model) throw appError('CrmExtension model is not registered', 500);
  const extensionId = String(id || '').trim().toLowerCase();
  const row = await leanResult(Model.findOne({ tenantId: resolveTenantId(req), extensionId, isDeleted: false }));
  if (!row) {
    const builtin = CRM_EXTENSIONS.some((def) => def.id === extensionId);
    throw appError(
      builtin ? 'Built-in extensions have no uploaded backend' : 'Unknown CRM extension',
      builtin ? 409 : 404,
      { code: builtin ? 'BUILTIN_EXTENSION' : 'EXTENSION_NOT_FOUND' }
    );
  }
  return { Model, row };
}

/**
 * Allow the uploaded backend code of exactly this upload (checksum) to run.
 * Body may carry `{ checksum }`; when given it must match, so an admin never
 * approves a package that was replaced after they reviewed it.
 */
async function approveBackend(req, id, body = {}) {
  forgetActive(req);
  const { Model, row } = await getUploadRow(req, id);
  if (!row.requiresTrust) {
    throw appError(`${row.name} ships no backend code; there is nothing to approve`, 409, { code: 'NO_BACKEND_CODE' });
  }
  const expected = String((body && body.checksum) || '').trim();
  if (expected && expected !== row.checksum) {
    throw appError('The package changed since you reviewed it. Reload the page and review it again.', 409, {
      code: 'CHECKSUM_MISMATCH'
    });
  }
  const userId = resolveUserId(req) || 'system';
  const tenantId = resolveTenantId(req);
  await Model.updateOne(
    { _id: row._id },
    {
      $set: {
        trust: 'approved',
        approvedChecksum: row.checksum,
        approvedBy: userId,
        approvedAt: new Date(),
        backendStatus: 'unloaded',
        backendError: '',
        updatedBy: userId
      }
    }
  );
  invalidateBackend(tenantId, row.extensionId);
  await audit(req, `CRM extension backend approved: ${row.name} v${row.version}`, {
    extensionId: row.extensionId,
    version: row.version,
    checksum: row.checksum
  });
  return serialize(
    fromUploadRow({ ...row, trust: 'approved', approvedChecksum: row.checksum, approvedBy: userId, backendStatus: 'unloaded' }),
    await getActiveExtensionId(req)
  );
}

/** Stop the uploaded backend from running. Declarations, UI and JSON models keep working. */
async function revokeBackend(req, id) {
  forgetActive(req);
  const { Model, row } = await getUploadRow(req, id);
  if (!row.requiresTrust) {
    throw appError(`${row.name} ships no backend code`, 409, { code: 'NO_BACKEND_CODE' });
  }
  const userId = resolveUserId(req) || 'system';
  const tenantId = resolveTenantId(req);
  await Model.updateOne(
    { _id: row._id },
    {
      $set: {
        trust: 'revoked',
        approvedChecksum: '',
        backendStatus: 'unloaded',
        backendError: '',
        updatedBy: userId
      }
    }
  );
  invalidateBackend(tenantId, row.extensionId);
  await audit(req, `CRM extension backend revoked: ${row.name} v${row.version}`, {
    extensionId: row.extensionId,
    version: row.version
  });
  return serialize(
    fromUploadRow({ ...row, trust: 'revoked', approvedChecksum: '', backendStatus: 'unloaded' }),
    await getActiveExtensionId(req)
  );
}

module.exports = {
  MAX_PACKAGE_BYTES,
  approveBackend,
  revokeBackend,
  ZIP_LIMITS,
  toClientValidation,
  list,
  listDefinitions,
  getDefinition,
  getRequestTypeKeys,
  resolveActiveDefinition,
  getActive,
  getActiveExtensionId,
  getActiveFeaturePayload,
  enable,
  disable,
  validatePackage,
  installPackage,
  uninstall,
  serialize,
  syncRequestTypes,
  syncPipeline
};
