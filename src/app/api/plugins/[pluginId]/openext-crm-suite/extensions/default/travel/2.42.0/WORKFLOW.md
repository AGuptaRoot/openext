# crm-travel — Workflow

Travel extension `travel` **2.42.0**, needs CRM `openext-crm-suite` **>= 3.69.0 < 4.0.0** (GST suite).

**Activities hidden (2.42.0, CRM 3.69.0):** Travel lists `activities` in `hiddenModules`. The CRM then shows no lead
Activities tab, no Leads "Activity" view or missed-activity badge, no activity reminders or follow-up alerts, no
dashboard activity cards, no Activity Location report, no Activity Types setting and no "add activity" on the client
timeline; every activity write answers 409 ACTIVITIES_HIDDEN. Old activities stay in the database. The Trip page no
longer reads activities, and Sales Person Performance no longer links to the Activity Location report. "Recent
Activity" (the audit feed) and the "Activities" service group of quotations are different things and stay.

**Lead Create document photos (2.41.0, CRM 3.68.0):** a passport / Aadhaar / PAN photo chosen in a Lead Create traveller
form is no longer only read by OCR: it is kept in the page's memory and, right after the lead is created, uploaded
(encrypted, S3 only, audited) onto the traveller that form made. Removing the photo or the traveller drops it. A photo
that could not be uploaded (traveller not saved, already on the lead, or an upload error) is listed in a warning — add
it on the lead's Travellers tab. An existing traveller keeps their stored photos. The guided sale is unchanged (OCR only).
A partly saved Lead Create now answers `{ ok: false, message, result }` instead of an error, so the saved travellers
still get their photos.

**Lead Create (2.39.0 / 2.40.0, CRM 3.67.0):** at the end of the page (just above Create; CRM 3.67.1), once Traveller
Details (at least one adult, child or infant) and Travel Information (From, To, Travel Start Date, Travel End Date) are
filled in, the page shows **Travellers** (one form per person, all open at once: "Traveller 1 of 3", "Traveller 2 of 3"…,
the same form as Lead → Travellers; a saved traveller becomes a short card with Edit / Remove; changing the counts adds
or removes empty forms) and **Travel Requirements** (one form per ticked service; ticking or unticking
a service adds or hides its form at once; an unticked form keeps its values until Create and is not saved). Both are
optional. Create checks every added traveller and every form with values with the rules of the lead tabs. When all
travellers are added, their ages on the Travel Start Date (Infant under 2, Child 2–11, Adult 12+; no date of birth =
adult) are compared with the counts; a difference, or more travellers than the counts, shows a warning with
"Create anyway" / "Go back and fix". After the lead is made, the travellers and forms are saved on it.

This file explains, in simple English, how a travel enquiry moves through the CRM: from the first lead to
the trip, the booking, vouchers and the client portal.

**Speed (2.37.0 / 2.38.0, best with CRM 3.65.0):** the Dashboard lets MongoDB count the enquiries and reads only
what its boxes show (active bookings, quotations waiting for an answer, accepted quotations for the money,
passports ending within 6 months, the newest activity); a user with few leads (up to 500) searches only those.
If more than 5 trips start on the same day, the earliest-booked come first. 2.38.1: database indexes on the booking
status and the passport expiry date (MongoDB builds them once after the upload). Reports read the data once for their 3 parts, not 3 times; every lead is read
(no 5,000-lead limit) with CRM 3.65.0; each screen's code is downloaded only when that screen opens. The figures
are the same as before.

> The CRM plugin stays generic. All travel logic lives in this extension. The CRM only calls the routes and
> hooks that `crm-extension.json` declares.

*Worked example picture (sample data: the Shah Family, Surat → Goa): `Refactor\documentation\crm-travel-workflow\workflow-example.png` (SVG version next to it). It is kept outside this folder because an extension package may only contain `json/`, `ui/`, `api/` and root `.json` / `.md` / `.txt` files; a `docs/` folder makes the CRM refuse the upload.*

---

## 1. The big picture

```mermaid
flowchart LR
  A[Lead<br/>Travel Enquiry] --> B[Travel Requirement<br/>per service]
  B --> C[Travellers<br/>passport / Aadhaar]
  C --> D{Lead ready?}
  D -- yes --> E[Opportunity<br/>Trip]
  E --> F[Quotation<br/>Travel lines]
  F --> G[Accepted]
  G --> H{Paid enough?<br/>advance or full}
  H -- yes --> I[Booking]
  I --> J[Confirm services]
  J --> K[Vouchers + Itinerary]
  K --> L[Trip done<br/>Booking Completed]
  F -. invoice .-> M[Invoice]
  I --> P[Client Portal<br/>My Bookings]
```

