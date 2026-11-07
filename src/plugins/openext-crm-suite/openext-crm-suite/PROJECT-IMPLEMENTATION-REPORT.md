# OpenExt CRM Suite — Project Implementation Report

**Plugin ID:** `openext-crm-suite`  
**Location:** `plugin-packages/crm-plugin/`  
**Platform:** OpenNext CMS Backend MVC Plugin  
**Report Date:** August–September 2026 (Updated & Comprehensive — includes 2–4 Sep 2026 delivery upgrades; dedicated creation pages & navigation streamlining 4 Sep 2026)  
**Version:** `1.28.0` (plugin manifest may still show `1.20.0` for OpenNext packaging)  
**Status:** **All Phases & Modules Complete** (Phase 1 Sales & Finance · Phase 2A Projects & Delivery · Phase 2B Time & Reporting · Phase 4 Expenses · Lead Details & S3 Attachments · Tenant Security & Multi-Tenant Management · Sales Orders & Logistics · Opportunities Pipeline · Customer Success & Support Tickets · Marketing Automation · AI Intelligence · Sample Requests · Self-Contained Custom Role Permissions & Record Scoping Engine · Task Dependencies · Task Archive/Restore · History-Aware CRM Navigation · Dedicated Invoices & Expenses Create Architecture · Bank Accounts Manager · Universal CSV/JSON Export Engine · Dedicated Quotation & Invoice Detail Workspaces · Invoice Accounting Guards & Edit Mode · Structured Grid & Summary Table Layouts · Project Manager Ticket Scoping & Agent Assignment Gates · Project Tasks Progress · Quotation Print Export · Roles Documentation Sync · **Invoice Template Creation Studio · Dedicated Sample Request Creator · Dedicated Opportunity Deal Builder · Settings Users & Designations Tab · Sidebar Navigation Streamlining**)

---

## 1. Executive Summary

This report provides a complete, production-grade record of all modules and architecture implemented in the **OpenExt CRM Suite** plugin. The plugin operates as a comprehensive, modular enterprise CRM system integrated seamlessly into the OpenNext CMS ecosystem with **24 admin pages/workspaces**, an **MVC backend architecture**, **24 MongoDB collections**, and full enterprise workflows:

1. **Sales + Finance (Phase 1):**
   ```text
   Lead → Convert to Client → Quotation → Invoice → Payment
   ```

2. **Project Delivery & Team Collaboration (Phase 2A):**
   ```text
   Client → Project → Milestone → Task → Depends-on (same-project) → Archive / Restore → Task Comments → Delivery Members
   ```

3. **Time Tracking, Print & Business Intelligence (Phase 2B):**
   ```text
   Task → Time Log (billable/non-billable hours) → Print (HTML Export) → Financial & Operational Reports
   ```

4. **Expense Management & Approvals (Phase 4):**
   ```text
   Draft Expense → Submit → Manager Review & Approval / Rejection → Financial Cash Flow Reports
   ```

5. **Lead 360° View & Attachments (v1.7.0 / v1.8.0):**
   ```text
   Lead Details → Timeline Events + Follow-ups + Notes + Map Coordinates + S3 Photos/Attachments
               → Proposals (Quotations) → Acceptance → Won Stage + Client Conversion
   ```

6. **Tenant Security & Multi-Tenant Access Control (v1.10.0):**
   ```text
   Tenant Provisioning → User Auto-Admit & Membership → Role Mapping Matrix → Read-Only Security Matrix
   ```

7. **Sales Orders & Logistics Tracking (v1.19.0):**
   ```text
   Quotation / Opportunity → Sales Order → State & Weight Shipping Rate Calculation → Courier Dispatch (AWB) → Delivery Confirmation (POD)
   ```

8. **Opportunities Pipeline & Stage Locking (v1.19.0):**
   ```text
   Lead / Client → Opportunity Pipeline (Kanban) → Revenue Probability Forecast → Stage Locking on Conversion
   ```

9. **Customer Support Tickets & SLA Timers (v1.20.0):**
   ```text
   Client / Contact → Support Ticket Creation → Priority SLA Countdown Tracking → Assignment & Status Resolution
   ```

10. **Customer Success, Health Scoring & CSAT Wall (v1.20.0):**
    ```text
    Client Metrics → Churn Risk & Health Scoring (0–100) → Retention Playbook Actions → Client Feedback & CSAT Wall
    ```

11. **Marketing Automation & AI Intelligence (v1.20.0):**
    ```text
    Marketing Campaign Execution → ROI Tracking → AI Demand Forecasting & Behavioral Insights → Next Best Action (NBA) Engine
    ```

12. **Self-Contained Custom Role Permissions & Record Scoping Engine (v1.20.0):**
    ```text
    CMS Custom Role (Freelancer / Custom Roles) → Role Plugin Page Access & Feature Filtering → Autonomous CRM Scoping (Projects, Tasks, Time Logs, Leads, Clients)
    ```

13. **Task Dependencies, Archive & History Navigation (27 Aug 2026):**
    ```text
    Task → Depends on same-project Task → Blocked indicator until dependency completes
         → Archive / Restore (read-only while archived)
    Deep Hash Routes (#tasks/<id>, #projects/<id>) → Browser / UI Back restores prior CRM view + list filters
    CRM iframe → Parent OpenExt Sidebar active highlight sync (crm-plugin-route-change)
    ```

**API Base URL:** `/api/plugins/openext-crm-suite`

---

## 2. Complete Build Timeline

| Step | Module / Milestone | Status |
|---|---|---|
| 1 | Folder structure, routing architecture & `manifest.json` | ✅ Complete |
| 2 | Plugin shell (iframe sandbox-safe admin UI + server entry) | ✅ Complete |
| 3 | Settings module (General, Finance, Pipeline, Delivery configuration) | ✅ Complete |
| 4 | Audit History service (immutable insert-only tracking with usernames) | ✅ Complete |
| 5 | Leads module (CRUD, wizard, stage transition, deduplication) | ✅ Complete |
| 6 | Clients module (Company + Contact management + Lead conversion) | ✅ Complete |
| 7 | Quotations module (line items, tax calculation, convert to invoice) | ✅ Complete |
| 8 | Invoices module (balance sync, send/cancel, payment tracking) | ✅ Complete |
| 9 | Payments module (overpayment prevention, balance updates, receipts) | ✅ Complete |
| 10 | Dashboard module (sales, finance, delivery, and time metrics) | ✅ Complete |
| 11 | UI design system + responsive layouts + custom dialogs | ✅ Complete |
| 12 | Audit username display & CMS user lookup | ✅ Complete |
| 13 | Sales Management & role profile mapping | ✅ Complete |
| 14 | Auto Tax ID generation on client creation | ✅ Complete |
| 15 | Role and permission wiring | ✅ Complete |
| 16 | Phase 2 bug fixes (permissions, won stage, rollback) | ✅ Complete |
| 17 | **Phase 2A — Projects + Delivery backend** | ✅ Complete |
| 18 | **Phase 2A — Projects + Delivery admin UI** | ✅ Complete |
| 19 | **Audit module expansion (`project`, `task`, `time_log`, `expense`)** | ✅ Complete |
| 20 | **Task comments drawer & discussion threads** | ✅ Complete |
| 21 | **Phase 2B — Time Logs backend & rate computation** | ✅ Complete |
| 22 | **Phase 2B — Time Logs admin UI & task integration** | ✅ Complete |
| 23 | **Print HTML export (quotations & invoices with zero dependencies)** | ✅ Complete |
| 24 | **Reports module (sales, pipeline, projects progress)** | ✅ Complete |
| 25 | **Reports expansion (conversion, ageing, time logs, CSV export)** | ✅ Complete |
| 26 | Dashboard time & billable revenue metrics | ✅ Complete |
| 27 | **List pagination (10/page) across all main tables** | ✅ Complete |
| 28 | **Expenses module (submit / approve / reject workflow)** | ✅ Complete |
| 29 | **Income vs expense report & cash flow aggregation** | ✅ Complete |
| 30 | **Lead 360° Details (events, follow-ups, map, proposal quotation)** | ✅ Complete |
| 31 | **Lead Photo & S3 Attachment management** | ✅ Complete |
| 32 | **Tenant Security & Multi-Tenant Management (`Tenant`, `TenantMembership`)** | ✅ Complete |
| 33 | **Sales Orders & Logistics Tracking (`SalesOrder`, courier, AWB, POD)** | ✅ Complete |
| 34 | **Dynamic State & Weight Shipping Rate Calculation (`ShippingService`)** | ✅ Complete |
| 35 | **Opportunities Pipeline, Revenue Forecast & Stage Locking (`Opportunity`)** | ✅ Complete |
| 36 | **List Pager & UI Pagination Engine (`createListPager`)** | ✅ Complete |
| 37 | **Customer Support Tickets & Priority SLA Timers (`Ticket`)** | ✅ Complete |
| 38 | **Customer Success & Churn Prevention Engine (`CustomerHealth`, CSAT Wall)** | ✅ Complete |
| 39 | **Sample Requests Lifecycle & Feedback Workflow (`SampleRequest`)** | ✅ Complete |
| 40 | **Marketing Automation & AI Demand Forecasting Engine (`MarketingCampaign`)** | ✅ Complete |
| 41 | **Self-Contained Custom Role Permissions & Record Scoping Engine** | ✅ Complete |
| 42 | **Recurring Tasks Engine & Recurrence Scheduling Workflow** | ✅ Complete |
| 43 | **Task Templates & Reusable Deliverable Checklists Engine** | ✅ Complete |
| 44 | **Same-Project Task Dependencies (`dependsOnTaskId`)** | ✅ Complete |
| 45 | **History-Aware Deep-Hash Navigation & List Context Restore** | ✅ Complete |
| 46 | **OpenExt Parent Sidebar Active Menu Sync (`crm-plugin-route-change`)** | ✅ Complete |
| 47 | **Task Archive & Restore Workflow** | ✅ Complete |
| 48 | **Task Watchers & Followers Engine (`followers`, `toggle-follow`)** | ✅ Complete |
| 49 | **Universal CSV & JSON Export across All Modules (`bindExportDropdown`, modal downloads)** | ✅ Complete |
| 50 | **Dedicated Quotation Details View, Edit Mode & Accepted Quote Immutability Guards** | ✅ Complete |
| 51 | **Dedicated Invoice Details Workspace, Payment Recording Modal & Bad-Debt Write-Off** | ✅ Complete |
| 52 | **Structured Invoices Listing Grid Layout, Dynamic Sorting & Summary Footers (`<tfoot>`)** | ✅ Complete |

---

## 3. Project Directory Structure

```text
openext-crm-suite/
├── manifest.json                         Plugin manifest (v1.20.0, 54 permissions, 20 navigation items)
├── package.json
├── PROJECT-IMPLEMENTATION-REPORT.md      ← Master Implementation Report
├── ui/
│   └── admin/
│       ├── index.html                    Shell layout, sandboxed modal, toast, task drawer container
│       ├── app.js                        Hash router, permission-aware navigation, auth context
│       ├── style.css                     Comprehensive modern CSS design system
│       ├── utils/
│       │   ├── ui.js                     CrmUi formatting, badges, pagination, helpers
│       │   ├── task-drawer.js            Task detail + comments + time logs slide-over drawer
│       │   └── validation.js             Frontend input sanitization and validation helpers
│       ├── pages/
│       │   ├── dashboard/                Executive metrics, sales/delivery/time KPI cards, quick actions
│       │   ├── leads/                    Lead list (`leads.js`), create wizard (`lead-create.js`), 360° detail (`lead-detail.js`)
│       │   ├── clients/                  Client directory, overview, contacts, finance, projects tabs
│       │   ├── data-quality/             Duplicate lead/client detection, confidence scoring, merge tool
│       │   ├── projects/                 Project workspaces, team members, milestones, tasks, deletion guards
│       │   ├── tasks/                    Task list, status workflows, priority tags, depends-on picker, archive/restore, drawer integration
│       │   ├── time-logs/                Billable time tracking, hourly rate computation, calendar filters
│       │   ├── expenses/                 Expense creation, categorization, submit / approve / reject flow
│       │   ├── quotations/               Quotation builder, line item discounts, approval, HTML print
│       │   ├── sales-orders/             Order fulfillment, courier selection, AWB tracking, POD upload
│       │   ├── invoices/                 Invoice generator, balance synchronization, payment terms, HTML print
│       │   ├── payments/                 Payment receipts, partial & full payment, balance recomputation
│       │   ├── samples/                  Sample request pipeline, dispatch, approval, and feedback
│       │   ├── opportunities/            Deals pipeline (Kanban), weighted revenue forecasting, stage locking
│       │   ├── tickets/                  Support ticketing, SLA countdown timers, priority resolution
│       │   ├── customer-success/         Client health index (0–100), churn risk alerts, CSAT review wall
│       │   ├── marketing/                Campaign builder, channel attribution, conversion ROI analytics
│       │   ├── analytics-ai/             AI forecasting, demand prediction, Next Best Action (NBA)
│       │   ├── reports/                  Sales, conversion, project progress, time logs, AR ageing, CSV download
│       │   ├── audit/                    Audit history log, user identification, change breakdown
│       │   ├── settings/                 System parameters, tax configurations, numbering prefixes
│       │   └── security/                 Multi-tenant security, member status, read-only role mapping matrix
│       └── services/
│           └── api.js                    CrmApi centralized client with full REST endpoint integration
└── api/
    ├── index.js                          Plugin entry point (registration, middleware, routes boot)
    ├── roles.js                          Built-in CRM plugin role definitions and feature capabilities
    ├── register-models.js                Global Mongoose model registration across CMS connections
    ├── models/                           24 Mongoose schemas (Leads, Projects, Tasks, Tickets, etc.)
    ├── controllers/                      22 REST API controllers
    ├── services/                         26 domain services (Tenant, Lead, Project, Ticket, AI, etc.)
    ├── routes/                           22 modular route files
    ├── middleware/                       Permission, tenant context, and schema validation middleware
    ├── migrations/                       001–009 database schema migrations
    ├── hooks/                            install.js, uninstall.js lifecycle scripts
    ├── validation/                       Zod schemas for strict request payload validation
    └── utils/
        ├── tenant.util.js                Tenant ID and User ID contextual resolution
        ├── tenant-role.util.js           Dynamic OpenNext CMS Role → CRM Role mapping
        ├── sales-access.util.js          Self-contained Lead & Client record assignment scoping
        ├── project-access.util.js        Self-contained Project, Task & Time Log assignment scoping
        ├── crm-role-permissions.util.js  Role-to-permission mapping and defaults
        ├── numbering.util.js             Sequential document auto-numbering (QUO-, INV-, ORD-, etc.)
        ├── pagination.util.js            Standardized pagination and sorting parser
        ├── finance-document.util.js      HTML printable payload builder
        └── user.util.js                  Safe CMS User lookup & username resolution
```

---

## 4. Manifest & Registered Permissions

**File:** `manifest.json`

