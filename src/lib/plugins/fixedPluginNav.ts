/**
 * Fixed sidebar menus for specific uploaded plugins.
 *
 * When a plugin is listed here, the CMS sidebar shows exactly these links for it
 * (in this order) instead of its manifest adminNav and any dynamic nav. Used for the
 * CRM so its Travel Agency pages show from the first page load on every dashboard page.
 *
 * Users with a restricted plugin page access (e.g. client portal logins) are not
 * affected: they keep the normal, permission-filtered navigation.
 *
 * To go back to the CRM's own navigation, remove its entry.
 */
import {
  BarChart3,
  CalendarCheck,
  Contact,
  FileSpreadsheet,
  FileText,
  History,
  Layers,
  LayoutDashboard,
  Plane,
  Settings,
  TrendingUp,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { runtimePluginPath } from '@/lib/plugins/adminNav';

export interface FixedPluginNavLink {
  label: string;
  icon: LucideIcon;
  path: string;
}

const CRM_PLUGIN_ID = 'openext-crm-suite';
const crm = (subPath: string) => `${runtimePluginPath(CRM_PLUGIN_ID)}/${subPath}`;

export const FIXED_PLUGIN_NAV: Readonly<Record<string, readonly FixedPluginNavLink[]>> = {
  [CRM_PLUGIN_ID]: [
    { label: 'Dashboard', icon: LayoutDashboard, path: crm('dashboard') },
    { label: 'Reports', icon: BarChart3, path: crm('reports') },
    { label: 'Leads', icon: UserPlus, path: crm('leads') },
    { label: 'Contacts', icon: Contact, path: crm('contacts') },
    { label: 'Clients', icon: Users, path: crm('clients') },
    { label: 'Opportunities', icon: TrendingUp, path: crm('opportunities') },
    { label: 'Quotations', icon: FileText, path: crm('quotations') },
    { label: 'Invoices', icon: FileSpreadsheet, path: crm('invoices') },
    { label: 'Audit History', icon: History, path: crm('audit') },
    { label: 'Settings', icon: Settings, path: crm('settings') },
    // Travel Agency extension pages (extension "travel").
    { label: 'Travellers', icon: Plane, path: crm('extension/travel/travellers') },
    { label: 'Bookings', icon: CalendarCheck, path: crm('extension/travel/bookings') },
    { label: 'Services & Forms', icon: Layers, path: crm('extension/travel/services') },
  ],
};

/** Attribute on the sidebar <nav> naming the plugins whose menu is fixed. */
export const FIXED_PLUGIN_NAV_ATTRIBUTE = 'data-fixed-plugin-nav';