There is a second way to start, for a client who already exists (section 7): **Client → Travel Requirement →
Quotation**, with no new lead.

---

## 2. Pipeline stages (Travel Sales Pipeline)

| Stage | Type | Probability |
| --- | --- | --- |
| Enquiry Received | OPEN | 15% |
| Requirements Gathered | OPEN | 30% |
| Quotation Sent | QUOTATION_SENT | 70% |
| Itinerary Proposed | OPEN | 78% |
| Negotiation / Revision | NEGOTIATION | 85% |
| Booking Confirmed | WON | 100% |
| Cancelled / Lost | LOST | 0% |

A new trip opportunity starts at **Enquiry Received** and moves to **Requirements Gathered** when the lead
is ready.

---

## 3. Step 1: Lead (Travel Enquiry)

On **Create Lead**, for the request type *Travel Enquiry*, staff fill in:

| Section | Fields |
| --- | --- |
| Traveller Details | Adults, Children, Infants, Total Travellers (calculated) |
| Travel Information | From, To, Destination, Travel Start / End Date, Number of Days (calculated), Travel Month (calculated), Date Flexibility |
| Required Services | Services enabled on the **Services & Forms** page (hotel, flights, transport, excursion, package...) |

Checks while creating the lead (CRM):
- **Duplicate contact** banner: use the existing contact or create a new one.
- **Existing Client Found** modal: the company, or the picked contact, already belongs to a client.
  - **Add as Secondary Contact**: the person is added to that client. The client keeps 1 Primary and can have many Secondary contacts (max 50).
  - **Continue Creating Lead**: a normal new lead.
  - **Sync Travel Information to Client** checkbox: copies the lead's Travel Information into the client's Travel Requirement (Step 1). It is hidden when the client's open trip already has a quotation.
- **Assigned To** shows only real users' names, never raw IDs.

The same Existing Client Found modal also runs on **Client Create** and **Contact Create**.

---

## 4. Step 2: Travel Requirement (lead tab)

- There is one form per selected service. The forms are built by admins in **Services & Forms**.
- Each form has a status: **Not started → Draft** (required details missing) **→ Complete**.
- A lead can need several of the same service (for example 2 hotels): use **+ Add another Hotel**. There can be at most 20 per service.
- **Remove** keeps the record (marked removed). It is refused while the requirement is on a booking.
- **Check availability** on a Complete requirement records:
  - the provider and a status: **Available / Held / On Request / Unavailable**;
  - the price, currency, and "valid until" (required for Held);
  - the channel (Phone, WhatsApp, Email, Website, Other) and an evidence file.
- Available does **not** mean booked. The quotation later takes the rate and provider from the latest valid check.

---

## 5. Step 3: Travellers (lead tab)

- Add each person: name, date of birth, passport, Aadhaar and PAN card details.
- **PAN and Aadhaar numbers are required** for Indian travellers aged 18 or more (a blank nationality counts as
  Indian, no date of birth counts as 18+). Settings → Travel → "PAN card required" / "Aadhaar card required"
  can change this to every traveller or optional. Older travellers are asked for them when next edited.
- **OCR** can read a passport, Aadhaar or PAN card image to fill the form.
- Document numbers are **encrypted and masked**. Files go to **S3 only**, never to local disk.
- A duplicate check runs before saving; travellers can be copied from the contact's other leads.
- A daily **passport alert** job warns about passports that are expiring.
- The **Travellers** page in the sidebar lists everyone, with document status.

---

## 6. Step 4: Lead ready → Opportunity → Quotation

### Lead readiness (Settings → Travel)

| Setting | Default | Meaning |
| --- | --- | --- |
| `ready_all_services_complete` | on | Every required service has a Complete requirement (off: at least one) |
| `ready_min_travellers` | 1 | At least this many travellers on the lead |
| `ready_requires_availability` | off | Every Complete requirement also needs a current availability check |

When the lead is ready, the CRM enables **Create Opportunity** and can move the lead to Qualified.

### Opportunity ("New Trip Opportunity")
- Trip details, travellers and budget are filled from the lead.
- The opportunity tab **Trip** shows the trip summary.

