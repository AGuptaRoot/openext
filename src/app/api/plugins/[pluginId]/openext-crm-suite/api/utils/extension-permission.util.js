'use strict';

/**
 * Permission checks for keys an uploaded CRM workspace extension defines
 * (`x.<extensionId>.<name>`, declared in crm-extension.json permissions.defines).
 *
 * Shared contract (see documentation/crm-upload-plan/00-CONTRACTS.md):
 *   - A user has an extension key when their resolved permissions contain it
 *     or "*".
 *   - Until roles can be granted x.* keys in Settings → Users, every holder
 *     of `crm.settings.manage` has all x.* keys implicitly.
 *   - A defined key may name a core permission it comes with
 *     (permissions.defines[].grantedWith), e.g. "manage bookings" with
 *     crm.leads.write: everyone holding that core key holds the extension key.
 *   - Core `crm.*` keys behave exactly as before.
 *
 * Used by the extension runtime routes (backend) and mirrored by
 * `useActiveExtension().canUse()` in the admin UI.
 */

const EXTENSION_KEY_RE = /^x\.[a-z][a-z0-9_-]{2,31}\.[a-z0-9_.]{2,60}$/;
const ADMIN_PERMISSION = 'crm.settings.manage';

function isExtensionPermission(key) {
  return EXTENSION_KEY_RE.test(String(key || ''));
}

/**
 * @param {string[]} permissions resolved permissions of the user (req.permissions)
 * @param {string} key           permission to test; empty means "no permission needed"
 */
function hasExtensionPermission(permissions, key, grants) {
  const wanted = String(key || '').trim();
  if (!wanted) return true;
  const list = Array.isArray(permissions) ? permissions : [];
  if (list.includes('*') || list.includes(wanted)) return true;
  if (!isExtensionPermission(wanted)) return false;
  if (list.includes(ADMIN_PERMISSION)) return true;
  const core = grants && grants[wanted];
  return Boolean(core && list.includes(core));
}

/** { <extension key>: <core key> } from an extension definition's permissions.defines[].grantedWith. */
function grantsOf(def) {
  const out = {};
  for (const d of (def && def.permissions && Array.isArray(def.permissions.defines) ? def.permissions.defines : [])) {
    if (d && d.key && d.grantedWith) out[d.key] = d.grantedWith;
  }
  return out;
}

/**
 * Same check against an Express-like request (uses req.permissions, then req.user.permissions).
 * Pass the extension definition when checking its own keys so grantedWith applies.
 */
function requestHasPermission(req, key, def) {
  const list = Array.isArray(req?.permissions)
    ? req.permissions
    : Array.isArray(req?.user?.permissions)
      ? req.user.permissions
      : [];
  return hasExtensionPermission(list, key, def ? grantsOf(def) : null);
}

module.exports = {
  EXTENSION_KEY_RE,
  ADMIN_PERMISSION,
  isExtensionPermission,
  hasExtensionPermission,
  grantsOf,
  requestHasPermission
};
