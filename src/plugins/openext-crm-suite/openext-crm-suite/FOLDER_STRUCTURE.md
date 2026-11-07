# openext-crm-suite — Backend API Folder Structure (Simple Guide)

This folder is the **plugin backend API** for OpenNext CRM Suite.  
It runs inside OpenNext CMS as plugin `openext-crm-suite`.

> Same `api/` structure is copied into **`openNext-CRM-suiteFinal`** when packaging the upload ZIP.

---

## Big picture

```
openext-crm-suite/
├── api/                 ← Backend API (main work for server logic)
├── ui/
│   ├── admin/           ← Built React admin UI (from OpenNextCRMRefactor dist)
│   └── portal/          ← Public client portal HTML pages
├── manifest.json        ← Plugin metadata, nav, permissions
└── FOLDER_STRUCTURE.md  ← This file
```

**API base path (typical)**

```
/api/plugins/openext-crm-suite/...
```

---

## Inside `api/` (most important)

```
api/
├── index.js             ← Plugin entry (register / boot / public paths)
├── roles.js             ← CRM roles definition
├── register-models.js   ← Registers all Mongoose models on load
│
├── routes/              ← URL → controller mapping
├── controllers/         ← Handle HTTP request/response
├── services/            ← Business logic (DB + rules)
├── models/              ← MongoDB / Mongoose schemas
├── validation/          ← Request body/query schemas
├── middleware/          ← Tenant, permissions, validation, audit
└── utils/               ← Shared helpers
```

### One-line meaning of each folder

| Folder | What it is |
|--------|------------|
| `routes/` | Declares endpoints (`GET /leads`, `POST /invoices`, …) |
| `controllers/` | Reads request, calls service, returns JSON |
| `services/` | Real business logic + database work |
| `models/` | Database collections (Lead, Invoice, Task, …) |
| `validation/` | Input rules (required fields, types, enums) |
| `middleware/` | Runs before controllers (tenant, permission checks) |
| `utils/` | Small reusable helpers |
| `index.js` | Plugin startup + shared middleware |

---

## Request flow (simple)

```
Client (React UI / Portal)
        │
        ▼
   routes/*.routes.js          ← path + method + middlewares
        │
        ▼
   middleware                  ← tenant / permission / validation
        │
        ▼
   controllers/*.controller.js ← parse req, call service
        │
        ▼
   services/*.service.js       ← business rules + DB queries
        │
        ▼
   models/*.js                 ← MongoDB documents
        │
        ▼
   JSON response to UI
```

**Rule of thumb**

1. Add/change URL → `routes/`  
2. Keep response shaping thin → `controllers/`  
3. Put logic + DB → `services/`  
4. Change data shape in DB → `models/`  
5. Validate payload → `validation/`

---

## `api/routes/` — API endpoints by module

| File | Module |
|------|--------|
| `dashboard.routes.js` | Dashboard widgets / summary |
| `reports.routes.js` | Reports (sales, conversion, ageing, etc.) |
| `leads.routes.js` / `lead-detail.routes.js` | Leads |
| `clients.routes.js` | Clients / companies |
| `opportunity.routes.js` | Opportunities |
| `projects.routes.js` / `milestones.routes.js` | Projects & milestones |
| `tasks.routes.js` | Tasks |
| `time-logs.routes.js` | Time logs |
| `expenses.routes.js` / `recurring-expenses.routes.js` | Expenses |
| `quotations.routes.js` | Quotations / estimates |
| `sales-orders.routes.js` | Sales orders |
| `invoices.routes.js` / `recurring-invoices.routes.js` | Invoices |
| `invoice-templates.routes.js` | Invoice templates |
| `payments.routes.js` | Payments |
| `credit-notes.routes.js` | Credit notes (API exists) |
| `products.routes.js` | Products |
| `sample.routes.js` | Sample requests |
| `tickets.routes.js` | Support tickets |
| `customer-success.routes.js` | Customer success |
| `marketing.routes.js` | Marketing campaigns |
| `contracts.routes.js` | Contracts |
| `data-quality.routes.js` | Dedup / data quality |
| `analytics-ai.routes.js` | Analytics AI |
| `audit.routes.js` | Audit history |
| `settings.routes.js` | CRM settings |
| `tenants.routes.js` | Tenant / membership |
| `context.routes.js` | Current user/tenant context |
| `media.routes.js` | File / media upload download |

OpenNext auto-loads route files from `api/routes/`.

---

## `api/controllers/` — HTTP layer

One controller per area, for example:

- `lead.controller.js`, `client.controller.js`, `invoice.controller.js`
- `dashboard.controller.js`, `report.controller.js`
- `payment.controller.js`, `task.controller.js`, …

Controllers should stay thin:

- read `req.params` / `req.query` / `req.body`
- call the matching service
- return `{ success, data }` or error status

---

## `api/services/` — business logic

Examples:

