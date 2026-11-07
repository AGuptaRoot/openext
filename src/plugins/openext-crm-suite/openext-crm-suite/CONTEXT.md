# Project Context: OpenExt CRM Suite for OpenNext CMS

> **Purpose**: This file provides comprehensive context for developers, pair programmers, and AI assistants (including Google Antigravity `agy` CLI/IDE) working on the OpenExt CRM Suite codebase across different machines and accounts.

---

## 1. Project Background

- **Product**: Open Next CRM (`openext-crm-suite`)
- **Host CMS**: OpenNext CMS
- **Repository Location**: `/plugins/openext-crm-suite/`
- **Plugin Entry Point**: `api/index.js`
- **Plugin Manifest**: `manifest.json`

OpenExt CRM Suite is an enterprise CRM plugin built specifically for the OpenNext CMS ecosystem. It integrates tightly with the CMS's authentication, tenant isolation, and administrative navigation while providing sales pipelines, client 360° management, project deliverables, ticketing, invoicing, quoting, and customer portal capabilities.

---

## 2. Design System & OpenNext CMS Alignment

The UI must strictly align with the OpenNext CMS dashboard theme:

### Typography System
- **Fonts**:
  - Display Font: `"Inter", system-ui, sans-serif`
  - Heading Font: `"Inter", system-ui, sans-serif`
  - Body Font: `"Inter", system-ui, sans-serif`
  - Mono Font: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`
- **Metrics**:
  - Base Font Size: `16px`
  - Line Height: `1.6`
  - Heading Line Height: `1.25`
  - Letter Spacing Body: `normal`
  - Letter Spacing Heading: `-0.01em`
- **Typography Scale (8 Tokens)**:
  - `display`: `28px`, `font-weight: 700` — Main page titles
  - `h1`: `24px`, `font-weight: 700` — Module and view titles
  - `h2`: `20px`, `font-weight: 600` — Section headers
  - `h3`: `18px`, `font-weight: 600` — Card and sub-panel titles
  - `body`: `16px`, `font-weight: 400` — Body descriptions and forms
  - `body Sm`: `14px`, `font-weight: 400` — Table cells and metadata
  - `caption`: `12px` (or `11px`), `font-weight: 600`, uppercase, tracking-wider — Labels, badges, category hints
  - `mono`: `13px`, `font-weight: 500` — Codes, IDs, invoice numbers, timestamps
- **CSS Variables** (in `ui/admin/style.css`):
  `--font-display`, `--font-heading`, `--font-body`, `--font-mono`, `--font-size-base`, `--line-height-base`.

### Surface & Border Design Principles
1. **Zero Box Shadows**:
   - `box-shadow: none !important;` across all cards, panels, modals, buttons, and inputs.
2. **Crisp 1px Flat Borders**:
   - `border: 1px solid #e2e8f0;` on default cards, inputs, buttons, and panels.
   - Hover borders: `#cbd5e1` or `#94a3b8`.
3. **Solid Black Active States**:
   - Active status tabs, active pagination buttons, active filter pills, and primary buttons use:
     `background: #000000 !important; color: #ffffff !important; border-color: #000000 !important; font-weight: 600 !important;`
4. **Slate Color Palette**:
   - Slate-900 (`#0f172a`): Headings, primary text
   - Slate-700 (`#334155`): Secondary buttons, labels
   - Slate-500 (`#64748b`): Captions, inactive tabs, hints
   - Slate-400 (`#94a3b8`): Placeholders, borders on hover
   - Slate-200 (`#e2e8f0`): Default borders, dividers
   - Slate-100 (`#f1f5f9`): Tab bar tracks, pill backgrounds
   - Slate-50 (`#f8fafc`): Subtle hover backgrounds, secondary filter strips
   - White (`#ffffff`): Cards, inputs, toolbar backgrounds

---

## 3. Universal Filtering System Architecture

All 17 listing modules in OpenNext CRM share the same responsive horizontal filtering standard:

### Core Rules:
1. **Always a Horizontal Flex Row**:
   Toolbars (`.leads-toolbar`, `.pj-filter-bar`, `.tkt-filter-bar`, `.so-filter-bar`, `.dq-toolbar`, `.audit-toolbar`, `.toolbar-card`, etc.) must render as horizontal rows:
   ```css
   display: flex !important;
   flex-direction: row !important;
   flex-wrap: wrap !important;
   align-items: flex-end !important;
   justify-content: flex-start !important;
   gap: 12px !important;
   width: 100% !important;
   box-sizing: border-box !important;
   ```
2. **Left-Aligned Field Labels**:
   Labels inside toolbars have uppercase caption titles directly above their input/select, aligned to the left:
   ```css
   display: inline-flex !important;
   flex-direction: column !important;
   align-items: flex-start !important;
   text-align: left !important;
   font-size: 11px !important;
   font-weight: 600 !important;
   text-transform: uppercase !important;
   letter-spacing: 0.04em !important;
   color: #64748b !important;
   ```
3. **Flexible Search Input**:
   The search field must use `flex: 1 1 200px; min-width: 180px;` so it expands horizontally across the remaining row width rather than bunching up.
4. **Grouped Action Buttons**:
   Reset and Refresh buttons must be placed in a `.leads-toolbar-actions` container (`display: flex; gap: 8px; align-items: flex-end; margin-left: auto;`) so they dock cleanly at the end of the row.
5. **No Double Borders**:
   When `.leads-toolbar` sits inside a `.panel` or card section, `.leads-toolbar` has `border: none; padding: 0; background: transparent;` so there is only one outer card border.

---

