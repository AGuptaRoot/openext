# OpenExt CRM Suite — Antigravity (AGY) Context & Rules

This file provides comprehensive context, architectural specifications, design system standards, role-based access rules, and developer guidelines for Google Antigravity (`agy` CLI / IDE / Agent) sessions across all accounts.

---

## 1. Product & Architecture Overview

- **Product Name**: Open Next CRM (`openext-crm-suite`)
- **Host CMS**: OpenNext CMS (runs as a modular plugin under `/plugins/openext-crm-suite/`)
- **Plugin Entry Point**: `api/index.js` (registers models, sets up tenant isolation, mounts routes, declares `publicApiPaths`)
- **Manifest**: `manifest.json` defines plugin metadata, permissions, admin pages, navigation items, hooks, and API routes.
- **Backend Tech Stack**: Node.js 18+, Express, MongoDB / Mongoose, native node test runner (`node --test`).
- **Frontend Tech Stack**: Vanilla ES6 modules, SPA router (`ui/admin/app.js`), API client (`ui/admin/services/api.js`), DataTables.net v2.1.8, Tailwind CSS utility layer (with `corePlugins: { preflight: false }`).

---

## 2. Design System & OpenNext CMS Alignment

All CRM interfaces must strictly align with the **OpenNext CMS** design system:

### Typography System
- **Display Font**: `"Inter", system-ui, -apple-system, sans-serif`
- **Heading Font**: `"Inter", system-ui, -apple-system, sans-serif`
- **Body Font**: `"Inter", system-ui, -apple-system, sans-serif`
- **Mono Font**: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`
- **Base Font Size**: `16px` | **Line Height**: `1.6` | **Heading Line Height**: `1.25`
- **CSS Variables (Defined in `ui/admin/style.css`)**:
  - `--font-display`: `"Inter", system-ui, sans-serif`
  - `--font-heading`: `"Inter", system-ui, sans-serif`
  - `--font-body`: `"Inter", system-ui, sans-serif`
  - `--font-mono`: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`
  - `--font-size-base`: `16px`
  - `--line-height-base`: `1.6`
- **8 Typography Scale Tokens**:
  - `display`: `28px`, `font-weight: 700` (Page titles)
  - `h1`: `24px`, `font-weight: 700` (Module titles)
  - `h2`: `20px`, `font-weight: 600` (Section titles)
  - `h3`: `18px`, `font-weight: 600` (Card titles)
  - `body`: `16px`, `font-weight: 400` (Descriptions, forms)
  - `body Sm`: `14px`, `font-weight: 400` (Table cells, meta)
  - `caption`: `12px` (or `11px`), `font-weight: 600`, uppercase, tracking-wider (Labels, badges)
  - `mono`: `13px`, `font-weight: 500` (IDs, invoice numbers, currency values)

### Surfaces, Borders & Shadows
- **Base Surfaces & Zero Drop Shadows**: Elements in standard administrative tables and toolbars use flat surfaces and zero shadows (`box-shadow: none !important;`).
- **Dashboard Surfaces (Enterprise SaaS Blue & White Theme)**:
  - Cards: Pure white (`#ffffff`), subtle 1px border (`#e9edf4`), rounded corners (`12px` to `16px`), soft elevation shadow (`0 1px 3px rgba(15, 23, 42, 0.04)`).
  - Hover effects: Soft lift (`translateY(-2px)`), gentle blue border tint (`#93c5fd`), and soft glow (`0 8px 24px -4px rgba(37, 99, 235, 0.08)`).
- **Crisp 1px Flat Borders**: All cards, panels, modals, dropdowns, inputs, and buttons use `border: 1px solid #e2e8f0;` or `#e9edf4;` (hover: `#cbd5e1` or `#93c5fd`).
- **Color Palette**:
  - Primary Accent: Rich modern blue (`#2563eb`, hover `#1d4ed8`)
  - Dark Slate: Slate-900 (`#0f172a`), Slate-800 (`#1e293b`)
  - Neutral Borders: Slate-200 (`#e2e8f0`), Slate-100/200 (`#e9edf4`)
  - Neutral Surfaces: White (`#ffffff`), Slate-50 (`#f8fafc`), Soft Blue Tint (`#eff6ff`)
  - Subdued / Secondary Text: Slate-500 (`#64748b`), Slate-400 (`#94a3b8`)