| Service | Responsibility |
|---------|----------------|
| `lead.service.js` | Lead CRUD, convert, filters |
| `client.service.js` | Client 360°, notes, timeline |
| `invoice.service.js` | Invoice create/send/status |
| `quotation.service.js` | Quotations / estimates |
| `payment.service.js` | Payments & reconciliation |
| `report.service.js` | All report calculations |
| `dashboard.service.js` | Dashboard KPIs & widgets |
| `project.service.js` / `task.service.js` | Delivery work |
| `time-log.service.js` | Time tracking |
| `ticket.service.js` | Support tickets |
| `tenant.service.js` | Tenancy + permission resolve |
| `mail.service.js` | Email sending |
| `razorpay-gateway.service.js` | Online payments |
| `client-portal.service.js` | Public portal access |

If logic is complex, it belongs here — not in routes/controllers.

---

## `api/models/` — database schemas

Mongoose models = MongoDB collections. Common ones:

| Model | Stores |
|-------|--------|
| `Lead.js` | Leads |
| `Company.js` / `Contact.js` | Clients & contacts |
| `Opportunity.js` | Deals |
| `Project.js` / `Milestone.js` / `Task.js` | Delivery |
| `TimeLog.js` | Time entries |
| `Expense.js` / `RecurringExpense.js` | Expenses |
| `Estimate.js` / `EstimateTemplate.js` | Quotations |
| `SalesOrder.js` | Sales orders |
| `Invoice.js` / `RecurringInvoice.js` / `InvoiceTemplate.js` | Invoices |
| `Payment.js` / `CreditNote.js` | Money in / credit |
| `Ticket.js` | Support |
| `Campaign.js` | Marketing |
| `AuditLog.js` | Audit trail |
| `Tenant.js` / `TenantMembership.js` | Multi-tenant access |
| `Setting.js` | CRM settings |
| `*Attachment.js` | Uploaded files linked to records |

---

## `api/validation/` — input rules

Zod/schema-style validators used by middleware, for example:

- `lead.schema.js`, `client.schema.js`, `task.schema.js`
- `finance.schema.js`, `payment.schema.js`, `invoice-template.schema.js`
- `common.util.js` — shared validation helpers

Bad input is rejected **before** service logic runs.

---

## `api/middleware/` — gates before controllers

| File | Job |
|------|-----|
| `tenant.middleware.js` | Ensure tenant context |
| `permission.middleware.js` | Check CRM permissions |
| `validation.middleware.js` | Apply validation schemas |
| `audit.middleware.js` | Record audit events |

Also, `api/index.js` adds shared middleware on plugin register (tenant + permission resolve + logging).

---

## `api/utils/` — helpers

Useful utilities include:

| Area | Examples |
|------|----------|
| Access control | `sales-access`, `project-access`, `ticket-access`, `expense-access` |
| Tenancy / roles | `tenant.util`, `tenant-role.util`, `crm-role-permissions.util` |
| Finance docs | `finance-document.util`, `numbering.util`, `pdf-generator.util` |
| Files / media | `storage.util`, `s3-media-bridge.util` |
| Search / lists | `pagination.util`, `search.util`, `import-fields.util` |
| Jobs | `cron-scheduler.util` (recurring invoices/tasks, etc.) |
| Portal | `portal.util`, `public-origin.util` |

---

## How a feature is usually organized

Example: **Leads**

```
api/routes/leads.routes.js
api/controllers/lead.controller.js
api/services/lead.service.js
api/models/Lead.js
api/validation/lead.schema.js
(+ related: LeadEvent, LeadAttachment, follow-up, upload services)
```

Same pattern for Clients, Invoices, Projects, Reports, etc.

---

## `api/index.js` — plugin entry

Handles:

1. **`publicApiPaths`** — endpoints that work without login (e.g. public quotation/invoice links)
2. **`register()`** — register models, tenant middleware, permission resolve
3. **`boot()`** — startup tasks (sync roles, cron jobs)

---

## Dev source vs deploy package

| Folder | Role |
|--------|------|
| `openext-crm-suite/` | Working / source plugin (edit API here) |
| `openNext-CRM-suiteFinal/` | Clean package used for ZIP upload to CMS |

When shipping:

1. Keep `api/` in sync (source → suiteFinal)
2. Copy built React UI into `ui/admin/`
3. Zip `openNext-CRM-suiteFinal` and upload

---

## What to edit when…

| You want to… | Start here |
|--------------|------------|
| Add a new API URL | `api/routes/` |
| Change response / status codes | `api/controllers/` |
| Fix business logic / wrong totals | `api/services/` |
| Add DB fields | `api/models/` |
| Tighten request validation | `api/validation/` |
| Restrict who can call an API | `api/middleware/` + `roles.js` |
| Shared helper (paging, PDF, access) | `api/utils/` |
| Plugin startup / cron | `api/index.js` |

---

## Quick tips

1. Keep controllers thin; put logic in services.
2. Always scope data by tenant (`clientId` / tenant context).
3. Check permissions for write/sensitive actions.
4. After API changes, sync into `openNext-CRM-suiteFinal` before creating the ZIP.
5. Frontend calls these APIs from `OpenNextCRMRefactor/src/services/api.ts`.

---

*Frontend structure: see `OpenNextCRMRefactor/FOLDER_STRUCTURE.md`.*
