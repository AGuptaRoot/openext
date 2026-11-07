# Travel Agency — CRM workspace extension (`travel`)

Turns Root CRM into a travel-agency CRM. Upload in **Settings → Extensions → Upload extension**,
install, then **Enable**. The package ships backend code (`api/`), so an admin must also approve the
backend in Settings → Extensions (see Backend).

## What it adds

**Lead module** (Create Lead and Lead Detail, for the request type *Travel Enquiry*):

| Section | Fields |
| --- | --- |
| Traveller Details | Adults, Children, Infants, Total Travellers (calculated) |
| Travel Information | From, To, Destination (from Settings → Travel), Travel Start Date, Travel End Date, Number of Days (calculated, inclusive), Travel Month (calculated), Date Flexibility |
| Required Services | multi-select of the services enabled on the Services & Forms page |

**Travel Requirement** (lead tab): one form per selected service. Each form is saved on its own and shows
*Not started*, *Draft* (required details missing) or *Complete*. The status is rechecked against the
current form whenever it is read (a field made required later turns a Complete requirement back to Draft;
the change is stored and audited as a system change). A choice whose option was removed later is shown
"(no longer offered)" and can be cleared; it never blocks saving (the server drops it with a warning). A
service without questions gets *Mark complete*. A selected service that was switched off, or removed, in
Services & Forms shows its saved details read only and says which. What was typed stays on screen while
saving and after a failed save.

A lead can need several requirements of one service (two hotels): *+ Add another Hotel* adds a card
(*Cancel* drops an unsaved one); with more than one card each gets a label ("Hotel – Goa", ≤ 80 characters;
default "Hotel 2", numbers never reused; at most 20 per service). *Remove* asks first and keeps the record
(marked removed; refused while it is on a booking). Unticking a service in Required Services hides its
requirements until it is ticked again. Each Complete requirement has **Check availability**: provider
(suggestions from earlier checks), Available / Held / On Request / Unavailable, prices by the service's
pricing, currency, checked at, valid until (pre-filled from Settings → Travel → Availability; required for
Held), channel, contact, notes and an evidence photo / PDF (≤ 700 KB), with the history (prices only for users
with finance read; the author can correct a check within 15 minutes). The card shows the latest as a badge:
"Held · valid till 14 Jun", "Expired — recheck", "Unavailable — propose an alternative". Available does not
mean booked. The quotation takes rate, availability and provider from the latest valid check (Unavailable
lines start unticked; expired or missing checks are warned about).

**Services & Forms** (page in the sidebar, admins): the services form builder — add, rename,
enable/disable, reorder services; add fields of type text, long text, number, date, dropdown, single
choice, multiple choice, checkbox; required, placeholder, help text, options; live preview. An enabled
service needs at least one field. A date field can have a *Date rule* ("on or after" another date of the
form, checked by the server); check-out / return / end dates default to their check-in / departure /
start date, and "Any date" turns the rule off. *Quotation tax %* saves when you leave the box (empty keeps
the old rate; held to 0–100; a banner names services that have none saved yet). Per service also: *Voucher
type* (hotel / transport / excursion / ticket / none; default by key), *Availability check required before
quoting*, and the day plan (item kind, start / end date fields, time field); per field *Hide on voucher*.

**Settings → Travel**: From, To and Destination lists, nationalities, relations, the lead-ready rule,
quotation texts, Aadhaar storage and the **Time zone** (IANA name, default Asia/Kolkata: "today" for passport
expiry and age checks). Below the form, for admins: **Import From / To locations (CSV)** (see below) and
*Orphaned travellers* (travellers of deleted leads) with an audited **Delete them**; travellers a booking
still lists are kept.

Workspace mode: request type *Travel Enquiry*, the *Travel Sales Pipeline*, Sales Orders, Samples,
Projects, Tasks, Time Logs, Invoices and Payments hidden.

## Files

