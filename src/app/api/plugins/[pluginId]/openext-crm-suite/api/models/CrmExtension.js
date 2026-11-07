'use strict';

const { Schema } = require('mongoose');

/**
 * An uploaded CRM workspace extension (Settings → Extensions → Upload).
 *
 * The validated `definition` has the same shape as a built-in registry entry
 * in api/crm-extensions.js (plus the manifestVersion 2 sections: declarations,
 * ui, backend, permissions), so the service treats both alike. One row per
 * tenant and extension id; an update replaces the definition in place and
 * keeps the previous version for reference.
 *
 * Package files are NOT stored in the database. They live only in the plugin
 * folder extensions/<tenant>/<extensionId>/<version>/ (api/extension-runtime/
 * package-folder.js). This row is the record: identity, version, checksum,
 * the per-file sha256 index used to verify the folder, and the trust state.
 * When the folder is missing (a CMS plugin update wipes it) the extension is
 * treated as not found and the workspace falls back to the default extension.
 *
 * Trust: a package that ships backend code (`requiresTrust`) is stored with
 * `trust: "pending"`. Its declarations and UI work at once; its api/ stays
 * unloaded until an admin approves exactly this checksum. A new upload with a
 * different checksum returns trust to "pending".
 */
const FileIndexSchema = new Schema(
  {
    path: { type: String, required: true, trim: true },
    area: { type: String, required: true, enum: ['root', 'json', 'ui', 'api'] },
    size: { type: Number, default: 0 },
    sha256: { type: String, trim: true, default: '' },
    contentType: { type: String, trim: true, default: '' }
  },
  { _id: false }
);

const CrmExtensionSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true, index: true },
    /** Registry id — lowercase, immutable across versions. */
    extensionId: { type: String, required: true, trim: true, lowercase: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    version: { type: String, required: true, trim: true, maxlength: 20 },
    previousVersion: { type: String, trim: true, default: null },
    /** Validated package definition (see crm-extension-package.schema.js). */
    definition: { type: Schema.Types.Mixed, required: true },
    manifestVersion: { type: Number, default: 1 },
    capabilities: { type: [String], default: [] },
    /** SHA-256 of the uploaded zip, to tell re-uploads apart. */
    checksum: { type: String, trim: true, default: '' },
    fileName: { type: String, trim: true, default: '' },
    fileSize: { type: Number, default: 0 },
    fileCount: { type: Number, default: 0 },
    fileIndex: { type: [FileIndexSchema], default: [] },
    /** README.md / CHANGELOG.md from the package, if any (shown on the card details). */
    readme: { type: String, default: '' },
    changelog: { type: String, default: '' },

    /** Backend trust gate. */
    requiresTrust: { type: Boolean, default: false },
    trust: { type: String, enum: ['n/a', 'pending', 'approved', 'revoked'], default: 'n/a' },
    approvedChecksum: { type: String, trim: true, default: '' },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    /** Runtime state of the backend loader for this tenant. */
    backendStatus: { type: String, enum: ['n/a', 'unloaded', 'loaded', 'failed'], default: 'n/a' },
    backendError: { type: String, default: '' },
    backendLoadedAt: { type: Date, default: null },

    installedBy: { type: String, default: 'system' },
    updatedBy: { type: String, default: 'system' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }
  },
  {
    collection: 'plugin_openext_crm_suite_crm_extensions',
    timestamps: true
  }
);

CrmExtensionSchema.index(
  { tenantId: 1, extensionId: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false }, name: 'crm_extension_tenant_id' }
);

module.exports = {
  name: 'CrmExtension',
  schema: CrmExtensionSchema
};