### Quotation ("New Travel Quotation")
- An opportunity is required (for the lead flow).
- **Lines are fixed**: they come from the Travel Requirement, one line per service, and staff enter only the rate and tax.
- To change the route, dates or class, use **Edit Travel Requirement**.
- Lines are grouped as Flights, Hotel, Transfers, Activities, Visa, Insurance and Other. Each line has extra fields: availability, date, route, cabin class, room type, meal plan and provider.
- Per-person services use the traveller count. If there are no travellers, they are quoted for 1 person and a warning is shown.
- "Valid till" cannot be later than the travel start date.
- "Valid till" must be **at least 1 day after the issue date** (CRM 3.64.5). The one exception is a trip that **starts today**: "Valid today only" (valid till = issue date), to be accepted or staff-confirmed before midnight.
- A quotation is valid **until the end of** its Valid Till day (workspace time zone, CRM_TIME_ZONE, default Asia/Kolkata); it shows Expired from the next day.
- **Price per person** can be shown (setting `show_price_per_person`).
- On save, the CRM calls the hook `/sales-flow/quotation-saved`; the stage moves to **Quotation Sent**.
- A revision (R1, R2...) keeps the same links.

---

## 7. Other start: quotation from an existing Client (no new lead)

Use this when the lead is already converted into a client and the client wants a new trip.

```mermaid
flowchart LR
  A[Client detail] --> B[Travel Requirement tab<br/>= client trip]
  B --> C[Create Quotation]
  C --> D[Select travellers<br/>min 0 if client has none]
  D --> E[Quotation<br/>linked to client trip<br/>no lead, no opportunity]
  E --> F[Accepted + paid]
  F --> G[Booking<br/>client_id + client_trip_id]
  G --> H[Trip marked Booked<br/>next requirement = new trip]
```

- The client's Travel Requirement is a **client trip** record (`ClientTravelRequirement`). Status: **Draft → Complete → Quoted → Accepted → Booked**.
- **One requirement → one accepted quotation (2.30.0).** Once its quotation is **Accepted**, the requirement is **used**:
  "Create Quotation" is hidden for it, and it stays visible under **Used Travel Requirements**. Use **Add New
  Travel Information** (empty, or *Copy from last requirement*) and Save: that new requirement gets its own
  Create Quotation. A used requirement is never reopened. The CRM (3.54.0) also refuses a second accepted
  quotation for the same requirement.
- **Create Quotation** opens the travellers picker:
  - choose from the client's saved travellers (expired passports are refused);
  - if the client has **no** saved travellers, the quotation can be created with none (quoted for 1 person).
- The quotation stores `extensionRecordId` (the trip id). **No lead and no opportunity are created.**
- Prefill, dates, lines and hooks all read from the trip record.
- When it is booked, the trip is closed (**Booked**). The client's next requirement starts a new trip.

Known limits:
- New travellers cannot be added to a client trip (no lead to hold them).
- Travel reports are still lead-based.

---

## 8. Step 5: Accept → payment → Booking

1. The client (or staff) **accepts** the quotation. The CRM calls `/sales-flow/quotation-accepted`.
2. **Payment rule** (CRM Settings → General, verified payments only):
   - the **advance** is paid when the advance option is allowed, otherwise the **full amount** is needed;
   - the CRM calls `/sales-flow/quotation-paid` after each verified payment (Razorpay, webhook or staff).
3. When the rule passes, a **Booking** is made:
   - automatically (setting `auto_create_booking_on_accept`), or
   - with the **Create Booking** action on the quotation.
4. Rules:
   - one booking per quotation;
   - one **booking service** per quotation line;
   - travellers come from the lead, or from the client trip;
   - the booking number uses `booking_prefix`.
5. Not paid yet → `409 QUOTATION_NOT_PAID`, and no booking.

The booking's travellers are **fixed**. There is no "Choose travellers" button, and the server refuses changes (`BOOKING_TRAVELLERS_FIXED`).

---

## 9. Step 6: Confirm services, vouchers, itinerary

### Booking service status

```mermaid
stateDiagram-v2
  [*] --> NotRequested
  NotRequested --> Requested
  NotRequested --> Confirmed
  NotRequested --> Unavailable
  Requested --> Confirmed
  Requested --> Unavailable
  Unavailable --> Requested
  Unavailable --> Confirmed
  Confirmed --> Requested
  Confirmed --> Unavailable
  NotRequested --> Cancelled
  Requested --> Cancelled
  Confirmed --> Cancelled
  Unavailable --> Cancelled
  Cancelled --> [*]
```

- **Confirm** a service with a reference number or an evidence file (S3).
- Provider documents (tickets and so on) can be attached to each service.

### Booking status (calculated from its services)

| Services | Booking |
| --- | --- |
| All active services Confirmed | **Confirmed** |
| Some Confirmed | **Partially Confirmed** |
| None Confirmed | **Pending** |
| All Cancelled | **Cancelled** |