```
crm-extension.json        manifest
request-type.json         Commercial Requirement form (trip purpose, priority, budget)
json/fields.json          the three lead sections
json/settings.json        Settings → Travel (lists, rules, texts, time zone) + stored services with their forms;
                          tab.slot settings.travel.admin (location CSV import, orphaned travellers panel)
json/navigation.json      Travellers and Services & Forms pages in the sidebar
json/tabs.json            Travel Requirement and Travellers lead tabs, Travellers contact section
json/catalog.json         extra lead sources and tags
api/models/TravelRequirement.json   one row per requirement (lead + service + instance, label, removed)
api/models/AvailabilityCheck.json   availability checks of a requirement (history)
api/routes.json                     the backend routes and their permissions
api/routes/services.js              GET/PUT /services: check and save services and forms
api/routes/requirements.js          lead requirements: list, add, check + save, soft remove (+ old per-service routes)
api/routes/availability.js          availability checks: history, add, correct, evidence, provider suggestions
api/services/requirement-store.js   instances, lazy migration, paged reads, booking guard, latest checks
api/services/availability.js        availability check rules, summary, end of day in the time zone
api/services/catalog.js             services list cleaning and checks
api/services/requirement-form.js    form value checks (removed options, date rules) and Draft / Complete status
api/services/requirement-status.js  status rechecked against the current form on read (audited system change)
api/routes/workflow.js              POST /lead-readiness (CRM lead workflow contract)
api/routes/sales.js                 POST /opportunity-prefill, /quotation-prefill (CRM sales-flow contract)
api/services/readiness.js           when a lead is ready
api/services/sales-prefill.js       what a new opportunity / quotation starts with
api/models/Traveller.json           one row per traveller of a lead (numbers encrypted; profile_id links copies of a person)
api/routes/travellers.js            travellers: list, add, add existing (copy), edit, delete, document photos
api/routes/ocr.js                   POST /ocr/:kind — read a passport / Aadhaar photo for review
api/routes/traveller-tools.js       Travellers page: directory, metrics, CSV export / import, search, trips, detail,
                                    lead picker, contacts, orphaned travellers (admin)
api/services/traveller-directory.js batched lead reads, orphans, one row per person, search, trips
api/services/traveller-store.js     shared traveller logic: lead / traveller loading, time zone, profiles, passport rule, presentation
api/services/traveller-rules.js     age on the trip date, Adult / Child / Infant, expiry warning, checks
api/services/document-ocr.js        what OCR reads, MRZ and Aadhaar check digits
ui/mount.js                         entry: picks the web component for the CRM slot
ui/style.css                        shared base styles (loaded by the CRM)
ui/shared/                          dom helpers, field inputs, base element, style loader
ui/components/service-form-builder/ <x-travel-service-builder-v1>: Services & Forms (.js + .css)
ui/components/lead-requirements/    <x-travel-lead-requirements-v1>: Travel Requirement tab (.js + .css)
ui/components/availability-dialog/  Check availability dialog (opened from a requirement card)
ui/components/lead-travellers/      <x-travel-lead-travellers-v1>: Travellers tab (also embedded: ctx.startWith, onSaved, onDone)
ui/components/travellers-page/      <x-travel-travellers-page-v1>: Travellers page
ui/components/contact-travellers/   <x-travel-contact-travellers-v1>: Travellers section on a contact
ui/components/settings-admin/       <x-travel-settings-admin-v1>: Settings → Travel, location CSV import
                                    (location-import.js), orphaned travellers
api/routes/locations.js             GET /locations, POST /locations/import (From / To locations, admins)
api/services/travel-locations.js    location import: checks, duplicates, stable ids, additive list sync
tests/world.js                      the fake CRM the tests run on (real sandbox; extend with options.extend / world.use)
tests/travellers.test.js            travellers and the E1–E18 / T0 regressions (backend)
tests/travellers-ui.test.js         the same for the UI (jsdom; skipped when jsdom is not installed)
tests/requirements-v2.test.js       T1 / T2: service settings, requirement instances, soft remove, booking guard, readiness
tests/availability.test.js          T3: availability checks
tests/prefill-v2.test.js            T4: quotation / opportunity prefill from requirement instances and checks
tests/sales-forms.test.js           2.1: manifest forms, prefill groups / columns / valid till / checks, saved hooks, Trip tab
tests/sales-forms-ui.test.js        2.1: Trip tab and Services & Forms line group (jsdom)
```

