# Old CRM — Projects Module

**Source:** `openext-crm-suite`  
**API base:** `/api/plugins/openext-crm-suite`  
**Plugin page id:** `projects`  
**Nav label:** Projects & Milestones (Operations & Delivery)  
**Permission gate (nav):** `crm.projects.read`

This document describes the **original (vanilla JS) Projects module** only — list, create, edit, detail workspace, templates, API, and data model — as implemented in the old CRM suite.

---

## 1. Purpose

Projects is the **delivery workspace** for client engagements. It covers:

- Project metadata (client, category, tags, priority, status, budget, timeline, custom fields)
- Team membership (with hourly rates)
- Milestones → Tasks (list / board / Gantt)
- Time logs, expenses, files & documents, activity
- Progress tracking (`tasks` | `time` | `manual`)
- Lifecycle: active → archive / drop → restore / reactivate
- Reusable **project templates** (milestones + tasks with day offsets)

Lifecycle chain in the product:

```text
Client → Project → Milestone → Task → Time Log / Expense / Documents
```

---

## 2. File map

### UI

| Path | Lines (approx.) | Role |
|------|-----------------|------|
| `ui/admin/pages/projects/projects.js` | ~5059 | List, Kanban, Dropped, Templates modals, **full Detail workspace** |
| `ui/admin/pages/projects/project-create.js` | ~731 | Dedicated create page (`CrmProjectCreate`) |
| `ui/admin/pages/projects/project-edit.js` | ~731 | Dedicated edit page (`CrmProjectEdit`) |
| `ui/admin/app.js` | — | Hash routes: `#projects`, `#projects/create`, `#projects/:id`, `#projects/:id/edit` |
| `ui/admin/services/api.js` | — | `CrmApi` project wrappers |

### API

| Path | Role |
|------|------|
| `api/routes/projects.routes.js` | Route registration |
| `api/controllers/project.controller.js` | HTTP handlers |
| `api/services/project.service.js` | Business logic (~1291 lines) |
| `api/validation/project.schema.js` | Create / update / member validators |
| `api/utils/project-access.util.js` | Admin / employee / client record scoping |
| `api/models/Project.js` | Project schema |
| `api/models/ProjectMember.js` | Members |
| `api/models/ProjectAttachment.js` | Documents |
| `api/models/ProjectTemplate.js` | Templates |
| `api/controllers/project-template.controller.js` | Template HTTP |
| `api/services/project-template.service.js` | Template CRUD + instantiate |
| `api/services/project-attachment.service.js` | Document upload / link / delete |
| `api/migrations/003_projects_tasks.js` | Collections & indexes |

### Related (used from project detail)

| Area | Path / notes |
|------|----------------|
| Milestones | `api/routes/milestones.routes.js`, milestone controller/service/model |
| Tasks | `GET /projects/:id/tasks` → `TaskService.listByProject` |
| Time logs | Filtered by `projectId` via time-logs APIs |
| Expenses | Filtered by `projectId` via expenses APIs |
| Settings | `GET /settings/delivery` + `/projects/categories|tags|…` |

---

## 3. Routing (hash)

| Hash | Behavior |
|------|----------|
| `#projects` | List (or Kanban from session) |
| `#projects/create` | Create page |
| `#projects/:id` | Detail workspace (`renderDetail`) |
| `#projects/:id/edit` | Edit page |

**Click project → detail:** list/kanban “Open” / row action → `CrmApp.navigate('projects', { recordId })` → `#projects/<id>` → `projects.js` `render()` → `renderDetail(container, projectId)`.

Bootstrap API for detail: **`GET /projects/:id/overview`** (not only `GET /projects/:id`).

Entry registration: `window.CrmPages.projects` with `render()` order:

1. Create (if pending)
2. Edit (if pending)
3. Detail (if `pendingId` / `recordId`)
4. Dropped view
5. List (default)

---

## 4. Permissions & RBAC

### Permission keys

| Key | Used for |
|-----|----------|
| `crm.projects.read` | List, view, overview, activity, documents list, templates list, meta lists |
| `crm.projects.write` | Create/update, members, archive/restore/reactivate, documents write, templates create/update/instantiate |
| `crm.projects.delete` | Drop (`POST …/drop`, `DELETE /projects/:id`), delete templates |
| `crm.projects.export` | Export (also accepted via read/write with `requireAnyPermission`) |

Nested tab permissions:

- Tasks: `crm.tasks.read` / `crm.tasks.write` / `crm.tasks.delete`
- Time: `crm.time.write` / `crm.time.delete`
- Expenses: `crm.expenses.write` / `crm.expenses.approve` / `crm.expenses.delete`