- **Plugin ID:** `openext-crm-suite`
- **Version:** `1.20.0`
- **Navigation:** 21 admin navigation pages declared
- **Permissions:** 54 discrete permission keys declared

```text
crm.dashboard.view

crm.leads.read
crm.leads.write
crm.leads.delete
crm.leads.convert
crm.leads.duplicate.override

crm.clients.read
crm.clients.write
crm.clients.delete
crm.clients.duplicate.override

crm.dataQuality.read
crm.dataQuality.manage

crm.projects.read
crm.projects.write
crm.projects.delete

crm.tasks.read
crm.tasks.write
crm.tasks.delete

crm.time.read
crm.time.write
crm.time.delete

crm.expenses.read
crm.expenses.write
crm.expenses.delete
crm.expenses.approve

crm.finance.read
crm.finance.write
crm.finance.delete
crm.quotes.approveDiscount

crm.orders.read
crm.orders.write
crm.orders.delete

crm.samples.read
crm.samples.write
crm.samples.approve
crm.samples.feedback

crm.opportunities.read
crm.opportunities.write
crm.opportunities.delete

crm.tickets.read
crm.tickets.write
crm.tickets.delete
crm.tickets.resolve

crm.customerSuccess.read
crm.customerSuccess.manage

crm.marketing.read
crm.marketing.write
crm.marketing.delete

crm.analytics.read
crm.ai.read
crm.ai.write

crm.audit.read
crm.reports.read
crm.reports.export
crm.settings.manage
crm.users.manage
```

---

## 5. Detailed Module Architecture

### 5.1 Self-Contained Custom Role Permissions & Record Scoping Engine
- **Independent Resolution:** All role permission mapping and filtering logic is implemented directly within `openext-crm-suite` without requiring modifications to the host OpenNext CMS core.
- **`PERM_REQ` Matrix:** Automatically verifies every manifest permission against the role's assigned `pages` and `features`. Non-granted pages (e.g. `settings`, `security`) strip administrative permissions (`crm.settings.manage`, `crm.users.manage`), ensuring non-admin custom roles cannot perform unauthorized actions.
- **Dynamic Membership Synchronization:** `attachTenantContext()` dynamically syncs `membership.role` whenever a user's role is modified in OpenNext CMS.

### 5.2 Project, Task & Time Log Scoping (`project-access.util.js`)
- **Assigned Project Filter:** Any non-admin role (including `freelancer`, project leader, custom roles, employees) is marked as `isEmployeeScoped(req)`.
- **Query Scoping:** Restricts project visibility to:
  1. Projects where the user is an assigned team member (`assignedTo: userId`).
  2. Projects where the user is in the project delivery team (`ProjectMember`).
  3. Projects created by the user (`createdBy: userId`).
- **Feature Exclusions:** Deletion is strictly guarded by `crm.projects.delete`; if ungranted, the delete button is hidden and direct DELETE requests return a 403 Forbidden error.
- **Task & Time Scoping:** Inherits the project scope, guaranteeing that task lists, time log entries, and project progress statistics strictly reflect accessible records.

### 5.3 Leads & Clients Scoping (`sales-access.util.js`)
- **Assigned Record Isolation:** Non-admin sales agents, freelancers, and custom roles are scoped via `isSalesAgentScoped(req)`.
- **Query Scoping:** Restricts lead visibility to leads assigned to the user or created by the user, completely eliminating leaks of unassigned leads.
- **Client Scoping:** Users can only view clients they created or converted from their own assigned leads.

### 5.4 Opportunities Pipeline & Stage Locking (`opportunity.service.js`)
- **Deals Kanban:** Visual pipeline tracking with stages (Discovery, Proposal, Negotiation, Won, Lost).
- **Revenue Forecasting:** Calculates expected revenue based on win probability percentages per stage.
- **Stage Locking:** Prevents accidental regression or tampering once an opportunity is converted to a formal Quotation or Sales Order.

### 5.5 Sales Orders & Shipping Logistics (`sales-order.service.js`, `shipping.service.js`)
- **Order Processing:** Converts approved quotations into active fulfillment orders.
- **Dynamic Shipping Calculator:** Calculates shipping rates based on consignment weight (kg) and destination state zone.
- **Logistics Tracking:** Manages courier assignment, Air Waybill (AWB) numbers, and Proof of Delivery (POD) attachments.

### 5.6 Customer Support Tickets & SLA Timers (`ticket.service.js`)
- **Ticketing Workflow:** Manages customer issues with statuses (Open, In Progress, Waiting on Customer, Resolved, Closed).
- **SLA Countdown Engine:** Priority-based resolution timers (Urgent: 4h, High: 12h, Medium: 24h, Low: 48h) with real-time visual alerts.

### 5.7 Customer Success & Health Index (`customer-success.service.js`)
- **Health Index Calculation:** Aggregates payment timeliness, support ticket frequency, and CSAT ratings into a 0–100 score.
- **Retention Playbooks:** Provides actionable playbooks for high-risk accounts and showcases positive client testimonials on the CSAT Wall.

### 5.8 Marketing Automation & AI Intelligence (`marketing.service.js`, `analytics-ai.service.js`)
- **Campaign Management:** Manages multi-channel marketing campaigns (Email, WhatsApp, Social, Ads) and tracks ROI.
- **AI Forecasting & NBA:** Predicts quarterly demand trends and provides Next Best Action recommendations for sales representatives.

### 5.9 Sample Requests Workflow (`sample.service.js`)
- **Sample Tracking:** Manages physical sample requests for prospects and clients.
- **Approval & Feedback:** Manages sample dispatch approvals and client feedback collection.

---

## 6. MongoDB Database Schema & Collections

| Collection Name | Model Name | Primary Purpose |
|---|---|---|
| `plugin_openext_crm_suite_settings` | `Setting` | Key-value system and tenant configuration |
| `plugin_openext_crm_suite_audit_logs` | `AuditLog` | Immutable audit history for all actions |
| `plugin_openext_crm_suite_leads` | `Lead` | Prospective customer records and pipeline status |
| `plugin_openext_crm_suite_lead_events` | `LeadEvent` | Timeline activities (calls, emails, meetings, notes) |
| `plugin_openext_crm_suite_follow_ups` | `FollowUp` | Scheduled reminders and follow-up tasks |
| `plugin_openext_crm_suite_lead_attachments` | `LeadAttachment` | S3-uploaded photo and document attachments |
| `plugin_openext_crm_suite_companies` | `Company` | Client account records and business profiles |
| `plugin_openext_crm_suite_contacts` | `Contact` | Individual contact persons linked to clients |
| `plugin_openext_crm_suite_projects` | `Project` | Client project entities, budgets, and timelines |
| `plugin_openext_crm_suite_project_members` | `ProjectMember` | Project delivery team member assignments |
| `plugin_openext_crm_suite_milestones` | `Milestone` | Deliverable phases and budget milestones |
| `plugin_openext_crm_suite_tasks` | `Task` | Work items linked to projects/milestones; same-project dependencies; archive/restore |
| `plugin_openext_crm_suite_task_comments` | `TaskComment` | Discussion comments on task items |
| `plugin_openext_crm_suite_time_logs` | `TimeLog` | Billable and non-billable labor hours |
| `plugin_openext_crm_suite_expenses` | `Expense` | Operational expenses, receipts, and approvals |
| `plugin_openext_crm_suite_estimates` | `Quotation` | Formal sales quotations and line items |
| `plugin_openext_crm_suite_sales_orders` | `SalesOrder` | Fulfillment orders, shipping, and logistics |
| `plugin_openext_crm_suite_invoices` | `Invoice` | Invoices, balances, and payment terms |
| `plugin_openext_crm_suite_payments` | `Payment` | Received payment records and receipts |
| `plugin_openext_crm_suite_opportunities` | `Opportunity` | Deals pipeline and revenue forecast records |
| `plugin_openext_crm_suite_sample_requests` | `SampleRequest` | Physical product sample requests |
| `plugin_openext_crm_suite_tickets` | `Ticket` | Customer support tickets and SLA tracking |
| `plugin_openext_crm_suite_customer_health` | `CustomerHealth` | Churn index, health scores, and CSAT reviews |
| `plugin_openext_crm_suite_marketing_campaigns` | `MarketingCampaign` | Marketing campaigns, budgets, and lead attribution |
| `plugin_openext_crm_suite_tenants` | `Tenant` | Multi-tenant organization definitions |
| `plugin_openext_crm_suite_tenant_memberships` | `TenantMembership` | User tenant access and role assignments |

---

## 7. Complete API Endpoint Directory

| Category | Endpoint | Method | Permission Required | Description |
|---|---|---|---|---|
| **Context & Auth** | `/me` | GET | `crm.dashboard.view` | Current user context, permissions, and roles |
| | `/users` | GET | `crm.leads.write` | Assignable user directory |
| **Settings** | `/settings` | GET, PUT | `crm.settings.manage` | Read / update tenant settings |
| | `/settings/pipeline` | GET, PUT | `crm.leads.read`, `crm.settings.manage` | Pipeline stage configuration |
| | `/settings/delivery` | GET, PUT | `crm.projects.read`, `crm.settings.manage` | Project / task status configuration |
| **Audit** | `/audit` | GET | `crm.audit.read` | Filterable system audit log |
| | `/audit/:module/:recordId` | GET | `crm.audit.read` | Record-specific audit history |
| **Leads** | `/leads` | GET, POST | `crm.leads.read`, `crm.leads.write` | List / create leads (scoped) |
| | `/leads/:id` | GET, PUT, DELETE | `crm.leads.read`, `crm.leads.write`, `crm.leads.delete` | Lead CRUD operations |
| | `/leads/:id/stage` | PUT | `crm.leads.write` | Transition lead stage |
| | `/leads/:id/convert` | POST | `crm.leads.convert` | Convert lead to client account |
| | `/leads/:id/events` | GET, POST | `crm.leads.read`, `crm.leads.write` | Timeline activities and notes |
| | `/leads/:id/follow-ups` | GET, POST | `crm.leads.read`, `crm.leads.write` | Scheduled follow-up tasks |
| | `/leads/:id/attachments` | GET, POST, DELETE | `crm.leads.read`, `crm.leads.write` | S3 photo and document attachments |
| **Clients** | `/clients` | GET, POST | `crm.clients.read`, `crm.clients.write` | List / create clients (scoped) |
| | `/clients/:id` | GET, PUT, DELETE | `crm.clients.read`, `crm.clients.write`, `crm.clients.delete` | Client CRUD operations |
| | `/clients/:id/contacts` | GET, POST | `crm.clients.read`, `crm.clients.write` | Manage client contacts |
| | `/clients/:id/projects` | GET | `crm.projects.read` | View client projects |
| **Projects** | `/projects` | GET, POST | `crm.projects.read`, `crm.projects.write` | List / create projects (scoped) |
| | `/projects/:id` | GET, PUT, DELETE | `crm.projects.read`, `crm.projects.write`, `crm.projects.delete` | Project CRUD operations |
| | `/projects/:id/members` | GET, POST, DELETE | `crm.projects.read`, `crm.projects.write` | Manage project team members |
| | `/projects/:id/milestones` | GET, POST | `crm.projects.read`, `crm.projects.write` | Project milestones |
| | `/projects/:id/overview` | GET | `crm.projects.read` | Project statistics and progress |
| | `/projects/:id/tasks` | GET | `crm.tasks.read` | Tasks belonging to project |
| **Tasks** | `/tasks` | GET, POST | `crm.tasks.read`, `crm.tasks.write` | List / create tasks (scoped; default excludes archived) |
| | `/tasks/:id` | GET, PUT, DELETE | `crm.tasks.read`, `crm.tasks.write`, `crm.tasks.delete` | Task CRUD operations |
| | `/tasks/:id/status` | POST | `crm.tasks.write` | Update task status |
| | `/tasks/:id/archive` | POST | `crm.tasks.write` | Archive task (read-only until restored) |
| | `/tasks/:id/restore` | POST | `crm.tasks.write` | Restore archived task to active list |
| | `/tasks/:id/comments` | GET, POST | `crm.tasks.read`, `crm.tasks.write` | Task comment discussion thread |
| **Time Logs** | `/time-logs` | GET, POST | `crm.time.read`, `crm.time.write` | List / record time logs (scoped) |
| | `/time-logs/:id` | GET, PUT, DELETE | `crm.time.read`, `crm.time.write`, `crm.time.delete` | Time log CRUD operations |
| **Expenses** | `/expenses` | GET, POST | `crm.expenses.read`, `crm.expenses.write` | List / create expense records |
| | `/expenses/:id` | GET, PUT, DELETE | `crm.expenses.read`, `crm.expenses.write`, `crm.expenses.delete` | Expense CRUD operations |
| | `/expenses/:id/submit` | POST | `crm.expenses.write` | Submit draft expense for approval |
| | `/expenses/:id/approve` | POST | `crm.expenses.approve` | Approve expense reimbursement |
| | `/expenses/:id/reject` | POST | `crm.expenses.approve` | Reject expense reimbursement |
| **Quotations** | `/quotations` | GET, POST | `crm.finance.read`, `crm.finance.write` | List / create sales quotations |
| | `/quotations/:id` | GET, PUT, DELETE | `crm.finance.read`, `crm.finance.write`, `crm.finance.delete` | Quotation CRUD operations |
| | `/quotations/:id/convert` | POST | `crm.finance.write` | Convert quotation to invoice |
| | `/quotations/:id/print` | GET | `crm.finance.read` | HTML print view |
| **Orders** | `/sales-orders` | GET, POST | `crm.orders.read`, `crm.orders.write` | List / create sales orders |
| | `/sales-orders/:id` | GET, PUT, DELETE | `crm.orders.read`, `crm.orders.write`, `crm.orders.delete` | Order CRUD operations |
| | `/sales-orders/:id/dispatch` | POST | `crm.orders.write` | Dispatch order with AWB tracking |
| | `/sales-orders/:id/deliver` | POST | `crm.orders.write` | Confirm delivery with POD |
| **Invoices** | `/invoices` | GET, POST | `crm.finance.read`, `crm.finance.write` | List / create invoices |
| | `/invoices/:id` | GET, PUT, DELETE | `crm.finance.read`, `crm.finance.write`, `crm.finance.delete` | Invoice CRUD operations |
| | `/invoices/:id/print` | GET | `crm.finance.read` | HTML print view |
| **Payments** | `/payments` | GET, POST | `crm.finance.read`, `crm.finance.write` | List / record payment receipts |
| | `/payments/:id` | GET, PUT, DELETE | `crm.finance.read`, `crm.finance.write`, `crm.finance.delete` | Payment CRUD operations |
| **Opportunities** | `/opportunities` | GET, POST | `crm.opportunities.read`, `crm.opportunities.write` | Deals pipeline & revenue forecast |
| | `/opportunities/:id` | GET, PUT, DELETE | `crm.opportunities.read`, `crm.opportunities.write`, `crm.opportunities.delete` | Opportunity CRUD operations |
| **Samples** | `/samples` | GET, POST | `crm.samples.read`, `crm.samples.write` | Sample requests pipeline |
| | `/samples/:id` | GET, PUT, DELETE | `crm.samples.read`, `crm.samples.write` | Sample request CRUD operations |
| **Tickets** | `/tickets` | GET, POST | `crm.tickets.read`, `crm.tickets.write` | Support tickets & SLA tracking |
| | `/tickets/:id` | GET, PUT, DELETE | `crm.tickets.read`, `crm.tickets.write`, `crm.tickets.delete` | Ticket CRUD operations |
| **Success** | `/customer-success` | GET | `crm.customerSuccess.read` | Health scores, churn risk, CSAT wall |
| **Marketing** | `/marketing` | GET, POST | `crm.marketing.read`, `crm.marketing.write` | Campaign management & ROI tracking |
| **AI Intelligence** | `/analytics-ai` | GET, POST | `crm.analytics.read`, `crm.ai.read` | Demand forecasting & Next Best Action |
| **Reports** | `/reports/sales` | GET | `crm.reports.read` | Sales performance & revenue reports |
| | `/reports/projects` | GET | `crm.reports.read` | Project delivery & progress reports |
| | `/reports/time` | GET | `crm.reports.read` | Billable labor hours reports |
| | `/reports/expenses` | GET | `crm.reports.read` | Income vs expense cash flow reports |
| | `/reports/export` | GET | `crm.reports.export` | CSV export for all report types |
| **Security** | `/tenants/security` | GET, PUT | `crm.users.manage` | Tenant security matrix & user roles |

