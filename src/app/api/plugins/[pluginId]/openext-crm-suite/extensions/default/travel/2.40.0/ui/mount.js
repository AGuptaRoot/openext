/**
 * Travel Agency extension UI (Root CRM workspace extension "travel").
 *
 * Entry only: picks the web component for the CRM slot and hands it ctx.
 *
 *   ui/
 *     mount.js                       this file
 *     style.css                      shared base styles (loaded by the CRM)
 *     shared/                        dom helpers, field inputs, base element, style loader
 *     components/<name>/<name>.js    one web component per page or tab, with its own .css
 *
 * Slots (declared in json/settings.json, json/navigation.json and json/tabs.json):
 *   page.travel_services           Services & Forms page    → <x-travel-service-builder-v1>
 *   settings.travel.admin          Settings → Travel, below the form: orphaned travellers → <x-travel-settings-admin-v1>
 *   lead.tab.travel_requirement    Lead → Travel Requirement → <x-travel-lead-requirements-v1>
 *   lead.tab.travellers            Lead → Travellers         → <x-travel-lead-travellers-v1>
 *   page.travellers                Travellers page (sidebar) → <x-travel-travellers-page-v1>
 *   contact.tab.travellers         Contact → Travellers      → <x-travel-contact-travellers-v1>
 *   page.bookings                  Bookings page (sidebar)   → <x-travel-bookings-page-v1>
 *   page.itinerary                 Itinerary page (?id=)     → <x-travel-itinerary-page-v1>
 *   quotation.tab.travel           Quotation → Booking & itinerary → <x-travel-quotation-travel-v1>
 *   lead.tab.bookings              Lead → Bookings           → <x-travel-lead-bookings-v1>
 *   client.tab.bookings            Client → Bookings         → <x-travel-lead-bookings-v1> (client mode)
 *   client.tab.travellers          Client → Travellers       → <x-travel-client-travellers-v1>
 *   client.tab.travel_requirement  Client → Travel Requirement → <x-travel-client-travel-requirement-v1>
 *   opportunity.tab.trip           Opportunity → Trip        → <x-travel-opportunity-trip-v1>
 *   page.portal_bookings           Client portal → Bookings  → <x-travel-portal-bookings-v1>
 *   page.trip                      Trip page (?lead= / ?client_trip=, from Reports → Trips) → <x-travel-trip-page-v1>
 *
 * Plain ES modules, no build step. Every class is prefixed "tvx-".
 * 2.37.0: views are loaded on demand (dynamic import) when their slot is mounted, and reused after that.
 */

import { h, errorText } from './shared/dom.js';

/*
 * 2.37.0 — each view's code (and its own .css) is loaded only when its slot opens, then kept by the browser:
 * opening Bookings loads the Bookings view, not all 16. Each entry gives the module; its TAG is the element.
 */
const SERVICE_BUILDER = () => import('./components/service-form-builder/service-form-builder.js');
const LEAD_REQUIREMENTS = () => import('./components/lead-requirements/lead-requirements.js');
const LEAD_TRAVELLERS = () => import('./components/lead-travellers/lead-travellers.js');
const TRAVELLERS_PAGE = () => import('./components/travellers-page/travellers-page.js');
const CONTACT_TRAVELLERS = () => import('./components/contact-travellers/contact-travellers.js');
const SETTINGS_ADMIN = () => import('./components/settings-admin/settings-admin.js');
const BOOKINGS_PAGE = () => import('./components/bookings-page/bookings-page.js');
const ITINERARY_PAGE = () => import('./components/itinerary-page/itinerary-page.js');
const QUOTATION_TRAVEL = () => import('./components/quotation-travel/quotation-travel.js');
const LEAD_BOOKINGS = () => import('./components/lead-bookings/lead-bookings.js');
const OPPORTUNITY_TRIP = () => import('./components/opportunity-trip/opportunity-trip.js');
const PORTAL_BOOKINGS = () => import('./components/portal-bookings/portal-bookings.js');
const CLIENT_TRAVELLERS = () => import('./components/client-travellers/client-travellers.js');
const TRIP_PAGE = () => import('./components/trip-page/trip-page.js');
const CLIENT_TRAVEL_REQUIREMENT = () => import('./components/client-travel-requirement/client-travel-requirement.js');
const GUIDED_SALE = () => import('./components/guided-sale/guided-sale.js');
const LEAD_CREATE = () => import('./components/lead-create/lead-create.js');

const SLOTS = {
  'page.travel_services': SERVICE_BUILDER,
  'settings.travel.admin': SETTINGS_ADMIN,
  'lead.tab.travel_requirement': LEAD_REQUIREMENTS,
  'lead.tab.travellers': LEAD_TRAVELLERS,
  'page.travellers': TRAVELLERS_PAGE,
  'contact.tab.travellers': CONTACT_TRAVELLERS,
  'page.bookings': BOOKINGS_PAGE,
  'page.itinerary': ITINERARY_PAGE,
  'quotation.tab.travel': QUOTATION_TRAVEL,
  'lead.tab.bookings': LEAD_BOOKINGS,
  'client.tab.bookings': LEAD_BOOKINGS,
  'client.tab.travellers': CLIENT_TRAVELLERS,
  'client.tab.travel_requirement': CLIENT_TRAVEL_REQUIREMENT,
  'opportunity.tab.trip': OPPORTUNITY_TRIP,
  'page.portal_bookings': PORTAL_BOOKINGS,
  'page.trip': TRIP_PAGE,
  // 2.36.0: the travel steps of CRM Invoices → Create Invoice from Scratch.
  'guided.travel_info': GUIDED_SALE,
  'guided.travellers': GUIDED_SALE,
  'guided.requirements': GUIDED_SALE,
  // 2.39.0: the Travellers and Travel Requirement sections of CRM Leads → Create.
  'lead.create.travel': LEAD_CREATE
};

/** The loaded views (slot loader → module promise): a view is downloaded once per page load. */
const loaded = new Map();
const MOUNT_TOKEN = Symbol('tvx-mount');

export async function mount(element, ctx) {
  const load = SLOTS[ctx.slot];
  if (!load) {
    element.replaceChildren(h('div', { class: 'tvx-root' }, [h('p', { class: 'tvx-muted', text: `Travel Agency has no view for "${ctx.slot}".` })]));
    return;
  }
  // A newer mount on the same element (fast tab switches) wins over this one.
  const token = {};
  element[MOUNT_TOKEN] = token;
  try {
    let pending = loaded.get(load);
    if (!pending) {
      pending = load();
      loaded.set(load, pending);
      pending.catch(() => loaded.delete(load)); // a failed download is tried again next time
    }
    const { TAG } = await pending;
    if (element[MOUNT_TOKEN] !== token) return;
    const view = document.createElement(TAG);
    view.className = 'tvx-root';
    view.ctx = ctx;
    element.replaceChildren(view);
  } catch (err) {
    if (element[MOUNT_TOKEN] !== token) return;
    element.replaceChildren(h('div', { class: 'tvx-msg tvx-msg-error', text: errorText(err) }));
  }
}

export function unmount(element) {
  element[MOUNT_TOKEN] = null;
  element.replaceChildren();
}