### Typical role matrix

| Role | Projects |
|------|----------|
| Admin / tenant admin | read + write + delete |
| Project manager | read + write + delete |
| Sales manager | read + write |
| CRM employee | read only |
| Client portal | read only (scoped to own client) |

### Record-level scoping (`project-access.util.js`)

- **Admin:** all projects
- **Client user:** only projects where `clientId` matches linked client (else 404)
- **Employee:** only projects they **created**, are in **`assignedTo`**, or are a **ProjectMember** of

---

## 5. Data model

### Collection: `plugin_openext_crm_suite_projects`

| Field | Type / notes |
|-------|----------------|
| `tenantId` | string, required, indexed |
| `clientId` | string, required, indexed |
| `name` | string, max 160, required |
| `description` | string, max 4000 |
| `category` | string, max 100 |
| `label` | string, max 100 (legacy; often first tag) |
| `tags` | `[String]` |
| `priority` | string, default `Medium` |
| `customFields` | Mixed object |
| `currency` | string, max 10, default `INR` |
| `hoursEstimate` | number ≥ 0 |
| `progressCalculationMethod` | `tasks` \| `time` \| `manual` (default `tasks`) |
| `status` | string, required (from delivery settings) |
| `budget` | number ≥ 0 |
| `startDate` / `deadline` | Date \| null |
| `assignedTo` | `[String]` user ids |
| `isArchived`, `archivedAt`, `archivedBy` | archive state |
| `isDropped`, `droppedAt`, `droppedBy`, `droppedReason` | drop state |
| `previousStatus` | status before drop |
| `createdBy`, `updatedBy` | string |
| `isDeleted`, `deletedAt`, `deletedBy` | soft delete |
| timestamps | `createdAt`, `updatedAt` |

**List enrichment** typically adds: `clientName`, assignee names, `taskCount`, `completedTaskCount`, milestone counts, `progress` / `progressPercent`, normalized `tags`.

**Progress calculation:**

- `time` → `(hoursLogged / hoursEstimate) * 100` when estimate > 0
- `manual` → 100 if status `Completed`, else 0 (or stored manual %)
- `tasks` (default) → blend of task completion % and milestone completion %

### Project members — `plugin_openext_crm_suite_project_members`

| Field | Notes |
|-------|--------|
| `tenantId`, `projectId`, `userId` | unique compound |
| `role` | default `member` (create may set `lead` for assignees) |
| `hourlyRate` | number ≥ 0 |
| soft-delete fields | `isDeleted`, etc. |

### Milestones — `plugin_openext_crm_suite_milestones`

| Field | Notes |
|-------|--------|
| `projectId`, `title`, `summary` | |
| `cost`, `addCostToBudget` | |
| `status` | `Pending`, `In Progress`, `Completed`, `Cancelled` |
| `startDate`, `endDate` | |
| `isProjectDropped` | set when parent project is dropped |

### Attachments — `plugin_openext_crm_suite_project_attachments`

**Categories:** General, Design, Specification, Contract, Invoice, Deliverable, Source Code, Asset, Other.

**Fields:** `projectId`, optional `milestoneId` / `taskId`, `fileName`, `originalName`, `mimeType`, `fileSize`, `fileUrl`, `storageProvider` (`s3` \| `local` \| `external`), `storageKey`, `category`, `description`, `uploadedBy`, soft-delete.

### Templates — `plugin_openext_crm_suite_project_templates`

| Field | Notes |
|-------|--------|
| `name`, `description`, `category`, `priority`, `currency`, `hoursEstimate` | |
| `milestones[]` | `name`, `description`, `order`, `dueDayOffset` (days from project start) |
| `tasks[]` | `title`, `description`, `priority`, `hoursEstimate`, `milestoneIndex`, `dayOffset`, `dueDayOffset` |

### Migration `003_projects_tasks.js`

Creates/indexes collections for projects, project_members, tasks, task_comments.

---

## 6. List page (`renderList`)

### Header actions

- Record count
- View toggle **List | Kanban** (`sessionStorage` key: `crm-projects-view`)
- Export dropdown (CSV / JSON) → `GET /projects/export`
- **Dropped Projects** → `renderDroppedProjects`
- **Templates** (write) → templates modal
- **+ Create Project** (write) → `#projects/create`

### KPIs

| KPI | Logic |
|-----|--------|
| Total Projects | pagination total |
| In Progress | status in In Progress / Not Started / On Hold |
| Overdue | deadline past and status not Completed / Cancelled |
| Completed | status Completed |

### Filters