---

## 8. Summary of Recent Enhancements

1. **Autonomous Custom Role Permissions**:
   Implemented self-contained permission derivation (`resolvePermissionsForMembership` + `PERM_REQ`) directly inside `openext-crm-suite`. Custom roles created in OpenNext CMS (such as `freelancer`) strictly receive only the capabilities corresponding to their enabled pages and features. Administrative capabilities (`crm.settings.manage`, `crm.users.manage`) are automatically stripped for non-admin custom roles.

2. **Strict Project, Lead & Client Scoping**:
   - Freelancers, project leaders, and custom roles can only view and manage projects where they are in `assignedTo`, in the `ProjectMember` delivery team, or were the original creator.
   - Lead lists strictly isolate assigned leads, removing fallback leaks of unassigned leads.
   - Client lists strictly isolate accounts created or converted by the user.

3. **Read-Only Tenant Security User Matrix**:
   Maintained clean synchronization between CMS user roles and CRM tenant profiles, with read-only badge display in the workspace user directory to prevent accidental role mutation.

4. **Zero-Dependency Integrity**:
   Verified that OpenNext CMS core files are untouched, with all business logic, data models, validation schemas, and UI styling contained cleanly inside `openext-crm-suite`.

---

## 9. Comprehensive Implementation Log — August 25, 2026

### 9.1 Cascade Deletion of Related Milestones & Tasks on Project Removal
- **Requirement / Business Rule**: Deleting a project must automatically delete its related milestones and tasks so no orphaned deliverables remain.
- **Backend Implementation ([`api/services/project.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/project.service.js))**:
  - In `ProjectService.remove(req, id)`:
    1. Soft-deletes the `Project` record (`isDeleted: true, deletedAt: now, deletedBy: userId`).
    2. Cascade soft-deletes all associated milestones (`Milestone.updateMany({ tenantId, projectId: id, isDeleted: false }, { isDeleted: true, ... })`).
    3. Cascade soft-deletes all associated tasks (`Task.updateMany({ tenantId, projectId: id, isDeleted: false }, { isDeleted: true, ... })`).
    4. Cascade soft-deletes all delivery team memberships (`ProjectMember.updateMany({ tenantId, projectId: id, isDeleted: false }, { isDeleted: true, ... })`).
    5. Emits an immutable audit log entry for project deletion.
- **Automated Verification**:
  - Unit test in [`test/project-workspace.test.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/test/project-workspace.test.js) verifies that deleting a project cascades to soft-delete all linked milestones, tasks, and member records.

---

### 9.2 Searchable Rich Client Selector with Circular Profile Photo & Details
- **Frontend Architecture ([`ui/admin/utils/ui.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/utils/ui.js))**:
  - Created modular `window.CrmUi.renderClientPicker` and `renderClientAvatar`.
  - **Visual Profile Representation**:
    - Circular profile photo / avatar (`border-radius: 50%`, `overflow: hidden`, `object-fit: cover`) loading uploaded `avatarUrl` or vibrant gradient with first-letter initials.
    - Prominent bold Client / Company Name.
    - Contact email address with `✉` icon.
    - Status indicator pill (`🟢 Active` in green or `⚪ Inactive` in slate).
    - Category badge (`🏷️ VIP`, `🏷️ Enterprise`, etc.).
  - **Live Search & Selection**:
    - Real-time search filter input across names, emails, and categories.
    - Selected card view with quick `Change Client ▾` trigger.
- **Unified Integration Across Core Modules**:
  1. **Projects — Create Project** ([`ui/admin/pages/projects/project-create.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/projects/project-create.js)): Integrated rich client picker + live sidebar sync.
  2. **Projects — Edit Project Modal** ([`ui/admin/utils/ui.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/utils/ui.js)): Integrated rich client picker + live sidebar sync.
  3. **Quotations — New Quotation Form** ([`ui/admin/pages/quotations/quotations.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/quotations/quotations.js)): Searchable client picker.
  4. **Invoices — New Invoice Form** ([`ui/admin/pages/invoices/invoices.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/invoices/invoices.js)): Searchable client picker + automatic sync when importing quotations.
  5. **Sales Orders — Create Sales Order Modal** ([`ui/admin/pages/sales-orders/sales-orders.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/sales-orders/sales-orders.js)): Searchable client picker for client account selection.

---

### 9.3 Dropdown Display & Card Overflow Bug Fixes
- **Styling Architecture ([`ui/admin/style.css`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/style.css))**:
  - Fixed parent card clipping by ensuring `overflow: visible` on `.lead-section-card`, `.lead-section-body`, `.quote-form`, `.so-modal-body`, `.so-form-grid`, and `.panel`.
  - Elevated active container z-index to `10000` and dropdown menu z-index to `99999` with smooth slide-down animation and layered box-shadow.

---

### 9.4 Project Creation & Edit Parity Improvements
- **Priorities**: Added priority level selector (`Urgent 🔥`, `High ⚡`, `Medium 🔹`, `Low ⚪`) with backend persistence.
- **Tags / Labels**: Added interactive tag chips with dynamic quick-creation modal (`openAddProjectTagModal`).
- **Custom Fields & Attributes**: Added dynamic custom field rendering supporting global defined fields (text, textarea, select, number, date, boolean, url, email) plus dynamic extra key-value attribute builder.

---

### 9.5 Lead Management Parity Improvements
- **Configurable Settings**: Added modals for custom Lead Sources (`openAddLeadSourceModal`), Lead Statuses (`openAddLeadStatusModal`), and Lead Tags (`openAddLeadTagModal`).
- **Bulk Lead Import Wizard ([`ui/admin/utils/ui.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/utils/ui.js))**:
  - RFC 4180 compliant CSV parser.
  - Drag-and-drop file upload zone + paste text area.
  - Sample CSV template generator and direct download (`downloadLeadSampleCsv`).
  - Row-level validation and duplicate detection preview table with warning/error breakdown cards.
- **Export Result Modal**:
  - Direct download trigger, one-click clipboard copy, and direct new-tab download link.
- **Bulk Operations**: Bulk lead assignment and bulk stage update support.

---

### 9.7 Lead Export with Permission & Tenant Scope
- **Backend Engine ([`api/services/lead.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/lead.service.js))**:
  - `GET /leads/export` requires `crm.leads.export` or `crm.leads.read` permission.
  - Strict **tenant scoping** — cross-tenant access is structurally impossible.
  - **Sales Agent scoping**: non-admin users only export leads assigned to or created by them.
  - **Live Filter Passthrough**: supports `stage`, `status`, `source`, `tag`, `search`, `from`, `to`, `format` (`csv` or `json`).
  - **Dynamic Custom Fields**: automatically flattens all tenant-defined custom attributes into `Custom: {field_name}` columns.
  - **Audit Logging**: records an audit entry (`exported`) tracking count, format, and filter criteria.
- **Frontend** ([`ui/admin/pages/leads/leads.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/leads/leads.js)):
  - `📤 Export` dropdown button with one-click `📄 CSV` and `📦 JSON` options.
  - Opens **Export Ready Modal** with direct download, clipboard copy, and new-tab fallback for iframe sandbox environments.
- **Permission Added**: `crm.leads.export` registered in `tenant-role.util.js` and `crm-role-permissions.util.js`.

---

### 9.8 Bulk Lead Assignment & Bulk Stage Update
- **Backend Routes ([`api/routes/leads.routes.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/routes/leads.routes.js))**:
  - `POST /leads/bulk/assign` — validates `leadIds[]` (max 500) + `assignedTo`, updates `assignedTo` + `updatedBy`, logs `bulk_assigned` audit entry.
  - `POST /leads/bulk/stage` — validates `leadIds[]` + `stage` against pipeline config, excludes converted leads, logs `bulk_stage_changed` audit entry.
  - Both routes registered **before** `/leads/:id` parameterized routes to prevent Express route collision (`"bulk"` being treated as a lead ID).
- **Frontend Bulk Actions Bar** ([`ui/admin/pages/leads/leads.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/leads/leads.js)):
  - Per-row checkboxes and **Select All** header checkbox.
  - Floating **Bulk Actions Bar** (appears on selection): `🔵 X leads selected`, `👤 Assign to Agent` dropdown + Apply, `🏷️ Move to Stage` dropdown + Apply, `✕ Clear`.
  - Real-time toast feedback and automatic table refresh.
- **Validation Schemas** ([`api/validation/lead.schema.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/validation/lead.schema.js)): `validateLeadBulkAssign`, `validateLeadBulkStage`.

---

### 9.9 Saved Lead Filters — Full Architecture & UI Integration
- **Backend Service & REST Endpoints ([`api/services/lead.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/lead.service.js) & [`api/routes/leads.routes.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/routes/leads.routes.js))**:
  - `GET /leads/saved-filters`: Scoped listing returning user's private filters + team-shared filters.
  - `POST /leads/saved-filters`: Validates and persists filter preset with auto-default management and audit logging.
  - `PUT /leads/saved-filters/:id`: Updates name, criteria, default status, or team sharing with authorization enforcement.
  - `DELETE /leads/saved-filters/:id`: Deletes filter preset with ownership validation.
- **Frontend UI & Modals ([`ui/admin/pages/leads/leads.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/leads/leads.js) & [`ui/admin/utils/ui.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/utils/ui.js))**:
  - `📁 Saved Filter` dropdown in Leads toolbar with instant preset activation and default filter auto-load.
  - `💾 Save` modal (`openSaveLeadFilterModal`) with active criteria breakdown, default toggle, and team sharing.
  - `⚙️ Manage` modal (`openManageSavedLeadFiltersModal`) with preset list, default switches, and deletion.
  - `✕ Reset` button for 1-click clearing of all filters.
- **Validation** ([`api/validation/lead.schema.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/validation/lead.schema.js)): `validateSavedLeadFilterCreate`, `validateSavedLeadFilterUpdate`.

---

### 9.10 Saved Lead Filters & Filter Matching Hardening
- Implemented case-insensitive regex pattern queries for `stage`, `status`, `source`, and `tag` filters.
- Replaced iframe-blocked raw confirm with `CrmApp.confirm` modal flow.

---

### 9.11 Automatic Client Reminder Emailing on Tasks Awaiting Reply
- **Business Rule / Requirement**: When a deliverable task's client feedback status remains in `Awaiting Reply` (or `Pending Review` / `Pending Feedback` / `Not Replied`) and exceeds the configured reminder threshold hours, automatically dispatch review reminder emails to the client contact.
- **Settings Toggle & Configuration ([`ui/admin/pages/settings/settings.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/settings/settings.js), [`api/services/setting.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/setting.service.js))**:
  - Added `task_client_reminder_auto_enabled` boolean setting switch with clean UI toggle card in Settings under **Tasks & Client Feedback Reminder Settings**.
  - Configured threshold hours (`task_client_reminder_hours`, default: 24h) with quick preset buttons (12h, 24h, 48h, 72h, 168h).
- **Backend Auto-Reminder Engine ([`api/services/task.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/task.service.js))**:
  - `TaskService.processAutoClientReminders(req)`:
    - Verifies setting enablement and calculates cutoff time.
    - Queries active tasks in awaiting feedback statuses that passed the reminder threshold hours.
    - Sends branded review reminder emails to client contacts via `MailService.sendViaEmailPlugin`.
    - Updates `lastReminderSentAt`, `clientNotifiedAt`, `clientNotifiedEmail`, increments `reminderCount`, and logs audit entry and task comment.
- **REST Endpoints & Frontend API ([`api/routes/tasks.routes.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/routes/tasks.routes.js), [`ui/admin/services/api.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/services/api.js))**:
  - `POST /tasks/auto-reminders/process` and `GET /tasks/auto-reminders/process` (registered before `/:id`).
  - Added `window.CrmApi.processAutoTaskReminders()`.
- **Database Schema ([`api/models/Task.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/Task.js))**:
  - Added `lastReminderSentAt: Date` and `reminderCount: Number` to `TaskSchema`.

---

### 9.12 Lead Ageing & Overdue Follow-up Indicators
- **Business Rule / Requirement**: Provide sales teams with instant visual clarity on lead stage duration (fresh, active, attention, stale) and overdue/upcoming follow-up tasks directly across Kanban, Table, and 360-degree Detail views.
- **Backend Calculation & Schema ([`api/models/Lead.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/Lead.js), [`api/services/lead.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/lead.service.js))**:
  - Added `stageUpdatedAt` timestamp field to `LeadSchema`, automatically set and updated on lead creation, stage transitions, and bulk stage shifts.
  - Implemented `enrichLeadsWithAgeingAndFollowUps(req, leads)`:
    - **Ageing Engine**: Calculates `totalAgeDays`, `stageAgeDays`, and classifies into `Fresh` (<=3d), `Active` (4-7d), `Attention` (8-14d), and `Stale` (>14d).
    - **Follow-up Engine**: Queries active open follow-ups from `FollowUp` collection, calculates `overdueDays`, `overdueCount`, and next scheduled due dates.
- **Frontend Badges & Integration ([`ui/admin/pages/leads/leads.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/leads/leads.js), [`ui/admin/pages/leads/lead-detail.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/leads/lead-detail.js))**:
  - `renderLeadAgeingBadge`: Displays color-coded pills (🌱 Fresh, 🕒 Active, ⚠️ Attention, 🔴 Stale) with day counters.
  - `renderLeadFollowUpBadge`: Displays urgent alerts (🚨 Overdue Xd, 🔔 Due Today, 📅 Upcoming Date).
  - Integrated across Kanban cards, Table rows, and Lead Detail hero headers.

---

### 9.13 Interactive Project Gantt Chart (Worksuite-Style Drag-to-Resize & Timeline Stretch)
- **Business Rule / Requirement**: Deliver a highly flexible, Worksuite-style Gantt chart allowing users to stretch and zoom date columns dynamically, drag left/right bar handles to stretch start and due dates with auto-saving, drag entire task bars to reschedule, and drag a split-pane divider to resize the task sidebar.
- **Frontend Architecture & Implementation ([`ui/admin/pages/projects/projects.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/projects/projects.js))**:
  - **Worksuite-Style Drag-to-Resize & Stretch Engine**:
    - **Left Handle (`.gantt-resize-handle-left`)**: Grab and drag to stretch / modify task `startDate` in real-time.
    - **Right Handle (`.gantt-resize-handle-right`)**: Grab and drag to stretch / modify task `dueDate` in real-time.
    - **Center Body Drag**: Grab and drag the task bar to shift the entire schedule forward or backward in time.
    - **Live Floating Tooltip**: Snaps to day columns and displays live preview during drag: `↔ Start: 12 Aug → Due: 28 Aug (16d)`.
    - **Auto-Persistence**: On drop/release, invokes `window.CrmApi.updateTask(taskId, { startDate, dueDate })`, displays toast confirmation, and updates local state.
  - **Dynamic Timeline Stretch & Zoom Controls**:
    - Interactive **↔ Stretch Slider** (`24px` to `140px`) allowing users to expand/stretch date column widths to their exact visual preference.
    - Multi-scale presets: **Days**, **Weeks**, and **Months**.
  - **Draggable Splitter & Sidebar Toggle**:
    - Draggable vertical splitter bar (`#gantt-splitter-bar`) allowing users to resize the left task list from `160px` to `520px`.
    - `◀ Task List` collapse/expand toggle button for maximum timeline viewport.
  - **Color-Coded Status Visualization & Badges**:
    - 🟢 Completed (`#10b981`), 🔵 In Progress (`#3b82f6`), 🟡 In Review (`#f59e0b`), 🟣 To Do (`#6366f1`), 🟠 On Hold (`#f97316`), ⚪ Cancelled (`#94a3b8`).
    - Subtask progress % fill underlay.
    - Vertical `📍 Today` guide line and `⚠️ OVERDUE` warning markers.

---

### 9.14 Project Manager & Member Task Visibility Scope Fix
- **Root Cause Identified**: 
  - `buildEmployeeTaskScope` in [`api/utils/project-access.util.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/utils/project-access.util.js) previously restricted accessible project tasks strictly to tasks where `assignedTo: ''` or `assignedTo: null`. Any task assigned to another project team member (e.g. `assignedTo: "user_123"`) was incorrectly filtered out and hidden from the Project Manager on both the Tasks Tab and Gantt Chart.
  - In addition, `userOwnsTask` previously checked `if (!task?.assignedTo && project && userOwnsProject(...))` which caused single-task read/write endpoints to deny access to project managers for assigned tasks.
- **Backend Fix & Enterprise Scoping**:
  - Updated `buildEmployeeTaskScope(req)` to include all tasks under any accessible/managed project (`{ projectId: { $in: [...projectIds, ...projectObjectIds] } }`), allowing Project Managers and team members to view all deliverables in their projects.
  - Enhanced `userOwnsProject(req, project)` to support `assignedTo` whether stored as an array of user IDs, array of objects, single string ID, or `createdBy`.
  - Updated `userOwnsTask(req, task, project)` so that Project Managers who own/manage or belong to the parent project have full read and write access across all project tasks.
- **Automated Verification**:
  - Created [`test/project-manager-tasks-access.test.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/test/project-manager-tasks-access.test.js) verifying Project Manager access to all assigned and unassigned deliverables.

---

### 9.15 Qualified Leads Connected to Product Catalogue & Contracts Workflows
- **Product Catalogue Model & Engine**:
  - Created [`api/models/Product.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/Product.js) supporting `sku` (tenant-unique), `name`, `category`, `type` (`product`, `service`, `subscription`), `unit`, `unitPrice`, `taxRate`, `status`, and `stockQuantity`.
  - Created [`api/services/product.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/product.service.js) with auto-seeded starter software/service items, category queries, and pagination.
  - Created [`api/routes/products.routes.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/routes/products.routes.js) exposing `/products` CRUD and category lookup.
- **Contracts & Agreements Model & Engine**:
  - Created [`api/models/Contract.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/Contract.js) supporting `contractNumber` (`CNT-YYYYMM-XXXX`), `leadId`, `clientId`, `subject`, `contractType` (MSA, Software License, SLA, NDA), `value`, `terms`, line items, and electronic signature metadata (`signerName`, `signerEmail`, `signedAt`, `signerIp`).
  - Created [`api/services/contract.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/contract.service.js) supporting contract lifecycle (`Draft`, `Sent`, `Under Review`, `Accepted`, `Declined`, `Active`, `Expired`) and immutable E-Signatures.
  - Created [`api/routes/contracts.routes.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/routes/contracts.routes.js) exposing `/contracts`, `/contracts/from-lead/:leadId`, and `/contracts/:id/sign`.
- **Connecting Qualified Leads**:
  - Extended `LeadSchema` in [`api/models/Lead.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/Lead.js) with `interestedProducts` and qualification `contractRequired` / `contractType`.
  - In `LeadService`: Added `addLeadProduct` (auto-recalculating expected revenue from catalogue prices), `removeLeadProduct`, `getLeadContracts`, and `createContractFromLead`.
  - In `LeadDetail` UI ([`ui/admin/pages/leads/lead-detail.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/leads/lead-detail.js)):
    - **`📦 Products & Catalogue` Tab**: Shows linked items with total valuation, 1-click `+ Browse Product Catalogue` modal with real-time price preview, **`+ Add New Product`** quick catalogue creation on the fly, and direct `📦 Sample Request` / `💼 Create Opportunity` buttons.
    - **`📜 Contracts & Agreements` Tab**: Shows active agreements, `+ Draft New Contract` modal pre-filled from qualification & product lines, 1-click **`✍️ E-Sign`** modal, and detailed agreement terms viewer.
    - **Hero Action Buttons**: Added `📦 Catalogue` and `📜 Propose Contract` quick buttons for fast navigation.
