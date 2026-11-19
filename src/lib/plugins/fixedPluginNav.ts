/**
 * Fixed sidebar menus for specific uploaded plugins.
 *
 * When a plugin is listed here, the CMS sidebar shows exactly these links for it
 * (in this order) instead of its manifest adminNav and any dynamic nav.
 *
 * Users with a restricted plugin page access (e.g. client portal logins) are not
 * affected: they keep the normal, permission-filtered navigation.
 *
 * The CRM is not listed: its menu comes from the installed version's manifest adminNav
 * plus GET /admin-nav (active extension pages, hidden modules), so a new CRM or
 * extension version updates the sidebar without a CMS change.
 */
import type { LucideIcon } from 'lucide-react';

export interface FixedPluginNavLink {
  label: string;
  icon: LucideIcon;
  path: string;
}

export const FIXED_PLUGIN_NAV: Readonly<Record<string, readonly FixedPluginNavLink[]>> = {};

/** Attribute on the sidebar <nav> naming the plugins whose menu is fixed. */
export const FIXED_PLUGIN_NAV_ATTRIBUTE = 'data-fixed-plugin-nav';