- Status tabs from delivery `project_statuses` (excludes Dropped)
- Search (debounced)
- Priority, Category, Tag
- Reset / Refresh

### List columns

Project · Client · Priority · Status · Tasks Progress · Budget · Owner · Tasks · Actions (Open / Edit / Delete-as-Drop)

Delete/drop is hidden when status is Completed.

### Kanban

- Columns = project statuses
- Cards: name, priority, client, category/tags, progress, budget, task count, deadline, owner
- Drag-drop (write): `PUT /projects/:id` with `{ status }`

### Load API

`GET /projects` with `status`, `priority`, `category`, `tag`, `search`, `page`, `limit` (kanban often uses higher limit).

---

## 7. Dropped projects (`renderDroppedProjects`)

- `GET /projects?isDropped=true` (or `view=dropped`)
- KPIs: count + budget of loaded items
- Actions: Open detail, **Reactivate** → `POST /projects/:id/reactivate`

---

## 8. Templates (modal from list)

- List: `GET /projects/templates`
- Create / edit: name, category, priority, hours, description, milestones builder (`dueDayOffset`), tasks builder (`milestoneIndex`, offsets, priority, hours)
- APIs: `POST/PUT/DELETE /projects/templates/:id`
- **Use template** → open create with `templateId` → `POST /projects/templates/:id/instantiate`

---

## 9. Create page (`project-create.js`)

Requires `crm.projects.write`. Hash: `#projects/create`.

Prefills: pending client id, pending template id.

Loads: categories, tags, priorities, custom fields, delivery settings, clients, assignable users, templates.

### Sections

1. **Client Information** — selected client preview  
2. **Delivery Guidelines** — from delivery settings  
3. **Start from Template** — selector; autofills name/category/priority/hours/description; preview milestone/task counts  
4. **Project Overview**
   - `name` * (max 160)
   - Client picker → `clientId` *
   - `category` (+ inline add category)
   - `priority`
   - multi-select tags (+ create tag)
5. **Timeline, Budget & Tracking**
   - `status` (delivery `project_statuses`)
   - `progressCalculationMethod`: tasks | time | manual
   - `currency`: INR, USD, EUR, GBP, AED, CAD, AUD, SGD
   - `budget`, `hoursEstimate`, `startDate`, `deadline`
6. **Custom Fields & Attributes** — defined fields + ad-hoc key/value → `customFields`
7. **Assign Team Members** — multi-select internal users only (client users filtered out); Select All / Clear / search
8. **Project Scope & Description** — `description` max 4000

### Submit

- With template → `POST /projects/templates/:id/instantiate`
- Else → `POST /projects`

On success → open project detail.

### Validation (API)

Required: `name`, `clientId`. Optional dates with order check. Max lengths as in schema.

---

## 10. Edit page (`project-edit.js`)

Hash: `#projects/:id/edit`.

- Same editable field shape as create
- No template selector
- Read-only meta strip (id / status / priority)
- Team + custom fields prefilled from project
- Submit → `PUT /projects/:id`
- Cancel / back → project detail

---

## 11. Detail workspace (`renderDetail`) — critical

Loads **`getProjectOverview(projectId)`** first.

### Header

- Status, archived badge, priority, client, budget, team, category, tags, hours estimate
- Actions (permission-gated): **Edit · Archive · Restore · Drop · Reactivate**
- Dropped / Archived banners
- When archived: UI blocks creating new members / milestones / tasks

### Tabs (10)

| Tab id | Label | Features | Primary APIs |
|--------|-------|----------|--------------|
| `tab-overview` | Overview | Budget / Earnings / Expenses / Profit; progress; task donut; hours-by-user; details; custom fields; **blocked dependency alert** (client Satisfied/Dissatisfied or Resend email) | overview payload; `updateTask`, `sendTaskReminderEmail` |
| `tab-members` | Members | List role/rate; add member + rate; inline rate edit; remove | `GET/POST /projects/:id/members`, `PUT/DELETE …/members/:userId` |
| `tab-milestones` | Milestones | CRUD modal (title, cost, status, addCostToBudget, dates, summary); status quick-change; jump to tasks filtered by milestone | `GET/POST /projects/:projectId/milestones`, `PUT/DELETE /milestones/:id` |
| `tab-tasks` | Tasks | Filters: status, milestone, client feedback, search; Add/Edit task modal; quick status; feedback; open task detail; archive/restore/delete; reminder badges | `GET /projects/:id/tasks`, task CRUD / status / reminder |
| `tab-board` | Tasks Board | Kanban by task status; drag-drop status; open task detail | same task APIs |
| `tab-gantt` | Gantt Chart | Days / Weeks / Months zoom; stretch slider; filters; collapsible list; **drag move / resize → save dates**; click opens task; + Add Task | `getProjectTasks` + milestones; `updateTask` dates |
| `tab-timelogs` | Time Logs | Project-scoped table; + Log Time (task, member, date, duration, billable, rate, notes); Delete | `GET/POST /time-logs`, `DELETE /time-logs/:id` |
| `tab-expenses` | Expenses | **Hidden for client portal**; filter by category; create/edit; Submit / Approve / Reject / Delete | expenses APIs by `projectId` |
| `tab-documents` | Files & Documents | Metrics by category; search/filter; Upload file / Link URL; open/delete; attach to milestone/task | `GET/POST /projects/:id/documents`, upload, delete |
| `tab-activity` | Activity | Project activity feed (search/filter) | `GET /projects/:id/activity` |