## 4. Role-Based Access Control (RBAC) & OpenNext CMS Integration

### Identity & Role Pre-Flight
The CRM verifies user identity via `await window.CrmApi.getMe()` on page initialization:
- **Non-Admin Users**: Strictly locked to their authenticated OpenNext CMS role. No role switcher is displayed.
- **Admin Users**: Can use the Role Preview Switcher (`#dash-role-select`, `#lead-role-select`) to test how the UI renders for other personas.

### Supported CRM Roles:
| Role Key | Title | Capabilities & Scoping |
| :--- | :--- | :--- |
| `crm-manager` | 👑 CRM Manager (Executive) | 360° overview across all 11 modules (Pipeline, Projects, Invoices, Expenses, Labor). |
| `sales-manager` | 📈 Sales Manager | Team pipeline, weighted forecast, stage progression, rep distribution. |
| `sales-representative` | 🎯 Sales Representative | My inbound leads, active deal pipeline, customer demo meetings, quotations. |
| `project-manager` | 📁 Project Lead | Deliverable milestones, client blockers, watched tasks, team billable hours. |
| `crm-employee` | 💻 Team Member (Delivery) | Daily task assignments, deadlines, time logs, team schedule. |
| `finance-manager` | 💳 Finance Lead | Receivables aging, invoices, expense approvals, payment tracking. |
| `support-agent` | 🛟 Support Agent | Urgent tickets, customer inquiries, SLA monitoring. |
| `client` | 👤 Client (Customer Portal) | Blocked deliverables awaiting client reply, watched deliverables, invoices, and meetings. |

#### Strict Client Portal Shielding:
- **Restricted (Zero Data Access / Hidden from UI & API)**:
  - ❌ Leads & Inbound Sales Funnel
  - ❌ Sales Pipeline & Revenue Forecast
  - ❌ Expenses & Approval Claims (including project-level Expenses tab and overview expense cards)
  - ❌ Company Profitability & Operating Margin (on Project Overview tab, Net Profit and Expenses cards are completely omitted; clients see only **Project Budget** and **Paid Invoices**)
  - ❌ Internal Team Audit Activity Stream
  - ❌ Internal Quick Actions & Employee Labor Rates
- **Allowed (Client-Centric)**:
  - ✅ Invoices & Balance Due
  - ✅ Blocked Tasks Awaiting Client Reply (with Action Buttons)
  - ✅ Watched Projects & Deliverables
  - ✅ Project Overview with **Project Budget** (Allocated total budget) and **Paid Invoices** (Revenue & paid invoices) only
  - ✅ Calendar & Scheduled Meetings
  - ✅ Support Tickets & SLA

---

## 5. Directory Structure & Key Files

```
openext-crm-suite/
├── api/                       # Backend Plugin Server
│   ├── index.js               # Plugin mount, tenant middleware, publicApiPaths
│   ├── roles.js               # 8 role definitions & permissions
│   ├── register-models.js     # Mongoose models registration
│   ├── controllers/           # HTTP controllers
│   ├── services/              # Business logic services
│   │   ├── dashboard.service.js # Role-based dashboard widgets & queries
│   │   ├── lead.service.js      # Leads & pipeline stages
│   │   ├── invoice.service.js   # Invoicing, recurring, credit notes
│   │   ├── quotation.service.js # Quotes, revisions, e-signatures
│   │   ├── project.service.js   # Projects, milestones, Gantt
│   │   ├── task.service.js      # Tasks, blockers, review workflows
│   │   └── time-log.service.js  # Timesheets, timer tracking
│   ├── models/                # Mongoose models
│   └── routes/                # Express router endpoints
├── ui/admin/                  # Admin SPA Frontend
│   ├── index.html             # Shell with Tailwind CDN & DataTables v2.1.8
│   ├── app.js                 # Frontend router & page mounting
│   ├── style.css              # Global design system, typography, filtering
│   ├── services/api.js        # REST API client
│   └── pages/                 # Modular page scripts
│       ├── dashboard/         # Role-based dashboard & customize modal
│       ├── leads/             # Responsive leads module (no DataTables / no x-scroll) & Kanban
│       ├── reports/           # Role-based analytics & report tabs
│       ├── clients/           # Client directory & 360 overview (OpenNext theme)
│       ├── projects/          # Projects listing & 10-tab workspace (role-scoped Overview financials)
│       ├── tasks/             # Task board & client approval workflows
│       ├── tickets/           # Ticket desk & SLA tracking
│       ├── sales-orders/      # Orders, pricing, delivery logistics
│       ├── invoices/          # Invoices, templates, credit notes
│       ├── quotations/        # Proposals & electronic sign-off portal
│       ├── expenses/          # Expense claims & approvals
│       ├── payments/          # Payment recording & allocations
│       └── time-logs/         # Timer tracking & weekly timesheets
├── test/                      # 263+ automated integration and unit tests
├── GEMINI.md                  # Auto-loaded rules & context for Antigravity (agy)
└── CONTEXT.md                 # This comprehensive reference document
```

---

## 6. Development & Quality Assurance Rules

1. **Running Automated Tests**:
   - Always run: `node --test`
   - Test suite status: **263 tests passing / 0 failures**.
2. **Syntax Verification**:
   - Validate JS files before committing or completing tasks: `node -c path/to/file.js`
3. **Preservation of Business Logic**:
   - Never modify backend API endpoints, database schemas, field names, or validation rules during UI design tasks.
   - Never alter frontend element IDs, form bindings, query parameter keys, or debounce timers.
4. **Communication**:
   - All conversation and documentation must be conducted in clear, concise English with clickable `file:///` links.
