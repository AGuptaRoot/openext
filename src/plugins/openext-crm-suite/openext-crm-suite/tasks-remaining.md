# OpenExt CRM Suite — Module-Wise Remaining Tasks

**Last updated:** 4 September 2026  
**Current plugin version:** 1.28.0  
**Goal:** Build an original OpenExt CRM with business-feature parity comparable to Worksuite CRM.

## Scope decisions

- [x] Email and SMTP sending are complete and excluded from this backlog.
- [x] HR is currently out of scope. Employee management, attendance, leave, shifts, holidays, payroll, recruitment, and onboarding are excluded.
- [x] Automated and manual testing tasks are excluded from this file.
- [x] Worksuite is used only as a feature reference. Do not copy its source code, branding, text, or protected visual assets.

## Status legend

- `- [x]` **Complete:** Fully implemented, tested, and active.
- `- [🔄]` **Mid-Level / In-Progress:** Working backend or frontend foundation exists with incremental parity enhancements in progress.
- `- [ ]` **Not started:** Queued for upcoming phases.
- **Optional:** Not required for the first core feature-parity release.

---

## 1. System foundation and production safety — Partial

- [🔄] Review database indexes and tenant-aware unique constraints.
- [x] Confirm every sensitive create, update, delete, conversion, approval, and payment action creates an audit entry.
- [x] Define safe rollback behavior for lead conversion, quotation conversion, invoice cancellation, payment deletion, and order cancellation.
- [ ] Add migration rollback instructions.
- [🔄] Document database backup and restore procedures.
- [🔄] Add production configuration checks for environment values, database connection, file storage, logging, and rate limiting.
- [x] Standardize API errors and prevent internal error details from being exposed to users.
- [🔄] Add safe concurrency handling for document numbers, finance balances, and stock updates.

## 2. Dashboard — Complete with parity improvements remaining

Existing dashboard metrics and customizable widgets remain in place.

- [x] Add configurable dashboard widgets by role.
- [x] Add overdue tasks, upcoming milestones, unpaid invoices, open tickets, expiring contracts, and recent activity widgets.
- [x] Add quick date filters for today, week, month, quarter, year, and custom range.
- [x] Add drill-down links from every metric to its filtered module list.
- [x] Update dashboard metrics when Contracts, Products, Credit Notes, Calendar, and Client Portal are completed.
- [x] Ensure each role sees only permitted and tenant-scoped dashboard data.

## 3. Leads — Complete with parity improvements remaining

Lead CRUD, qualification, validation, duplicate detection, assignment, stages, 360-degree details, follow-ups, activities, attachments, and conversion already exist.

- [x] Add configurable lead sources and lead-status management.
- [x] Add lead tags and custom fields.
- [x] Add bulk lead import with row-level validation and duplicate warnings.
- [x] Add lead export with permission and tenant scope.
- [x] Add bulk assignment and bulk stage update.
- [x] Add saved lead filters.
- [x] Add lead ageing indicators and overdue follow-up indicators.
- [x] Connect qualified leads directly to the Contracts and Product Catalogue workflows where appropriate.
- [x] **Leads Listing Responsive Overhaul (7 Sep 2026):** Removed DataTables library dependency; built clean responsive layout without horizontal scrolling; streamlined columns by removing extraneous Action and Status columns for an uncluttered view.


## 4. Clients and contacts — Complete with parity improvements remaining

Client CRUD, company information, contacts, validation, duplicate detection, lead conversion, finance, and project relationships already exist.

- [x] Add client tags and custom fields.
- [x] Add configurable client categories or groups.
- [x] Add client import and export.
- [x] Add multiple billing and shipping addresses.
- [x] Add a complete client document area.
- [x] Add client notes and an account-level activity timeline.
- [x] Add dedicated **`☑️ Tasks`** tab to client profile with scoped client tasks filtering, status metrics, and pre-populated task creation modal.
- [x] Add dedicated **`⏱️ Time Logs`** tab to client profile with scoped timesheets, billable KPI cards, filter pills, and pre-populated log time modal.
- [x] Connect Client Quick Actions and Dashboard metric cards ("View tasks", "Log time", "Hours this month", "Billable hours") to client-scoped tabs.
- [*] Add client portal invitation, activation, suspension, and access status.
- [x] Connect clients to Contracts and Product Catalogue history.

## 5. Data Quality and Duplicate Centre — Complete with parity improvements remaining