### In-project Add/Edit Task modal (rich)

Template prefill · milestone · **dependsOnTaskId** · status · priority · assignee (project members) · due date · notifyClientOnCompletion · recurring schedule · client feedback · watchers/followers · description · save-as-template · resend reminder · pending subtasks on create.

Client feedback statuses (normalized): Pending Review, Satisfied, Dissatisfied, Not Replied.

### Overview finance notes

- Earnings often derived from paid / partially paid invoices
- Expenses from Approved / Submitted project expenses
- Profit = earnings − expenses (hidden for client portal)
- Client portal: “Paid Invoices” instead of profit cards

Prefetch: milestones + tasks often loaded in background after overview for smooth tab switches.

---

## 12. Lifecycle actions

| Action | UI | API | Permission | Effect |
|--------|----|-----|------------|--------|
| **Drop** (UI “Delete”) | List / detail | `DELETE /projects/:id` or `POST /projects/:id/drop` | `crm.projects.delete` | `isDropped=true`, `status='Dropped'`, stores `previousStatus` / reason; related tasks/expenses/time logs/milestones get `isProjectDropped=true` |
| **Reactivate** | Dropped list / detail | `POST /projects/:id/reactivate` | write | Clears drop; restores previous status (or In Progress); clears child dropped flags |
| **Archive** | Detail | `POST /projects/:id/archive` | write | `isArchived=true` |
| **Restore** | Detail | `POST /projects/:id/restore` | write | Clears archive (and drop flags as implemented); restores status |

There is **no hard delete** in normal UI — Delete = drop/deactivate.

---

## 13. API route catalogue

### Projects

| Method | Path | Permission |
|--------|------|------------|
| GET | `/projects/export` | export \| read \| write |
| GET | `/projects/templates` | read |
| GET | `/projects/templates/:id` | read |
| POST | `/projects/templates` | write |
| PUT | `/projects/templates/:id` | write |
| DELETE | `/projects/templates/:id` | delete |
| POST | `/projects/templates/:id/instantiate` | write |
| GET | `/projects` | read |
| GET/POST | `/projects/categories` | read / write |
| GET/POST | `/projects/labels` | read / write |
| GET/POST | `/projects/tags` | read / write |
| GET/POST | `/projects/statuses` | read / write |
| GET/POST | `/projects/priorities` | read / write |
| GET/POST | `/projects/custom-fields` | read / write |
| POST | `/projects` | write |
| GET | `/projects/:id/overview` | read |
| GET | `/projects/:id/activity` | read |
| GET | `/projects/:id/tasks` | **`crm.tasks.read`** |
| GET | `/projects/:id/members` | read |
| POST | `/projects/:id/members` | write |
| PUT | `/projects/:id/members/:userId` | write |
| DELETE | `/projects/:id/members/:userId` | write |
| GET | `/projects/:projectId/milestones` | read |
| POST | `/projects/:projectId/milestones` | write |
| POST | `/projects/:id/archive` | write |
| POST | `/projects/:id/restore` | write |
| POST | `/projects/:id/drop` | delete |
| POST | `/projects/:id/reactivate` | write |
| GET | `/projects/:id/documents` | read |
| POST | `/projects/:id/documents/upload` | write |
| POST | `/projects/:id/documents` | write (link URL) |
| DELETE | `/projects/:id/documents/:documentId` | write |
| GET | `/projects/:id` | read |
| PUT | `/projects/:id` | write |
| DELETE | `/projects/:id` | delete (= drop) |

### List query params

`page`, `limit`, `sort`, `clientId`, `status`, `category`, `label`, `priority`, `tag`, `search`, `isDropped` / `view=dropped` / `dropped=true`, `isDropped=all` / `status=all`.

### Milestones (standalone)