## Backend

All travel business logic runs in this package's own `api/` code, inside the CRM sandbox.
The CRM only provides the generic runtime and SDK.

- **Services & Forms:** `PUT /services` cleans keys, rejects missing names, duplicate keys and choice fields without options.
- **Travel Requirement:** `POST /leads/:lead_id/requirements` (next instance), `PUT` / `DELETE /requirements/:id`
  (soft remove; 409 while on a booking, 503 if that cannot be checked); the old `PUT` / `DELETE
  /leads/:lead_id/requirements/:service_key` work on the first instance (DELETE also soft-removes). Writes accept only active services that the lead selected in Required Services.
  It checks every value against the service form and sets `Draft` or `Complete` on the server. Values the form does not have are dropped.
- **Sales agents see their own leads only:** bookings, booking details, itineraries, the traveller directory and export, contact travellers and every lead tab follow the CRM's lead access (`sdk.access.leadIds()`, `sdk.crm.leads`). The raw `_models` API is admin-only for every model.
- **Direct writes are closed:** the generic `_models` API needs `crm.settings.manage` to write TravelRequirement, so normal users always go through the checked routes.

The package ships JavaScript, so after upload an admin must approve the backend in Settings → Extensions.
Until then the Services page and the Travel Requirement tab show "waiting for an admin's approval".
- **Travellers:** each lead has a Travellers tab. Age and Adult / Child / Infant (under 2 / 2–11 / 12+) are
  worked out on the trip start date. Passport and Aadhaar photos can be read with OCR (`POST /ocr/:kind`):
  the passport's machine-readable lines and the Aadhaar number are checked with their check digits, unsure
  values come back marked for review, nothing is invented and nothing is saved until the user confirms.
- **Rules:** phone and relation are required; email is optional. Passport details (number, expiry, country)
  become required when the lead's Travel Requirement includes a service marked *Passport required* in
  Services & Forms (International Air Ticket by default). An expired passport, or one expiring before the
  trip, is refused; under 6 months after the trip is a warning.
  Names and the issuing country take letters of any language (with spaces, dots, apostrophes and hyphens;
  a country may also have `& , ( )`). A passport number always needs its expiry date and issuing country.
  The same person cannot be added to a lead twice (same full name and the same date of birth or phone —
  409 `DUPLICATE_TRAVELLER`). The form checks a field when it is left, and Save takes the user to the
  first wrong field; the server checks everything again.
