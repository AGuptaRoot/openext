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
 *
 * Plain ES modules, no build step. Every class is prefixed "tvx-".
 */

import { h, errorText } from './shared/dom.js';
import { TAG as SERVICE_BUILDER } from './components/service-form-builder/service-form-builder.js';
import { TAG as LEAD_REQUIREMENTS } from './components/lead-requirements/lead-requirements.js';
import { TAG as LEAD_TRAVELLERS } from './components/lead-travellers/lead-travellers.js';
import { TAG as TRAVELLERS_PAGE } from './components/travellers-page/travellers-page.js';
import { TAG as CONTACT_TRAVELLERS } from './components/contact-travellers/contact-travellers.js';
import { TAG as SETTINGS_ADMIN } from './components/settings-admin/settings-admin.js';
import { TAG as BOOKINGS_PAGE } from './components/bookings-page/bookings-page.js';
import { TAG as ITINERARY_PAGE } from './components/itinerary-page/itinerary-page.js';
import { TAG as QUOTATION_TRAVEL } from './components/quotation-travel/quotation-travel.js';
import { TAG as LEAD_BOOKINGS } from './components/lead-bookings/lead-bookings.js';
import { TAG as OPPORTUNITY_TRIP } from './components/opportunity-trip/opportunity-trip.js';
import { TAG as PORTAL_BOOKINGS } from './components/portal-bookings/portal-bookings.js';
import { TAG as CLIENT_TRAVELLERS } from './components/client-travellers/client-travellers.js';
import { TAG as CLIENT_TRAVEL_REQUIREMENT } from './components/client-travel-requirement/client-travel-requirement.js';

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
  'page.portal_bookings': PORTAL_BOOKINGS
};

export function mount(element, ctx) {
  const tag = SLOTS[ctx.slot];
  if (!tag) {
    element.replaceChildren(h('div', { class: 'tvx-root' }, [h('p', { class: 'tvx-muted', text: `Travel Agency has no view for "${ctx.slot}".` })]));
    return;
  }
  try {
    const view = document.createElement(tag);
    view.className = 'tvx-root';
    view.ctx = ctx;
    element.replaceChildren(view);
  } catch (err) {
    element.replaceChildren(h('div', { class: 'tvx-msg tvx-msg-error', text: errorText(err) }));
  }
}

export function unmount(element) {
  element.replaceChildren();
}