Duplicate review, exact-match signals, similar-company detection, validation, and quality scoring already exist.

- [x] Keep duplicate records read-only until an authorized user chooses an action.
- [x] Add clear duplicate-resolution statuses such as New, Reviewed, Ignored, and Resolved.
- [x] Add reviewer name, review date, resolution note, and audit entry.
- [x] Add configurable data-quality rules and score weights.
- [x] Add data-quality filters by record type, score, missing field, and duplicate signal.
- [x] Add data-quality summary export.
- [x] Keep Lead Merge and Customer Merge deferred until safe database transaction support is approved.
- [x] When merge is enabled later, require preview, field selection, permission checks, tenant checks, audit history, and a recoverable merge record.

## 6. Opportunities — Complete

Opportunity pipeline, Kanban stages, revenue probability, forecasting, stage locking, and dedicated create workspace already exist.

- [x] Dedicated full-page Opportunity Deal Creation Workspace ([`ui/admin/pages/opportunities/opportunity-create.js`](ui/admin/pages/opportunities/opportunity-create.js)) with 1-click industry templates, 9 visual pipeline stage cards, win probability slider with real-time weighted value calculation, dynamic State shipping & GST tax engine, and direct quotation proposal generation.
- [x] Streamlined Opportunity listing Client / Account column to display concise client or company name.
- [x] Add configurable opportunity stages and probabilities.
- [x] Add opportunity owner, collaborators, tags, products, competitors, and expected close date filters.
- [x] Add opportunity activities, notes, files, and follow-up reminders.
- [x] Connect opportunity products to the Product Catalogue.
- [x] Connect won opportunities to quotation, contract, project, and sales-order creation.
- [x] Add lost-reason configuration and loss analysis.
- [x] Add pipeline value and weighted forecast drill-down reports.

## 7. Projects — Complete with parity improvements remaining

Project CRUD, clients, members, milestones, tasks, budgets, progress, activity, and access scoping already exist.

- [x] Complete project-access behavior for all OpenNext roles without weakening tenant isolation.
- [x] Add project templates containing reusable milestones and tasks.
- [x] Add project files and documents with secure tenant-scoped storage.
- [x] Add project categories, tags, and custom fields.
- [x] Add project status and priority configuration.
- [x] Add project-level discussions if the existing activity view is insufficient.
- [x] Add project archive and restore instead of permanent deletion where appropriate.
- [x] Add project print and export.
- [x] Add the Project Gantt functionality listed below.
- [x] **Project list Tasks Progress column (2 Sep 2026):** Batch-compute progress in `enrichProjects()` from task/milestone completion and time logs; unified progress bar UI; column renamed from "Progress" to **Tasks Progress**.
- [x] **Projects Listing Theme & Workspace Fixes (7 Sep 2026):** Aligned projects listing with OpenNext CMS dashboard theme (horizontal icon-left KPI cards, solid black active status pills, horizontal flex filter toolbar, responsive table without clipping). Fixed "+ Add Task" button on both Tasks and Gantt tabs by referencing assignable users defensively.
- [x] **Client Role Project Workspace Financial Privacy (7 Sep 2026):** On particular project page inside Overview tab, client role displays ONLY Project Budget (Allocated total budget) and Paid Invoices (Revenue & paid invoices). Internal Expenses and Net Profit cards are completely hidden. The Expenses tab button and content pane are also shielded from client accounts.

### Project Gantt

- [x] Display milestones and tasks using start date, due date, progress, and status.
- [x] Add task dependencies and prevent circular dependencies.
- [x] Show delayed, overdue, completed, and dependency-blocked work.
- [x] Allow authorized users to change dates from the timeline.
- [x] Add project, milestone, member, status, and date filters.
- [x] Add timeline zoom levels.
- [x] Provide an accessible table alternative.
- [x] Enforce permissions and tenant scope for every timeline update.

## 8. Tasks — Complete with parity improvements remaining

Task CRUD, assignment, comments, priority, dates, client feedback, status workflow, drawer, and project access already exist.

- [x] Add List and Kanban view switching.
- [x] Group Kanban cards by configurable task status.
- [x] Add permission-safe drag-and-drop status changes.
- [x] Show project, milestone, assignees, priority, due date, labels, logged time, and overdue status on cards.
- [x] Add filters for project, milestone, assignee, priority, status, label, and date.
- [x] Add keyboard-accessible alternatives to drag-and-drop.
- [x] Add task labels, categories, checklists, and file attachments.
- [x] Add task dependencies and blocked status.
- [x] Add recurring tasks.
- [x] Add task templates.
- [x] Add task watchers/followers.
- [x] Add task archive and restore.
- [x] Audit all important status, assignment, and due-date changes.
- [x] **Full-page task edit (2 Sep 2026):** Edit opens at `#tasks/{id}/edit` (dedicated page like project edit); create task remains modal-based.

