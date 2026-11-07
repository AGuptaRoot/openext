# OpenExt CRM Suite — Roles & Permissions Reference

> **Source of truth**: [`api/roles.js`](./api/roles.js) (permissions + pages) · [`manifest.json`](./manifest.json) · runtime gates in `ticket.service.js`, `ticket-access.util.js`, `app.js`  
> **Last updated:** 4 September 2026  
> This document describes what each role **can do** across every module, including record-level scoping rules that permissions alone do not express.

---

## Role Hierarchy Overview

| # | Role ID | Display Name | Base Level | Scope |
|---|---------|-------------|------------|-------|
| 1 | `crm-manager` | CRM Manager | 2 (Manager) | **Full access** — all modules, all actions |
| 2 | `sales-manager` | Sales Manager | 2 (Manager) | Sales pipeline, finance, projects (limited), marketing |
| 3 | `sales-representative` | Sales Representative | 3 (Staff) | Own/assigned sales records; quotations via `crm.quotes.write`; invoices/payments view-only |
| 4 | `project-manager` | Project Manager | 2 (Manager) | Projects, tasks, time, expenses, **project-scoped tickets** |
| 5 | `crm-employee` | Employee | 3 (Staff) | Own tasks, time logs, expenses, and linked project tickets |
| 6 | `finance-manager` | Finance Manager | 2 (Manager) | Invoices, payments, quotations, expenses, audit |
| 7 | `support-agent` | Support Agent | 3 (Staff) | Tickets, customer success (**cannot assign agents**) |
| 8 | `user-agent` | User Agent | 3 (Staff) | Tickets, customer success (same as support-agent) |
| 9 | `client` | Client / Customer Portal | 3 (Staff) | Own company records; create tickets; accept/reject quotes; view invoices |

