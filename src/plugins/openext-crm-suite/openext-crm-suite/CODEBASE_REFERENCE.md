# OpenExt CRM Suite — Complete Codebase Reference

> Auto-generated from the project source. Describes every folder, every file, and every exported function/object.

---

## Table of Contents

1. [Root Files](#root-files)
2. [api/ — Backend Server](#api--backend-server)
   - [api/index.js — Plugin Entry Point](#apiindexjs--plugin-entry-point)
   - [api/roles.js — Role Definitions](#apirolesjs--role-definitions)
   - [api/register-models.js — Model Registration](#apiregister-modelsjs--model-registration)
   - [api/controllers/ — HTTP Request Handlers](#apicontrollers--http-request-handlers)
   - [api/services/ — Business Logic Layer](#apiservices--business-logic-layer)
   - [api/routes/ — Express Route Definitions](#apiroutes--express-route-definitions)
   - [api/models/ — Mongoose Schemas](#apimodels--mongoose-schemas)
   - [api/middleware/ — Request Middleware](#apimiddleware--request-middleware)
   - [api/utils/ — Shared Utilities](#apiutils--shared-utilities)
   - [api/validation/ — Input Validation Schemas](#apivalidation--input-validation-schemas)
   - [api/hooks/ — Lifecycle Hooks](#apihooks--lifecycle-hooks)
   - [api/migrations/ — Database Migrations](#apimigrations--database-migrations)
3. [ui/ — Frontend Interface](#ui--frontend-interface)
   - [ui/admin/ — Admin Panel SPA](#uiadmin--admin-panel-spa)
   - [ui/admin/app.js — Shell & Router](#uiadminappjs--shell--router)
   - [ui/admin/services/api.js — API Client](#uiadminservicesapijs--api-client)
   - [ui/admin/utils/ — Frontend Utilities](#uiadminutils--frontend-utilities)
   - [ui/admin/pages/ — Page Modules](#uiadminpages--page-modules)
   - [ui/portal/ — Public Portal Pages](#uiportal--public-portal-pages)
4. [test/ — Integration & Unit Tests](#test--integration--unit-tests)

---

## Root Files

| File | Purpose |
|------|---------|
| `manifest.json` | Plugin metadata — ID, version, name, description, permissions, page routes, sidebar items, hooks, and public API paths. The CMS reads this to register the plugin. |
| `README.md` | Project overview and setup instructions |
| `ROLES_AND_PERMISSIONS.md` | Comprehensive roles & permissions reference for all 9 CRM roles |
| `PROJECT-IMPLEMENTATION-REPORT.md` | Detailed implementation report of all completed features |
| `tasks-remaining.md` | Tracking document for remaining tasks and known issues |
| `.gitignore` | Git ignore rules |

---

## api/ — Backend Server

The `api/` directory contains the complete server-side logic. It follows a **Controller → Service → Model** pattern with Express routes.

---

### `api/index.js` — Plugin Entry Point

The main entry point loaded by OpenExt CMS when the plugin starts.

| Export | Type | Description |
|--------|------|-------------|
| `publicApiPaths` | Array | URL prefixes that skip authentication (`quotations/public`, `invoices/public`) |
| `register({ app, cms })` | async function | Called on plugin load — registers models, mounts tenant middleware, resolves CRM permissions for each request |
| `boot({ cms })` | async function | Called after all plugins finish `register()` — syncs plugin roles to the database |
| `shutdown()` | function | Called when plugin is disabled — cleanup handler |
| `syncPluginRoles(cms)` | async function (internal) | Upserts the 8 CRM roles (value 100–107) into the `roles` MongoDB collection with permissions and page access |

---

### `api/roles.js` — Role Definitions

Defines available pages (with features) and all 9 plugin roles.

| Export | Type | Description |
|--------|------|-------------|
| `pages` | Array | 22 page definitions with IDs, labels, and feature capabilities (e.g., `{ id: 'leads', features: ['list', 'create', 'edit', ...] }`) |
| `roles` | Array | 9 role definitions — each has `id`, `name`, `baseRole`, `permissions[]`, and `pages` (either `'*'` for full access or an array of page configs) |

---

### `api/register-models.js` — Model Registration

| Export | Type | Description |
|--------|------|-------------|
| `registerAllModels(cms)` | async function | Re-registers all Mongoose schemas from `api/models/` to prevent stale model references after plugin reload |

---

### `api/controllers/` — HTTP Request Handlers

Each controller file receives HTTP requests from routes, validates input, calls the corresponding service, and returns JSON responses. They follow the pattern: `async function handler(req, res) { ... }`.

#### `analytics-ai.controller.js`
| Function | Description |
|----------|-------------|
| `salesAnalytics` | Returns AI-powered sales analytics (forecasting, win probability) |
| `customerBehavior` | Returns customer behavior analysis and segmentation |
| `nextBestActions` | Returns AI-recommended next-best-actions for leads/deals |
| `applyAction` | Applies an AI-recommended action to a record |

#### `audit.controller.js`
| Function | Description |
|----------|-------------|
| `list` | Lists all audit log entries with pagination and filtering |
| `listByRecord` | Lists audit entries for a specific record (by entity type + ID) |
| `exportAudit` | Exports audit log as CSV |

#### `client.controller.js`
| Function | Description |
|----------|-------------|
| `list` | Lists clients with pagination, search, filters |
| `checkDuplicates` | Checks for duplicate clients before creation |
| `get` | Gets a single client by ID with enriched data |
| `create` | Creates a new client record |
| `update` | Updates client details |
| `remove` | Soft-deletes a client |
| `listContacts` | Lists contact persons for a client |
| `addContact` | Adds a contact person to a client |
| `updateContact` | Updates a contact person |
| `removeContact` | Removes a contact person |
| `listQuotations` | Lists quotations linked to a client |
| `listInvoices` | Lists invoices for a client |
| `listPayments` | Lists payments from a client |
| `listProjects` | Lists projects linked to a client |
| `listTasks` | Lists tasks linked to a client's projects |
| `listTimeLogs` | Lists time logs for a client's projects |
| `listContracts` | Lists contracts with a client |
| `listProducts` | Lists products associated with a client |
| `listDocuments` | Lists uploaded documents for a client |
| `uploadDocument` / `createDocument` / `deleteDocument` | File upload CRUD for client docs |
| `listPortalAccess` | Lists portal access records for a client |
| `invitePortalContact` | Sends a portal invitation email to a client contact |
| `resendPortalInvitation` | Re-sends a pending portal invitation |
| `activatePortalUser` / `suspendPortalUser` / `reinstatePortalUser` | Portal user status management |
| `updatePortalPermissions` | Updates what a portal user can access |
| `revokePortalAccess` | Revokes portal access for a user |
| `listSummary` / `summary` | Client overview with financial summary |
| `listCategories` / `addCategory` | Client category management |
| `listStatuses` | Lists available client statuses |
| `listTags` / `addTag` | Client tag management |
| `listCustomFields` / `addCustomField` | Custom field management |
| `importPreview` | Previews a CSV import before execution |

#### `context.controller.js`
| Function | Description |
|----------|-------------|
| `me` | Returns the current authenticated user's CRM context |
| `permissions` | Returns the current user's resolved permission set |
| `assignableUsers` | Returns users that can be assigned to records |

#### `credit-note.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve credit notes |
| `create` | Creates a standalone credit note |
| `createFromInvoice` | Creates a credit note from an existing invoice |
| `apply` | Applies credit note amount to an invoice |
| `refund` | Processes a refund against a credit note |
| `voidNote` | Voids a credit note |
| `remove` | Deletes a credit note |
| `archive` / `restore` | Archive/restore credit notes |
| `printHtml` | Generates printable HTML for a credit note |

#### `customer-success.controller.js`
| Function | Description |
|----------|-------------|
| `getSummary` | Returns overall customer success metrics |
| `listAccounts` | Lists all accounts with health scores |
| `getAccountHealth` | Gets detailed health score for a specific account |
| `exportCustomerSuccess` | Exports customer success data as CSV |

#### `dashboard.controller.js`
| Function | Description |
|----------|-------------|
| `health` | Returns plugin health status and version |
| `summary` | Returns all dashboard metrics filtered by time period |
| `getWidgets` | Returns the user's widget configuration |
| `saveWidgets` | Saves custom widget layout for a user |

#### `data-quality.controller.js`
| Function | Description |
|----------|-------------|
| `list` | Lists data quality scores for leads and clients |
| `exportDataQuality` | Exports quality scores as CSV |
| `getRules` | Returns current quality scoring rules and weights |
| `updateRules` | Updates quality scoring rules |

#### `expense.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve expenses |
| `exportExpenses` | Exports expenses as CSV |
| `create` / `update` / `remove` | CRUD for expense records |
| `submit` | Submits an expense for approval |
| `approve` / `reject` | Approves or rejects a submitted expense |
| `archive` / `restore` | Archive/restore expenses |
| `getUnbilledBillable` | Lists billable expenses not yet invoiced |
| `markBilled` | Marks expenses as billed |
| `categories` | Returns available expense categories |

#### `invoice-template.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve invoice templates |
| `create` / `update` / `remove` | CRUD for invoice templates |
| `saveAsTemplate` | Saves an existing invoice as a reusable template |

#### `invoice.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve invoices |
| `exportInvoices` | Exports invoices as CSV |
| `create` / `update` / `remove` | CRUD for invoices |
| `send` | Sends invoice via email to the client |
| `markAsViewed` | Marks invoice as viewed by client |
| `writeOff` | Writes off an unpaid invoice balance |
| `archive` / `restore` | Archive/restore invoices |
| `saveAsTemplate` | Saves invoice as a reusable template |
| `cancel` | Cancels an invoice |
| `listPayments` | Lists payments against an invoice |
| `printHtml` | Generates printable HTML |
| `getNextInvoiceNumber` | Returns the next auto-generated invoice number |
| `getRazorpayStatus` | Checks Razorpay gateway configuration status |
| `createRazorpayOrder` / `confirmRazorpayPayment` | Razorpay payment flow (authenticated) |
| `generatePayToken` | Generates a public payment link token |
| `getPublicPortal` | Returns invoice data for the public payment portal |
| `createPublicRazorpayOrder` / `confirmPublicRazorpayPayment` | Public Razorpay payment flow (unauthenticated) |

#### `lead.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve leads |
| `checkDuplicates` | Checks for duplicate leads before creation |
| `create` / `update` / `remove` | CRUD for leads |
| `updateQualification` | Updates lead qualification status (MQL/SQL/etc.) |
| `changeStage` | Moves a lead through pipeline stages |
| `convert` | Converts a lead into a client |
| `listEvents` / `createEvent` / `updateEvent` / `completeEvent` / `removeEvent` | Lead event (meeting/call) management |
| `listFollowUps` / `createFollowUp` / `updateFollowUp` / `completeFollowUp` / `removeFollowUp` | Follow-up reminders |
| `listQuotations` / `createProposal` | Lead-linked quotation management |
| `uploadPhoto` | Uploads a lead's profile photo |
| `listAttachments` / `uploadAttachment` / `removeAttachment` | File attachment management |
| `storageStatus` | Returns storage usage info |
| `listSources` / `addSource` | Lead source management |
| `listStatuses` / `addStatus` | Lead status management |
| `listTags` / `addTag` | Lead tag management |
| `listCustomFields` / `addCustomField` | Custom field management |
| `importPreview` / `importExecute` | CSV import preview and execution |
| `exportLeads` | Exports leads as CSV |
| `bulkAssign` / `bulkChangeStage` | Bulk operations on multiple leads |
| `listSavedFilters` | Lists saved filter presets |

#### `marketing.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `getById` | List and retrieve campaigns |
| `exportMarketing` | Exports campaign data as CSV |
| `create` / `update` / `remove` | CRUD for campaigns |
| `audienceStats` | Returns audience segmentation stats |
| `execute` | Executes a campaign (sends emails) |
| `sendTest` | Sends a test email for a campaign |
| `reEngage` / `simulateReEngage` | Re-engagement workflow |
| `analytics` | Returns campaign performance analytics |
| `eligibleLeads` | Returns leads eligible for re-engagement |
| `createRequest` / `listRequests` / `approveRequest` / `rejectRequest` | Re-engagement request workflow |
| `trackClick` | Tracks email link clicks |

#### `milestone.controller.js`
| Function | Description |
|----------|-------------|
| `list` | Lists all milestones |
| `listByProject` | Lists milestones for a specific project |
| `get` / `create` / `update` / `remove` | CRUD for milestones |

#### `opportunity.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `getById` | List and retrieve opportunities |
| `getSummary` | Returns pipeline summary with stage totals |
| `create` | Creates a new opportunity |
| `changeStage` | Moves opportunity through pipeline stages |
| `convertToQuotation` | Converts an opportunity to a quotation |
| `remove` | Deletes an opportunity |
| `exportOpportunities` | Exports opportunities as CSV |

#### `payment.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve payments |
| `exportPayments` | Exports payments as CSV |
| `create` / `update` / `remove` | CRUD for payments |
| `requestRefund` | Initiates a refund request |
| `approveRefund` / `rejectRefund` | Approves/rejects refund requests |
| `listRefunds` / `getPaymentRefunds` | Lists refund records |

#### `project-template.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve project templates |
| `create` / `update` / `remove` | CRUD for project templates |
| `instantiate` | Creates a new project from a template |

#### `project.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve projects |
| `exportProjects` | Exports projects as CSV |
| `getOverview` | Returns project analytics (budget, progress, task breakdown, hours) |
| `getActivity` | Returns project activity feed |
| `create` / `update` / `remove` | CRUD for projects |
| `archive` / `restore` | Archive/restore projects |
| `listDocuments` / `uploadDocument` / `createDocument` / `deleteDocument` | Project file management |
| `listMembers` / `addMember` / `updateMember` / `removeMember` | Team member management |
| `listTasks` | Lists tasks for a project |
| `listCategories` / `addCategory` | Project category management |
| `listLabels` / `addLabel` | Project label management |
| `listStatuses` / `addStatus` | Project status management |
| `listPriorities` / `addPriority` | Project priority management |
| `listTags` / `addTag` | Project tag management |
| `listCustomFields` / `addCustomField` | Custom field management |

#### `quotation.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve quotations |
| `exportQuotations` | Exports quotations as CSV |
| `create` / `update` / `remove` | CRUD for quotations |
| `send` | Sends quotation via email |
| `accept` / `reject` | Accept/reject a quotation |
| `createRevision` / `getRevisions` | Quotation revision management |
| `archive` / `restore` | Archive/restore quotations |
| `generatePortalToken` | Generates a public portal link |
| `getPublicPortal` | Returns quotation for the public portal |
| `clientPortalAccept` / `clientPortalReject` | Client portal accept/reject workflow |
| `listTemplates` / `getTemplate` / `createTemplate` / `updateTemplate` / `deleteTemplate` / `saveAsTemplate` | Estimate template CRUD |
| `convertToInvoice` | Converts quotation to an invoice |
| `printHtml` | Generates printable HTML |

#### `recurring-expense.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve recurring expense profiles |
| `create` / `update` / `remove` | CRUD for recurring expense profiles |
| `toggleStatus` | Activates/pauses a recurring profile |
| `runNow` | Manually triggers a recurring expense generation |
| `runDue` | Processes all due recurring expenses |
| `upcomingReport` | Returns upcoming recurring expense schedule |

#### `recurring-invoice.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve recurring invoice profiles |
| `create` / `update` / `remove` | CRUD for recurring invoice profiles |
| `toggleStatus` | Activates/pauses a recurring profile |
| `runNow` | Manually triggers a recurring invoice generation |
| `runDue` | Processes all due recurring invoices |
| `upcomingReport` | Returns upcoming recurring invoice schedule |

#### `report.controller.js`
| Function | Description |
|----------|-------------|
| `sales` | Returns sales pipeline report |
| `projects` | Returns projects delivery report |
| `leadConversion` | Returns lead conversion funnel report |
| `invoiceAgeing` | Returns invoice ageing analysis |
| `timeReport` | Returns time utilization report |
| `incomeExpense` | Returns income vs. expense report |
| `recurringInvoices` | Returns recurring invoices summary |
| `creditNotes` | Returns credit notes report |
| `paymentReconciliation` | Returns payment reconciliation report |
| `exportCsv` | Exports any report as CSV |

#### `sales-order.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve sales orders |
| `exportSalesOrders` | Exports sales orders as CSV |
| `create` | Creates a new sales order |
| `convertQuotation` | Converts a quotation to a sales order |
| `updateStatus` | Updates order status |
| `dispatch` | Marks order as dispatched |
| `confirmDelivery` | Confirms order delivery |
| `addShipment` / `updateShipmentStatus` | Shipment tracking |
| `createReturn` / `updateReturnStatus` | Returns/RMA management |
| `cancel` | Cancels a sales order |
| `reserveStock` | Reserves stock for an order |
| `remove` | Deletes a sales order |

#### `sample.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `getById` | List and retrieve sample requests |
| `exportSamples` | Exports sample requests as CSV |
| `create` | Creates a new sample request |
| `approve` | Approves a sample request |
| `dispatch` | Marks sample as dispatched |
| `deliver` | Marks sample as delivered |
| `submitFeedback` | Records client feedback on a sample |

#### `setting.controller.js`
| Function | Description |
|----------|-------------|
| `getSettings` | Returns all CRM settings for the tenant |
| `putSettings` | Updates CRM settings |
| `getPipeline` | Returns sales pipeline stage configuration |
| `putPipeline` | Updates pipeline stages |
| `getDelivery` | Returns project delivery settings (task statuses, priorities, etc.) |
| `testEmail` | Sends a test email to verify email configuration |
| `getEmailStatus` | Returns email plugin integration status |
| `validateSettingsInput` | Validates settings input before saving |

#### `task-template.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve task templates |
| `create` / `update` / `remove` | CRUD for task templates |
| `instantiate` | Creates tasks from a template |
| `saveAsTemplate` | Saves an existing task as a reusable template |

#### `task.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve tasks |
| `exportTasks` | Exports tasks as CSV |
| `create` / `update` / `remove` | CRUD for tasks |
| `changeStatus` | Changes task status with validation |
| `archive` / `restore` | Archive/restore tasks |
| `listComments` / `addComment` | Task comment management |
| `sendReminder` | Sends a manual reminder notification for a task |
| `processAutoReminders` | Processes automatic client review reminders |
| `processRecurringTasks` | Processes recurring task generation |
| `listSubtasks` / `addSubtask` / `updateSubtask` / `toggleSubtask` / `deleteSubtask` | Subtask/checklist management |
| `addFollower` / `removeFollower` / `toggleFollower` / `updateFollowers` | Task follower/watcher management |

#### `tenant.controller.js`
| Function | Description |
|----------|-------------|
| `context` | Returns tenant context for the current user |
| `roles` | Lists all available tenant roles |
| `members` / `exportMembers` | Lists/exports tenant members |
| `candidates` | Lists users who can be added as tenant members |
| `addMember` / `updateMember` | Adds/updates tenant members |
| `rolePermissions` / `updateRolePermissions` | Gets/updates role-level permissions |
| `createCustomRole` / `deleteCustomRole` | Custom role management |

#### `ticket.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `getById` | List and retrieve tickets |
| `exportTickets` | Exports tickets as CSV |
| `create` | Creates a new support ticket |
| `updateStatus` | Updates ticket status |
| `resolveTicket` | Marks a ticket as resolved |
| `remove` | Deletes a ticket |
| `listFeedback` / `createFeedback` / `getFeedbackSummary` | CSAT feedback management |
| `addMessage` / `listMessages` | Ticket conversation messages |
| `getCannedResponses` / `createCannedResponse` / `deleteCannedResponse` | Canned response templates |
| `addWatcher` / `removeWatcher` | Ticket watcher management |
| `reassign` | Reassigns ticket to another agent |
| `escalate` | Escalates ticket priority |
| `archiveTicket` / `restoreTicket` | Archive/restore tickets |

#### `time-log.controller.js`
| Function | Description |
|----------|-------------|
| `list` / `get` | List and retrieve time logs |
| `exportTimeLogs` | Exports time logs as CSV |
| `create` / `update` / `remove` | CRUD for time logs |
| `submit` | Submits time log for approval |
| `approve` / `reject` | Approves/rejects submitted time logs |
| `bulkApprove` | Bulk approves multiple time logs |
| `lockLogs` / `unlockLogs` | Locks/unlocks time logs for a date range |
| `getWeeklyTimesheet` | Returns weekly timesheet view |
| `listByTask` / `taskSummary` | Task-specific time log views |
| `getActiveCheckIn` | Returns the currently active check-in session |
| `checkIn` / `checkOut` | Real-time check-in/check-out timer |

---

### `api/services/` — Business Logic Layer

Services contain all business logic. They interact with Mongoose models, enforce business rules, and return data to controllers.

#### `analytics-ai.service.js`
Sales analytics engine: win-probability forecasting, customer behavior segmentation, demand analysis, and AI-powered next-best-action recommendations.

#### `audit.service.js`
Records all CRM actions as immutable audit log entries. Supports listing, filtering by record, and CSV export.

#### `client-attachment.service.js`
Handles client file uploads (documents, receipts) to S3 or local storage.

#### `client-note.service.js`
CRUD for internal notes attached to client accounts.

#### `client-portal.service.js`
Manages client portal access — invitations, activation, suspension, permission updates, and portal authentication.

#### `client-timeline.service.js`
Builds a chronological timeline of all activities for a client (invoices, payments, tasks, etc.).

#### `client.service.js` (70KB — largest service)
Full client lifecycle: CRUD, contacts, addresses, categories, tags, custom fields, import/export, duplicate detection, and client summary analytics.

#### `context.service.js`
Returns the current user's CRM context (tenant, permissions, role).

#### `contract.service.js`
CRUD for contracts/agreements linked to clients or leads.

#### `credit-note.service.js`
Credit note lifecycle: creation (standalone or from invoice), application to invoices, refund processing, void, and print rendering.

#### `customer-feedback.service.js`
CSAT survey collection and analysis — submission, listing, and summary statistics.

#### `customer-success.service.js`
Customer health score calculation, account health monitoring, CSAT aggregation, and retention metrics.

#### `dashboard.service.js` (45KB)
Aggregates metrics from all modules for the dashboard — lead counts, invoice totals, task progress, expense sums, etc. Also manages widget configuration per user/role.

| Key Export | Description |
|------------|-------------|
| `AVAILABLE_WIDGETS` | List of all widget IDs |
| `ROLE_DEFAULT_WIDGETS` | Default widget set per role |
| `getDefaultWidgetsForRole(role)` | Returns default widgets for a given role |
| `getWidgetConfig(req)` | Returns saved widget config for the current user |
| `saveWidgetConfig(req, config)` | Saves widget config |
| `getSummary(req)` | Main dashboard aggregation — returns all metrics |
| `getHealth()` | Returns plugin health status |

#### `data-quality-center.service.js`
Scores leads and clients on data completeness using configurable weighted rules.

#### `estimate-template.service.js`
CRUD for reusable quotation/estimate templates.

#### `expense.service.js`
Full expense lifecycle: CRUD, submit for approval, approve/reject, archive, billable tracking, recurring generation, and CSV export.

#### `follow-up.service.js`
Follow-up reminder management for leads — create, update, complete, remove.

#### `invoice-template.service.js`
CRUD for reusable invoice templates.

#### `invoice.service.js` (42KB)
Full invoice lifecycle: CRUD, send via email, write-off, archive, cancel, payment application, credit note adjustments, print HTML generation, pay-token for public portal, Razorpay integration, and CSV export.

#### `lead-event.service.js`
Lead event/meeting management — CRUD for calls, meetings, and activities linked to leads.

#### `lead-upload.service.js`
Lead file management — profile photo upload, attachment upload/list/remove, and storage status.

#### `lead.service.js` (55KB)
Full lead lifecycle: CRUD, qualification, stage changes, conversion to client, duplicate detection, bulk import/export, saved filters, bulk assign/stage, products, and contracts.

#### `mail.service.js`
Email delivery service — resolves SMTP/plugin config, sends finance document emails (invoices, quotations), and test emails.

#### `marketing.service.js` (37KB)
Campaign lifecycle: CRUD, audience segmentation, email execution, A/B testing, re-engagement workflows, analytics, and template rendering.

#### `milestone.service.js`
Project milestone CRUD with cost tracking and completion status.

#### `opportunity.service.js`
Opportunity/deal pipeline: CRUD, stage progression with probability, conversion to quotation, and CSV export.

#### `payment.service.js` (32KB)
Payment recording, allocation to invoices, refund workflow (request/approve/reject), multi-method support, Razorpay integration, and CSV export.

#### `print-html.service.js`
Generates printable HTML for financial documents (invoices, quotations, credit notes) with company branding.

#### `product.service.js`
Product/service catalogue: CRUD with categories, pricing, and SKU management.

#### `project-attachment.service.js`
Project file management — upload, list, delete with category support (design, document, deliverable, etc.).

#### `project-template.service.js`
Project template CRUD — save project structure (with milestones, tasks) as a reusable template and instantiate new projects from templates.

#### `project.service.js` (39KB)
Full project lifecycle: CRUD, overview analytics (budget/earnings/expenses/profit/progress), activity feed, member management, archive/restore, and CSV export.

#### `quotation.service.js` (41KB)
Full quotation lifecycle: CRUD, line item calculation with GST, revisions, portal token generation, client portal accept/reject, send via email, convert to invoice, print HTML, and CSV export.

#### `razorpay-gateway.service.js`
Razorpay payment gateway integration — order creation, payment verification, and webhook handling for both authenticated and public (pay-link) flows.

#### `record-merge.service.js`
Duplicate record merge workflow — finds candidates, merges lead or client records, and re-links associated data.

#### `recurring-expense.service.js`
Recurring expense profile management — CRUD, toggle active/paused, manual and scheduled execution, and upcoming schedule reports.

#### `recurring-invoice.service.js`
Recurring invoice profile management — similar to recurring expenses, plus next-run-date calculation.

#### `report.service.js` (55KB)
Report generation engine: sales, projects, lead conversion, invoice ageing, time utilization, income vs. expense, recurring invoices, credit notes, payment reconciliation, and CSV export.

#### `sales-order.service.js` (36KB)
Full sales order lifecycle: CRUD, create from quotation/opportunity, status management, shipment tracking, returns/RMA, dispatch, delivery confirmation, stock reservation, and CSV export.

#### `sample.service.js`
Sample request workflow: create → approve → dispatch → deliver → feedback.

#### `setting.service.js` (32KB)
CRM settings management — company profile, currency, GST, pipeline stages, task/project statuses and priorities, categories, tags, custom fields, lead sources/statuses, and email configuration.

#### `shipping.service.js`
State-based shipping rate calculation for Indian states.

#### `task-template.service.js`
Task template CRUD — save/instantiate reusable task configurations.

#### `task.service.js` (65KB — second largest)
Full task lifecycle: CRUD, status changes, archiving, comments, subtask/checklist management, followers/watchers, automatic client reminders, recurring task generation, and CSV export.

#### `tenant.service.js` (40KB)
Multi-tenant management: member CRUD, role assignments, permission matrix, custom role creation/deletion, permission resolution, and member export.

#### `ticket.service.js` (38KB)
Support ticket lifecycle: CRUD, status changes, resolution, messages/conversations, canned responses, watcher management, reassignment, escalation, archive/restore, and CSV export.

#### `time-log.service.js` (53KB)
Time tracking: CRUD, submit/approve/reject workflow, bulk approval, lock/unlock periods, weekly timesheet, check-in/check-out timer, billable calculations, and CSV export.

---

### `api/routes/` — Express Route Definitions

Each route file mounts endpoints under the plugin's API prefix. Routes call `requirePermission()` middleware before invoking controllers.

| Route File | Base Path | Description |
|-----------|-----------|-------------|
| `analytics-ai.routes.js` | `/analytics-ai` | AI analytics endpoints |
| `audit.routes.js` | `/audit` | Audit log endpoints |
| `clients.routes.js` | `/clients` | Client CRUD, contacts, documents, portal access |
| `context.routes.js` | `/context` | User context and permissions |
| `contracts.routes.js` | `/contracts` | Contract CRUD |
| `credit-notes.routes.js` | `/credit-notes` | Credit note CRUD and actions |
| `customer-success.routes.js` | `/customer-success` | Health scores and CSAT |
| `dashboard.routes.js` | `/dashboard` | Dashboard metrics and widget config |
| `data-quality.routes.js` | `/data-quality` | Quality scoring |
| `expenses.routes.js` | `/expenses` | Expense CRUD and approval workflow |
| `invoice-templates.routes.js` | `/invoice-templates` | Invoice template CRUD |
| `invoices.routes.js` | `/invoices` | Invoice CRUD, email, payments, Razorpay |
| `lead-detail.routes.js` | `/leads/:id` | Lead sub-resources (events, follow-ups, attachments) |
| `leads.routes.js` | `/leads` | Lead CRUD, import/export, bulk ops |
| `marketing.routes.js` | `/marketing` | Campaign CRUD and execution |
| `milestones.routes.js` | `/milestones` | Milestone CRUD |
| `opportunity.routes.js` | `/opportunities` | Opportunity pipeline CRUD |
| `payments.routes.js` | `/payments` | Payment CRUD and refunds |
| `products.routes.js` | `/products` | Product catalogue CRUD |
| `projects.routes.js` | `/projects` | Project CRUD, members, documents, overview |
| `quotations.routes.js` | `/quotations` | Quotation CRUD, portal, templates |
| `recurring-expenses.routes.js` | `/recurring-expenses` | Recurring expense profiles |
| `recurring-invoices.routes.js` | `/recurring-invoices` | Recurring invoice profiles |
| `reports.routes.js` | `/reports` | Report generation endpoints |
| `sales-orders.routes.js` | `/sales-orders` | Sales order lifecycle |
| `sample.routes.js` | `/samples` | Sample request workflow |
| `settings.routes.js` | `/settings` | CRM settings management |
| `tasks.routes.js` | `/tasks` | Task CRUD, comments, subtasks, followers |
| `tenants.routes.js` | `/tenants` | Tenant member and role management |
| `tickets.routes.js` | `/tickets` | Support ticket lifecycle |
| `time-logs.routes.js` | `/time-logs` | Time log CRUD, approval, check-in |

---

### `api/models/` — Mongoose Schemas

Each model file defines a MongoDB collection schema with fields, types, defaults, indexes, and validation.

| Model File | Collection | Key Fields |
|-----------|-----------|------------|
| `AuditLog.js` | Audit logs | `action`, `entity`, `entityId`, `userId`, `changes`, `timestamp` |
| `Campaign.js` | Marketing campaigns | `name`, `type`, `audience`, `subject`, `body`, `status`, `stats` |
| `ClientAttachment.js` | Client uploaded files | `clientId`, `filename`, `url`, `category`, `uploadedBy` |
| `ClientEvent.js` | Client activity events | `clientId`, `type`, `title`, `date`, `notes` |
| `ClientNote.js` | Internal client notes | `clientId`, `content`, `createdBy` |
| `ClientPortalAccess.js` | Portal user access | `clientId`, `userId`, `email`, `status`, `permissions` |
| `Company.js` | Client/company records | `name`, `email`, `phone`, `addresses`, `contacts`, `category`, `tags`, `customFields` |
| `Contact.js` | Contact persons | `companyId`, `name`, `email`, `phone`, `designation` |
| `Contract.js` | Service contracts | `clientId`, `leadId`, `title`, `startDate`, `endDate`, `value`, `status` |
| `CreditNote.js` | Credit notes | `invoiceId`, `clientId`, `amount`, `status`, `reason`, `lineItems` |
| `CustomerFeedback.js` | CSAT surveys | `clientId`, `ticketId`, `rating`, `comment` |
| `Estimate.js` | Quotation/estimate records | `clientId`, `leadId`, `lineItems`, `subtotal`, `tax`, `total`, `status`, `validUntil` |
| `EstimateTemplate.js` | Reusable estimate templates | `name`, `lineItems`, `terms`, `notes` |
| `Expense.js` | Expense claims | `projectId`, `category`, `amount`, `currency`, `status`, `receipt`, `submittedBy` |
| `FollowUp.js` | Lead follow-up reminders | `leadId`, `date`, `type`, `notes`, `isCompleted` |
| `Invoice.js` | Tax invoices | `clientId`, `lineItems`, `subtotal`, `tax`, `total`, `status`, `dueDate`, `amountPaid` |
| `InvoiceTemplate.js` | Reusable invoice templates | `name`, `lineItems`, `terms`, `notes` |
| `Lead.js` | Lead/prospect records | `name`, `email`, `phone`, `company`, `source`, `stage`, `status`, `assignedTo`, `qualification`, `tags`, `customFields` |
| `LeadAttachment.js` | Lead uploaded files | `leadId`, `filename`, `url`, `uploadedBy` |
| `LeadEvent.js` | Lead activities/meetings | `leadId`, `type`, `title`, `date`, `notes`, `isCompleted` |
| `Milestone.js` | Project milestones | `projectId`, `name`, `dueDate`, `cost`, `status` |
| `Opportunity.js` | Sales opportunities/deals | `name`, `leadId`, `clientId`, `stage`, `value`, `probability`, `expectedCloseDate` |
| `Payment.js` | Payment records | `invoiceId`, `clientId`, `amount`, `method`, `date`, `reference`, `refunds` |
| `Product.js` | Product/service catalogue | `name`, `sku`, `price`, `unit`, `category`, `description` |
| `Project.js` | Project records | `name`, `clientId`, `budget`, `currency`, `status`, `priority`, `startDate`, `deadline`, `assignedTo`, `category`, `tags`, `customFields` |
| `ProjectAttachment.js` | Project files | `projectId`, `filename`, `url`, `category`, `uploadedBy` |
| `ProjectMember.js` | Project team members | `projectId`, `userId`, `hourlyRate` |
| `ProjectTemplate.js` | Reusable project templates | `name`, `milestones`, `tasks`, `budget`, `description` |
| `ReEngagementRequest.js` | Marketing re-engagement | `leadId`, `campaignId`, `status`, `requestedBy` |
| `RecurringExpense.js` | Recurring expense profiles | `projectId`, `category`, `amount`, `frequency`, `nextRunDate`, `status` |
| `RecurringInvoice.js` | Recurring invoice profiles | `clientId`, `lineItems`, `frequency`, `nextRunDate`, `status` |
| `SalesOrder.js` | Sales order records | `quotationId`, `clientId`, `lineItems`, `status`, `shipments`, `returns` |
| `SampleRequest.js` | Sample requests | `leadId`, `clientId`, `products`, `status`, `feedback` |
| `Setting.js` | CRM settings (key-value) | `tenantId`, `key`, `value` |
| `Task.js` | Task records | `projectId`, `milestoneId`, `title`, `description`, `status`, `priority`, `assignedTo`, `dueDate`, `estimatedHours`, `subtasks`, `followers`, `isRecurring` |
| `TaskComment.js` | Task comments | `taskId`, `userId`, `content` |
| `TaskTemplate.js` | Reusable task templates | `name`, `description`, `priority`, `subtasks`, `estimatedHours` |
| `Tenant.js` | Tenant records | `name`, `ownerId` |
| `TenantMembership.js` | Tenant member records | `tenantId`, `userId`, `role`, `linkedClientId` |
| `Ticket.js` | Support tickets | `subject`, `description`, `status`, `priority`, `category`, `assignedTo`, `clientId`, `projectId`, `messages`, `watchers` |
| `TimeLog.js` | Time log entries | `projectId`, `taskId`, `userId`, `hours`, `workDate`, `isBillable`, `billableAmount`, `status` |

---

### `api/middleware/` — Request Middleware

| File | Exported Function(s) | Description |
|------|----------------------|-------------|
| `audit.middleware.js` | `auditAction` | Records an audit log entry for the current request action |
| `permission.middleware.js` | `requirePermission(perm)`, `requireAnyPermission(perms)` | Express middleware that checks if the current user has the required CRM permission(s) — returns 403 if not |
| `tenant.middleware.js` | `requireTenantContext` | Ensures `req.tenantId` is resolved — rejects requests without a valid tenant |
| `validation.middleware.js` | `validate(schema)` | Express middleware that validates `req.body` against a Joi/custom schema — returns 400 on validation failure |

---

### `api/utils/` — Shared Utilities

#### `crm-role-permissions.util.js`
| Export | Description |
|--------|-------------|
| `CRM_MANIFEST_PERMISSIONS` | Complete list of all CRM permission strings |
| `EDITOR_SALES_MANAGER` | Permission set for sales manager role |
| `AUTHOR_SALES_AGENT` | Permission set for sales agent role |
| `resolveCrmRolePermissions(role)` | Returns permission array for a given CRM role key |

#### `customer-label.util.js`
| Export | Description |
|--------|-------------|
| `buildCustomerLabelMaps(req)` | Builds lookup maps for customer display names |
| `resolveCustomerLabel(id, maps)` | Resolves a customer ID to a display name |
| `resolveCustomerAvatar(id, maps)` | Resolves a customer ID to an avatar URL |
| `resolveCustomerEmail(id, maps)` | Resolves a customer ID to an email |
| `enrichWithCustomerLabel(records, maps)` | Enriches an array of records with customer names |

#### `data-quality.util.js`
| Export | Description |
|--------|-------------|
| `qualityLabel(score)` | Returns "Excellent" / "Good" / "Fair" / "Poor" for a quality score |
| `scoreLead(lead, weights)` | Calculates a data quality score for a lead (0–100) |
| `scoreClient(client, weights)` | Calculates a data quality score for a client (0–100) |
| `DEFAULT_LEAD_WEIGHTS` | Default scoring weights for lead fields |
| `DEFAULT_CLIENT_WEIGHTS` | Default scoring weights for client fields |

#### `expense-access.util.js`
| Export | Description |
|--------|-------------|
| `isExpenseScoped(req)` | Checks if user is scoped to their own expenses only |
| `userOwnsExpense(req, expense)` | Checks if the user owns a specific expense |
| `assertExpenseReadAccess(req, expense)` | Throws 403 if user cannot read the expense |
| `assertExpenseWriteAccess(req, expense)` | Throws 403 if user cannot edit the expense |
| `applyExpenseListScope(req, filter)` | Adds ownership filter to expense list queries |

#### `finance-document.util.js`
| Export | Description |
|--------|-------------|
| `buildQuotationPayload(body)` | Normalizes and validates quotation input data |
| `buildInvoicePayload(body)` | Normalizes and validates invoice input data |

#### `lead-duplicate.util.js`
| Export | Description |
|--------|-------------|
| `COMPANY_SIMILARITY_THRESHOLD` | Minimum similarity score to flag as duplicate (0.7) |
| `normalizeCompanyName(name)` | Normalizes company name for comparison |
| `buildCompanyTokens(name)` | Tokenizes a company name for fuzzy matching |
| `diceCoefficient(a, b)` | Calculates Dice coefficient similarity (0–1) |
| `tokenSimilarity(a, b)` | Calculates token-based similarity |
| `companySimilarity(a, b)` | Combined company name similarity score |
| `duplicateReasons(lead, match)` | Returns human-readable reasons why two leads are duplicates |

#### `model-register.util.js`
| Export | Description |
|--------|-------------|
| `reRegisterModel(cms, name, schema)` | Re-registers a Mongoose model, replacing stale cached versions |

#### `numbering.util.js`
| Export | Description |
|--------|-------------|
| `formatNumber(seq, prefix, padding)` | Formats a sequence number (e.g., `INV-00042`) |
| `parseSequenceFromDocumentNumber(docNumber)` | Extracts sequence number from a formatted document number |
| `syncSequenceFromDocumentNumber(req, key, docNumber)` | Syncs the counter to match an existing document number |
| `getNextNumber(req, key)` | Returns the next sequence number for a counter key |
| `allocateUniqueNumber(req, key, prefix)` | Allocates a unique document number atomically |
| `COUNTER_KEYS` | Map of counter keys (invoice, quotation, payment, etc.) |

#### `pagination.util.js`
| Export | Description |
|--------|-------------|
| `parsePagination(query, defaults)` | Parses `page`, `limit`, `sort`, `order` from query params into `{ page, limit, skip, sort }` |

#### `portal.util.js`
| Export | Description |
|--------|-------------|
| `attachTenantFromRecord(req, record)` | Attaches tenant context from a record for portal requests |

#### `project-access.util.js`
| Export | Description |
|--------|-------------|
| `isEmployeeScoped(req)` | Checks if user is employee-tier (scoped to own projects) |
| `getMemberUserIds(req, projectId)` | Returns user IDs of project members |
| `userOwnsProject(req, project)` | Checks if user is a member of the project |
| `userOwnsTask(req, task)` | Checks if user is assigned to the task |
| `assertProjectReadAccess(req, project)` | Throws 403 if user cannot read the project |
| `assertProjectWriteAccess(req, project)` | Throws 403 if user cannot edit the project |
| `buildEmployeeProjectScope(req)` | Builds MongoDB filter for employee-visible projects |
| `applyEmployeeProjectListScope(req, filter)` | Applies employee scope to project list queries |
| `assertTaskReadAccess(req, task)` / `assertTaskWriteAccess(req, task)` | Task-level access control |
| `buildEmployeeTaskScope(req)` / `applyEmployeeTaskListScope(req, filter)` | Task-level scope filters |

#### `public-origin.util.js`
| Export | Description |
|--------|-------------|
| `PLUGIN_ID` | Plugin identifier string |
| `resolvePublicOrigin(req)` | Resolves the public-facing base URL from settings or request |
| `buildPluginPortalUrl(req, path)` | Builds a full portal URL for a given path |
| `buildInvoicePayPortalUrl(req, token)` | Builds a public invoice payment link |
| `buildQuotationPortalUrl(req, token)` | Builds a public quotation portal link |
| `isValidOrigin(origin)` | Validates a URL origin |

#### `razorpay-credential.util.js`
| Export | Description |
|--------|-------------|
| `isEncryptedCredential(value)` | Checks if a Razorpay credential is encrypted |
| `decryptCredential(encrypted)` | Decrypts a Razorpay credential |

#### `safe-require.util.js`
| Export | Description |
|--------|-------------|
| `requireController(name)` | Safely requires a controller module with error handling |

#### `sales-access.util.js`
| Export | Description |
|--------|-------------|
| `accessError(msg)` | Creates a 403 error with a message |
| `isAdmin(req)` | Checks if user is a CRM admin/manager |
| `getPermissions(req)` | Returns the user's permission array |
| `hasPermission(req, perm)` | Checks if user has a specific permission |
| `isSalesAgentScoped(req)` | Checks if user is a sales rep (scoped to own leads) |
| `userOwnsLead(req, lead)` / `userOwnsClient(req, client)` | Ownership checks |
| `assertLeadWriteAccess` / `assertLeadReadAccess` | Lead-level access control |
| `applySalesAgentLeadListScope` / `applySalesAgentClientListScope` | List-level scope filters |
| `assertClientWriteAccess` / `assertClientReadAccess` | Client-level access control |

#### `search.util.js`
| Export | Description |
|--------|-------------|
| `DEFAULT_MAX_SEARCH_LENGTH` | Maximum search string length (200) |
| `toLiteralSearchTerm(str)` | Escapes regex special characters for literal MongoDB search |

#### `storage.util.js`
| Export | Description |
|--------|-------------|
| `PHOTO_MIME_TYPES` | Allowed photo MIME types |
| `DOCUMENT_MIME_TYPES` | Allowed document MIME types |
| `LIMITS` | File size limits |
| `isS3Configured()` | Checks if S3 storage is configured |
| `getS3Config()` | Returns S3 configuration |
| `readUploadFile(req)` | Reads an uploaded file from the request |
| `uploadLeadFile(req, buffer, metadata)` | Uploads a file for a lead |
| `deleteStoredFile(url)` | Deletes a file from storage |
| `sanitizeFileName(name)` / `sanitizePathSegment(seg)` | Sanitizes file names for storage |
| `hasExpectedFileSignature(buffer, mime)` | Validates file content matches declared MIME type |
| `buildPublicUrl(key)` | Builds a public URL for a stored file |

#### `tenant-role.util.js`
| Export | Description |
|--------|-------------|
| `PERMISSION_GROUPS` | Permission groups for the UI matrix |
| `CRM_MANIFEST_PERMISSIONS` | All CRM permission strings |
| `ROLE_DEFINITIONS` | Role definitions from manifest |
| `getRoleDefinition(roleId)` | Returns a role definition by ID |
| `TENANT_ROLES` | Mapped tenant role values |
| `normalizePlatformRole(role)` | Normalizes platform role to CRM role |
| `deriveTenantRole(req)` | Derives the CRM role from the request context |
| `isTenantRole(req, role)` | Checks if the user has a specific tenant role |
| `normalizeTenantRoleKey(key)` | Normalizes a role key string |
| `resolveTenantRolePermissions(req)` | Resolves all permissions for a user's tenant role |
| `listTenantRoles()` | Returns all available tenant roles |
| `getDefaultRolePermissionsMap()` | Returns default permission map per role |

#### `tenant.util.js`
| Export | Description |
|--------|-------------|
| `resolveTenantId(req)` | Extracts tenant ID from request |
| `resolveUserId(req)` | Extracts user ID from request |
| `isClientUser(req)` | Checks if user is a client portal user |
| `isUnlinkedClientUser(req)` / `isUnlinkedClientUserAsync(req)` | Checks if client user has no linked client record |
| `resolveClientId(req)` / `resolveClientIdAsync(req)` | Resolves the linked client ID for portal users |
| `applyClientScope(req, filter)` / `applyClientScopeAsync(req, filter)` | Adds client-scoping to queries for portal users |

#### `ticket-access.util.js`
| Export | Description |
|--------|-------------|
| `isProjectManager(req)` | Checks if user is a project manager |
| `isTicketProjectScoped(req)` | Checks if tickets should be scoped to managed projects |
| `getManagedProjectIds(req)` | Returns project IDs managed by the user |
| `getProjectTeamUserIds(req, projectId)` | Returns team member IDs for a project |
| `applyProjectManagerTicketListScope(req, filter)` | Scopes ticket list to project manager's projects |
| `assertTicketReadAccess` / `assertTicketWriteAccess` | Ticket-level access control |
| `assertTicketProjectInput` | Validates ticket project linkage |
| `assertProjectManagerTicketAssignee` | Validates assignee is in the project team |

#### `user.util.js`
| Export | Description |
|--------|-------------|
| `findCmsUserById(req, userId)` | Finds a CMS user by ID |
| `resolveUsernames(req, userIds)` | Bulk resolves user IDs to display names |
| `resolveUsername(req, userId)` | Resolves a single user ID to a display name |
| `resolveUserDesignations(req, userIds)` | Resolves user designations/titles |
| `enrichAuditUsers(req, records)` | Enriches audit log entries with user names |
| `enrichLeadAssignee(req, lead)` / `enrichLeadAssignees(req, leads)` | Adds assignee names to lead records |
| `findUserIdsBySearchTerm(req, term)` | Searches users by name/email |
| `listAssignableUsers(req)` | Returns users that can be assigned to records |

---

### `api/validation/` — Input Validation Schemas

Each schema file exports validation functions that parse and validate request bodies. They return `{ ok: true, data }` or `{ ok: false, errors }`.

| Schema File | Key Validators |
|------------|----------------|
| `client.schema.js` | `validateClientCreate`, `validateClientUpdate`, `validateContactCreate`, `validateClientImportPreview`, `validateClientNoteCreate`, `validateClientEventCreate` |
| `common.util.js` | `EMAIL_RE`, `MOBILE_RE`, `PAN_RE`, `isValidEmail`, `isValidMobile`, `isValidPan`, `assertMaxLength`, `trimString`, `trimLowerEmail` |
| `credit-note.schema.js` | `validateCreditNoteCreate`, `validateCreditNoteFromInvoice`, `validateCreditNoteApply`, `validateCreditNoteRefund` |
| `estimate-template.schema.js` | `validateEstimateTemplateCreate`, `validateEstimateTemplateUpdate` |
| `expense.schema.js` | `DEFAULT_CATEGORIES`, `validateExpenseCreate`, `validateExpenseUpdate`, `validateExpenseReject` |
| `finance.schema.js` | `MAX_LINE_ITEMS`, `validateLineItems`, `validateQuotationCreate`, `validateInvoiceCreate`, `validateInvoiceWriteOff` |
| `invoice-template.schema.js` | `validateInvoiceTemplateCreate`, `validateInvoiceTemplateUpdate` |
| `lead.schema.js` | `validateLeadCreate`, `validateLeadUpdate`, `validateLeadStageChange`, `validateLeadQualification`, `validateLeadImportPreview`, `validateSavedLeadFilterCreate` |
| `merge.schema.js` | `LEAD_FIELDS`, `CLIENT_FIELDS`, `validateLeadMerge`, `validateClientMerge` |
| `milestone.schema.js` | `VALID_MILESTONE_STATUSES`, `validateMilestoneCreate`, `validateMilestoneUpdate` |
| `opportunity.schema.js` | `OPPORTUNITY_STAGES`, `STAGE_PROBABILITIES`, `validateOpportunityCreate`, `validateStageChange` |
| `payment.schema.js` | `PAYMENT_MODES`, `REFUND_MODES`, `validatePaymentCreate`, `validatePaymentUpdate`, `validateRefundRequest` |
| `project.schema.js` | `validateProjectCreate`, `validateProjectUpdate`, `validateProjectMember` |
| `recurring-expense.schema.js` | `validateRecurringExpenseCreate`, `validateRecurringExpenseUpdate` |
| `recurring-invoice.schema.js` | `validateRecurringInvoiceCreate`, `validateRecurringInvoiceUpdate` |
| `sales-order.schema.js` | `ORDER_STATUSES`, `SHIPMENT_STATUSES`, `RETURN_TYPES`, `validateSalesOrderCreate`, `validateShipmentCreate` |
| `sample.schema.js` | `SAMPLE_STATUSES`, `validateSampleCreate`, `validateSampleApproval`, `validateSampleFeedback` |
| `task-template.schema.js` | `validateTaskTemplateCreate`, `validateTaskTemplateUpdate`, `validateTaskTemplateInstantiate` |
| `task.schema.js` | `VALID_FEEDBACK_STATUSES`, `validateTaskCreate`, `validateTaskUpdate`, `validateTaskStatusChange`, `validateTaskComment`, `validateSubtaskCreate` |
| `tenant.schema.js` | `USER_ID_PATTERN`, `validateMemberCreate`, `validateMemberUpdate` |
| `time-log.schema.js` | `validateTimeLogCreate`, `validateTimeLogUpdate`, `validateCheckIn`, `validateCheckOut`, `validateBulkApprove` |

---

### `api/hooks/` — Lifecycle Hooks

| File | Description |
|------|-------------|
| `install.js` | Runs on plugin installation — seeds default settings, creates initial pipeline stages |
| `uninstall.js` | Runs on plugin uninstallation — cleanup stub |

---

### `api/migrations/` — Database Migrations

Sequential migration scripts that run once to update the database schema. Each exports `up(cms)` and optionally `down(cms)`.

| Migration | Description |
|-----------|-------------|
| `001_crm_sales_core.js` | Creates indexes for Lead, Company, Estimate, and Contact collections |
| `002_finance_core.js` | Creates indexes for Invoice, Payment, and Product collections |
| `003_projects_tasks.js` | Creates indexes for Project, Task, Milestone, and ProjectMember |
| `004_time_logs.js` | Creates indexes for TimeLog collection |
| `005_expenses.js` | Creates indexes for Expense collection |
| `006_lead_details.js` | Creates indexes for LeadEvent, FollowUp, and LeadAttachment |
| `007_lead_attachments.js` | Additional attachment indexes |
| `008_tenant_security.js` | Creates indexes for Tenant, TenantMembership, and Setting |
| `009_customer_success.js` | Creates indexes for CustomerFeedback |
| `009_tenant_admin_lock.js` | Adds admin lock fields to tenant settings |
| `010_lead_contact_validation.js` | Adds email/phone validation indexes |
| `011_lead_duplicate_detection.js` | Adds fuzzy match indexes for duplicate detection |
| `012_record_merge_and_quality.js` | Adds merge tracking and quality score fields |
| `013_invoice_pay_token.js` | Adds `payToken` field to Invoice for public payment links |
| `014_invoice_pay_token_null_fix.js` | Fixes null payToken entries |
| `015_sync_invoice_sequence_counter.js` | Syncs invoice sequence counter with existing data |

---

## ui/ — Frontend Interface

---

### `ui/admin/` — Admin Panel SPA

The admin panel is a single-page application (SPA) loaded inside an iframe by OpenExt CMS.

| File | Size | Description |
|------|------|-------------|
| `index.html` | 10KB | HTML shell — includes CSS, loads app.js, defines the sidebar/nav skeleton, meta tags |
| `style.css` | 245KB | Complete CSS design system — dark mode support, component styles, responsive layouts, animations |
| `app.js` | 67KB | Main application shell — router, navigation, breadcrumbs, command palette, quick create menu |

---

### `ui/admin/app.js` — Shell & Router

The main SPA orchestrator. Wraps all page modules with navigation, routing, and global features.

**Key Objects:**
- `NAV_ITEMS` — 20 navigation items with categories (Overview, Sales, Operations, Finance, Support, Administration), icons, descriptions, and permission requirements
- `QUICK_ACTIONS` — 10 quick-create shortcuts (New Lead, New Client, New Project, etc.)

**Key Functions (on `window.CrmApp`):**
- `navigate(route, params)` — Hash-based router that loads page modules
- `goBack(options)` — Back navigation with history stack
- `hasPermission(perm)` — Checks if current user has a permission
- `openLeadCreate()` / `openClientCreate()` / `openProjectCreate()` / `openQuotationCreate()` / `openInvoiceCreate()` / `openExpenseCreate()` / `openSalesOrderCreate()` — Direct create-page navigation
- `openCommandPalette()` — Opens Ctrl+K command palette
- `showToast(message, type)` — Shows a notification toast

---

### `ui/admin/services/api.js` — API Client

Single-file API client that wraps all backend endpoints. Exposes `window.CrmApi` with methods for every module.

**Pattern:** Each method calls `get()`, `post()`, `put()`, or `del()` helpers that handle auth cookies, JSON parsing, and error handling.

**Example methods:** `CrmApi.leads.list(params)`, `CrmApi.getProjectOverview(id)`, `CrmApi.dashboard(params)`, `CrmApi.invoices.create(data)`, etc.

---

### `ui/admin/utils/` — Frontend Utilities

| File | Size | Key Exports | Description |
|------|------|-------------|-------------|
| `ui.js` | 242KB | `window.CrmUi` | Massive UI helper library — `formatMoney()`, `formatDate()`, `statusBadge()`, `escapeHtml()`, table builders, modal helpers, form builders, pagination, sorting, and 200+ utility functions |
| `validation.js` | 12KB | `window.CrmValidation` | Client-side form validation — email, phone, PAN, GST, required fields, and custom validators |
| `feature-flags.js` | 1.4KB | `window.CrmFeatures` | Feature flag system — `filterDashboardWidgets()`, `isDashboardWidgetEnabled()`, role-based feature visibility |
| `portal-url.js` | 2KB | Portal URL builder | Builds public-facing URLs for quotation/invoice portals |
| `workflow-dialog.js` | 5KB | `window.CrmWorkflow` | Reusable workflow confirmation dialogs (approve, reject, convert, etc.) |

---

### `ui/admin/pages/` — Page Modules

Each page directory contains one or more JS files. Every file registers itself on `window.CrmPages` with `{ id, title, description, render(container) }`.

| Page Directory | Files | Description |
|---------------|-------|-------------|
| `analytics-ai/` | `analytics-ai.js` (36KB) | AI dashboard with forecasting charts, behavior analysis, and next-best-action cards (standalone route, hidden from main sidebar) |
| `audit/` | `audit.js` (8KB) | Audit log viewer with filters, search, and CSV export |
| `clients/` | `clients.js` (243KB), `client-create.js` (42KB) | Client list/detail with 360° view, contacts, portal, documents (OpenNext CMS theme with flat 1px borders and zero shadows); client creation form |
| `customer-success/` | `customer-success.js` (24KB) | Customer health scores, CSAT dashboard, and account health details |
| `dashboard/` | `dashboard.js` (64KB) | Configurable dashboard with 15+ widgets, period filtering, and widget customization modal |
| `data-quality/` | `data-quality.js` (26KB) | Data quality scores, rule configuration, and deduplication |
| `expenses/` | `expenses.js` (88KB) | Expense list, create/edit forms, approval workflow, recurring expenses |
| `invoices/` | `invoices.js` (209KB), `invoice-template-create.js` (48KB) | Invoice list/detail, create/edit, templates studio workspace, recurring, credit notes |
| `leads/` | `leads.js` (62KB), `lead-detail.js` (151KB), `lead-create.js` (32KB) | Responsive leads listing (no DataTables dependency, no x-scrolling) with saved filters; detail view with events, follow-ups, qualification; creation form |
| `marketing/` | `marketing.js` (59KB) | Campaign list, editor, audience builder, analytics, re-engagement workflows |
| `opportunities/` | `opportunities.js` (29KB), `opportunity-create.js` (32KB) | Deal pipeline with stage board, probability forecasting, deal creation workspace, and conversion |
| `payments/` | `payments.js` (102KB) | Payment list, recording, allocation, refund workflow |
| `projects/` | `projects.js` (266KB), `project-create.js` (40KB), `project-edit.js` (40KB) | Projects listing (OpenNext theme) and 10-tab workspace with Add Task modal fixes, client-scoped Overview financials (Project Budget & Paid Invoices only; Expenses and Net Profit hidden), and creation/edit forms |
| `quotations/` | `quotations.js` (117KB), `quotation-create.js` (83KB) | Quotation list/detail, line item editor with GST, templates, portal |
| `reports/` | `reports.js` (32KB) | 9 report types with date filtering and CSV export |
| `sales-orders/` | `sales-orders.js` (104KB) | Sales order list/detail, shipment tracking, returns, dispatch/delivery |
| `samples/` | `samples.js` (34KB), `sample-create.js` (22KB) | Sample request list, dedicated sample create workspace, approval workflow, dispatch tracking, feedback |
| `security/` | `security.js` (21KB) | Tenant member management and permission matrix (shifted user designations to System Settings tab) |
| `settings/` | `settings.js` (76KB) | CRM settings — company profile, currency, GST, pipeline, email, and OpenNext Users & Designations tab |
| `tasks/` | `tasks.js` (114KB), `task-detail.js` (72KB), `task-drawer.js` (32KB), `task-edit.js` (28KB) | Task list, Kanban board, detail view with comments/subtasks/followers, inline drawer, edit form |
| `tickets/` | `tickets.js` (102KB) | Support ticket list/detail, conversation thread, canned responses, SLA tracking |
| `time-logs/` | `time-logs.js` (58KB) | Time log list, check-in timer, weekly timesheet, approval workflow |

---

### `ui/portal/` — Public Portal Pages

Standalone HTML pages served without authentication for external access.

| File | Description |
|------|-------------|
| `invoice.html` (16KB) | Public invoice payment portal — displays invoice details and Razorpay payment button. Accessed via `payToken` URL |
| `quotation.html` (20KB) | Public quotation portal — displays quotation details and accept/reject buttons. Accessed via portal token URL |

---

## test/ — Integration & Unit Tests

51 test files covering all modules. Tests use the project's test harness with mock request objects.

| Test File | Module Tested |
|-----------|--------------|
| `analytics-ai.test.js` | AI analytics service |
| `client-contracts-products.test.js` | Client-linked contracts and products |
| `client-documents.test.js` | Client document uploads |
| `client-import-export.test.js` | Client CSV import/export |
| `client-multiple-addresses.test.js` | Multi-address client records |
| `client-notes-timeline.test.js` | Client notes and timeline |
| `client-portal-access.test.js` | Client portal invitation and access |
| `client-role-scoping.test.js` | Role-based client data scoping |
| `client-tags-custom-fields.test.js` | Client tags and custom fields |
| `client-tasks.test.js` | Client-linked tasks |
| `client-time-logs.test.js` | Client-linked time logs |
| `client-unlinked-zero-records.test.js` | Unlinked client user zero-data behavior |
| `clients-category-status.test.js` | Client categories and statuses |
| `credit-notes.test.js` | Credit note lifecycle |
| `dashboard-extended-metrics.test.js` | Dashboard metric aggregation |
| `dashboard-widgets.test.js` | Dashboard widget configuration |
| `data-quality-rules.test.js` | Data quality scoring rules |
| `expenses-parity.test.js` | Expense module feature parity |
| `lead-ageing-followups.test.js` | Lead ageing and follow-up reminders |
| `lead-bulk-assign-stage.test.js` | Bulk lead assignment and stage change |
| `lead-bulk-import.test.js` | CSV lead import |
| `lead-export.test.js` | Lead CSV export |
| `lead-products-contracts.test.js` | Lead-linked products and contracts |
| `lead-saved-filters.test.js` | Saved filter presets |
| `lead-tags-customfields-sources-statuses.test.js` | Lead metadata management |
| `marketing-automation.test.js` | Marketing campaign execution |
| `payment-allocations.test.js` | Payment-to-invoice allocation |
| `payment-refunds.test.js` | Refund workflow |
| `project-archived-guard.test.js` | Archived project write protection |
| `project-budget-multiassign.test.js` | Project budget and multi-assignee |
| `project-categories-tags-customfields.test.js` | Project metadata management |
| `project-documents.test.js` | Project file management |
| `project-manager-tasks-access.test.js` | Project manager task access scoping |
| `project-templates.test.js` | Project template instantiation |
| `project-workspace.test.js` | Project workspace (overview, members, milestones) |
| `projects-create-fields.test.js` | Project creation field validation |
| `quotations-lead-client.test.js` | Quotations linked to leads and clients |
| `quotations-parity.test.js` | Quotation module feature parity |
| `quotations.test.js` | Quotation CRUD |
| `recurring-invoices.test.js` | Recurring invoice generation |
| `reports-finance-parity.test.js` | Finance report accuracy |
| `sales-order-page-parity.test.js` | Sales order page feature parity |
| `sales-orders-parity.test.js` | Sales order module feature parity |
| `task-archive.test.js` | Task archive/restore |
| `task-auto-reminders.test.js` | Automatic task reminders |
| `task-followers.test.js` | Task follower/watcher management |
| `task-recurring.test.js` | Recurring task generation |
| `task-templates.test.js` | Task template CRUD and instantiation |
| `tasks-lookup.test.js` | Task search and lookup |
| `tickets-parity.test.js` | Support ticket module feature parity |
| `time-logs.test.js` | Time log CRUD, approval, check-in/out |