- **Cancel booking**: a reason is required. Its services and live vouchers are cancelled too.
- **Complete booking**: allowed when the booking is Confirmed and the trip has ended (setting `allow_early_completion` allows it earlier).

### Scan supplier ticket / voucher (2.33.0)
- In **Confirm service**, "Scan supplier ticket / voucher" reads an air ticket, hotel confirmation or supplier bill (PDF, first 5 pages, or a photo).
- It fills **Provider**, **Confirmation reference** (PNR / confirmation no.) and **Final confirmed details** (flights, stay, ticket numbers, names). Prices are never read.
- It warns when a name is not a traveller on the booking, a traveller is missing, or the dates differ from the service.
- Empty fields are filled; typed values change only with "Use scanned values". Nothing is saved until **Save**; the file becomes the evidence file (stored on S3).
- Customer invoices still come only from the accepted quotation, so the CRM's "Scan PDF" is not shown on Invoices or Quotations.

### Vouchers (hotel, transport, excursion)
- Status: **Draft → Issued → Sent → Used**, or **Cancelled**. A reissue makes the old voucher **Superseded**.
- Vouchers are PDFs, versioned, stored on S3.
- The permission `x.travel.vouchers.issue` is needed.

### Itinerary
- A day-by-day plan generated **from the quotation** (Draft → **Final**; a new version makes the old one Superseded).
- It is a PDF and can be opened from the quotation tab **Booking & itinerary** or from the booking.

---

## 10. Invoice

- The invoice is made **from the quotation** (`invoiceFromQuotation`), with travel lines and the "Travel Summary" print layout.
- Recurring invoices, invoice templates and write-off are hidden for travel.

### Create Direct Invoice / Create Direct Quotation (2.36.0, CRM 3.64.0; renamed in 2.36.6 from "Create Invoice from Scratch")

Invoices → **Create Direct Invoice** (Quotations → **Create Direct Quotation**: the same steps, stops at a Draft quotation, CRM 3.64.10) (admin, manager, finance; not sales reps). Six steps, **nothing is saved until Create**:

1. **Client**: company name, mobile (country code), email (optional), state, GSTIN (optional, checked). A mobile or email another client already has shows a warning under the field and the existing client is offered ("Use this client"); a client is never duplicated (CRM 3.64.3). A similar name is only a hint.
2. **Contact Person**: salutation, name, gender, email, mobile, PAN (optional, encrypted), job title. Company name = the client's (locked). An existing contact is reused.
3. **Travel Information**: the same fields and checks as the client's Travel Requirement. 2.36.3: when an **existing client** is picked in step 1 and its trip (open trip or saved Travel Requirement) has **no quotation**, steps 3, 4 and 5 are filled from it and Create updates that same trip (never a second one). When that trip **has a quotation**, nothing is filled and Next is blocked: finish or close that trip first (one open trip per client).
4. **Travellers**: at least one. **The same form as Travellers → Add traveller** (2.36.2: the lead Travellers component on the draft) — same fields, rules, OCR, "Existing Traveller Found" card and "Add existing traveller". Each save is checked by the server; nothing is stored until Create. A document photo is only read (OCR) here, not stored: add it on the trip's Travellers tab afterwards.
5. **Travel Requirements**: one form per service chosen in step 3.
6. **Invoice**: the lines are built from steps 3–5; only the prices are entered. Payment term: **full payment only**.

After the invoice, a **draft itinerary** is made from its quotation (2.36.5, CRM 3.64.9 `afterRoute`; staff check it and make it Final once services are confirmed). The booking still waits for full payment.

On Create, in order: client → contact (added to the client) → the trip is saved (Travel Requirement, trip enquiry opened, travellers added) → quotation (full payment) → **staff confirms the sale** (salesFlow.staffConfirmedSale, audited) → **tax invoice** (unpaid until a payment is recorded). If a step fails, **Retry** goes on from it; nothing is made twice. A client that already has another open trip is refused (finish that trip first).

No new route: the draft is checked and priced through `POST /quotation-prefill { draft, check? }` and saved through `POST /clients/:client_id/quotation-start { draft }`. The booking follows the normal flow after payment.

---

## 11. Client Portal

Who can log in:
- the client's **Primary** contact and **Secondary** contacts (full access to that client's data).

How to give access:
- Use **Give Portal Access** on the Lead, Opportunity or Client detail page, or the manager approves a request.
- The OpenNext user is created (or reused by email) and gets the CRM role **"Client / Customer Portal (openext-crm-suite)"**.
- The role is **verified** before portal access is marked assigned. If it fails, nothing is marked.
- A staff account's email is refused (`PORTAL_USER_IS_STAFF`).