| Method | Path | Permission |
|--------|------|------------|
| GET | `/milestones` | read |
| POST | `/milestones` | write |
| GET | `/milestones/:id` | read |
| PUT | `/milestones/:id` | write |
| DELETE | `/milestones/:id` | write |

### Related settings

| Method | Path | Notes |
|--------|------|-------|
| GET | `/settings/delivery` | Delivery bundle (statuses, priorities, categories, tags, custom fields, task statuses, reminder hours) |
| GET | `/clients/:id/projects` | Projects for a client |

---

## 14. Settings / meta defaults

From delivery settings (`GET /settings/delivery`):

| Key | Typical defaults |
|-----|------------------|
| `project_statuses` | Not Started, In Progress, On Hold, Completed, Cancelled |
| `project_priorities` | Low, Medium, High, Urgent |
| `project_categories` | Web Development, Mobile App, UI/UX Design, Marketing / SEO, Cloud / DevOps, Consulting, Maintenance, Internal |
| `project_tags` / labels | Client Project, Internal, High Priority, … |
| `project_custom_fields` | `[]` |
| `task_statuses` | To Do, In Progress, Review, Completed, On Hold |
| `task_priorities` | Low, Medium, High, Urgent |
| `task_client_reminder_hours` | 24 |

---

## 15. Related module integration

| Module | How it connects |
|--------|-----------------|
| **Tasks** | Nested under project; dependencies; board + Gantt; client feedback + reminder emails |
| **Milestones** | Nested CRUD; progress & cost; optional add cost to budget |
| **Time logs** | Filtered by `projectId`; overview hours charts |
| **Expenses** | Filtered by `projectId`; approve workflow; overview totals |
| **Documents** | ProjectAttachment vault (upload + URL) |
| **Invoices** | Overview earnings from paid invoices |
| **Audit** | Activity tab aggregates project + child audits |
| **Clients** | Required `clientId`; create can prefill client |
| **Reports** | Projects report endpoint |
| **Drop cascade** | Tasks / expenses / time logs / milestones flagged `isProjectDropped` |

---

## 16. Client portal differences

| Area | Client behavior |
|------|-----------------|
| List scope | Forced to own `clientId` |
| Create / Templates / Dropped admin | No write UI |
| Expenses tab | **Not rendered** |
| Overview finance | Hides Expenses & Net Profit; Earnings → **Paid Invoices** |
| Task feedback | Satisfied / Not Satisfied only |
| Blocked-dependency alert | Client CTAs on prerequisite task |
| Access | API 404 for other clients’ projects |

---

## 17. `CrmApi` methods (UI client)

`getProjects`, `getProject`, `getProjectOverview`, `getProjectActivity`,  
`getProjectTemplates`, `getProjectTemplate`, `createProjectTemplate`, `updateProjectTemplate`, `deleteProjectTemplate`, `createProjectFromTemplate`,  
`createProject`, `updateProject`, `deleteProject`, `dropProject`, `reactivateProject`, `archiveProject`, `restoreProject`,  
`getProjectDocuments`, `uploadProjectDocument`, `createProjectDocument`, `deleteProjectDocument`,  
`getProjectCategories` / `addProjectCategory`, labels / tags / statuses / priorities / custom-fields getters + adders,  
`getProjectTasks`, `getProjectMembers`, `addProjectMember`, `updateProjectMember`, `removeProjectMember`,  
`getProjectMilestones`, `createProjectMilestone`, `updateProjectMilestone`, `deleteProjectMilestone`,  
`downloadProjectsExport`, `getClientProjects`, `getDeliverySettings`.

---

## 18. Parity checklist (for React refactor)

Use this as the acceptance checklist when matching the React Projects module to old CRM:

- [ ] `#/projects` list with KPIs, filters, List/Kanban, export
- [ ] Dropped projects view + reactivate
- [ ] Templates CRUD + instantiate on create
- [ ] Create page: all 8 sections + template + custom fields + team
- [ ] Edit page mirrors create (no template)
- [ ] `#/projects/:id` opens detail via **overview** API
- [ ] All 10 detail tabs with nested CRUD
- [ ] Header lifecycle: Edit, Archive, Restore, Drop, Reactivate
- [ ] Task modal richness (deps, recurring, feedback, reminder)
- [ ] Board drag-drop + interactive Gantt date save
- [ ] Time log create with task/member; expense approve workflow
- [ ] Documents upload + link URL
- [ ] Activity feed
- [ ] Client portal variants (no expenses; feedback CTAs)
- [ ] Permission + record scoping parity

---

*Document generated from `openext-crm-suite` source (Projects UI + API). Source of truth for old CRM Projects behavior.*