- **Dashboard UI Elements**:
  - **KPI Badges**: 44x44px rounded badges (`.dash-icon-badge`) with pastel tints (`dash-icon-blue`, `emerald`, `purple`, `amber`, `rose`, `slate`).
  - **Trend Chips**: `.dash-trend-pill` (`trend-up`, `trend-neutral`, `trend-warn`, `trend-danger`).
  - **Buttons**: Primary `.dash-btn-primary` (`#2563eb`), Secondary `.dash-btn-secondary` (`#ffffff` with 1px border).
  - **Active State Pills**: Solid modern blue (`background: #2563eb !important; color: #ffffff !important; border-color: #2563eb !important;`).
  - **Action Tiles**: `.dash-action-tile` with `.dash-action-icon-box` for quick 1-click actions.

---

## 3. Universal Filtering System (All Listing Modules)

Every listing module in OpenNext CRM must provide a consistent, responsive, horizontal filtering toolbar:

### Structural Rules for Toolbars:
1. **Always a Horizontal Flex Row**:
   ```css
   .leads-toolbar, .pj-filter-bar, .tkt-filter-bar, .so-filter-bar, .dq-toolbar, .audit-toolbar {
     display: flex !important;
     flex-direction: row !important;
     flex-wrap: wrap !important;
     align-items: flex-end !important;
     justify-content: flex-start !important;
     gap: 12px !important;
     width: 100% !important;
     box-sizing: border-box !important;
   }
   ```
   *Warning*: Never set `.leads-toolbar` to `flex-direction: column` on desktop.
2. **Left-Aligned Field Labels**:
   ```css
   .leads-toolbar > label {
     display: inline-flex !important;
     flex-direction: column !important;
     align-items: flex-start !important;
     justify-content: flex-end !important;
     gap: 4px !important;
     font-size: 11px !important;
     font-weight: 600 !important;
     text-transform: uppercase !important;
     letter-spacing: 0.04em !important;
     color: #64748b !important;
     text-align: left !important;
   }
   ```
3. **Flexible Search Input**:
   - The search input container must use `flex: 1 1 200px; min-width: 180px;` so it expands horizontally across the remaining row space.
4. **Form Controls Height & Radius**:
   - All filter dropdowns, date pickers, search inputs, and action buttons must have uniform height: `36px`, `border-radius: 8px`, `border: 1px solid #e2e8f0`.
5. **No Double Borders**:
   - When `.leads-toolbar` is inside a `.panel` or card section, `.leads-toolbar` must have `border: none !important; padding: 0 !important; background: transparent !important;`.
6. **Action Buttons**:
   - Reset and Refresh buttons should be grouped side-by-side (`display: flex; gap: 8px; align-items: flex-end; margin-left: auto;`).

---

## 4. Role-Based Access Control (RBAC) & OpenNext CMS Integration

The CRM enforces strict role-based views and security across all modules:

### OpenNext CMS Role Resolution:
- On initial page load, the frontend invokes `await window.CrmApi.getMe()` to retrieve the verified OpenNext CMS user identity and assigned roles.
- Non-administrative users are **strictly locked** to their authenticated role.
- Administrators (`isAdmin || permissions.includes('crm.users.manage')`) have access to a Role Preview switcher (`#dash-role-select`, `#lead-role-select`, etc.) to preview how pages render for specific roles.