> **Base Level**: `2` = Manager-tier (can manage others' records), `3` = Staff-tier (scoped to own records unless explicitly granted).  
> **Platform mapping**: OpenNext role `103` → `project-manager`. Super Admin / tenant admin inherit CRM Manager–level capability via admin checks.

---

## Critical Runtime Rules (not permission keys alone)

### Ticket agent assignment

| Who | Can Assign / Reassign Agent? | Assignee pool |
|-----|------------------------------|---------------|
| Super Admin / Admin | Yes | All assignable tenant users |
| CRM Manager | Yes | All assignable tenant users |
| Project Manager | Yes | **Only members of the ticket’s linked project team** (members + creator + project leads) |
| Support Agent / User Agent / Employee / Sales roles / Client | **No** | — |

- Unassigned tickets stay **Unassigned** until an allowed role assigns an agent.
- Client-created tickets **never** auto-assign the client as the agent.
- Project Manager must link a **managed project** when creating a ticket; list/detail/write are limited to tickets whose `projectId` is in their managed projects.

### Project / task record scope

- Project Managers and Employees see projects/tasks via employee project scope (`assignedTo`, `ProjectMember`, or creator) — not the full tenant catalogue unless they are CRM/admin.
- Clients see only records for their linked `clientId`; unlinked client emails get **zero records**.

---

## 1. CRM Manager (`crm-manager`)

**Summary**: Full administrative access to every module. This is the super-role for the CRM plugin.

### Modules & Capabilities

| Module | Actions |
|--------|---------|
| **Dashboard** | View all widgets, configure widgets, switch time periods |
| **Leads** | List, Create, Edit, Delete, Convert to Client, Qualify, Override Duplicates |
| **Clients** | List, Create, Edit, Delete, Override Duplicates |
| **Data Quality** | View data quality scores, Manage rules & weights |
| **Projects** | List, Create, Edit, Delete, Manage Members |
| **Tasks** | List, Create, Edit, Delete, Add Comments, Change Status, Assign to members |
| **Time Logs** | List, Create, Delete (any member's logs) |
| **Expenses** | List, Create, Delete, Submit, Approve, Reject |
| **Quotations** | List, Create, Edit, Delete, Send, Accept, Reject, Convert to Invoice, Approve Discounts |
| **Sales Orders** | List, Create, Edit, Delete, Dispatch, Confirm Delivery |
| **Invoices** | List, Create, Edit, Delete, Send, Cancel, Manage Templates, Recurring, Credit Notes, Archive, Write-Off |
| **Payments** | List, Create, Edit, Delete |
| **Sample Requests** | List, Create, Approve, Give Feedback |
| **Opportunities** | List, Create, Edit, Delete, Convert |
| **Support Tickets** | List, Create, Change Status, Resolve, Delete, **Assign / Reassign agents** |
| **Customer Success** | View Summary, View Health Scores, Manage CSAT |
| **Marketing** | List, Create, Edit, Delete, Execute Campaigns |
| **AI Intelligence** | View Dashboard, Forecasting, Behavior Analysis, Demand, Apply NBA |
| **Reports** | View, Export |
| **Audit History** | View full audit trail |
| **Settings** | Manage all CRM settings, currency, tax rates, prefixes, and tenant member designations (`#settings?tab=users`) |
| **User Management** | Manage CRM user designations and workspace memberships (via Settings → Users & Designations tab) |
| **AI Intelligence** | View Dashboard, Forecasting, Behavior Analysis, Demand, Apply NBA (standalone workspace route `#analytics-ai`) |

### Permissions
```
crm.dashboard.view, crm.leads.read, crm.leads.write, crm.leads.delete,
crm.leads.convert, crm.leads.duplicate.override, crm.clients.read,
crm.clients.write, crm.clients.delete, crm.clients.duplicate.override,
crm.dataQuality.read, crm.dataQuality.manage, crm.projects.read,
crm.projects.write, crm.projects.delete, crm.tasks.read, crm.tasks.write,
crm.tasks.delete, crm.time.read, crm.time.write, crm.time.delete,
crm.expenses.read, crm.expenses.write, crm.expenses.delete,
crm.expenses.approve, crm.finance.read, crm.finance.write,
crm.finance.delete, crm.contracts.read, crm.contracts.write,
crm.contracts.delete, crm.samples.read, crm.samples.write,
crm.samples.approve, crm.samples.feedback, crm.opportunities.read,
crm.opportunities.write, crm.opportunities.delete,
crm.quotes.approveDiscount, crm.orders.read, crm.orders.write,
crm.orders.delete, crm.tickets.read, crm.tickets.write,
crm.tickets.delete, crm.tickets.resolve, crm.customerSuccess.read,
crm.customerSuccess.manage, crm.marketing.read, crm.marketing.write,
crm.marketing.delete, crm.analytics.read, crm.ai.read, crm.ai.write,
crm.audit.read, crm.reports.read, crm.reports.export,
crm.settings.manage, crm.users.manage
```

---

## 2. Sales Manager (`sales-manager`)

**Summary**: Manages the entire sales pipeline — leads through invoices. Can approve expenses and discounts. Has limited project access (no delete) and read-only tickets.

### Modules & Capabilities

| Module | Actions |
|--------|---------|
| **Dashboard** | View all widgets |
| **Leads** | List, Create, Edit, Delete, Convert, Qualify, Override Duplicates |
| **Clients** | List, Create, Edit, Delete, Override Duplicates |
| **Data Quality** | View scores (no manage) |
| **Projects** | List, Create, Edit, Manage Members (no delete) |
| **Tasks** | List, Create, Edit, Add Comments, Change Status (no delete) |
| **Time Logs** | List, Create (no delete) |
| **Expenses** | List, Create, Submit, Approve, Reject |
| **Quotations** | List, Create, Edit, Delete, Send, Accept, Reject, Convert, Approve Discounts |
| **Sales Orders** | List, Create, Edit, Delete, Dispatch, Confirm Delivery |
| **Invoices** | List, Create, Send, Cancel (no edit, no delete) |
| **Payments** | List, Create, Edit, Delete |
| **Sample Requests** | List, Create, Approve, Give Feedback |
| **Opportunities** | List, Create, Edit, Delete, Convert |
| **Support Tickets** | List / read (permission key `crm.tickets.read`; **cannot assign agents**) |
| **Customer Success** | View Summary (read-only) |
| **Marketing** | List, Create, Edit (no delete, no execute) |
| **AI Intelligence** | View Analytics (standalone workspace route `#analytics-ai`) |
| **Reports** | View, Export |
| **Audit History** | View |

### Permissions
```
crm.dashboard.view, crm.leads.read, crm.leads.write, crm.leads.delete,
crm.leads.convert, crm.leads.duplicate.override, crm.clients.read,
crm.clients.write, crm.clients.delete, crm.clients.duplicate.override,
crm.dataQuality.read, crm.dataQuality.manage, crm.projects.read,
crm.projects.write, crm.tasks.read, crm.tasks.write, crm.time.read,
crm.time.write, crm.expenses.read, crm.expenses.write,
crm.expenses.approve, crm.finance.read, crm.finance.write,
crm.contracts.read, crm.contracts.write, crm.samples.read,
crm.samples.write, crm.opportunities.read, crm.opportunities.write,
crm.orders.read, crm.orders.write, crm.tickets.read,
crm.customerSuccess.read, crm.marketing.read, crm.marketing.write,
crm.analytics.read, crm.ai.read, crm.audit.read, crm.reports.read,
crm.reports.export
```

### Cannot Do
- Delete projects, tasks, time logs, invoices, contracts, or tickets
- Manage CRM settings or user designations
- Execute marketing campaigns
- Access security settings

---

## 3. Sales Representative (`sales-representative`)

**Summary**: Front-line sales staff with **own/assigned record scope**. Can work leads, create quotations and orders for assigned accounts, but cannot delete records, approve discounts/expenses, or mutate invoices/payments. Sidebar visibility alone does **not** grant full module access — every API also enforces the same rules.

### Record-level scope (Sales Rep only)

| Access mode | Meaning for this role |
|-------------|------------------------|
| **Own Records** | Created by the logged-in user |
| **Assigned Records** | `assignedTo` / `salesOwner` / project membership matches the user |
| **Team Records** | Only if a custom role explicitly grants broader permissions |
| **All Records** | Never — reserved for CRM Manager / Sales Manager / admin |

Applies to leads, clients (created or converted from owned leads), opportunities, samples, sales orders, quotations/invoices/payments linked to owned clients, tickets for owned clients, and member projects.

### Modules & Capabilities

| Module | Actions |
|--------|---------|
| **Dashboard** | View sales-relevant widgets for the logged-in user |
| **Leads** | Create; view/edit **own or assigned** only; follow-ups, notes, stages; no unrestricted delete / no other reps' leads |
| **Clients** | View/edit **assigned / owned** clients only (not every client in the org) |
| **Projects** | List/read only when Sales Rep is a project member or has explicit access |
| **Tasks** | View/update **assigned** tasks (per task permissions) |
| **Time Logs** | Create and manage **own** time logs only |
| **Expenses** | Create/view own expenses or expenses on assigned projects; **no approve** |
| **Quotations** | Create/edit **drafts** for assigned customers/opportunities; view sent/accepted; accepted quotes use **revision flow** (no direct edit) |
| **Sales Orders** | Create/view orders for own/assigned customers where permitted |
| **Invoices** | **View** invoices related to assigned clients only |
| **Payments** | **View** payment status only (no create/delete/change confirmed payments) |
| **Sample Requests** | Create and track for own opportunities/clients |
| **Opportunities** | Create/manage for own/assigned leads and clients; stages, products, revenue, follow-ups |
| **Support Tickets** | Create/view tickets related to assigned clients; updates per assignment |

### Permissions
```
crm.dashboard.view,
crm.leads.read, crm.leads.write, crm.leads.convert, crm.leads.export,
crm.clients.read, crm.clients.write,
crm.projects.read,
crm.tasks.read, crm.tasks.write,
crm.time.read, crm.time.write,
crm.expenses.read, crm.expenses.write,
crm.finance.read,
crm.quotes.write,
crm.contracts.read,
crm.samples.read, crm.samples.write, crm.samples.export,
crm.opportunities.read, crm.opportunities.write, crm.opportunities.export,
crm.orders.read, crm.orders.write,
crm.tickets.read, crm.tickets.write
```

> **Configurable:** Quotation create/edit uses `crm.quotes.write`. Invoice/payment mutations still require `crm.finance.write` (not granted to this role by default). Do not rely on hiding menus alone.

### Cannot Do
- Delete leads/clients or access other sales reps' records without team access
- Edit another employee's time logs
- Approve expenses or quotation discounts
- Create, edit, or delete invoices / confirmed payments (`crm.finance.write` / `crm.finance.delete` not granted)
- Convert quotation → invoice (requires `crm.finance.write`)
- Manage projects write, marketing, AI, audit, reports, or settings
- Override duplicate records

---

## 4. Project Manager (`project-manager`)

**Summary**: Owns project delivery — manages projects, tasks, team members, time tracking, and expenses. Can manage **support tickets only for projects they manage**, and can assign those tickets **only to that project’s team**. No access to sales pipeline or finance.

### Modules & Capabilities

| Module | Actions |
|--------|---------|
| **Dashboard** | View project-related widgets (incl. dependency / client-reply red alerts) |
| **Clients** | Read-only (view linked clients via projects) |
| **Projects** | List, Create, Edit, Delete, Manage Members, Archive/Restore (scoped to managed projects) |
| **Tasks** | List, Create, Edit, Delete, Add Comments, Change Status, Assign to members; full-page edit |
| **Time Logs** | List, Create, Delete (manage team's time entries) |
| **Expenses** | List, Create, Submit (no approve — must be approved by Finance or CRM Manager) |
| **Support Tickets** | List, Create, Change Status, Resolve, **Assign / Reassign to project team only** |
| **Reports** | View (no export) |

### What Project Manager Can Do Inside Each Module

#### Projects
- Create new projects with budget, deadline, category, tags, and custom fields
- Edit project details (name, description, status, budget, priority, dates)
- Delete projects (cascade soft-deletes tasks, milestones, members)
- Add/remove team members and set hourly rates
- Create/edit/complete milestones
- Upload and manage project files & documents
- View project overview analytics (budget, earnings, expenses, profit) and **Tasks Progress**
- Archive and restore projects

#### Tasks
- Create tasks and assign them to project members
- Set priority, status, due dates, estimated hours
- Link tasks to milestones and set task dependencies
- Add comments and activity notes
- Change task status (To Do → In Progress → Review → Completed)
- Edit tasks on dedicated full page (`#tasks/{id}/edit`)
- Delete tasks
- View task board (Kanban) and Gantt chart
- **Task Dependency Client-Reply Red Alert**: Receives alert banners on Dashboard and Project Overview when dependent tasks wait on completed prerequisites whose client status is still awaiting reply / not satisfied, with one-click client email reminder resend

#### Time Logs
- Log work hours against tasks and projects
- Mark entries as billable or non-billable
- Set hourly rates and billable amounts
- Delete incorrect time entries
- View team's time distribution

#### Expenses
- Create expense records linked to projects
- Attach receipts and supporting documents
- Submit expenses for approval
- View all project-related expenses
- **Cannot approve/reject** — needs Finance Manager or CRM Manager

#### Support Tickets
- See and manage tickets **only when `projectId` is one of their managed projects**
- Create tickets **only** for a managed project (project required)
- Change ticket status and priority; resolve tickets
- **Assign / Reassign** agents from the **linked project team only** (not all tenant users)
- **Cannot delete** tickets — needs CRM Manager
- **Cannot** see or assign tickets with no project link or outside managed projects

### Permissions
```
crm.dashboard.view, crm.clients.read, crm.projects.read,
crm.projects.write, crm.projects.delete, crm.tasks.read,
crm.tasks.write, crm.tasks.delete, crm.time.read, crm.time.write,
crm.time.delete, crm.expenses.read, crm.expenses.write,
crm.reports.read, crm.tickets.read, crm.tickets.write,
crm.tickets.resolve
```

### Cannot Do
- Access leads, opportunities, or sales pipeline
- Create/edit quotations, invoices, or sales orders
- Manage payments or financial records
- Approve or reject expenses
- Delete tickets
- Assign tickets to users outside the project team
- Access marketing, AI, audit, data quality, or settings
- Export reports
- Manage users

---

## 5. Employee (`crm-employee`)

**Summary**: Staff & project team member role. Can view assigned projects and linked project tickets, work on tasks, log time, and submit expenses. No deletion or administrative capabilities.

### Modules & Capabilities

| Module | Actions |
|--------|---------|
| **Dashboard** | View basic widgets |
| **Projects** | List only (view projects they're a member of) |
| **Tasks** | List, Add Comments, Change Status (own tasks only, no create/edit/delete) |
| **Time Logs** | List, Create (own time entries only) |
| **Expenses** | List, Create, Submit (own expenses only) |
| **Support Tickets** | List, Create, Add Messages (access project tickets for projects they are a team member of) |

### What Employee Can Do Inside Each Module

#### Projects
- View projects they are assigned to or are a team member of
- See project overview, milestones, and progress
- **Cannot** create, edit, or delete projects
- **Cannot** manage members

#### Support Tickets
- View support tickets linked to their assigned projects
- Create new support tickets linked to their assigned projects
- Post messages and conversation replies on their project tickets
- Update ticket status on accessible tickets
- **Cannot** assign/reassign agents (Super Admin / CRM Manager / Project Manager only)
- **Cannot** delete tickets or resolve tickets (resolution reserved for PM / CRM Manager / Support Agent)
#### Tasks
- View tasks assigned to them
- Update task status (e.g., "In Progress" → "Review")
- Add comments and notes on tasks
- View task dependency alerts on Dashboard and Project Overview when prerequisite completed tasks are awaiting client reply
- **Cannot** create, edit, or delete tasks
- **Cannot** assign tasks to others

#### Time Logs
- Create time log entries for their own work
- View their own logged hours
- **Cannot** delete time logs
- **Cannot** view other members' logs (unless project-scoped)

#### Expenses
- Create expense records for their own expenses
- Submit expenses for approval
- View their own expense records
- **Cannot** approve, reject, or delete expenses

### Permissions
```
crm.dashboard.view, crm.projects.read, crm.tasks.read, crm.tasks.write,
crm.time.read, crm.time.write, crm.expenses.read, crm.expenses.write,
crm.tickets.read, crm.tickets.write
```

### Cannot Do
- Access leads, clients, sales pipeline, or finance
- Create or delete projects, tasks, or time logs
- Approve expenses
- Delete tickets or resolve tickets
- Access marketing, AI, reports, audit, or settings

---

## 6. Finance Manager (`finance-manager`)

**Summary**: Full ownership of financial operations — quotations, invoices, payments, and expense approvals. Can view audit trail. No access to sales pipeline or project delivery.

### Modules & Capabilities

| Module | Actions |
|--------|---------|
| **Dashboard** | View finance-related widgets |
| **Clients** | List only (view for invoice reference) |
| **Quotations** | List, Create, Edit, Delete, Send, Accept, Reject, Convert to Invoice, Approve Discounts |
| **Sales Orders** | List, Create, Edit, Delete, Dispatch, Confirm Delivery |
| **Invoices** | List, Create, Send, Cancel (no edit/delete — data integrity) |
| **Payments** | List, Create, Edit, Delete |
| **Expenses** | List, Create, Submit, Approve, Reject |
| **Reports** | View, Export |
| **Audit History** | View full audit trail |

### What Finance Manager Can Do Inside Each Module

#### Quotations
- Create and edit quotations with line items, taxes, and discounts
- Send quotations to clients
- Accept or reject client quotations
- Convert accepted quotations to invoices
- Approve discount overrides on quotations
- Delete draft quotations

#### Sales Orders
- Create sales orders from quotations or manually
- Edit order details, line items, and delivery dates
- Dispatch orders and track delivery status
- Confirm delivery completion
- Delete cancelled orders

#### Invoices
- Create invoices manually or from quotations
- Send invoices to clients via email
- Cancel invoices
- **Cannot edit** or **delete** existing invoices (financial data integrity)

#### Payments
- Record incoming payments against invoices
- Edit payment details (amount, method, date)
- Delete incorrect payment records

#### Expenses
- Create expense records
- Submit expenses
- **Approve or Reject** submitted expenses from all staff
- View expense reports across the organization

### Permissions
```
crm.dashboard.view, crm.clients.read, crm.finance.read,
crm.finance.write, crm.finance.delete, crm.contracts.read,
crm.contracts.write, crm.contracts.delete, crm.expenses.read,
crm.expenses.write, crm.expenses.approve, crm.reports.read,
crm.reports.export, crm.audit.read
```

### Cannot Do
- Access leads, opportunities, or sales pipeline
- Manage projects, tasks, or time logs
- Access tickets, customer success, or marketing
- Manage AI, settings, or users
- Edit or delete invoices

---

## 7. Support Agent (`support-agent`)

**Summary**: Handles customer support tickets and monitors customer health scores. Can work tickets end-to-end **except agent assignment** (assignment is reserved for Super Admin, CRM Manager, and Project Manager). No access to any other CRM module.

### Modules & Capabilities

| Module | Actions |
|--------|---------|
| **Dashboard** | View support-related widgets |
| **Support Tickets** | List, Create, Change Status, Resolve, Delete (**no Assign Agent**) |
| **Customer Success** | View Summary, View Health Scores, Submit CSAT Surveys |

### What Support Agent Can Do Inside Each Module

#### Support Tickets
- View support tickets in the system
- Create new tickets on behalf of customers
- Change ticket status (Open → In Progress → Resolved → Closed)
- Set ticket priority and category
- Resolve tickets
- Delete tickets (e.g., spam or duplicates)
- Add internal notes and replies
- **Cannot assign or reassign** the ticket agent field

#### Customer Success
- View customer health score summaries
- View individual client health indicators
- Submit CSAT (Customer Satisfaction) surveys
- **Cannot** manage health score rules or thresholds

### Permissions
```
crm.dashboard.view, crm.tickets.read, crm.tickets.write,
crm.tickets.resolve, crm.tickets.delete, crm.customerSuccess.read
```

### Cannot Do
- Assign / reassign ticket agents
- Access leads, clients, projects, tasks, or finance
- Manage customer success rules (read-only)
- Access marketing, AI, reports, audit, or settings

---

## 8. User Agent (`user-agent`)

**Summary**: Identical to Support Agent. Handles tickets and monitors customer health. Intended for internal users who need support capabilities without other CRM access.

### Modules & Capabilities

| Module | Actions |
|--------|---------|
| **Dashboard** | View support-related widgets |
| **Support Tickets** | List, Create, Change Status, Resolve, Delete (**no Assign Agent**) |
| **Customer Success** | View Summary, View Health Scores, Submit CSAT Surveys |

### Permissions
```
crm.dashboard.view, crm.tickets.read, crm.tickets.write,
crm.tickets.resolve, crm.tickets.delete, crm.customerSuccess.read
```

> **Note**: This role has identical permissions to `support-agent`. It exists as a separate role for organizational clarity — use `support-agent` for dedicated support staff and `user-agent` for internal users who also handle support.

### Cannot Do
- Same restrictions as Support Agent (including **no agent assignment**)

---

## 9. Client / Customer Portal (`client`)

**Summary**: External client-facing portal. Access limited to their linked company: projects, tasks, invoices, payments, quotations response, and tickets. Can submit CSAT feedback. Cannot modify core CRM operational data.

### Modules & Capabilities

| Module | Actions |
|--------|---------|
| **Dashboard** | View client-scoped widgets only |
| **Projects** | List only (projects they are linked to) |
| **Tasks** | List, Add Comments, Update Client Status (two options: Satisfied / Not Satisfied) |
| **Sample Requests** | List (view delivered samples linked to their company), Submit Feedback & Reviews |
| **Quotations** | List, Accept, Reject (respond to quotations sent to them) |
| **Invoices** | List/View invoices; **Pay Online** with Razorpay on the invoice page when `balanceDue > 0` and status is open (`Sent` / `Viewed` / `Partially Paid` / `Overdue`); public pay-token portal |
| **Payments** | List only (view payment history and receipts) |
| **Support Tickets** | List, Create (create new tickets, view their own; **not** assigned as agent) |
| **Customer Success** | View Summary, Submit CSAT (provide satisfaction feedback) |

### What Client Can Do Inside Each Module

#### Dashboard
- View client-scoped widgets (projects, task delivery, invoices, tickets, health summary)
- View **Deliverable Review Required** red alert banner when dependent tasks are blocked awaiting client review; directly choose **`Satisfied`** or **`Not Satisfied`** from the banner to unblock work

#### Projects
- View projects they are linked to as a client
- See project overview, progress, milestones, and documents
- **Overview Tab Financial Scoping**: On the project Overview tab, clients see only **Project Budget** (`Allocated total budget`) and **Paid Invoices** (`Revenue & paid invoices`). Internal company financial metrics—**Expenses** and **Net Profit**—are completely hidden and omitted from the DOM for the client role.
- **Expenses Tab Shielding**: The **`🧾 Expenses`** tab button and content panel are completely hidden from client users to prevent unauthorized exposure of internal expense claims, direct costs, or team reimbursement receipts.
- On the Project Overview tab, when completed deliverables are awaiting client feedback, interact directly with **`Satisfied`** and **`Not Satisfied`** action buttons (the internal staff reminder email option is hidden for clients)
- **Cannot** create, edit, or delete anything

#### Tasks
- View tasks in their linked projects
- Add comments on tasks (provide feedback, ask questions)
- Change client satisfaction status for completed/delivered tasks, strictly limited to **two options**: **`Satisfied`** and **`Not Satisfied`** (available directly on the Task detail, Project Overview banner, and Dashboard red alert banner)
- **Cannot** create, delete, or modify core task fields (title, assignee, milestone, due date, operational status)

#### Sample Requests
- View sample requests linked to their client company
- **Sample Review Option**: On the client-side role portal, when a sample request is in **`Delivered`** status and **`Client Review is Pending`** (feedback rating not yet submitted), clients can directly submit their review via the **`⭐ Give Review`** button. Clients evaluate the product with a 1–5 star rating, provide product quality feedback/notes, and indicate whether they are interested in placing an order.
- Edit/view previously submitted sample reviews on completed sample deliveries.
- **Cannot** create new sample requests, approve/reject requests, or update shipping dispatch details (internal staff operations only).

#### Quotations
- View quotations sent to them
- Accept or reject quotations (portal / CRM)
- **Cannot** create, edit, or delete quotations

#### Invoices & Payments
- View invoices issued to their linked client company
- View recorded payment receipts and transaction history
- **Invoice Payment Option**: On the client-side role portal/app, clients can pay an invoice online with Razorpay when **`balanceDue > 0`** and the status is not **`Draft`**, **`Cancelled`**, **`Written Off`**, or **`Paid`**. That includes **`Sent`**, **`Viewed`**, **`Partially Paid`**, and **`Overdue`**. The **`💳 Pay with Razorpay`** button is shown on the invoice detail page for those cases (Rule 14).
- May also use the secure token-based public invoice payment link from email
- Cannot create, edit, cancel, write-off, or delete invoices (read + payment initiation only)

#### Support Tickets
- Create new support tickets (remain **Unassigned** until staff assigns an agent)
- View their own submitted tickets
- **Cannot** resolve, delete, change status as staff, or be assigned as the agent

#### Customer Success
- View their own health summary
- Submit CSAT survey responses

### Permissions
```
crm.dashboard.view, crm.projects.read, crm.tasks.read, crm.time.read,
crm.expenses.read, crm.finance.read, crm.contracts.read,
crm.samples.read, crm.samples.feedback,
crm.tickets.read, crm.tickets.write, crm.customerSuccess.read,
crm.customerSuccess.manage
```

### Cannot Do
- Create, edit, or delete any CRM records (except tickets)
- Access leads, opportunities, sales orders
- Access marketing, AI, reports, audit, or settings
- View other clients' data
- Act as a ticket support agent

---

## Permission Key Reference

| Permission | Description |
|------------|-------------|
| `crm.dashboard.view` | View the dashboard |
| `crm.leads.read` | View leads list and details |
| `crm.leads.write` | Create and edit leads |
| `crm.leads.delete` | Delete leads |
| `crm.leads.convert` | Convert leads to clients |
| `crm.leads.duplicate.override` | Override duplicate detection for leads |
| `crm.clients.read` | View clients list and details |
| `crm.clients.write` | Create and edit clients |
| `crm.clients.delete` | Delete clients |
| `crm.clients.duplicate.override` | Override duplicate detection for clients |
| `crm.dataQuality.read` | View data quality scores |
| `crm.dataQuality.manage` | Configure quality rules and weights |
| `crm.projects.read` | View projects |
| `crm.projects.write` | Create and edit projects |
| `crm.projects.delete` | Delete projects |
| `crm.tasks.read` | View tasks |
| `crm.tasks.write` | Create, edit tasks, change status, add comments |
| `crm.tasks.delete` | Delete tasks |
| `crm.time.read` | View time logs |
| `crm.time.write` | Create time log entries |
| `crm.time.delete` | Delete time log entries |
| `crm.expenses.read` | View expenses |
| `crm.expenses.write` | Create and submit expenses |
| `crm.expenses.delete` | Delete expenses |
| `crm.expenses.approve` | Approve or reject submitted expenses |
| `crm.finance.read` | View quotations, invoices, payments |
| `crm.finance.write` | Create and edit invoices, payments, and (also) quotations/templates |
| `crm.finance.delete` | Delete financial records |
| `crm.quotes.write` | Create / edit / send / revise quotations (drafts & revisions); does **not** allow invoice or payment mutations |
| `crm.contracts.read` | View contracts |
| `crm.contracts.write` | Create and edit contracts |
| `crm.contracts.delete` | Delete contracts |
| `crm.samples.read` | View sample requests |
| `crm.samples.write` | Create sample requests |
| `crm.samples.approve` | Approve sample requests |
| `crm.samples.feedback` | Provide feedback on samples |
| `crm.opportunities.read` | View opportunities |
| `crm.opportunities.write` | Create and edit opportunities |
| `crm.opportunities.delete` | Delete opportunities |
| `crm.quotes.approveDiscount` | Approve discount overrides on quotations |
| `crm.orders.read` | View sales orders |
| `crm.orders.write` | Create and edit sales orders |
| `crm.orders.delete` | Delete sales orders |
| `crm.tickets.read` | View support tickets |
| `crm.tickets.write` | Create tickets, edit fields, post messages (does **not** by itself allow agent assignment) |
| `crm.tickets.delete` | Delete tickets |
| `crm.tickets.resolve` | Resolve/close tickets |
| `crm.customerSuccess.read` | View customer health and CSAT |
| `crm.customerSuccess.manage` | Manage health score rules, submit CSAT |
| `crm.marketing.read` | View marketing campaigns |
| `crm.marketing.write` | Create and edit campaigns |
| `crm.marketing.delete` | Delete campaigns |
| `crm.analytics.read` | View analytics dashboards |
| `crm.ai.read` | View AI insights and forecasts |
| `crm.ai.write` | Apply AI recommendations (NBA) |
| `crm.audit.read` | View audit history / activity trail |
| `crm.reports.read` | View reports |
| `crm.reports.export` | Export reports to CSV/PDF |
| `crm.settings.manage` | Manage CRM plugin settings |
| `crm.users.manage` | Manage CRM user roles and assignments |

---

## Quick Comparison Matrix

| Module | CRM Manager | Sales Manager | Sales Rep | Project Manager | Employee | Finance Manager | Support Agent | User Agent | Client |
|--------|:-----------:|:------------:|:---------:|:---------------:|:--------:|:---------------:|:-------------:|:----------:|:------:|
| Dashboard | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Leads | CRUD+Convert | CRUD+Convert | CRU+Convert | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Clients | CRUD | CRUD | CRU | Read | ❌ | Read | ❌ | ❌ | ❌ |
| Data Quality | Manage | View | View | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Projects | CRUD+Members | CRU+Members | Read | CRUD+Members† | Read† | ❌ | ❌ | ❌ | Read† |
| Tasks | CRUD+All | CRU+Status | CR+Status | CRUD+All† | Status+Comments† | ❌ | ❌ | ❌ | Comments+CSAT† |
| Time Logs | CRD | CR | CR | CRD† | CR† | ❌ | ❌ | ❌ | Read |
| Expenses | CRUD+Approve | CRU+Approve | CRU+Submit | CRU+Submit | CRU+Submit | CRU+Approve | ❌ | ❌ | Read |
| Quotations | CRUD+All | CRUD+All | CRU+Send | ❌ | ❌ | CRUD+All | ❌ | ❌ | Accept/Reject |
| Sales Orders | CRUD+All | CRUD+All | CR | ❌ | ❌ | CRUD+All | ❌ | ❌ | ❌ |
| Invoices | CRUD+All | CR+Send+Cancel | Read | ❌ | ❌ | CR+Send+Cancel | ❌ | ❌ | Read (+ pay link) |
| Payments | CRUD | CRUD | Read | ❌ | ❌ | CRUD | ❌ | ❌ | Read |
| Samples | CRUD+Approve | CRUD+Approve | CR | ❌ | ❌ | ❌ | ❌ | ❌ | Read+Review† |
| Opportunities | CRUD+Convert | CRUD+Convert | CRU+Convert | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Tickets | CRUD+Resolve+**Assign** | Read* | CR | CR+Resolve+**Assign team†** | CR† | ❌ | CRUD+Resolve (**no Assign**) | CRUD+Resolve (**no Assign**) | CR (own) |
| Customer Success | Manage | Read | ❌ | ❌ | ❌ | ❌ | Read+CSAT | Read+CSAT | Read+CSAT |
| Marketing | CRUD+Execute | CRU | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| AI Intelligence | Full | Read | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Reports | View+Export | View+Export | ❌ | View | ❌ | View+Export | ❌ | ❌ | ❌ |
| Audit | View | View | ❌ | ❌ | ❌ | View | ❌ | ❌ | ❌ |
| Settings | ✅ (incl. Users & Designations) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

> **Legend**: C = Create, R = Read, U = Update/Edit, D = Delete  
> **†** = Record-scoped (managed / member / linked client projects only)  
> **\*** Sales Manager `api/roles.js` permissions include `crm.tickets.read` only; UI pages may expose more ticket features — API assignment still requires Super Admin / CRM Manager / Project Manager  
> **Assign** = ticket agent assign/reassign (runtime gate, not a separate permission key)  
> **Note on Navigation**: AI Intelligence (`#analytics-ai`) and standalone Tenant Security are streamlined from the primary sidebar; user designation assignment is centralized inside **Settings → Users & Designations (`#settings?tab=users`)**.

---

## Related Documentation

| File | Purpose |
|------|---------|
| [`api/roles.js`](./api/roles.js) | Canonical role permission arrays and page feature maps |
| [`manifest.json`](./manifest.json) | Plugin nav + role permission mirrors for OpenNext |
| [`PROJECT-IMPLEMENTATION-REPORT.md`](./PROJECT-IMPLEMENTATION-REPORT.md) | Full implementation history (incl. §11 Sep 2026 ticket/PM work) |
| [`tasks-remaining.md`](./tasks-remaining.md) | Module backlog and daily work logs |