What the client sees:
- **Quotations**, **Invoices** and **Bookings** ("My Bookings") for their own client and leads, including client-trip bookings.
- Ticket and voucher downloads. These are private S3 files, and only the owner can download them.
- The sidebar is built on the server per user (`/admin-nav`). Staff-only pages are hidden.

---

## 12. Where things appear

| Place | Travel adds |
| --- | --- |
| Sidebar (staff) | Travellers, Bookings, Services & Forms (admins) |
| Sidebar (portal) | Bookings (My Bookings) |
| Lead detail | Travel Requirement, Travellers, Bookings tabs |
| Opportunity detail | Trip tab |
| Quotation detail | Booking & itinerary tab |
| Client detail | Travel Requirement, Travellers, Bookings tabs |
| Contact detail | Travellers tab |
| Settings → Travel | Locations, readiness rules, availability, booking prefix, time zone... |
| Reports / Dashboard | Enquiries to trips, revenue and collections, services, destinations, upcoming trips, traveller readiness |
| Reports → Trips (2.35.0) | Every trip in one table: lead trips and client trips. Click a row to open the Trip page |
| Trip page (2.35.0) | `/ext/travel/trip?lead=<id>` or `?client_trip=<id>`, opened from Reports → Trips |

### Trips report and Trip page (2.35.0, CRM 3.61.0)

- **Trips tab** (first tab of Reports): one row per trip.
  - A lead trip is a travel lead (merged leads are left out).
  - A client trip is a client Travel Requirement with no lead. When a client trip opens an enquiry lead, it is shown once, as that lead's trip.
  - The date range uses the date the trip was created. Travel date is a column.
  - Sales person, destination, service, booking status and payment filters apply. Lead source applies to lead trips only, so client trips are left out when it is set.
  - Client trips need `crm.clients.read`. Quotations and payment need `crm.finance.read`; booking status needs `x.travel.bookings.read`.
- **Trip page** (read-only): trip details, payment, and a count + list of quotations, invoices, proformas, bookings, itineraries, travellers, travel requirements, activities and notes.
  - Each count jumps to its section; each section links to the CRM page or tab that manages it; each row opens its own record.
  - Quotation revisions are shown once (latest version, with the number of revisions). Archived ones are left out.
  - Invoices and proformas come only from the trip's own quotations. Paid / balance come from the CRM's verified payments.
  - Travellers show name, age group, relation and passport / Aadhaar status only, never numbers or files.
  - A client trip shows the client's notes and activities as "Client notes (all trips)" / "Client activities (all trips)", because the CRM keeps them on the client, not on one trip.
  - Client-portal logins cannot open the page or the report (404).
- **Private client notes** (CRM 3.61.0): only the note's author and admins see a note marked Private, on the client page and on the Trip page.

Hidden CRM modules for travel: Sales Orders, Samples, Projects, Tasks, Time Logs, Payments, Tickets; Settings → Users.

---

## 13. Permissions

| Permission | Given with | Allows |
| --- | --- | --- |
| `x.travel.bookings.read` | `crm.leads.read` | See bookings, services, confirmations, vouchers, documents |
| `x.travel.bookings.write` | `crm.leads.write` | Create bookings, request / confirm / cancel services, cancel / complete bookings |
| `x.travel.vouchers.issue` | `crm.leads.write` | Issue, reissue, mark sent / used, cancel vouchers |

Money (rate, amount, total) is shown only to users with `crm.finance.read`.

---

## 14. Safety rules (always)

- **Tenant isolation**: every read and write is scoped to the tenant.
- **Audit trail**: entries hold ids only, never document numbers or prices.
- Passport, Aadhaar and PAN numbers are **encrypted, masked, never exported and never logged** in full.
- **Files only on S3** (private). Nothing is stored on local disk.
- Changes to data are **additive**: old records stay safe if the extension has a problem.

---

## 15. Quick status cheat-sheet

| Record | Statuses |
| --- | --- |
| Travel Requirement (lead) | Not started, Draft, Complete |
| Client trip | Draft, Complete, Quoted, Booked |
| Availability check | Available, Held, On Request, Unavailable |
| Booking | Pending, Partially Confirmed, Confirmed, Cancelled, Completed |
| Booking service | Not Requested, Requested, Confirmed, Unavailable, Cancelled |
| Voucher | Draft, Issued, Sent, Used, Cancelled, Superseded |
| Itinerary | Draft, Final, Superseded |
