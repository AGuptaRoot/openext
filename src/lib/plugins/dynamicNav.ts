/**
 * Dynamic admin navigation contributed by an uploaded plugin's backend.
 *
 * Contract: a plugin may implement `GET /api/plugins/{pluginId}/admin-nav` returning
 *   { "data": { "add": [{ "id", "label", "icon"?, "path" }], "hide": ["<adminNav id>", ...] } }
 * (a top-level object without `data` is accepted too).
 *
 * - `add[].path` is relative to the plugin runtime page, e.g. "extension/travel/travellers"
 *   → /dashboard/plugins/runtime/{pluginId}/extension/travel/travellers
 * - `hide` lists static adminNav ids (from the manifest) to leave out of the sidebar.
 * - The plugin filters both lists for the requesting user; the CMS only renders them.
 *
 * Plugins without the route (404) keep their manifest navigation unchanged.
 */
import { runtimePluginPath } from '@/lib/plugins/adminNav';

export interface PluginDynamicNavItem {
  id: string;
  label: string;
  icon?: string;
  /** Absolute dashboard path, already resolved under the plugin runtime page. */
  path: string;
}

export interface PluginDynamicNav {
  add: PluginDynamicNavItem[];
  hide: string[];
}

/** Window event a plugin dispatches when its navigation changed (e.g. extension switched). */
export const PLUGIN_NAV_CHANGED_EVENT = 'cms:plugin-nav-changed';

/** Set on <html> so plugin UIs know the host renders dynamic nav natively. */
export const NATIVE_PLUGIN_NAV_ATTRIBUTE = 'data-cms-native-plugin-nav';

export const EMPTY_DYNAMIC_NAV: PluginDynamicNav = { add: [], hide: [] };

const MAX_ITEMS = 50;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Resolve a plugin-relative path; reject anything that could leave the plugin runtime page. */
export function resolveDynamicNavPath(pluginId: string, rawPath: string): string | null {
  const segments = rawPath.replace(/^\/+|\/+$/g, '').split('/');
  if (!segments.length || segments.length > 6) return null;
  if (!segments.every((segment) => SAFE_SEGMENT.test(segment))) return null;
  return `${runtimePluginPath(pluginId)}/${segments.map(encodeURIComponent).join('/')}`;
}

/** Validate an untrusted admin-nav payload. Invalid entries are dropped, never thrown. */
export function parsePluginDynamicNav(pluginId: string, payload: unknown): PluginDynamicNav {
  const root = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const body =
    root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root;

  const add: PluginDynamicNavItem[] = [];
  const seenPaths = new Set<string>();
  for (const raw of Array.isArray(body.add) ? body.add.slice(0, MAX_ITEMS) : []) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = asString(item.id);
    const label = asString(item.label).slice(0, 80);
    const path = resolveDynamicNavPath(pluginId, asString(item.path));
    if (!SAFE_ID.test(id) || !label || !path || seenPaths.has(path)) continue;
    seenPaths.add(path);
    const icon = asString(item.icon).slice(0, 40);
    add.push(icon ? { id, label, icon, path } : { id, label, path });
  }

  const hide = (Array.isArray(body.hide) ? body.hide.slice(0, MAX_ITEMS) : [])
    .map(asString)
    .filter((id) => SAFE_ID.test(id));

  return { add, hide };
}