- **Automated Verification**:
  - Created [`test/lead-products-contracts.test.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/test/lead-products-contracts.test.js) verifying Product Catalogue CRUD, SKU uniqueness, Lead catalogue linking, Contract creation from Lead, and E-Signatures.

---

### 9.16 Client Tags, Categories & Custom Fields Architecture
- **Company Model & Database Indexing**:
  - Updated [`api/models/Company.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/Company.js) with `tags: { type: [String], default: [] }` and `customFields: { type: Schema.Types.Mixed, default: () => ({}) }`.
  - Added compound index `{ tenantId: 1, tags: 1 }` for high-speed tag-based customer segmentation queries.
- **Validation & Request Normalization**:
  - Updated [`api/validation/client.schema.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/validation/client.schema.js) with `parseTags(raw)` and `parseCustomFields(raw)`.
  - Allowed `tags` and `customFields` in `validateClientCreate` and `validateClientUpdate`.
- **Client Service & Settings Service**:
  - Updated [`api/services/client.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/client.service.js):
    - In `list(req)`: Added `req.query.tag` filtering and incorporated `tags` in multi-field literal regex search.
    - In `create(req, input)` and `update(req, id, input)`: Persisted `tags` and `customFields`.
  - Updated [`api/services/setting.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/setting.service.js): Added `getClientTags`, `addClientTag`, `updateClientTags`, `getClientCustomFields`, `addClientCustomField`, and `updateClientCustomFields`.
- **REST Endpoints & Controllers**:
  - Updated [`api/controllers/client.controller.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/controllers/client.controller.js) and [`api/routes/clients.routes.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/routes/clients.routes.js) with `GET /clients/tags`, `POST /clients/tags`, `GET /clients/custom-fields`, and `POST /clients/custom-fields`.
- **Frontend Admin Experience**:
  - **API Client & Modal Utilities**:
    - Added `getClientTags`, `addClientTag`, `getClientCustomFields`, `addClientCustomField` to [`ui/admin/services/api.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/services/api.js).
    - Added `openAddClientTagModal` and `openAddClientCustomFieldModal` to [`ui/admin/utils/ui.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/utils/ui.js).
  - **Client Creation Page** ([`ui/admin/pages/clients/client-create.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/clients/client-create.js)):
    - Added interactive `🏷️ Client Tags` card with pill checkboxes and inline `+ Add New Tag` modal.
    - Added dynamic `🧩 Custom Fields` card rendering loaded definitions with inline `+ Add Custom Field` modal.
    - Added live tag preview in the left sidebar card.
  - **Client Directory & 360 Overview** ([`ui/admin/pages/clients/clients.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/clients/clients.js)):
    - Added `Tag` dropdown filter to toolbar and tag pill chips in client table rows.
    - Rendered client tags in hero meta chips.
    - Added `🏷️ Tags` and `🧩 Custom Fields` sections in Overview Tab (view & edit modes).
  - **Settings Page** ([`ui/admin/pages/settings/settings.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/settings/settings.js)):
    - Added `🏢 Client Directory, Categories, Tags & Custom Fields` management section with full custom field builder.
- **Automated Verification**:
  - Created [`test/client-tags-custom-fields.test.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/test/client-tags-custom-fields.test.js) verifying schema validation, SettingsService methods, route registrations, ClientService persistence, and tag filtering.

---

### 9.17 Client Import & Export Architecture
- **Validation Schemas & Normalization**:
  - Updated [`api/validation/client.schema.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/validation/client.schema.js) with `validateClientImportPreview`, `validateClientImport`, and `validateClientExport`.
- **Client Service Import & Export Engine**:
  - [`api/services/client.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/client.service.js):
    - `previewImport(req, { rows, options })`: Parses company attributes (name, email, phone, website, taxId, category, status, tags, customFields, billingAddress) and primary contact details (name, email, phone, designation). Runs in-batch duplicate analysis and database deduplication.
    - `executeImport(req, { rows, options })`: Imports clients in batch with automatic sequence Tax ID generation, primary contact record creation, configurable duplicate skip/override rules, and audit logging.
    - `exportClients(req, query)`: Exports clients in CSV or JSON format with tenant scoping, filter criteria (status, category, tag, search, date range), primary contact enrichment, and custom fields flattener.
- **REST Endpoints & Controllers**:
  - Added `importPreview`, `importExecute`, `exportClients` in [`api/controllers/client.controller.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/controllers/client.controller.js).
  - Registered `POST /clients/import/preview`, `POST /clients/import`, `GET /clients/export` in [`api/routes/clients.routes.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/routes/clients.routes.js).
- **Frontend Admin Experience**:
  - **API Client**: Added `previewClientImport`, `executeClientImport`, `exportClients`, `downloadClientsExport` in [`ui/admin/services/api.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/services/api.js).
  - **UI Modal Utilities**:
    - Implemented `openClientImportModal` wizard in [`ui/admin/utils/ui.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/utils/ui.js) supporting Drag & Drop CSV/JSON, raw text pasting, rule configuration, interactive 4-KPI validation preview with filter tabs, and progress execution summary.
    - Implemented `downloadClientSampleCsv` providing pre-formatted CSV template.
  - **Client List Integration** ([`ui/admin/pages/clients/clients.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/clients/clients.js)):
    - Added **`📤 Export`** dropdown (CSV/JSON) and **`📥 Import Clients`** button in the header actions bar.