## 9. Time Logs and Time Tracker — Complete

Manual billable/non-billable time logs, rates, project/task relationships, and totals already exist.

- [x] **Time Logs Action Buttons & Dedicated Modal Flow**:
  - Replaced inline panels in [`ui/admin/pages/time-logs/time-logs.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/time-logs/time-logs.js) with dedicated top-right header action buttons: `⏱️ Check-in / Timer (Timer Entry)` (with live ticker) and `✍️ + Manual Time Entry`.
  - Check-in / Check-out Timer modal (`openTimerModal`) and Manual Time Entry modal (`openManualEntryModal`) with hours/minutes numeric sync + decimal duration pill + quick preset chips (`+15m`, `+30m`, `+45m`, `1h`, `1.5h`, `2h`, `4h`, `8h`).
  - Weekly Timesheet grid `+ Log` cells now open the manual entry modal pre-filled.

- [x] **Reusable Templates Overhaul & Modernization**:
  - **Quotation & Proposal Templates**:
    - Built comprehensive **Quotation Templates Manager** modal in [`ui/admin/pages/quotations/quotations.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/quotations/quotations.js) with card grid, search filter, category filter pills, deliverable line items summary, subtotal calculation preview, `+ New Template`, `⚡ Use in New Quote`, `✏️ Edit`, and `🗑️ Delete`.
    - Built interactive **Quotation Template Builder / Editor** modal (`openQuotationTemplateFormModal`) with dynamic line items table, currency, tax calculation mode (`after_discount` / `before_discount`), default discount %, recipient notes, and contract terms.
    - Enhanced **Quotation Creation Workspace** in [`ui/admin/pages/quotations/quotation-create.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/quotations/quotation-create.js) with `📁 Load Template` picker modal, `💾 Save as Template` prompt, and auto-prefill from navigation options.
  - **Task Templates**:
    - Upgraded **Task Templates Manager** in [`ui/admin/pages/tasks/tasks.js`](file:///c:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/ui/admin/pages/tasks/tasks.js) with modern card grid, category filter pills, search input, checklist subtasks previews, and quick actions (`⚡ Use Template`, `✏️ Edit`, `🗑️ Delete`).
    - Upgraded **Task Template Builder** modal with numbered subtask rows (`1.`, `2.`), description fields, and responsive UX.
    - In **Task Creation Modal** (`openTaskModal`), added interactive checklist preview container that shows all template subtasks with item removal and count before creating the task.
- [x] Add user, project, task, billable, status, and date filters.
- [x] Add editable hourly-rate history so old entries retain their original calculated value.
- [x] Add time-log locking after billing or period closing (`isLocked: true`, `invoiceId` guard).
- [x] Connect approved billable time to quotation or invoice line items.

## 10. Quotations and estimates — Complete with parity improvements remaining

Quotation CRUD, line items, discount approval, taxes, acceptance, rejection, printing, email delivery, and invoice/order conversion already exist.

- [x] Dedicated full-page Quotation Creation Workspace with Lead Contacts, Deal/Opportunity selector, Valid Till, Multi-Currency, Calculate Tax mode (after/before discount), and Recipient notes.
- [x] Connect quotation line items to the Product Catalogue with inline "+ New Product" quick create modal while preserving historical price snapshots.
- [x] Add configurable terms, notes, payment terms, recipient notes, and expiry reminders.
- [x] Add reusable quotation templates (Model `EstimateTemplate`, CRUD Service, controller, routes, Template Picker modal & manager UI).
- [x] Add quotation versioning and revision history (Branching revisions `QT-001-R1`, `revisionOf`, `version`, `isLatestVersion`, revision notes & revision history modal).
- [x] Add client portal review, acceptance, and rejection (`/portal/quotation?token=...` public branded review workspace).
- [x] Add secure acceptance metadata and accepted-document snapshot (`acceptedBy`, `acceptedEmail`, `acceptedIp`, `signature`, `acceptedAt`, immutable `acceptedSnapshot`).
- [x] Add proper PDF download in addition to HTML print.
- [x] Add quotation archive and restore (`isArchived`, `archivedAt`, filter toggles, 1-click archive/restore actions).
- [x] Connect accepted quotations to Contracts when required.
- [x] **Quotation print fix (2 Sep 2026):** Implemented `exportPrintHtml()` in `quotation.service.js` using `buildQuotationPayload` + `renderFinancePrintHtml` (fixes `/quotations/:id/print` error).
- [x] **Send to Client loading UX (2 Sep 2026):** Detail **Send to Client** button shows disabled **Sending…** state until email API completes (quotations + invoices).

## 11. Sales Orders and logistics — Complete

Quotation conversion, order lifecycle, shipping rates, courier, AWB, dispatch, POD, and delivery confirmation are fully complete and verified with automated tests.

- [x] Connect order line items to the Product Catalogue.
- [x] Add billing and shipping address snapshots.
- [x] Add packing, ready-to-ship, partially shipped, returned, and cancelled states where required.
- [x] Add multiple shipments for one order (multi-package partial dispatching, line-item quantity tracking, individual shipment status).
- [x] Add shipment history and delivery timeline (package cards, AWB tracking, dispatched contents, proof of delivery).
- [x] Add return and replacement workflow (RMA tickets, defective item selection, refund authorization, automatic replacement order generation).
- [x] Add order document/PDF output (packing slip and order preview).
- [x] Add stock reservation and deduction tracking (`stockReserved`, `inventoryDeducted`, stock audit trail).
- [x] Add safe order cancellation rules for invoiced, paid, shipped, or delivered orders (safety validation blocking cancellation on dispatched packages).

## 12. Invoices — Complete

Invoice CRUD, quotation conversion, totals, tax, balances, cancellation, printing, email delivery, payment synchronization, dedicated create flow, and template builder are fully complete.

- [x] Dedicated full-page Invoice Creation Workspace (`#invoices-create-view`) with sequence number auto-fetch (`/invoices/next-number`), multi-currency conversion, dynamic product lookup, discount types (% vs amount), tax calculation modes (before/after discount), dropzone attachments, and recurring email reminder scheduling.
- [x] Dedicated full-page **Invoice Template Studio Workspace** ([`ui/admin/pages/invoices/invoice-template-create.js`](ui/admin/pages/invoices/invoice-template-create.js)) registered at `#invoice-templates-create` with live preview card, variable chips (`{{client_name}}`, `{{invoice_number}}`, `{{due_date}}`, `{{total_amount}}`), auto-calculating line items, and terms presets.
- [x] Add dynamic **Bank Account selector** in Invoice and Recurring Invoice creation/edit forms loaded from `Settings → Bank Accounts Manager` with auto-filling payment instructions into payment details / terms.
- [x] Connect invoice line items to Product Catalogue items while preserving snapshots.
- [x] Add reusable invoice templates (`InvoiceTemplate` model, controller, routes, Template Picker modal & manager UI).
- [x] Add proper PDF download in addition to HTML print.
- [x] Add configurable payment terms and overdue reminders.
- [x] Add draft, sent, viewed, partially paid, paid, overdue, cancelled, and written-off states where required.
- [x] Add recurring invoice profiles and schedules (`RecurringInvoice` model, frequencies, auto-execution, upcoming forecast report, and run-now triggers).
- [x] Add credit-note conversion and balance adjustment (`CreditNote` model, validations, invoice balance adjustments, refunds, and standalone creation).
- [ ] Add client portal invoice viewing, downloading, and payment. (Skipped per user directive)
- [x] Add invoice archive and restore.
- [x] Add multi-currency with automatic exchange rate conversion.
- [x] **Send to Client loading UX (2 Sep 2026):** Detail **Send to Client** button shows disabled **Sending…** state until email API completes.

### Known follow-ups (2 Sep 2026)

- [ ] **Public invoice Razorpay Pay Now:** Portal may load by token but **Pay Now with Razorpay** can return **Invoice not found** when the browser is logged in as a different CRM client user (tenant/client scope mismatch on order creation). Fix: bypass client scope on public token payment routes or use incognito for client testing.
- [ ] Set **`NEXT_PUBLIC_SITE_URL` / `SITE_URL`** in production so invoice email payment links use absolute URLs (not relative `/plugins/...` paths).

### Recurring invoices

- [x] Add recurring profiles based on invoice templates.
- [x] Support daily, weekly, monthly, quarterly, yearly, and custom schedules.
- [x] Add start date, next run, end condition, timezone, and active/paused status.
- [x] Generate invoices idempotently so retries do not create duplicates.
- [x] Add failure logs and safe retry actions.
- [x] Add an upcoming recurring-invoice report.
- [x] Reuse the completed email service for optional generated-invoice delivery.

### Credit notes

- [x] Add credit-note model, migration, numbering, service, API, permissions, and UI.
- [x] Convert complete invoices or selected invoice lines into a credit note.
- [x] Prevent credit above the eligible invoice amount.
- [x] Recalculate invoice balances safely.
- [x] Add open, applied, refunded, void, and cancelled states.
- [x] Add credit-note PDF/print output.
- [x] Add audit history and finance-report integration.

## 13. Payments — Complete with parity improvements remaining

Manual payments, partial/full allocation, overpayment protection, invoice balance updates, and receipts already exist.

- [x] Add payment methods and configurable payment accounts.
- [ ] Add payment gateway integration.
- [ ] Add secure client checkout.
- [ ] Verify gateway webhook signatures and process every event idempotently.
- [ ] Support pending, successful, failed, refunded, partially refunded, and disputed transactions.
- [x] Add payment allocation across multiple invoices if required.
- [x] Add refund workflow and approval.
- [x] Add payment reconciliation and settlement reports.
- [ ] Add gateway transaction logs without exposing secrets.
- [ ] Prevent payment changes after a finance period is locked.

## 14. Expenses — Complete

Expense CRUD, categories, receipts, submission, approval, rejection, permissions, reporting, dedicated create workspace, recurring schedules, and billable invoice integration are fully complete.

- [x] Dedicated full-page Expense Creation Workspace (`#expenses-create-view`) with `Item Name *`, `Currency *`, `Exchange Rate *`, `Price *`, `Purchase Date *`, `Employee`, `Project`, `Expense Category`, `Purchased From`, `Bank Account (select)`, `Description / Notes`, and `Bill (upload file)`.
- [x] Centralized `🏦 Bank Accounts Manager` under Settings with dynamic row configuration and auto-population in Expense and Invoice dropdowns.
- [x] Add expense vendors and payment accounts.
- [x] Add recurring expenses (`RecurringExpense` model, schema validation, periodic schedule engine, runner, upcoming forecast report, and UI manager).
- [x] Add billable expenses linked to clients and projects.
- [x] Allow approved billable expenses to be added to invoices (`💼 Import Billable Expenses` modal inside Invoice Create Workspace).
- [x] Add expense tags and custom fields.
- [x] Add expense archive and restore (`isArchived`, archive/restore endpoints, active vs archived filter pills, detail actions).

## 15. Sample Requests — Complete

Sample request creation, dispatch, approval workflow, customer feedback, and dedicated creation workspace are fully complete.

- [x] Dedicated full-page Sample Request Creation Workspace ([`ui/admin/pages/samples/sample-create.js`](ui/admin/pages/samples/sample-create.js)) registered at `#samples-create-view`.
- [x] Dual recipient picker (Lead vs Client Account) with auto-fetching address and contact details.
- [x] 1-click sample product presets, priority & SLA urgency selector with live turnaround forecast, and sticky summary panel.
- [x] Sample approval workflow, dispatch tracking, and client feedback logging.

### Optional inventory extension

- [ ] Decide whether the product catalogue will support stock or remain non-stock.
- [ ] If approved, add warehouses, quantity, reorder level, stock movement, adjustment, reservation, and release.
- [ ] If approved, add suppliers, purchase orders, goods receipt, supplier invoices, and purchase reports.
- [ ] Ensure failed order or purchase operations cannot leave incorrect stock quantities.


## 17. Support Tickets — Complete

Ticket CRUD, priorities, assignment, statuses, SLA timers, resolution, conversation threads, internal staff notes, canned responses, watchers, reassignment history, escalation levels, archive/restore, and customer-success integration are fully complete.

- [x] Add ticket categories, channels, tags, and custom fields with full-page creation view, requester type toggle (Client vs Employee), circular avatar select preview, custom Assign Groups, Types, Priorities, and Channels with inline modals.
- [x] Add ticket conversation threads and secure attachments (`messages: [{ _id, senderId, senderName, senderRole, isInternal, message, attachments, createdAt }]`).
- [ ] Add client portal ticket creation, viewing, and replies (deferred to Section 18 Client Portal).
- [x] Add canned responses and internal staff notes (`/investigating`, `/logs`, `/resolved`, `/escalated` and custom tenant templates).
- [x] Add watchers and reassignment history (`watchers: [userId]`, `reassignmentHistory: [{ fromUser, toUser, reason, reallocatedAt, reallocatedBy }]`).
- [x] Add SLA policies configurable by priority or customer type with auto-due target calculation.
- [x] Add escalation rules (`escalationLevel: 'Level 2' | 'Level 3' | 'Supervisor'`, `escalationHistory`, automatic priority bump to Urgent).
- [x] Add open/closed, response-time, resolution-time, SLA-breach, category, and assignee reports.
- [x] Add ticket archive and restore (`isArchived`, `archiveReason`, archive filter toggle, detail action buttons).
- [x] Comprehensive interactive **Ticket Detail Slide-Over Drawer** with tabbed message stream, staff notes, canned response inserter, watchers manager, and audit timeline.
- [x] **Ticket assignment & Project Manager scoping (2 Sep 2026):**
  - Only Super Admin, CRM Manager, and Project Manager can assign/reassign agents; unassigned tickets stay unassigned until picked.
  - Project Managers see and manage only tickets linked to their managed projects; create requires a managed `projectId`.
  - PM assignee dropdown limited to linked **project team members** (members + project leads/creator); enforced in `ticket-access.util.js` and tickets UI.
  - Client-created tickets never self-assign the client as agent; legacy invalid assignments shown as Unassigned.

## 18. Client Portal — In Progress

- [x] Define a restricted OpenNext `Client / Customer Portal` (`client`) role and CRM permissions (`crm.projects.read`, `crm.tasks.read`, `crm.finance.read`, `crm.contracts.read`, `crm.tickets.read/write`, `crm.customerSuccess.manage`).
- [x] Add client invitation, activation, suspension, and account linking (`ClientPortalAccess` lifecycle).
- [x] Show only the signed-in client's company and permitted records (enforced via `isClientUser(req)`, `resolveClientId(req)`, `applyClientScope`).
- [x] Allow clients to view projects and client-visible tasks (`project.service.js`, `task.service.js`, `project-access.util.js`).
- [x] Allow clients to accept or reject quotations and contracts.
- [x] Allow clients to view and download invoices, credit notes, payments, receipts, and order documents.
- [ ] Allow clients to make online payments after a gateway is implemented.
- [x] Allow clients to create and reply to support tickets.
- [x] Allow client feedback only where explicitly enabled.
- [x] Apply tenant and client-record scope to every portal endpoint (`applyClientScope` across projects, tasks, tickets, invoices, estimates, contracts, payments).
- [ ] Add responsive and accessible portal layouts.

## 19. Internal messages and chat — Not started

- [ ] Add one-to-one conversations.
- [ ] Add permitted group conversations.
- [ ] Add tenant-safe conversation membership.
- [ ] Add unread counts, timestamps, pagination, and search.
- [ ] Add secure message attachments.
- [ ] Add real-time message delivery using an OpenNext-supported mechanism.
- [ ] Add a fallback when real-time transport is unavailable.
- [ ] Add edit/delete rules and retention policy.
- [ ] Add permissions and moderation/audit requirements.

## 20. Events and shared calendar — Not started

- [ ] Add company events, meetings, deadlines, tasks, milestones, contract dates, and follow-ups to a unified calendar.
- [ ] Add day, week, month, and agenda views.
- [ ] Add attendees, visibility, reminders, location/link, recurring events, and status.
- [ ] Add project, client, event-type, owner, and date filters.
- [ ] Apply tenant, role, project, client, and private-event visibility rules.
- [ ] Handle user timezone and stored UTC dates consistently.
- [ ] Add optional calendar export or third-party integration after the internal calendar is complete.

## 21. Notices and notifications — Not started

- [ ] Add company, role, and team notice publishing.
- [ ] Add notice scheduling, expiry, priority, acknowledgement, and audience permissions.
- [ ] Add an in-app notification centre.
- [ ] Add unread count, mark-as-read, mark-all-read, and notification history.
- [ ] Add notification preferences by event type and channel.
- [ ] Add notifications for assignment, due date, follow-up, approval, ticket reply, invoice status, payment, order status, and contract expiry.
- [ ] Add real-time delivery if supported by OpenNext.
- [ ] Reuse the completed email service without changing its transport implementation.
- [ ] Keep Slack, Pusher, and OneSignal integrations optional.

## 22. Reports — Complete

Sales, conversion, project progress, time logs, ageing, income/expense, recurring invoices, credit notes/refunds, payment reconciliation, project profitability, CSV export, and dashboard reports are fully complete.

- [x] Add saved report filters.
- [x] Add task completed-versus-pending report.
- [x] Add ticket open-versus-closed and SLA report.
- [x] Add contract expiry and renewal report.
- [x] Add product sales report.
- [x] Add recurring-invoice report (`recurring-invoices` tab, MRR/ARR projections, active profiles, and schedule breakdown).
- [x] Add credit-note and refund report (`credit-notes` tab, total credit issued, applied amount, open credit balance, and refunds).
- [x] Add payment-gateway / payment reconciliation report (`payment-reconciliation` tab, collections by payment mode, refunds, net revenue, and settlement listing).
- [x] Add project profitability using revenue, billable time, and expenses.
- [x] Add PDF/print export where CSV is insufficient.
- [x] Apply tenant and permission scope to every report and export.

## 23. Settings — Complete

General, finance, pipeline, delivery, SMTP, prefixes, tax, rates, categories, and tenant user designations are fully complete.

- [x] Shifted OpenNext user designation and role assignment to a dedicated **`🛡️ Users & Designations`** tab in System Settings (`#settings?tab=users`) with search filter, preset chips, instant save, and permissions inspector.
- [x] Streamlined primary sidebar navigation by removing redundant `Tenant Security` (`#security`) and `AI Intelligence` (`#analytics-ai`) entries from `NAV_ITEMS`.
- [x] Add configurable lead sources, stages, opportunity stages, probabilities, task statuses, task labels, priorities, ticket categories, and SLA policies.
- [x] Add contract, product, credit-note, payment-method, and gateway configuration as those modules are completed.
- [x] Add locale, timezone, date format, currency format, and number format.
- [x] Add organization branding for generated documents.
- [x] Add OpenNext-compatible theme preferences without copying Worksuite styling.
- [x] Add safe secret handling so gateway credentials never return to the browser.
- [x] Validate every setting server-side and audit sensitive changes.

## 24. Roles, permissions, tenant security, and audit — Complete with maintenance remaining

- [x] Shift user designation assignment for workspace members into Settings tab.
- [x] Register permissions for every new module before exposing its navigation page.
- [x] Map new permissions to OpenNext roles using least privilege.
- [ ] Add client-role permissions for the Client Portal.
- [x] Enforce permissions in APIs as well as UI navigation and buttons.
- [x] Enforce tenant and record scope in lists, details, reports, exports, lookups, and dashboard aggregations.
- [x] Add audit module types for Contracts, Products, Credit Notes, Chat, Calendar, Notices, and Gateway Payments.
- [x] Prevent users from changing protected role or tenant membership fields without authorization.
- [x] Keep tenant administration separate from ordinary CRM user management.

## 25. UI, responsive design, and accessibility — Complete

- [x] Standardize list, detail, create, edit, loading, empty, and error states across modules.
- [x] Standardize pagination, filtering, search, sorting, dialogs, drawers, badges, and toast messages.
- [x] Verify layouts at desktop, tablet, and mobile widths.
- [x] Ensure every form has labels and accessible validation messages.
- [x] Ensure complete keyboard navigation and visible focus states.
- [x] Ensure dialogs trap focus and close safely.
- [x] Provide non-drag alternatives for Kanban and Gantt actions.
- [x] Check color contrast, zoom, reduced motion, screen-reader names, and table accessibility.
- [x] Keep the interface visually consistent with OpenNext.

## 26. Optional integrations and add-ons — Optional

These modules must not block the first core Worksuite-style CRM release.

### Asset management

- [ ] Add asset categories, assets, serial numbers, condition, assigned user, and location.
- [ ] Add issue, return, transfer, repair, and acknowledgement history.
- [ ] Add asset reports, permissions, and audit history.

### External/public REST API

- [ ] Separate the versioned external API from the internal plugin API.
- [ ] Add secure authentication, token scopes, rotation, rate limits, pagination, and audit logs.
- [ ] Publish API documentation and integration examples.

### SMS and meetings

- [ ] Add an optional SMS provider abstraction, templates, consent, opt-out, logs, and cost controls.
- [ ] Add an optional Zoom or other meeting provider using secure OAuth and tenant-specific credentials.
- [ ] Keep the CRM functional when these integrations are not installed.

### SaaS extensions

- [ ] Decide whether customer subdomains or custom domains are required.
- [ ] If approved, add tenant-domain mapping, verification, certificates, and routing.
- [ ] Add subscriptions, plans, module entitlements, usage limits, billing, trials, and tenant suspension only if OpenExt becomes a SaaS product.

---

## Completion requirements for every module

A page being visible does not mean its module is complete. Each new module must include all applicable items:

- [ ] Documented requirements and workflows.
- [ ] Tenant-aware models and migrations.
- [ ] Required indexes and unique constraints.
- [ ] Services and business rules.
- [ ] Controllers and routes.
- [ ] Server-side validation and normalization.
- [ ] List, detail, create, edit, loading, empty, and error UI states.
- [ ] Navigation and manifest permissions.
- [ ] OpenNext role mapping with least privilege.
- [ ] API-enforced tenant and record access.
- [ ] Audit history for sensitive actions.
- [ ] Reports and exports where relevant.
- [ ] Responsive design and accessibility.
- [ ] Updated implementation report and remaining-task file.

## Recommended module order

1. System foundation and current project access behavior.
2. Tasks Kanban and Project Gantt.
3. Product Catalogue.
4. Contracts and e-signatures.
5. Quotation and Invoice parity improvements.
6. Credit Notes and Recurring Invoices.
7. Payments and the first Payment Gateway.
8. Client Portal.
9. Ticket conversation improvements.
10. Calendar and Events.
11. Notices and Notification Centre.
12. Internal Messages and Chat.
13. Reporting and Settings expansion.
14. UI consistency, responsive design, accessibility, security, and production readiness.
15. Optional integrations only after the core modules are stable.

---

## Daily work log — 2 September 2026

| Area | Delivered |
|------|-----------|
| **Support tickets** | PM-scoped ticket list/read/write; assign/reassign gated to Super Admin, CRM Manager, PM; PM assignee dropdown = project team only; client never auto-assigned as agent |
| **Tasks** | Full-page edit at `#tasks/{id}/edit` (modal retained for create) |
| **Projects** | List/kanban **Tasks Progress** column shows real computed progress; backend batch stats in `enrichProjects()` |
| **Quotations** | Fixed print HTML (`exportPrintHtml`); Send to Client loading state |
| **Invoices** | Send to Client loading state; documented public Razorpay pay-link edge case |

**Files touched (main):** `api/utils/ticket-access.util.js`, `api/services/ticket.service.js`, `api/services/project.service.js`, `api/services/quotation.service.js`, `ui/admin/pages/tickets/tickets.js`, `ui/admin/pages/tasks/task-edit.js`, `ui/admin/pages/projects/projects.js`, `ui/admin/pages/quotations/quotations.js`, `ui/admin/pages/invoices/invoices.js`, `ui/admin/style.css`, `manifest.json`, `api/roles.js`

---

## Daily work log — 4 September 2026

| Area | Delivered |
|------|-----------|
| **Invoice Templates** | Dedicated full-page Invoice Template Creator studio ([`ui/admin/pages/invoices/invoice-template-create.js`](ui/admin/pages/invoices/invoice-template-create.js)) with live preview card and variables |
| **Sample Requests** | Dedicated full-page Sample Request Creator ([`ui/admin/pages/samples/sample-create.js`](ui/admin/pages/samples/sample-create.js)) with lead/client picker, SLA selector, and live forecast |
| **Opportunities** | Dedicated full-page Opportunity Deal Creator ([`ui/admin/pages/opportunities/opportunity-create.js`](ui/admin/pages/opportunities/opportunity-create.js)) with 9 stage pipeline, probability slider, State tax engine, and direct quote conversion; cleaned up client/account column |
| **Settings & Security** | Shifted OpenNext user designation assignment into **Settings → Users & Designations** tab; removed standalone Tenant Security & AI Intelligence from primary sidebar menu |
| **Docs** | Synced [`ROLES_AND_PERMISSIONS.md`](ROLES_AND_PERMISSIONS.md), [`CODEBASE_REFERENCE.md`](CODEBASE_REFERENCE.md), [`PROJECT-IMPLEMENTATION-REPORT.md`](PROJECT-IMPLEMENTATION-REPORT.md), and [`tasks-remaining.md`](tasks-remaining.md) |

**Related:** See Roles doc section **Critical Runtime Rules** for ticket assignment — permissions keys alone do not grant Assign Agent.