- **Travellers page (sidebar):** metrics, search, View (details with lead, contact person and photos),
  Add / Import (choose a lead whose Travel Requirement has a Complete service; pick the contact person
  from the lead's contacts), Export (CSV, document numbers masked). Imports never carry document numbers.
- **Contact page:** a Travellers section shows how many travellers have that contact as their contact person.
- **Traveller directory and profiles:** a traveller who travels again is added with *Add existing traveller*
  (lead tab): `GET /travellers/search?q=&leadId=` finds people by full name (every word matches the first or
  last name) or phone, and `POST /leads/:lead_id/travellers/copy { travellerId }` copies the profile — document
  numbers as stored (still encrypted, never decrypted) and the photos (saved again under the new record) — with
  the same `profile_id`. The Travellers page shows one row per person ("N trips"), and *Trips*
  (`GET /travellers/:id/trips`, also in the page detail) lists every lead and booking of the person. Older
  rows get `profile_id` = their own id when first read. A traveller a booking lists cannot be deleted (409
  `TRAVELLER_ON_BOOKING`); when the bookings cannot be checked, the delete is refused (503, try again).
  A year of birth can be given when the date of birth is not known (the date wins); imports accept "1990"
  in the date of birth column or a *Year of birth* column.
- **Lists stay correct and fast:** age categories are worked out on read (the stored one is only for
  exports, refreshed on save); travellers of deleted leads never count; the page pages by cursor
  (`after=`) and reads leads in batches (`sdk.crm.leads.findByIds`, `sdk.values.getMany`, CRM 3.17.0; older
  CRMs fall back to one read per lead). Large workspaces: one answer looks at the newest 2,000 matching
  travellers ("about N").
- **Theme:** every colour is a `--tvx-*` CSS variable (`ui/style.css`); components set `data-tvx-theme`
  (our own attribute, not `data-theme`) from `ctx.theme` / `ctx.onThemeChange`, or follow the page's dark
  class when the CRM has no theme events. Subscriptions and page-wide listeners end when a view closes.
- **Documents:** passport numbers are encrypted (`sdk.crypto`) with a fingerprint to catch duplicates;
  by default only the last 4 Aadhaar digits are kept (Settings → Travel → Aadhaar number storage).
  Photos are stored encrypted (`sdk.files`, the same S3 as lead documents). Views and changes are audited,
  without the numbers.

- **Opportunity and quotation (sales flow):** the manifest's `salesFlow` routes tell the CRM what a new
  opportunity / quotation for a lead starts with, and its switches change the two pages:
  - *Create Opportunity* (`hideOpportunityLines`): the product lines are replaced by the lead's travel services
    (status and requirement details) and travellers (age group, relation, passport status — never the number).
    Title ("Goa — 2 Adults, 1 Child · 12–18 Jun 2027"), close date (the day before travel), Estimated Deal
    Value (the lead's Deal Value, still editable) and Trip details are filled in; each service with a Complete
    requirement is saved as one of the opportunity's items.
  - *Create Quotation* (`lockQuotationLines`, "New Travel Quotation"): title and description filled in; a
    Travel Summary row (from, to, destination, dates, trip type, travellers); a Travel Services / Requirements
    table — one row per Complete service, or per Adult / Child / Infant group for per-person services, with
    quantity and unit by the service's *Quotation pricing* ("Rooms × Nights", "2 Adults", "2 Vehicles") and tax
    from its *Quotation tax %* (Services & Forms). The agent ticks the rows to include, enters the rate, and sets
    Availability (Available / Held / On Request — printed on the quotation) and Provider (internal, not printed);
    *Add Travel Line* adds a service or a custom row. A Travellers card lists the names only. Inclusions,
    Exclusions and Cancellation policy (Settings → Travel → Quotation texts) are added as sections.
  - Warnings list services without a Complete requirement and passport problems. A client-only opportunity or
    quotation (no lead) keeps the normal editor. Without this extension the CRM pages behave as before.
- **Pipeline:** Enquiry Received → Requirements Gathered → Quotation Sent → Itinerary Proposed → Negotiation /
  Revision → Booking Confirmed. *Itinerary Proposed* (2.8.0) follows Quotation Sent: finalizing an itinerary of a
  quotation moves its trip opportunity there (forward only, never after acceptance). Updating adds the stage to an
  existing Travel pipeline; nothing else in the pipeline changes.
- **Payments (2.8.0, CRM 3.28.0):** a booking is made once the CRM's verified payments allow it — the required
  advance when CRM Settings → General *Allow Booking Creation After Advance Payment* is Yes, otherwise the full amount
  (automatically on payment when *Create the booking automatically…* is on; one booking per quotation). A hotel,
  transport or excursion voucher needs the service Confirmed **and** the full payment verified (setting *Vouchers only
  after full payment*). Services & Forms no longer shows a Voucher option.
- **Travel Reports (2.9.0, CRM 3.29.0):** with Travel active the Reports page is a travel dashboard (`json/reports.json`):
  KPIs, the conversion funnel (each lead once), revenue and collections (verified payments; a moved advance counted
  once), payment status, bookings over time and overview, travel service performance (every service of Services &
  Forms), top destinations, upcoming trips with what needs attention, service confirmation, traveller readiness, sales
  person and lead source performance, quotation performance. Every section follows the filters (date range, sales
  person, lead source, destination, travel service, opportunity stage, booking status, payment status); tables export
  as CSV. Money needs *crm.finance.read*; no passport / Aadhaar numbers or documents are ever in a report. Invoice
  Ageing, Payment Reconciliation and Income vs Expense stay under *Finance reports*.
- **Sales rules (CRM switches):** an accepted quotation closes the opportunity's other open quotations (status
  Closed) and locks its services; a lead converted to a client takes no new quotation, and its other open
  opportunities move to Won; *Create Quotation* on a client starts a new enquiry for that client.

Needs CRM 3.16.0 or later (`salesFlow`, quotation sections; `sdk.values`, `sdk.crypto`, `sdk.files`, `sdk.ai`; capabilities
`files.private` and `ai.vision`).

## UI

Plain ES modules, no build step. Each page or tab is a web component in its own folder under
`ui/components/<name>/`, with its own `.js` and `.css`. A new screen means a new folder plus one
line in the `SLOTS` map in `ui/mount.js`. Components use light DOM (no Shadow DOM), so the shared
`ui/style.css` applies. Tag names carry the major version (`-v1`) because a tag cannot be
redefined until the page reloads.

## Bookings, vouchers and itineraries (2.0)

**Bookings.** Since 2.2 (CRM 3.19.0) the booking is made **as soon as the quotation is accepted** — by the client,
on the portal link or by paying (CRM hook `salesFlow.quotationForm.acceptedRoute` → `POST /sales-flow/quotation-accepted`;
switch off with Settings → Travel → *Create the booking when a quotation is accepted*). An accepted (or already
invoiced) quotation also has a **Create Booking** button (record action, `json/actions.json`).
It makes booking `BK-0001` (prefix in Settings → Travel → Bookings & vouchers) with one booking service per
quotation line: name, quantity, rate, the requirement it came from (line `sourceRef`), the availability and
provider as quoted, and the lead's travellers. Every line is checked before anything is written; a booking
interrupted half way is completed on the next click; a second booking for the same quotation is refused
(409 with a link to the existing one). The **Bookings** page lists bookings with status tabs and counts,
search and a travel-date filter; a booking page shows travellers (masked document numbers — pick from the lead
and the contact's other trips, or add a new one), services, itinerary and notes. Rates and totals are shown
only to users with finance read access.

**Confirm Service.** Per service: Requested / Confirmed / Unavailable / Cancelled, provider, confirmation
reference, confirmed at, final details, evidence file, notes. Confirmed needs a reference or an evidence file
(setting `confirmation_evidence`: reference or file / reference / file / none); Unavailable and Cancelled need
a note. Every change is kept in the service history. The booking status follows its services (Pending →
Partially Confirmed → Confirmed); Cancel and Mark completed are manual (completion after the trip's end date in
the workspace time zone, unless `allow_early_completion`). A cancelled or completed booking cannot be changed —
also when it closes while a confirmation is being saved.

**Vouchers.** Hotel, transport and excursion services get a PDF voucher once Confirmed (`HTV-0001`, `TPV-…`,
`EXV-…`; terms per type in Settings). A change means **Reissue**: same number, next version, the old one is
marked Superseded and redrawn with a watermark from what it printed. If the confirmation changes after a
voucher was issued, the voucher shows **Details changed — reissue**. Vouchers print the guest, traveller names,
service, dates, form details, provider, reference and terms — never prices, budgets, rates or fares, document
numbers, internal notes, or form fields marked "hide on voucher". Download, copy a link, WhatsApp text, mark
sent / used, cancel. Air, rail and bus tickets come from the provider: upload them on the service (removing one
is recorded in the history).

**Itinerary.** **Generate itinerary** on a quotation (any status except Rejected) builds a day-by-day plan from
its lines and requirements (stays, flights, transfers, activities; undated services under "Included services").
Edit items, move them between days, add notes, Regenerate, then **Finalize & PDF** (`ITN-<quotation>-v<n>`; the
guest and travellers are kept with it). A new version supersedes the older final one.

**Sections on CRM pages.** Quotation → *Booking & itinerary*; Lead → *Bookings*; Opportunity → *Trip*
(read-only trip summary — from 2.1 the saved TripPlan — and travellers).

**Permissions.** `x.travel.bookings.read` (comes with Leads read), `x.travel.bookings.write` and
`x.travel.vouchers.issue` (come with Leads write); admins hold all of them. Itineraries use Leads read / write.
Reading quotations needs Finance read.

## Sales forms (2.1, CRM 3.18.0)

Needs CRM **3.18.0** or later (manifest `salesFlow.opportunityForm`, `quotationForm`, `quotationLineGroups` and
declared fields for quotations). Before a lead is chosen, the Create Opportunity / Create Quotation pages
already show the travel layout (inputs off, "Select a lead …").

**New Trip Opportunity** (`json/fields.json` → `opportunity`; every older key kept): *Trip Details* — From
(Settings → Travel From list), Destination, Trip type, Trip purpose, start / end date, Nights and Days
(calculated), Date flexibility; *Travellers* — Adults, Children, Infants, Total (calculated); *Budget* — from /
up to; *Special Requests & Notes*. Filled from the lead: title "Goa trip – Priya Shah · Jun 2027", the lead's
Deal Value, expected close = trip start − *Opportunity: expected close (days before the trip)* (default 7,
never before tomorrow; no start date → today + 14), and three checks (services complete, travellers match the
head count, trip dates set). *Opportunities start from a lead* (default on) hides the Client option.

**Quotation**: lines are grouped (Flights, Hotel, Transfers, Activities, Visa, Insurance, Other). A service's
group is *Quotation: line group* in Services & Forms (automatic: key visa / insurance, else by day-plan kind —
travel → Flights, stay → Hotel, transfer → Transfers, activity → Activities, else Other). Extra columns
besides Availability and Provider (internal): Date, Route, Cabin class, Room type, Meal plan (printed), filled
from the requirement. Declared quotation fields *Trip & pricing*: Travellers for price per person (adults +
children of the opportunity, else the lead) and Special requests (this version only). *Valid till* starts at
the earliest Held availability (that day in the workspace time zone) when *Quotation: valid till the earliest
supplier hold* is on, else today + *Quotation: days a quotation stays valid* (default 7); saving a later date
than the earliest hold asks first. Checks: no expired availability, services complete. A read-only *Day plan
(from proposed services)* previews the itinerary of the proposed lines. *Price per person* (grand total ÷
travellers) shows with the totals unless *Quotation: show price per person* is off. Markup is not a field yet
(declared fields have no field-level permission).

**Saved copies** (`POST /sales-flow/opportunity-saved` { opportunityId }, `POST /sales-flow/quotation-saved`
{ quotationId }, called by the CRM after a save): the record is read again through `sdk.crm` (only the id is
taken from the body) and its stored values through `sdk.values`; the copy is upserted — **TripPlan** (one per
opportunity: the trip fields, currency, values snapshot) and **QuotationTravel** (one per quotation version:
travellers, per person, grand total, lines per group, valid till, special requests). Idempotent; audited on
create. The opportunity *Trip* tab reads the TripPlan, else the opportunity's own values, else (opportunities
saved before 2.1) the lead's trip.

## Type-ahead on requirement text fields (2.3.1)

Every **text** field of a Travel Requirement form is a type-ahead box: typing shows the values entered
before for that field (starts-with first, most used first), and `Add "…"` saves a new value to the
field's list (any user who can edit the lead). Anything typed is still the value. Dropdowns, radios,
dates, numbers and notes are unchanged.

- Lists are per field key (`FieldSuggestion`, one row per field + value, counted on each use); fields
  with the same key share a list (From city of domestic and international flights).
- Saving a requirement adds its text values to the lists.
- Text fields holding personal details (phone, email, passport, Aadhaar, address, date of birth, a
  person's name — by key or label) and internal fields never get a shared list.
- `GET /field-suggestions?field=&q=` (`crm.leads.read`), `POST /field-suggestions { field, value }`
  (`crm.leads.write`); only text fields of active services. Raw rows are admin-only.

## From / To locations — CSV import

Settings → Travel → **Import From / To locations (CSV)** (admins, `crm.settings.manage`) adds or updates many
locations at once. Columns (header without case; `available_for` also accepted): **Name**, **Available For**
(`from`, `to` or `both`), **Enabled** (yes / no, true / false, 1 / 0, y / n; empty = yes). *Download template*
and *Download current locations* (with the location ids) are on the card.

- The file (up to 1 MB, 2000 rows) is parsed in the browser and sent as JSON rows; nothing is stored as a file.
  The card previews the rows with their checks and asks the server for a dry run, then **Import N locations**.
- The server checks every row again. Names compare without case and extra spaces: the first row of a name
  wins, later ones are *skipped (duplicate in file)*; a known name is *updated* (available for / enabled) or
  *skipped (no change)*; bad rows *fail* with the reason. Totals: imported / updated / skipped / failed.
- Every location is a `TravelLocation` row with a stable `location_id` (`loc_…`, set once, never changed);
  names already in the lists get one on the first import (`source: settings`).
- The From / To lists (`from_places`, `to_places`, which the lead fields offer) **only grow**: enabled
  locations are appended where they are available, keeping the existing order. Nothing is removed, so older
  leads keep valid values; a disabled or narrowed name that is still listed gets a warning (remove it from
  the list by hand if no lead uses it). Disabled new names are stored, not offered.
- `POST /locations/import { rows: [{ name, available_for, enabled, line? }], dryRun? }`, `GET /locations`;
  audited with counts only.

## Client portal — Bookings (2.3, CRM 3.20.0)

With Settings → General → Proforma & Advance Payment on, the client pays instead of accepting: the first
verified payment accepts the quotation (the booking is created then), and full payment closes it with a
Paid tax invoice. The portal page **Bookings** (`json/navigation.json` `my-bookings`, `audience: "portal"`)
shows the client's own bookings: number, destination, dates, travellers, booking status, payment status
and the quotation.

| Route | Rule |
|---|---|
| `GET /portal/bookings`, `GET /portal/bookings/:id` | Client logins only (`sdk.access.portal()`); bookings of the login's own leads. No prices, suppliers or internal notes; a ticket reference shows only once downloads are allowed. |
| `GET /portal/vouchers/:id/file` | The booking is the client's, not cancelled; its quotation is **Paid** with a **Paid** tax invoice (`sdk.finance.quotationPayment`); the voucher belongs to the booking and is Issued / Sent / Used (not cancelled, superseded or outdated). Otherwise 403 `PAYMENT_REQUIRED` ("Complete the remaining payment to download tickets and vouchers."), 404 or 409. |
| `GET /portal/booking-services/:id/files/:file_id` | Same payment and ownership rule; only the service's provider documents (tickets, confirmations), never the agency's evidence files. |

Every download is audited. Staff pages (`audience: "staff"`) never show in the portal.

## Data

- Lead fields (sections B, C, D): `plugin_openext_crm_suite_x_travel__recordvalues`, linked by lead id.
- Travel Requirement records: `plugin_openext_crm_suite_x_travel_travelrequirement`, linked by `lead_id`.
- Travellers: `plugin_openext_crm_suite_x_travel_traveller`, linked by `lead_id`.
- From / To locations: `…_travellocation` (stable `location_id`, unique name); the lists themselves stay in settings.
- Bookings `…_booking` (one per quotation), booking services `…_bookingservice`, their history
  `…_serviceconfirmation`, vouchers `…_voucher` (PDFs as private files) and itineraries `…_itinerary`.
  Nothing is deleted: bookings, services and vouchers are cancelled, never removed.
- 2.1: trip plans `…_tripplan` (one per opportunity) and quotation travel details `…_quotationtravel` (one per
  quotation version); opportunity and quotation field values are the CRM's `…__recordvalues`.
- Document photo facts: `plugin_openext_crm_suite_x_travel__files`; the encrypted photos themselves are in S3
  (or the CRM's private files folder when S3 is not set up).
- Core CRM tables are only read.

## Build

```bash
node scripts/build-extension-package.js crm-travel
# → releases/extensions/travel-2.2.0.zip
```

Default services and fields were taken from the old CMS extension `crm-travel` 1.9.1 as reference data.
The two extensions do not share data.