- **Automated Verification**:
  - Created [`test/client-import-export.test.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/test/client-import-export.test.js) verifying schema validation, route registration, preview error/warning detection, deduplicated batch execution, and CSV/JSON export.

---

### 9.18 Automated Test Suite Status (Historical Snapshot)
- **Total Tests**: **78 automated unit tests** across **21 test files**.
- **Result**: **78 passed, 0 failed, 0 skipped** (`node --test test/*.test.js`).

---

### 9.19 Recurring Tasks Engine & Recurrence Scheduling Workflow
- **Database Schema & Recurrence Attributes ([`api/models/Task.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/Task.js))**:
  - Added `isRecurring: Boolean` (marks schedule parent), `recurringInterval: String` (`day`, `week`, `month`, `quarter`, `year`), `recurringEvery: Number` (step multiplier >= 1), `recurringTotalCycles: Number` (0 for unlimited, or positive integer cap), `recurringCyclesCompleted: Number`, `recurringNextDate: Date` (next scheduled run timestamp), `recurringLastGeneratedAt: Date`, and `recurringParentTaskId: String` (links generated instance back to template schedule).
  - Added compound database indexes for high-speed batch scheduler lookups.
- **Validation & Request Normalization ([`api/validation/task.schema.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/validation/task.schema.js))**:
  - Sanitizes and validates recurrence interval, step multiplier, total cycles, and custom next run date.
- **Backend Service & Processing Engine ([`api/services/task.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/task.service.js))**:
  - `calculateNextRecurringDate(baseDate, interval, every)`: accurately computes forward timestamps across days, weeks, months, quarters, and years.
  - `processRecurringTasks(req)`: scans due recurring parent tasks (`isRecurring: true`, `recurringNextDate <= now`), creates new instance tasks linked via `recurringParentTaskId`, increments `recurringCyclesCompleted`, advances `recurringNextDate`, and gracefully terminates recurrence when `recurringTotalCycles` is reached. Emits audit logs.
- **REST Endpoints & Controllers ([`api/routes/tasks.routes.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/routes/tasks.routes.js), [`api/controllers/task.controller.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/controllers/task.controller.js))**:
  - Added `POST /tasks/recurring/process` and `GET /tasks/recurring/process`.
- **Frontend Admin Experience ([`ui/admin/pages/tasks/tasks.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/tasks/tasks.js), [`ui/admin/pages/projects/projects.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/projects/projects.js))**:
  - Added `🔄 Process Recurrence` header trigger button.
  - Added `Recurrence` filter dropdown (`All Tasks`, `🔄 Recurring Only`, `📌 One-Time Only`).
  - Added visual badges on list rows and Kanban cards (`🔄 Repeats every X [cycles]` and `🔄 Recurring Instance`).
  - Added recurrence schedule form in task modal (interval select, step input, cycles cap, next run date).
- **Automated Verification**:
  - Created [`test/task-recurring.test.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/test/task-recurring.test.js) verifying interval calculations, schema validation, instance task spawning, cycle incrementation, and cycle termination.

---

### 9.20 Task Templates & Reusable Deliverable Checklists
- **Database Model & Schema ([`api/models/TaskTemplate.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/TaskTemplate.js))**:
  - Model `TaskTemplate` supporting `tenantId`, `title`, `description`, `category`, `priority`, `hoursEstimate`, `tags`, `subtasks: [{ title, description }]`, `createdBy`, `updatedBy`, and soft-deletion fields.
- **Validation Schema ([`api/validation/task-template.schema.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/validation/task-template.schema.js))**:
  - Implemented `validateTaskTemplateCreate`, `validateTaskTemplateUpdate`, and `validateTaskTemplateInstantiate`.
- **Service Layer ([`api/services/task-template.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/task-template.service.js))**:
  - `listTemplates(req)`: returns active tenant templates with category and term search filtering.
  - `getTemplateById(req, id)`: retrieves template with subtasks.
  - `createTemplate(req, payload)` / `updateTemplate(req, id, payload)` / `deleteTemplate(req, id)`: full CRUD with immutable audit logging.
  - `instantiateTemplate(req, id, options)`: creates a new Task document under target `projectId` and automatically generates all checklist subtasks.
  - `saveTaskAsTemplate(req, taskId, options)`: converts an existing task + its subtasks into a reusable TaskTemplate.
- **REST Endpoints & Controllers ([`api/routes/tasks.routes.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/routes/tasks.routes.js), [`api/controllers/task-template.controller.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/controllers/task-template.controller.js))**:
  - Mounted `GET /tasks/templates`, `GET /tasks/templates/:id`, `POST /tasks/templates`, `PUT /tasks/templates/:id`, `DELETE /tasks/templates/:id`, `POST /tasks/templates/:id/instantiate`, `POST /tasks/:id/save-as-template`.
- **Frontend Admin Experience ([`ui/admin/pages/tasks/tasks.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/tasks/tasks.js), [`ui/admin/pages/projects/projects.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/projects/projects.js), [`ui/admin/services/api.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/services/api.js))**:
  - Added `📋 Templates` header button opening the **Task Templates Manager Modal** (view templates, checklist count, create template with dynamic subtask rows, edit, delete, and "⚡ Use").
  - In Task creation modal: added `📋 Prefill from Task Template` dropdown to populate title, description, priority, category, and attach checklist subtasks upon submission.
  - In Task edit modal: added `💾 Save as Template` action button.
- **Automated Verification**:
  - Created [`test/task-templates.test.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/test/task-templates.test.js) verifying validation rules, CRUD operations, multi-subtask instantiation, and task-to-template conversion.

---

### 9.21 Current Automated Test Suite Status
- **Total Tests:** **130 automated unit and integration tests** across **32 test files**.
- **Result:** **130 passed, 0 failed, 0 skipped** (`node --test test/*.test.js`).
- **Commit:** `feat: implement task templates and checklist instantiation workflow`

---

## 10. Comprehensive Implementation Log — August 27, 2026

### 10.1 Same-Project Task Dependencies
- **Requirement / Business Rule**: A task may optionally depend on another task, and the selectable dependency list must be limited to tasks belonging to the **same project**. Self-links and circular dependency chains are rejected.
- **Database Schema ([`api/models/Task.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/Task.js))**:
  - Added `dependsOnTaskId: String` (nullable, indexed) plus compound index `tasks_tenant_depends_on`.
- **Validation ([`api/validation/task.schema.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/validation/task.schema.js))**:
  - Create / update accept optional `dependsOnTaskId` (empty clears dependency).
- **Service Layer ([`api/services/task.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/task.service.js))**:
  - `assertValidDependsOnTask(req, projectId, dependsOnTaskId, currentTaskId)`:
    1. Verifies dependency task exists and is not deleted.
    2. Enforces **same `projectId`**.
    3. Blocks self-dependency.
    4. Walks the dependency chain to prevent circular references.
  - Enrichment adds `dependsOnTaskTitle`, `dependsOnTaskStatus`, `dependsOnCompleted`, and `isDependencyBlocked` for UI badges.
- **Frontend Admin Experience**:
  - **Tasks Create/Edit Modal** ([`ui/admin/pages/tasks/tasks.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/tasks/tasks.js)): `Depends on Task (same project only)` dropdown; refreshes when project changes; excludes the current task while editing.
  - **Project Workspace Task Modal** ([`ui/admin/pages/projects/projects.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/projects/projects.js)): same dependency picker scoped to project tasks.
  - **List / Kanban / Detail**: 🔗 dependency badges; orange “Blocked by” when the dependency is not yet `Completed`; detail sidebar shows Depends on + status.

---

### 10.2 History-Aware Deep-Hash Navigation & List Context Restore
- **Requirement / UX Rule**: Navigating Tasks → Project (or Task detail → Project) must push browser history so **Back** returns to the previous CRM view (including task detail when that was the prior route), not a hard-coded list reset.
- **Router Architecture ([`ui/admin/app.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/app.js))**:
  - Deep hash routes: `#tasks`, `#tasks/<id>`, `#projects`, `#projects/<id>`, plus create actions where applicable (`#clients/create`, `#leads/create`, `#projects/create`).
  - `navigate(routeId, { recordId, action, replace, syncHash })` writes deep hashes and applies pending detail IDs before page render.
  - `goBack({ fallbackRoute })` uses browser history when CRM hash-stack depth allows; otherwise falls back to the module list.
  - `saveListContext` / `consumeListContext` (sessionStorage) restore Tasks filters, view mode, search, and page after return.
- **Page Integration**:
  - Project detail **← Back** uses `CrmApp.goBack({ fallbackRoute: 'projects' })`.
  - Task detail Back uses `goBack({ fallbackRoute: 'tasks' })`.
  - Opening a project from Tasks / Task detail saves Tasks list context first.
- **Outcome**: Tasks listing → click project → Project page → Back → Tasks listing with prior filters restored; Task detail → Project → Back → Task detail restored via `#tasks/<id>`.

---

### 10.3 OpenExt Parent Sidebar Active Menu Sync
- **Problem**: Parent OpenExt Sidebar uses Next.js `usePathname()`. CRM iframe updates the parent URL with `history.replaceState`, which does **not** update React pathname — so the active menu highlight stayed on the previous module after in-app navigation.
- **CRM Fix ([`ui/admin/app.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/app.js))**:
  - After `syncParentRuntimeUrl(routeId)`, dispatches parent custom event `crm-plugin-route-change` with `{ pluginId, routeId, path }`.
  - `syncParentSidebarNav()` also applies temporary active styling on matching sidebar anchors as a fallback.
- **Host CMS Fix ([`src/components/Sidebar.tsx`](file:///c:/Users/AdarshGupta/Documents/OpenExt/openNext%20gitlab/src/components/Sidebar.tsx) in OpenNext CMS)**:
  - Tracks `syncedPathname` from `window.location.pathname`.
  - Listens for `popstate` and `crm-plugin-route-change` to refresh active menu highlighting without remounting the plugin iframe.
- **Outcome**: Switching CRM modules in-app (e.g. Tasks → Projects) correctly highlights the matching OpenExt sidebar menu item.

---

### 10.4 Task Archive & Restore Workflow
- **Requirement / Business Rule**: Tasks can be archived (hidden from the default active list, read-only) and later restored. Soft-delete remains a separate destructive action.
- **Database Schema ([`api/models/Task.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/Task.js))**:
  - Uses existing `isArchived`, `archivedAt`, `archivedBy` fields; added index `tasks_tenant_archived`.
- **Service Layer ([`api/services/task.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/task.service.js))**:
  - `archiveTask(req, id)` / `restoreTask(req, id)` with write-access checks and project-archive guards.
  - List filter: default `isArchived ≠ true`; query `isArchived=true|archived` for archived only; `isArchived=all` for both.
  - Write guards block update, delete, comments, and subtask mutations while a task is archived (restore is the unlock path).
  - Immutable audit actions: `archived`, `restored`.
- **REST Endpoints ([`api/routes/tasks.routes.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/routes/tasks.routes.js), [`api/controllers/task.controller.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/controllers/task.controller.js))**:
  - `POST /tasks/:id/archive` — permission `crm.tasks.write`
  - `POST /tasks/:id/restore` — permission `crm.tasks.write`
- **Frontend Admin Experience**:
  - API client: `archiveTask`, `restoreTask` in [`ui/admin/services/api.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/services/api.js).
  - **Tasks list** ([`ui/admin/pages/tasks/tasks.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/tasks/tasks.js)): Archive filter (`Active` / `Archived Only` / `Active + Archived`), 📦 badges, Archive / Restore row & Kanban actions.
  - **Task detail** ([`ui/admin/pages/tasks/task-detail.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/tasks/task-detail.js)): Archive / Restore header actions + archived read-only banner.
  - **Project workspace tasks** ([`ui/admin/pages/projects/projects.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/projects/projects.js)): Archive / Restore actions on project task rows.

---

### 10.5 Task Watchers & Followers Engine
- **Requirement / Business Rule**: Team members can follow/watch tasks to stay updated on progress, view assigned watchers with designations, toggle their own watching status, and filter task views by watched tasks.
- **Database Schema ([`api/models/Task.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/Task.js))**:
  - `followers: [{ type: String, trim: true }]` (array of user IDs) with compound index `tasks_tenant_followers`.
- **Service Layer ([`api/services/task.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/task.service.js))**:
  - `enrichTasks`: Resolves follower user IDs to `followerUsers` objects (`id`, `username`, `displayName`, `designation`) and `followerCount`.
  - `addFollower(req, taskId, userId)` / `removeFollower(req, taskId, userId)`: Uses `$addToSet` and `$pull` for atomic follower mutation.
  - `toggleFollower(req, taskId, userId)`: Automatically adds if not watching, removes if currently watching.
  - `updateFollowers(req, taskId, followers[])`: Bulk-updates follower list with validation.
  - List filtering: Supports `?watching=true` or `?follower=<userId>` to query tasks followed by the user.
- **REST Endpoints ([`api/routes/tasks.routes.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/routes/tasks.routes.js), [`api/controllers/task.controller.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/controllers/task.controller.js))**:
  - `POST /tasks/:id/followers` — permission `crm.tasks.write`
  - `DELETE /tasks/:id/followers/:userId` — permission `crm.tasks.write`
  - `POST /tasks/:id/toggle-follow` — permission `crm.tasks.read`
  - `PUT /tasks/:id/followers` — permission `crm.tasks.write`
- **Frontend Admin Experience**:
  - API client: `addTaskFollower`, `removeTaskFollower`, `toggleTaskFollow`, `updateTaskFollowers` in [`ui/admin/services/api.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/services/api.js).
  - **Tasks page** ([`ui/admin/pages/tasks/tasks.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/tasks/tasks.js)): "Watching" filter dropdown (`All Tasks` / `👁️ Watching Only`), 👥 follower badges on Kanban & table rows, and watcher selectors in modal.
  - **Task detail workspace** ([`ui/admin/pages/tasks/task-detail.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/tasks/task-detail.js)): "👥 Watchers & Followers" sidebar card with interactive toggle button ("👁️ Watch Task" / "Unwatch"), live follower list with avatar initials, designations, and "+ Add Watcher" picker.
  - **Project task modal** ([`ui/admin/pages/projects/projects.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/projects/projects.js)): Watcher selector checkboxes in project task creation/edit modal.

---

### 10.6 Advanced Quotation & Proposal Creation Engine
- **Requirement / Business Rule**: Comprehensive quotation workspace featuring dedicated creation flow (`#quotations/create`), Lead Contacts / Client selector with auto-switch, Deal/Opportunity pipeline linking, Valid Till expiration dates, Multi-Currency selection, dynamic tax mode (`after_discount` vs `before_discount`), full Product Catalogue picker + inline "+ New Product" quick creation modal, item attachments, live discount & tax calculation, and recipient notes.
- **Database Schema ([`api/models/Estimate.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/Estimate.js))**:
  - `LineItemSchema`: Added `name`, `file` (specification / attachment url), `productId` (catalogue reference).
  - `EstimateSchema`: Added `opportunityId`, `dealId`, `title`, `description`, `taxCalculation` (`after_discount` | `before_discount`), `recipientNotes`.
- **Validation Layer ([`api/validation/finance.schema.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/validation/finance.schema.js))**:
  - Validates `opportunityId`, `dealId`, `taxCalculation`, `validTill`, `currency`, `discountPercent`, `discountAmount`, `recipientNotes`, `lineItems[].name`, `lineItems[].file`, and `lineItems[].productId`.
- **Service Layer ([`api/services/quotation.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/quotation.service.js))**:
  - `buildLineItems`: Computes subtotal, discount ratio, individual line item taxable base respecting `after_discount` vs `before_discount`, and total tax.
  - `enrichQuotationsWithDeals`: Resolves linked deals/opportunities to attach deal title, deal number, and deal stage to quotation payloads.
- **Frontend Admin Experience**:
  - **Dedicated Full-Page Create Workspace** ([`ui/admin/pages/quotations/quotation-create.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/quotations/quotation-create.js)):
    - Lead Contact vs Client Account toggle with recipient summary card.
    - Active Deal / Opportunity selector.
    - Valid Till date picker (defaults to +30 days).
    - Multi-currency selector (INR ₹, USD $, EUR €, GBP £, AED د.إ, SGD S$, CAD C$, AUD A$, JPY ¥) with dynamic live symbol updating.
    - Calculate Tax selector (`After Discount` vs `Before Discount`).
    - Proposal Title & Scope Description inputs.
    - Product Catalogue Quick Bar with dropdown, "+ Add Product" button, and "+ Custom Item" button.
    - Inline "✨ New Product" modal form allowing direct catalogue insertion and immediate quotation line injection.
    - Interactive Line Items table (ItemName, Description, Quantity, Unit Price, Tax %, Line Amount, Specs/Doc file link, Delete).
    - Live Financial Summary card with Subtotal, Discount (% toggle vs Fixed), State Tax mode breakdown (CGST+SGST vs IGST), State shipping charge, and Grand Total.
    - Note for the recipient textarea.
    - "💾 Save Draft" and "✉️ Save & Send" buttons.
  - **Quotations Dashboard** ([`ui/admin/pages/quotations/quotations.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/quotations/quotations.js)):
    - Modern header with `+ Create Quotation` action button routing to full page create workspace.
    - 5 KPI summary cards (Total Quotations, Drafts, Sent, Accepted, Converted).
    - Data table with deal badges, line item count, currency totals, status badges, print/PDF preview, email send, and conversion to Sales Orders or Invoices.

### 10.7 Personalized Watched Tasks Dashboard Highlight & Dedicated Recurring Tasks Workspace
- **Requirement / Business Rule**:
  1. Highlight monitored deliverables on the main Dashboard exclusively for assigned Watchers/Followers (e.g. Project Managers monitoring task execution without being primary assignee).
  2. Provide a dedicated Recurring Tasks & Schedules management view to inspect frequencies, due schedules, and trigger runs on demand.
- **Backend Architecture ([`api/services/dashboard.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/dashboard.service.js))**:
  - Registered `watched_tasks_highlight` widget in `AVAILABLE_WIDGETS` and `ROLE_DEFAULT_WIDGETS`.
  - In `getSummary(req)`:
    - Queries active tasks where `followers: currentUserId` (`status: { $nin: ['Completed'] }`, `isArchived: { $ne: true }`).
    - Populates project names, priority badges, checklist subtasks progress, follower count, and overdue flags.
    - Aggregates `watchedTasksList`, `watchedOpenTasks`, and `watchedOverdueTasks`.
- **Frontend Dashboard Experience ([`ui/admin/pages/dashboard/dashboard.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/dashboard/dashboard.js))**:
  - Rendered rich `👁️ My Watched Tasks & Deliverables` widget with distinct indigo gradient styling and left accent border.
  - Displays project badges, task title with 1-click workspace navigation, priority badges, due date status (`⚠️ Overdue` / `📅 Due Date`), subtask progress counters, and status badges.
- **Dedicated Recurring Tasks Workspace ([`ui/admin/pages/tasks/tasks.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/tasks/tasks.js))**:
  - Upgraded header button to `🔄 Recurring Tasks`.
  - Built `openRecurringTasksManagerModal`:
    - KPI Metrics row (Active Schedules, Due to Generate Now, Cycles Completed).
    - Quick actions: `+ New Recurring Task` and `⚡ Run Due Now`.
    - Live schedules table with frequency, next generation date, due badges, cycles progress, assignee, and inline controls (`✏️ Edit`, `⏸️ Stop / ▶️ Resume`, `🔍 View Workspace`).
- **Automated Verification**:
  - Verified with [`test/dashboard-widgets.test.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/test/dashboard-widgets.test.js) and full repository test run: **140 unit test suites passing with 0 failures**.

---

### 10.8 Time Logs Approval Workflow, Billing Locking & Weekly Timesheet Matrix
- **Requirement / Business Rule**:
  1. Full approval status workflow (`Draft` / `Pending` / `Approved` / `Rejected`) for logged hours, with manager rejection reasons and 1-click single/bulk approvals.
  2. Weekly Timesheet Matrix view (Monday-to-Sunday) grouping logged hours by task and project, with daily and grand totals.
  3. Strict billing lock guard (`isLocked: true`, `invoiceId`) preventing modification or deletion of invoiced or closed-period hours.
- **Database Schema ([`api/models/TimeLog.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/TimeLog.js))**:
  - `approvalStatus`: Enum `['Draft', 'Pending', 'Approved', 'Rejected']` (default: `'Approved'`).
  - `approvedBy`, `approvedAt`, `rejectionReason`.
  - `isLocked`: Boolean index flag.
  - `invoiceId`: String reference to billed invoice.
  - `entryType`: Enum `['manual', 'timer']`.
- **Validation Layer ([`api/validation/time-log.schema.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/validation/time-log.schema.js))**:
  - Added validations for `approvalStatus`, `entryType`, `isLocked`, `invoiceId`, `validateReject`, `validateBulkApprove`, and `validateLock`.
- **Service Layer ([`api/services/time-log.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/time-log.service.js))**:
  - `submitForApproval(req, id)`: Transitions status to `Pending` and logs audit entry.
  - `approve(req, id)`: Sets status to `Approved`, records `approvedBy` & `approvedAt`.
  - `reject(req, id, reason)`: Sets status to `Rejected` and records manager's clarification reason.
  - `bulkApprove(req, ids)`: Batch-approves multiple time logs.
  - `lockTimeLogs(req, { ids, invoiceId })` & `unlockTimeLogs(req, { ids })`: Safely manages billing lock states.
  - `update` & `remove` guards: Throws `403 Forbidden` if attempting to modify locked/invoiced time logs.
  - `getWeeklyTimesheet(req, { weekStart, userId, projectId })`: Aggregates 7-day Monday–Sunday matrix with task groupings, individual day hours, and daily/weekly financial totals.
- **Frontend Admin Experience ([`ui/admin/pages/time-logs/time-logs.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/time-logs/time-logs.js), [`ui/admin/style.css`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/style.css))**:
  - **Tab Switcher**: Seamless switching between `📋 Time Logs List` and `📅 Weekly Timesheet`.
  - **Weekly Timesheet View**:
    - Interactive week navigator (`← Prev Week`, Date Range pill, `This Week`, `Next Week →`).
    - Project filter dropdown.
    - 7-Column Day Matrix with billable vs non-billable hour badges.
    - Quick "+ Log" buttons on empty day cells.
    - Summary footer with daily hour sums and total billable revenue.
    - `✓ Bulk Approve Week` action for managers.
  - **List View Enhancements**:
    - Status pills (`Approved ✅`, `Pending ⏳`, `Rejected ❌`, `Draft 📝`).
    - Method badge (`⏱️ Timer` vs `✍️ Manual`).
    - Lock badge (`🔒 Locked`).
    - Inline manager actions (`✓ Approve`, `✕ Reject`) and employee submission (`✉ Submit`).
- **Automated Verification**:
  - Verified with [`test/time-logs.test.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/test/time-logs.test.js) and full repository test run: **143 unit test suites passing with 0 failures**.

### 10.9 Quotations & Estimates Parity Enhancements (Completed August 2026)

- **Business Objective**: Complete all remaining Section 10 requirements for quotations and estimates:
  1. Reusable quotation templates for rapid proposal generation.
  2. Revision history and version branching (`QT-001-R1`, `QT-001-R2`, etc.) with audit tracking.
  3. Quotation archive and restore workflow with dedicated UI filter views.
  4. Public Client Review Portal with electronic signoff acceptance, change request feedback, and immutable snapshot recording.
- **Database Schemas & Extensions ([`api/models/EstimateTemplate.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/EstimateTemplate.js), [`api/models/Estimate.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/Estimate.js))**:
  - Created `EstimateTemplate` schema with `name`, `description`, `category`, `currency`, `taxCalculation`, `lineItems`, `discountPercent`, `shippingState`, `notes`, `recipientNotes`, `terms`, `isDefault`.
  - Extended `Estimate` schema with `terms`, `version`, `revisionOf`, `isLatestVersion`, `revisionNotes`, `portalToken`, `portalViewedAt`, `acceptedMetadata`, `rejectedMetadata`, `acceptedSnapshot`, `isArchived`, `archivedAt`, `archivedBy`.
  - Added `'quotation_template'` to `AuditLog` module enum.
- **Validation Layer ([`api/validation/estimate-template.schema.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/validation/estimate-template.schema.js), [`api/validation/finance.schema.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/validation/finance.schema.js))**:
  - `validateEstimateTemplateCreate`, `validateEstimateTemplateUpdate`.
  - `validateQuotationRevision`, `validatePortalAccept`, `validatePortalReject`.
- **Service & Controller Layers ([`api/services/estimate-template.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/estimate-template.service.js), [`api/services/quotation.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/quotation.service.js), [`api/controllers/quotation.controller.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/controllers/quotation.controller.js))**:
  - Template CRUD and "Save As Template" from any active proposal.
  - Revision branching: `createRevision` increments version, generates revision suffix, updates previous revisions `isLatestVersion: false`, and links `revisionOf`.
  - Revision timeline: `getRevisionHistory` returns the entire chronological tree for a proposal.
  - Archiving: `archiveQuotation` and `restoreQuotation`.
  - Client Portal: `generatePortalToken` creates 24-byte crypto tokens; `getPublicPortalQuotation`, `clientPortalAccept` (captures signoff name, email, IP, e-signature, comments, and immutable `acceptedSnapshot`), and `clientPortalReject` (captures change requests).
- **Client Portal Public Web Page ([`ui/portal/quotation.html`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/portal/quotation.html))**:
  - Standalone, mobile-responsive, client-facing portal workspace with branded company details, line items table, GST calculations, discount breakdown, terms & conditions.
  - Interactive "✓ Accept & E-Sign" modal with electronic signature capture and "✕ Request Changes" feedback modal.
- **Admin UI Integration ([`ui/admin/pages/quotations/quotations.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/quotations/quotations.js), [`ui/admin/pages/quotations/quotation-create.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/quotations/quotation-create.js))**:
  - Added Reusable Template Manager modal and inline "📁 Load Template" / "💾 Save Template" buttons.
  - Added Version badges (`v1`, `v2`) opening Revision History Timeline modal.
  - Added View Filter dropdown for Active Proposals, Archived Quotes, and All Versions.
  - Added 1-click Quick Revise modal, Client Portal link generator modal, and Archive / Restore table actions.
- **Automated Verification**:
### 10.10 Sales Orders & Logistics Parity Enhancements (Completed August 2026)

- **Business Objective**: Complete all remaining Section 11 requirements for Sales Orders and Logistics tracking:
  1. Multi-shipment creation and partial package fulfillment per sales order with individual courier assignment, AWB tracking, package weight, and line-item quantity allocations.
  2. Return Merchandise Authorization (RMA) & replacement lifecycle tracking with return reason categorizations, refund estimations, and automatic replacement order generation.
  3. Interactive order details drawer with dedicated tabs (`📋 Items & Summary`, `🚚 Multi-Shipments`, `↩️ Returns & RMA`), deliverable fulfillment progress bar, and packing slip preview.
  4. Safe cancellation validation rules blocking cancellation on dispatched or delivered orders while allowing stock reservation releases on pending orders.
  5. Warehouse inventory stock reservation and deduction audit trail tracking.
- **Database Schema Extensions ([`api/models/SalesOrder.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/models/SalesOrder.js))**:
  - Embedded `SalesOrderShipmentSchema` with `shipmentNumber`, `courierName`, `trackingNumber`, `shippingState`, `weightKg`, `shippedItems: [{ lineItemIndex, description, qty, productId }]`, `dispatchedAt`, `deliveredAt`, `deliveryStatus`, `proofOfDelivery`, `notes`, `createdBy`.
  - Embedded `SalesOrderReturnSchema` with `rmaNumber`, `type: ['Return', 'Replacement']`, `status: ['Requested', 'Approved', 'Received', 'Inspected', 'Refunded', 'Replaced', 'Rejected']`, `returnedItems: [{ description, qty, unitRate, reason, productId }]`, `reason`, `refundAmount`, `replacementOrderId`, `requestedAt`, `resolvedAt`, `inspectedBy`, `createdBy`.
  - Added flags `stockReserved`, `stockReservedAt`, `inventoryDeducted`, `inventoryDeductedAt`, and `stockAudit: [{ action, performedAt, performedBy, details }]`.
  - Extended order status enums to include `'Partially Shipped'`, `'Shipped'`, `'Returned'`.
- **Validation Schemas ([`api/validation/sales-order.schema.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/validation/sales-order.schema.js))**:
  - Added `validateShipmentCreate`, `validateShipmentStatusUpdate`, `validateReturnCreate`, `validateReturnStatusUpdate`, `validateOrderCancel`.
- **Service & Controller Logic ([`api/services/sales-order.service.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/sales-order.service.js), [`api/controllers/sales-order.controller.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/controllers/sales-order.controller.js), [`api/routes/sales-orders.routes.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/routes/sales-orders.routes.js))**:
  - `addShipment`: Dispatches partial/full package, generates sequential `SHP` numbering, updates line-item `shippedQty`, computes fulfillment (`Partially Dispatched` / `Dispatched`), marks inventory deduction, and logs audit.
  - `updateShipmentStatus`: Updates shipment delivery status (e.g. `Delivered`), attaches POD, and automatically marks parent sales order as `Completed` when all items and shipments are fulfilled.
  - `createReturn`: Creates RMA ticket, validates returned quantities against delivered items, updates `returnedQty` on line items, and logs audit.
  - `updateReturnStatus`: Advances RMA status (`Approved` -> `Received` -> `Refunded` / `Replaced`) and automatically creates a linked replacement sales order when authorized.
  - `cancel`: Safe cancellation guard prohibiting cancellation if any package is already dispatched/delivered, and releasing stock reservations on approved orders.
  - `reserveStock`: Allocates warehouse inventory stock for sales orders prior to dispatch.
- **Frontend Admin UI Upgrades ([`ui/admin/pages/sales-orders/sales-orders.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/sales-orders/sales-orders.js), [`ui/admin/services/api.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/services/api.js))**:
  - `modal-add-shipment`: Interactive package builder with line-item checklist, remaining un-shipped quantity inputs, shipping partner selector (BlueDart, Delhivery, Shiprocket, FedEx, DTDC, Custom), AWB tracking input, and package weight in KG.
  - `modal-request-return`: RMA request builder with Return vs Replacement selector, returnable item picker, defect reason categorization, and real-time refund calculation preview.
  - Order Details Drawer Tabs: `📋 Items & Summary`, `🚚 Multi-Shipments (${count})`, `↩️ Returns & RMA (${count})`.
  - Deliverables Fulfillment Progress Bar showing exact percentage of deliverables fulfilled and delivered.
  - Interactive Action Buttons: `📦 + Add Shipment`, `↩️ + Request Return`, `🔒 Reserve Stock`, `🚫 Safe Cancel`, `✅ Confirm Delivery & Attach POD`.
- **Automated Verification**:
  - Verified with [`test/sales-orders-parity.test.js`](file:///C:/Users/N/Documents/projects/openNextCRM/test/sales-orders-parity.test.js) and full repository test run: **166 unit test suites passing with 0 failures**.

### 10.11 Invoices, Recurring Profiles, Credit Notes & Dedicated Create Flow (Completed 28 August 2026)

- **Business Objective**:
  1. Replace the legacy inline invoice form with a dedicated full-page create experience (`#invoices-create-view`) supporting sequence generation, multi-currency conversion, tax calculations, discounts, file attachments, and email reminders.
  2. Implement sub-tab action buttons across Recurring Invoices, Credit Notes, and Templates tabs.
  3. Resolve modal invocation contract mismatch where `invoices.js` called `showModal` while `ui.js` exported `openModal`.
  4. Fix credit note validation schema to seamlessly accept line item schemas with `qty`/`quantity` and `rate`/`unitPrice`/`price`.
- **Database Schema Extensions ([`api/models/Invoice.js`](file:///C:/Users/N/Documents/projects/openNextCRM/api/models/Invoice.js), [`api/models/CreditNote.js`](file:///C:/Users/N/Documents/projects/openNextCRM/api/models/CreditNote.js))**:
  - Added `exchangeRate`, `projectId`, `bankAccount`, `paymentDetails`, `billingAddress`, `shippingAddress`, `discountType`, `discountAmount`, `file`, `attachments`, and `reminder: { enabled, timing, count, days }` to `Invoice` model schema.
  - Added `GET /invoices/next-number` endpoint for auto-incrementing sequential invoice numbers (`INV-0001`, `INV-0002`).
- **Validation & Service Layers ([`api/validation/credit-note.schema.js`](file:///C:/Users/N/Documents/projects/openNextCRM/api/validation/credit-note.schema.js), [`api/routes/credit-notes.routes.js`](file:///C:/Users/N/Documents/projects/openNextCRM/api/routes/credit-notes.routes.js))**:
  - Updated `validateCreditNoteItems` to support both `quantity` / `qty` and `unitPrice` / `rate` / `price` with safe fallback defaults.
  - Attached route param `:invoiceId` to `req.body.invoiceId` before validation in `POST /invoices/:invoiceId/credit-note`.
- **Core UI Engine Enhancements ([`ui/admin/utils/ui.js`](file:///C:/Users/N/Documents/projects/openNextCRM/ui/admin/utils/ui.js))**:
  - Updated `openModal` to auto-generate default action buttons when passed `{ confirmLabel, cancelLabel, onConfirm, onCancel, showConfirm }`.
  - Exposed `.body` and `.modalEl` on returned modal instance for direct DOM querying.
  - Added global alias `showModal: openModal` on `window.CrmUi`.
- **Dedicated Invoice Creation Page ([`ui/admin/pages/invoices/invoices.js`](file:///C:/Users/N/Documents/projects/openNextCRM/ui/admin/pages/invoices/invoices.js))**:
  - Full-screen create layout with client selection, address auto-fill, dynamic product catalog selection, line-item table, percentage/flat discounts, tax modes (before vs after discount), dropzone attachments, and reminder checkboxes.
  - Sub-tab modals wired up: Recurring Profile Builder, Standalone Credit Note, Template Builder, Forecast Report, Execution History Logs, and Load/Save Templates.

### 10.12 Expenses Dedicated Full-Page Create View & Bank Accounts Manager (Completed 28 August 2026)

- **Business Objective**:
  1. Remove the inline expense form panel from the expenses list page in favor of a dedicated full-page create experience (`#expenses-create-view`).
  2. Implement all requested fields: `Item Name *`, `Currency *`, `Exchange Rate *`, `Price *`, `Purchase Date *`, `Employee`, `Project`, `Expense Category`, `Purchased From`, `Bank Account (select)`, `Description`, and `Bill (upload file)`.
  3. Add a centralized `🏦 Bank Accounts Manager` in Settings allowing users to add, edit, and delete company bank accounts.
  4. Dynamically populate Bank Account options in Expense creation and Invoice payment details.
- **Database Schema Extensions ([`api/models/Expense.js`](file:///C:/Users/N/Documents/projects/openNextCRM/api/models/Expense.js), [`api/models/Setting.js`](file:///C:/Users/N/Documents/projects/openNextCRM/api/models/Setting.js))**:
  - Extended `Expense` model schema with `itemName`, `price`, `exchangeRate`, `purchaseDate`, `employeeId`, `employeeName`, `purchasedFrom`, `bankAccount`, `description`, `bill` while preserving backward compatibility with legacy fields (`title`, `amount`, `expenseDate`, `receiptUrl`, `notes`).
  - Added `bank_accounts` to `DEFAULT_SETTINGS` in [`api/services/setting.service.js`](file:///C:/Users/N/Documents/projects/openNextCRM/api/services/setting.service.js) with fields `id`, `accountName`, `bankName`, `accountNumber`, `ifscCode`, `branch`, `currency`, `isDefault`.
- **Validation Layer ([`api/validation/expense.schema.js`](file:///C:/Users/N/Documents/projects/openNextCRM/api/validation/expense.schema.js))**:
  - Updated `validateExpenseCreate` and `validateExpenseUpdate` to validate and normalize all extended attributes.
- **Service Layer ([`api/services/expense.service.js`](file:///C:/Users/N/Documents/projects/openNextCRM/api/services/expense.service.js))**:
  - Updated `create`, `update`, and `enrichExpenses` to persist and return all new attributes.
- **Bank Accounts Manager in Settings ([`ui/admin/pages/settings/settings.js`](file:///C:/Users/N/Documents/projects/openNextCRM/ui/admin/pages/settings/settings.js))**:
  - Added interactive `🏦 Bank Accounts Manager` card in Settings where admins can dynamically add, configure, and remove company bank accounts.
  - Automatically loads and saves bank accounts with PUT `/settings`.
- **Dedicated Expense Create Page ([`ui/admin/pages/expenses/expenses.js`](file:///C:/Users/N/Documents/projects/openNextCRM/ui/admin/pages/expenses/expenses.js))**:
  - Replaced inline panel with full-page create view with `← Back to Expenses` navigation.
  - Preloads dynamic Bank Accounts from Settings, Assignable Employees, and Active Projects.
  - Dropzone for attaching receipts and bills.
  - Dual action buttons: `💾 Save as Draft` (`submit: false`) and `🚀 Save & Submit for Approval` (`submit: true`).
- **API Client Upgrades ([`ui/admin/services/api.js`](file:///C:/Users/N/Documents/projects/openNextCRM/ui/admin/services/api.js))**:
  - Added `getExpenses`, `getExpense`, `createExpense`, `updateExpense`, `deleteExpense`, `submitExpense`, `approveExpense`, `rejectExpense`, `getExpenseCategories`, `getSettings`, `updateSettings`, `sendTestEmail`, and `getBankAccounts`.
- **Automated Verification**:
  - Verified with [`scratch/expenses-extended.test.js`](file:///C:/Users/N/Documents/projects/openNextCRM/scratch/expenses-extended.test.js), [`scratch/credit-note-create.test.js`](file:///C:/Users/N/Documents/projects/openNextCRM/scratch/credit-note-create.test.js), [`test/invoices-parity.test.js`](file:///C:/Users/N/Documents/projects/openNextCRM/test/invoices-parity.test.js), and full repository AST/VM syntax checks: **All test suites passing with 0 errors**.

### 10.13 Universal Multi-Format Export Engine (Completed August 2026)

- **Business Objective**:
  1. Provide unified, automated data export capabilities across all business records in the CRM suite (Leads, Clients, Opportunities, Quotations, Invoices, Payments, Expenses, Sales Orders, Tasks, Time Logs, Projects, Support Tickets, Marketing Campaigns) excluding only Settings.
  2. Support both `CSV Spreadsheet` and `Formatted JSON` exports.
  3. Ensure reliable, non-blocking file downloads across all browsers and iframe sandboxes with modal previews and direct fallback triggers.
- **Frontend Export Engine Components ([`ui/admin/utils/ui.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/utils/ui.js))**:
  - `renderExportDropdownHtml(idPrefix)`: Renders accessible, styled dropdown menu with CSV and JSON format selections.
  - `bindExportDropdown({ container, idPrefix, onExport })`: Handles toggle interactions, click-outside closures, and loading state triggers.
  - `openExportResultModal({ title, filename, format, content, directUrl })`: Displays interactive modal with instant `💾 Download File` button, `📋 Copy to Clipboard` button, and direct fallback URI trigger.
- **Client API Integration ([`ui/admin/services/api.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/services/api.js))**:
  - Integrated `downloadLeadsExport`, `downloadClientsExport`, `downloadOpportunitiesExport`, `downloadQuotationsExport`, `downloadInvoicesExport`, `downloadPaymentsExport`, `downloadExpensesExport`, `downloadSalesOrdersExport`, `downloadTasksExport`, `downloadTimeLogsExport`, `downloadProjectsExport`, `downloadTicketsExport`, `downloadMarketingCampaignsExport`.
  - Automated client-side Blob generation with `text/csv;charset=utf-8;` and `application/json;charset=utf-8;` MIME handling and anchor click dispatch.

### 10.14 Quotations Dedicated Details View, Edit Mode & Accounting Immutability Safeguards (Completed August 2026)

- **Business Objective**:
  1. Remove cluttered table `Actions` column from the quotations listing table, making each row clickable to navigate into a dedicated full-page Quotation Details view.
  2. Implement a complete Quotation Details workspace (`renderQuotationDetail` / `#quotations/:id`) with actionable business workflows.
  3. Support Quotation Editing mode (`#quotations/:id/edit`) while enforcing accounting integrity safeguards prohibiting direct edits on `Accepted` or `Converted to Invoice` proposals.
- **Admin Details & Edit Workspaces ([`ui/admin/pages/quotations/quotations.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/quotations/quotations.js), [`ui/admin/pages/quotations/quotation-create.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/quotations/quotation-create.js))**:
  - **Top Action Bar**: `← Quotations List` back button, `✏️ Edit Quotation` (hidden for accepted/converted quotes), `🖨️ Print / PDF`, `🧾 Convert to Invoice`, `✉️ Send to Client`, `🔗 Client Portal`, `🔄 Quick Revise`, `🗄️ Archive / Restore`, `🗑️ Delete`.
  - **KPI Metric Summary Cards**: Grand Total, Subtotal, GST Taxes, Applied Discounts, and Total Line Items count.
  - **Two-Column Detail Layout**:
    - Left Column: Deliverables table (item names, descriptions, quantities, unit rates, tax rates, net amounts), financial summary box, notes, terms & conditions.
    - Right Column: Recipient account / contact profile, linked deal card, revision history timeline, and full lifecycle audit trail.
  - **Quotation Edit Mode**: Pre-populates recipient type (`lead` vs `client`), customer IDs, deal associations, line items, and terms.
  - **App Router Integration ([`ui/admin/app.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/app.js))**: Added route builder and parser for `#quotations/:id/edit`.

### 10.15 Invoices Dedicated Details Workspace, Interactive Payment Recording & Bad-Debt Write-Off (Completed August 2026)

- **Business Objective**:
  1. Replace legacy inline invoice detail panels with a dedicated full-page workspace (`#invoices-detail-view`).
  2. Provide comprehensive financial KPI metrics, line-item breakdowns, banking instructions, and real-time payment history logs.
  3. Add interactive modals for recording client payments and bad-debt write-offs.
  4. Implement full Invoice Editing mode (`#invoices/:id/edit`) with backend status guards.
- **Backend Service Guards ([`api/services/invoice.service.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/services/invoice.service.js))**:
  - `update()`: Supports line-item modifications, tax calculations, discounts (fixed amount & percentage), banking fields, and addresses.
  - Enforced status integrity: Direct line-item edits are blocked on `Paid`, `Cancelled`, or `Written Off` invoices to protect ledger balances.
- **Admin UI Details Workspace ([`ui/admin/pages/invoices/invoices.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/invoices/invoices.js))**:
  - **Top Panel**: Back navigation, invoice number, status badge, recurring cycle indicator, and action buttons bar (`✏️ Edit Invoice`, `🖨️ Print / PDF`, `💳 Record Payment`, `✉️ Send to Client`, `🔗 Client Portal`, `💳 Credit Note`, `💸 Write Off`, `🗄️ Archive / Restore`, `🗑️ Cancel`, `🗑️ Delete`).
  - **KPI Financial Cards**: Invoice Grand Total, Total Amount Paid, Credits Applied, and Remaining Balance Due (with overdue warning alerts).
  - **Record Payment Modal (`openRecordPaymentModal`)**: Quick modal with payment method selector (Bank Transfer, UPI, Cards, Cash, Cheque, Stripe, Razorpay, PayPal), payment date, transaction reference number, notes, and balance due limit validation.
  - **Client Review Portal Modal (`openInvoicePortalModal`)**: Shareable direct client portal payment link with 1-click clipboard copy.

### 10.16 Structured Invoices Listing Layout, Summary Footers & Global Sort Engine (Completed August 2026)

- **Business Objective**:
  1. Organize invoice listing into clean, intuitive, business-oriented columns and rows without redundant action buttons.
  2. Provide page summary calculation footers (`<tfoot>`) for financial clarity.
  3. Ensure seamless column sorting across the CRM backend and UI.
- **Pagination & Sort Utility ([`api/utils/pagination.util.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/utils/pagination.util.js))**:
  - Enhanced `parsePagination` to safely parse and apply `query.sort` and `query.order` across all MongoDB model queries.
- **Invoices Listing Grid Layout ([`ui/admin/pages/invoices/invoices.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/invoices/invoices.js))**:
  - **Columns Order & Proportions**:
    1. `Invoice #` (14%, monospace badge, `🔄` recurring indicator, `Archived` tag)
    2. `Client / Account` (21%, client name + email/phone subtext)
    3. `Issue Date` (11%, formatted date)
    4. `Due Date` (11%, formatted date + `Overdue` badge when unpaid past due)
    5. `Total Amount` (11%, right-aligned `num-cell`, bold formatted amount)
    6. `Paid` (10%, right-aligned `num-cell`, green amount or `—`)
    7. `Credits` (9%, right-aligned `num-cell`, blue amount or `—`)
    8. `Balance Due` (11%, right-aligned `num-cell`, bold red if `> 0`, `✓ Paid` in green)
    9. `Status` (10%, center-aligned status badge)
  - **Interactive Rows**: Entire row has `cursor: pointer` and hover highlights, navigating directly to the Invoice Details page on click.
  - **Page Summary Footer (`<tfoot>`)**: Calculates and displays the total invoiced amount, total paid, total credits, and total balance due for all records on the active page.
- **Automated Test Suite Verification**:
### 10.17 Client Role Zero-Record Isolation Architecture & Email Auto-Matching Scoping (Completed September 2026)

- **Business Objective & Rule Definition**:
  1. **Strict Client-Exclusivity Rule**: When a user possesses the `client` role (`isClientUser(req) === true`), their login email is resolved against registered Client / Company records in the database (primary email, official email, primary contact email, billing email, company email, and contact person emails).
  2. **Unlinked Client Complete Data Isolation**: If a `client` user's email **does NOT match any client record** in the CRM (`clientId` is `null` / unlinked), they **MUST NOT see any records from ANY section or module**:
     - **All list endpoints across every module** (Projects, Tasks, Milestones, Clients, Leads, Quotations, Invoices, Payments, Sales Orders, Tickets, Expenses, Time Logs, Opportunities, Samples, Customer Success, Marketing, Analytics/AI, Reports, Dashboard, Context) return zero records (`items: []`, `pagination: { total: 0, page: 1, limit, totalPages: 0 }`, `unlinkedClient: true`, `message: 'Client email ID not found in CRM records'`).
     - **All detail and resource endpoints** (`getById`, `findOrThrow`, overview, activity, export) throw `404` ("Record not found").
     - **Dashboard and Analytics/AI endpoints** return `0` for all metrics, zeroed revenue/forecasts, and empty widget feeds (`unlinkedClient: true`).
     - **Report Generation endpoints** (Sales, Projects, Lead Conversion, Invoice Ageing, Time, Income/Expense, Recurring Invoices, Credit Notes, Payment Reconciliation) return zero totals and empty tables (`unlinkedClient: true`).
  3. **Role Exclusivity**: This strict zero-record isolation rule applies **ONLY to the `client` role**. Internal staff roles (`admin`, `super-admin`, `crm-manager`, `sales-manager`, `sales-rep`, `project-manager`, `employee`, `freelancer`, `accountant`, etc.) are **NOT** affected by this rule and continue using their internal staff/tenant permission scoping.
  4. **Linked Client Scoping**: If a `client` user's email **DOES match a client record**, they are strictly scoped to access only the records belonging to their linked `clientId` (and their client project IDs for tasks and milestones).

- **Implementation Details Across Core Architecture & Services**:
  - **Tenant Utilities ([`api/utils/tenant.util.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/utils/tenant.util.js))**:
    - `isUnlinkedClientUser(req)` & `async isUnlinkedClientUserAsync(req)`: Inspects user role and checks whether a matching client entity exists.
    - `applyClientScope(req, filter, field)` & `async applyClientScopeAsync(req, filter, field)`: Enforces `[field]: '__UNLINKED_CLIENT_NO_MATCH__'` when unlinked, ensuring database queries safely evaluate to 0 results.
  - **Access Assertion Utilities ([`api/utils/sales-access.util.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/utils/sales-access.util.js), [`api/utils/project-access.util.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/utils/project-access.util.js), [`api/utils/expense-access.util.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/api/utils/expense-access.util.js))**:
    - Guarded project, task, milestone, lead, client, expense, and timelog read/write access assertions with asynchronous client detection and strict isolation.
  - **Business Services**:
    - `client.service.js`: Zero clients in list, 404 in detail for unlinked clients.
    - `lead.service.js`: Zero leads in list and 404 in detail for client role.
    - `project.service.js`: Zero projects in list and pseudo-project isolation for unlinked clients.
    - `task.service.js`: Zero tasks in list and milestone scoping for unlinked clients.
    - `milestone.service.js`: Scoped milestone queries to client projects; zero for unlinked clients.
    - `quotation.service.js`: Zero quotations in list and 404 on access for unlinked clients.
    - `invoice.service.js`: Zero invoices in list and 404 on access for unlinked clients.
    - `payment.service.js`: Zero payments in list and 404 on access for unlinked clients.
    - `sales-order.service.js`: Zero orders in list and 404 on access for unlinked clients.
    - `ticket.service.js`: Zero tickets in list and 404 on access for unlinked clients.
    - `expense.service.js`: Zero expenses in list for unlinked clients.
    - `time-log.service.js`: Zero time logs in list for unlinked clients.
    - `customer-success.service.js`: Zero health metrics/records for unlinked clients.
    - `opportunity.service.js`: Zero opportunities in list/summary for unlinked clients.
    - `sample.service.js`: Zero sample requests in list for unlinked clients.
    - `marketing.service.js`: All marketing campaign, audience, re-engagement, and analytics methods blocked for client role.
    - `analytics-ai.service.js`: All executive sales analytics, customer behavior models, and AI next-best-action methods blocked for client role.
    - `dashboard.service.js`: `getSummary()` returns zeroed sales, finance, and expense metrics, empty widget feeds, and `unlinkedClient: true` when unlinked.
    - `report.service.js`: Added `resolveReportClientId` and updated all 9 reports (Sales, Projects, Lead Conversion, Invoice Ageing, Time, Income/Expense, Recurring Invoices, Credit Notes, Payment Reconciliation) to return 0 totals, empty rows, and `unlinkedClient: true` when unlinked.
    - `context.service.js`: `getMe()` returns `isClientUser: true`, `clientId: null`, and `unlinkedClient: true` for unlinked clients, and `getAssignableUsers()` returns `[]`.
- **Automated Test Suite Verification ([`test/client-unlinked-zero-records.test.js`](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/test/client-unlinked-zero-records.test.js))**:
  - Comprehensive automated test suite verifying unlinked client zero-record isolation across every service, confirming staff role exclusivity and linked client data access.
  - Full repository test suite: **227 tests passing with 0 failures** (`node --test test/*.test.js`).

---

*OpenExt CRM Suite — Production Grade Enterprise CRM Plugin — Comprehensive Implementation Report Complete (updated 4 September 2026).*

---

## 11. Comprehensive Implementation Log — 2 September 2026

### 11.1 Support Ticket Assignment, Role Gates & Project Manager Scoping

- **Business rules:**
  - Unassigned tickets remain unassigned until Super Admin, CRM Manager, or Project Manager explicitly assigns an agent.
  - Project Managers access Support Tickets only for tickets linked to projects they manage.
  - Project Managers may assign/reassign only to members of the linked project's team (members, creator, project leads).
  - Client portal ticket creation never sets the client account as the assigned agent.
- **Backend ([`api/utils/ticket-access.util.js`](api/utils/ticket-access.util.js), [`api/services/ticket.service.js`](api/services/ticket.service.js)):**
  - `getProjectTeamUserIds`, `assertProjectManagerTicketAssignee`, PM list/read/write scope, `assertTicketProjectInput`.
  - Assignment validation on create, status update, and reassign; client assignee sanitization for legacy data.
- **Roles ([`api/roles.js`](api/roles.js), [`manifest.json`](manifest.json)):** `crm.tickets.read`, `crm.tickets.write`, `crm.tickets.resolve` for project-manager.
- **Admin UI ([`ui/admin/pages/tickets/tickets.js`](ui/admin/pages/tickets/tickets.js), [`ui/admin/app.js`](ui/admin/app.js)):**
  - Assign/Reassign modals and create form agent dropdown scoped to project team for PMs.
  - List **Assign** action for unassigned tickets (allowed roles only).

### 11.2 Task Edit — Full-Page Workspace

- **New page:** [`ui/admin/pages/tasks/task-edit.js`](ui/admin/pages/tasks/task-edit.js) — dedicated edit form at `#tasks/{id}/edit`.
- **Routing:** [`ui/admin/pages/tasks/tasks.js`](ui/admin/pages/tasks/tasks.js), [`ui/admin/app.js`](ui/admin/app.js) — `openTaskEdit`, `pendingTaskEditId`.
- **Entry points:** Task detail and project task list Edit buttons open full page; create task remains modal-based.

### 11.3 Project Listing — Tasks Progress Column

- **Problem:** List/kanban progress bars always showed **0%** because `enrichProjects()` did not compute progress.
- **Backend ([`api/services/project.service.js`](api/services/project.service.js)):**
  - `computeProjectProgressPercent`, `loadProjectProgressStats` — batch task/milestone/time aggregates per project.
  - Each list item returns `progress`, `progressPercent`, `completedTaskCount`, `milestoneCount`.
- **Frontend ([`ui/admin/pages/projects/projects.js`](ui/admin/pages/projects/projects.js), [`ui/admin/style.css`](ui/admin/style.css)):**
  - Unified `renderProgressCell` / `resolveProjectProgressPct`; column label **Tasks Progress**.

### 11.4 Quotation Print HTML Export Fix

- **Problem:** `GET /quotations/:id/print` failed with `QuotationService.exportPrintHtml is not a function`.
- **Fix ([`api/services/quotation.service.js`](api/services/quotation.service.js)):**
  - Added `buildQuotationPrintHtml`, `exportPrintHtml` using `FinanceDocumentUtil.buildQuotationPayload` + `PrintHtmlService.renderFinancePrintHtml` (aligned with invoice print flow).

### 11.5 Send to Client — Loading State (Invoices & Quotations)

- **UX:** Detail **Send to Client** buttons disable and show **Sending…** until the send API returns, then toast + refresh.
- **Files:** [`ui/admin/pages/invoices/invoices.js`](ui/admin/pages/invoices/invoices.js), [`ui/admin/pages/quotations/quotations.js`](ui/admin/pages/quotations/quotations.js).

### 11.6 Documented Follow-Up — Public Invoice Razorpay Payment

- **Observed behavior:** Client opens email payment portal (invoice loads), but **Pay Now with Razorpay** may return **Invoice not found** when the same browser session is logged into CRM as a different client user — public token lookup succeeds, but tenant/client-scoped `getById` on order creation can fail.
- **Mitigation for testing:** Use incognito/private window or log out before paying.
- **Production:** Configure `NEXT_PUBLIC_SITE_URL` / `SITE_URL` for absolute payment links in emails.
- **Backlog:** Bypass client scope on public token Razorpay order routes (tracked in [`tasks-remaining.md`](tasks-remaining.md)).

### 11.7 Task Dependency Client-Reply Red Alert & Client Feedback Options

- **Task Dependency Red Alert for Internal Roles (Super Admin, CRM Manager, Project Manager, Employee):**
  - **Rule:** If any task depends on another task, and the prerequisite task is completed but its client status is awaiting reply (not `Satisfied`), a high-visibility Red Alert banner is displayed.
  - **Project Overview Tab ([`ui/admin/pages/projects/projects.js`](ui/admin/pages/projects/projects.js)):** Displays `"this task is depends on this task so can you talk and resend email to client"` with task dependency details, client notification timestamp, and direct `✉️ Resend Email to Client` action button.
  - **Dashboard ([`ui/admin/pages/dashboard/dashboard.js`](ui/admin/pages/dashboard/dashboard.js)):** Displays a top-level Red Alert banner for blocked tasks across accessible projects with one-click `✉️ Resend Email to Client` and `📂 View Project` shortcuts.
  - **Backend Support ([`api/services/project.service.js`](api/services/project.service.js), [`api/services/dashboard.service.js`](api/services/dashboard.service.js)):** Computes `blockedAwaitingClientTasks` array containing all dependent tasks blocked by unapproved prerequisite tasks.
- **Client Role Feedback Permissions & Select Options:**
  - **Rule:** Client users can change task client satisfaction status, but are strictly restricted to **two options**: **`Satisfied`** and **`Not Satisfied`**.
  - **Backend Enforcement ([`api/services/task.service.js`](api/services/task.service.js), [`api/utils/project-access.util.js`](api/utils/project-access.util.js)):** Allows client users to update client satisfaction fields on tasks in their projects, while rejecting core task modifications (title, assignee, status, dates) and enforcing that `clientFeedbackStatus` is `'Satisfied'` or `'Dissatisfied'`.
  - **UI Controls ([`ui/admin/pages/projects/projects.js`](ui/admin/pages/projects/projects.js), [`ui/admin/pages/tasks/tasks.js`](ui/admin/pages/tasks/tasks.js), [`ui/admin/pages/tasks/task-edit.js`](ui/admin/pages/tasks/task-edit.js)):** Dynamically checks user role and renders only the two options (`Satisfied` and `Not Satisfied`) for client users.

### 11.8 Documentation Sync — Roles & Permissions (4 September 2026)

- Updated [`ROLES_AND_PERMISSIONS.md`](ROLES_AND_PERMISSIONS.md) to match runtime behavior in `api/roles.js`, `ticket.service.js`, and `ticket-access.util.js`:
  - Ticket **Assign / Reassign** limited to Super Admin, CRM Manager, Project Manager.
  - Project Manager ticket list/create/assign scoped to managed projects and project team members.
  - Support Agent / User Agent: resolve/delete allowed; **agent assignment not allowed**.
  - Employee tickets: project-linked CR (matrix corrected).
  - Client: no agent self-assignment; invoice pay-link note.
- Cross-links added to implementation report and `tasks-remaining.md`.

### 11.9 Dedicated Creation Workspaces, Designation Management & Navigation Streamlining (4 September 2026)

- **Dedicated Invoice Template Studio Workspace ([`ui/admin/pages/invoices/invoice-template-create.js`](ui/admin/pages/invoices/invoice-template-create.js)):**
  - Full-page invoice template creation suite registered at `#invoice-templates-create`.
  - Dynamic template variables (`{{client_name}}`, `{{invoice_number}}`, `{{issue_date}}`, `{{due_date}}`, `{{subtotal}}`, `{{total_amount}}`), auto-calculating line items, payment terms, and interactive live preview card.
- **Dedicated Sample Request Creation Workspace ([`ui/admin/pages/samples/sample-create.js`](ui/admin/pages/samples/sample-create.js)):**
  - Full-page sample creation workspace registered at `#samples-create-view`.
  - Dual recipient selector (Lead vs Client Account) with auto-fetching address and contact details.
  - 1-click Sample Product presets (Software Trial, Hardware Evaluation, Prototype Component, Marketing Collateral, Full Demo Kit).
  - Priority & SLA Urgency selector with real-time turnaround calculations, quantity counters, and sticky live summary forecast.
- **Dedicated Opportunity Deal Creation Workspace ([`ui/admin/pages/opportunities/opportunity-create.js`](ui/admin/pages/opportunities/opportunity-create.js)):**
  - Full-page deal creation suite registered at `#opportunities-create-view`.
  - 1-click Industry Deal Templates (Enterprise SaaS, Professional Services, Maintenance Contract, Hardware Deployment, Custom Development).
  - 9 visual pipeline stage cards, interactive win probability slider with real-time weighted value calculation.
  - Multi-item pricing calculator with dynamic State Shipping & GST tax calculation engine.
  - Direct Quotation generation toggle creating instant matching proposals upon deal creation.
  - Cleaned up Opportunity list Client / Account column to display concise client or company name.
- **Streamlined Navigation & Centralized User Designations:**
  - Removed `Tenant Security` (`#security`) from CRM primary sidebar (`NAV_ITEMS`) to eliminate clutter.
  - Shifted designation and role assignment for OpenNext workspace users into a dedicated **`🛡️ Users & Designations`** tab in System Settings ([`ui/admin/pages/settings/settings.js`](ui/admin/pages/settings/settings.js)).
  - Provides user search, quick preset designation chips, instant save via `updateTenantMember`, and a full permissions inspector modal.
  - Streamlined `AI Intelligence` (`#analytics-ai`) from primary sidebar into an accessible standalone workspace route.

### 11.10 Leads Listing Responsive Overhaul & DataTables Removal (7 September 2026)

- **Problem:** DataTables library caused formatting anomalies and unwanted horizontal scrolling (`x-scrolling`) on lead listings with cramped tables.
- **Solution ([`ui/admin/pages/leads/leads.js`](ui/admin/pages/leads/leads.js)):**
  - Removed external DataTables library integration from the leads listing view.
  - Built a native, responsive leads table that fits cleanly within viewport boundaries without horizontal scroll clipping.
  - Removed redundant Action and Status columns from the listing table for a streamlined, clutter-free prospect overview.
  - Preserved saved filter presets, search, stage badges, lead qualification, and Kanban pipeline views.

### 11.11 Universal OpenNext CMS Theme Standard & Project Workspace Client Privacy (7 September 2026)

- **Universal OpenNext CMS Dashboard Theme Standard:**
  - **Surfaces & Shadows:** Enforced `box-shadow: none !important;` across all cards, modals, buttons, and inputs.
  - **Borders:** Crisp 1px flat borders (`border: 1px solid #e2e8f0;`) across all modules.
  - **Active States:** Solid black active pills and buttons (`background: #000000 !important; color: #ffffff !important; border-color: #000000 !important;`).
  - **Filtering System:** Consolidated toolbars (`.leads-toolbar`, `.pj-filter-bar`, etc.) into responsive horizontal flex rows with top left-aligned labels, 36px uniform control height, expanding search fields, and side-by-side Reset & Refresh buttons docked on the right.
- **Projects Module Fixes & Overhaul ([`ui/admin/pages/projects/projects.js`](ui/admin/pages/projects/projects.js)):**
  - **Add Task Button Fix:** Fixed "+ Add Task" button on both Tasks tab (`#btn-open-task-modal`) and Gantt chart tab (`#btn-gantt-add-task`) by referencing assignable users (`projectAssignableUsers`) defensively instead of an out-of-scope variable.
  - **Projects Listing:** Aligned with OpenNext CMS dashboard theme (header typography, horizontal icon-left KPI scorecards, solid black active status pills, horizontal flex filter toolbar, responsive table without clipping).
  - **Client Role Project Overview Financial Privacy:**
    - On the project detail page Overview tab (`#tab-overview`), client portal accounts see ONLY **Project Budget** (`Allocated total budget`) and **Paid Invoices** (`Revenue & paid invoices`).
    - Internal company financial metrics—**Expenses** and **Net Profit**—are completely omitted and hidden from the DOM for the `client` role.
    - Non-client roles (internal team and administrators) continue to see all 4 financial KPI cards.
    - The **Expenses tab button** (`#tab-expenses`) and content pane are completely hidden for client accounts.