### Supported CRM Roles:
1. `crm-manager` — Executive 360° overview across all modules.
2. `sales-manager` — Pipeline progression, rep quota, weighted forecast, deal stages.
3. `sales-representative` — Inbound prospect leads, personal deal pipeline, customer meetings.
4. `project-manager` — Client deliverable handoffs, milestones, task blockers, team billable hours.
5. `crm-employee` — Assigned tasks, deadlines, time logs, schedule.
6. `finance-manager` — Receivables aging, invoices, expense claims, billing readiness.
7. `support-agent` — Urgent tickets, customer inquiries, SLA monitoring.
8. `client` — External Client / Customer Portal.

### Strict Client Portal Security:
- **Clients CANNOT See (Completely Hidden & API Restricted)**:
  - ❌ Leads & Inbound Funnel
  - ❌ Sales Pipeline & Forecast
  - ❌ Expenses & Approval Claims (including project-level Expenses tab and overview expense cards)
  - ❌ Company Profitability & Operating Margin (on Project Overview tab, Net Profit and Expenses cards are completely omitted; clients see only **Project Budget** and **Paid Invoices**)
  - ❌ Internal Audit Activity Log
  - ❌ Internal Quick Actions & Employee Labor Rates
- **Clients CAN See (Customer Experience)**:
  - ✅ Invoices & Outstanding Balance Due
  - ✅ Tasks Blocked Awaiting Client Reply (with direct feedback buttons)
  - ✅ Watched Projects & Deliverables
  - ✅ Project Overview with **Project Budget** (Allocated total budget) and **Paid Invoices** (Revenue & paid invoices) only
  - ✅ Scheduled Meetings & Demos
  - ✅ Client Support Tickets

---

## 5. Directory Map & Key Modules

```
openext-crm-suite/
├── api/                       # Backend Plugin Server
│   ├── index.js               # Entry point, tenant middleware, permissions
│   ├── roles.js               # 8 role definitions & capabilities
│   ├── controllers/           # Route controller handlers
│   ├── services/              # Business logic (dashboard, leads, invoices, etc.)
│   ├── models/                # Mongoose schemas
│   └── validation/            # Joi/Zod input validation schemas
├── ui/admin/                  # Admin SPA Frontend
│   ├── index.html             # Shell with Tailwind config & DataTables CDN
│   ├── app.js                 # Frontend router & page loader
│   ├── style.css              # Global styles, variables, typography, filtering
│   ├── services/api.js        # Frontend REST API client
│   └── pages/                 # Modular page controllers
│       ├── dashboard/         # Role-based KPI cards & attention radar
│       ├── leads/             # Responsive leads listing (no DataTables / no x-scroll) & Kanban
│       ├── reports/           # Role-scoped reporting & BI charts
│       ├── clients/           # Client CRM accounts & 360 view (OpenNext theme)
│       ├── projects/          # Projects listing & 10-tab workspace (role-scoped Overview financials)
│       ├── tasks/             # Task board & client approval workflows
│       ├── tickets/           # Support tickets & SLA tracking
│       ├── sales-orders/      # Orders, pricing, delivery logistics
│       ├── invoices/          # Invoices, recurring invoices, credit notes
│       ├── quotations/        # Quotations & electronic sign-off portal
│       ├── expenses/          # Expense tracking & approval claims
│       ├── payments/          # Payment recording & refunds
│       └── time-logs/         # Timer tracking & weekly timesheets
└── test/                      # Comprehensive integration test suite (263+ tests)
```

---

## 6. Developer Guidelines & Testing Rules

1. **Test Command**:
   - Always run tests using: `node --test`
   - Do NOT run `npm test` directly since `package.json` scripts may vary by environment.
2. **Syntax Validation**:
   - Validate JS files before completing tasks: `node -c path/to/file.js`
3. **Preserve Logic & Integrations**:
   - When updating UI, styles, or layouts, NEVER change:
     - Element IDs or data attributes (`data-action`, `data-id`, `data-status`, etc.)
     - Input/Select `name` attributes or form field names
     - API endpoint contracts or query parameters
     - Existing debounce timers, event listeners, or table render callbacks
4. **Communicate in English**:
   - Maintain clear, concise markdown communication and always reference file links with `file:///` format.
