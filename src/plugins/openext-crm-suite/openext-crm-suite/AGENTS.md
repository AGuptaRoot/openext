# Antigravity (AGY) Agent Instructions & Project Context

> This file is automatically loaded by Antigravity (`agy`) across all developer accounts.
> For the complete reference, please see [GEMINI.md](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/GEMINI.md) and [CONTEXT.md](file:///C:/Users/AdarshGupta/Documents/plugin-packages/OpenNext%20crm/openext-crm-suite/CONTEXT.md).

## Quick Instructions for AGY Agents

1. **Product & Context**:
   - Open Next CRM (`openext-crm-suite`), a plugin for OpenNext CMS.
   - Built with Node.js, Express, MongoDB/Mongoose, and a Vanilla ES6 SPA frontend.
2. **Design System & OpenNext CMS Alignment**:
   - Display/Heading/Body Font: `"Inter", system-ui, sans-serif`
   - Mono Font: `ui-monospace, "SF Mono", Menlo, Consolas, monospace`
   - 8 typography scale tokens (`display`: 28px, `h1`: 24px, `h2`: 20px, `h3`: 18px, `body`: 16px, `body Sm`: 14px, `caption`: 12px, `mono`: 13px).
   - 6 CSS variables: `--font-display`, `--font-heading`, `--font-body`, `--font-mono`, `--font-size-base`, `--line-height-base`.
   - Crisp borders (`border: 1px solid #e2e8f0;` or `#e9edf4;`).
   - **Dashboard Design System (Enterprise SaaS Blue & White Theme)**:
     - Reference standard: Clean enterprise SaaS (Coderthemes Paces style).
     - Color palette: Modern primary blue (`#2563eb`), white cards (`#ffffff`), soft slate borders (`#e9edf4`), light tinted backgrounds (`#f8fafc` / `#eff6ff`).
     - Rounded corners: `12px` to `16px` (`rounded-xl`, `rounded-2xl`).
     - Icon badges: 44x44px rounded badges with pastel category tints (`.dash-icon-badge .dash-icon-blue`, `emerald`, `purple`, `amber`, `rose`, `slate`).
     - Trend comparison chips: `.dash-trend-pill` (`trend-up`, `trend-neutral`, `trend-warn`, `trend-danger`).
     - Buttons: Primary `.dash-btn-primary` (`#2563eb`), Secondary `.dash-btn-secondary` (`#ffffff` with crisp 1px border).
     - Active pills & switches on dashboard: Modern blue (`#2563eb` active state).
     - Quick Action tiles: `.dash-action-tile` with `.dash-action-icon-box`.
3. **Filtering System & Listing Tables**:
   - Toolbars (`.leads-toolbar`, `.pj-filter-bar`, etc.) must always be horizontal flex rows:
     `display: flex; flex-direction: row; flex-wrap: wrap; align-items: flex-end; gap: 12px; width: 100%;`
   - Never set `.leads-toolbar` to `flex-direction: column`.
   - Labels on top, left-aligned (`display: inline-flex; flex-direction: column; align-items: flex-start; text-align: left;`).
   - Search inputs expand with `flex: 1 1 200px; min-width: 180px;`.
   - Reset & Refresh buttons grouped side-by-side (`margin-left: auto`).
   - Listing tables use native responsive layout without x-scrolling and without DataTables dependencies.
4. **Role-Based Security**:
   - Check OpenNext CMS role via `window.CrmApi.getMe()` and `window.CrmApp.isClientUser()`.
   - Non-admins are locked to their authenticated role.
   - Clients CANNOT see Leads, Sales Pipeline, Expenses & Approvals, or Internal Audit logs.
   - **Client Role Project Workspace Rule**: On the project detail page Overview tab, clients see ONLY **Project Budget** (Allocated total budget) and **Paid Invoices** (Revenue & paid invoices). **Expenses** and **Net Profit** cards are completely hidden. The **Expenses tab** is also hidden for client users.
5. **Opportunity ↔ Sales Order (1:1)**:
   - Relation key is `opportunityId` only (never match by Opportunity/Client name).
   - Won + no SO → Create Sales Order (`crm.orders.write`); Won + SO → Open Sales Order (`crm.orders.read`).
   - Duplicate create → HTTP 409 `SALES_ORDER_EXISTS` + message *A Sales Order already exists for this Opportunity.*
   - Sales Order detail shows **Related Opportunity** when `opportunityId` is set.
   - Full handoff for other AIs: `../md files/OPPORTUNITY_SALES_ORDER_RELATION_AI.md` (or `md files/OPPORTUNITY_SALES_ORDER_RELATION_AI.md` from Refactor root).
   - After UI changes: `npm run build` in OpenNextCRMRefactor, sync `dist/` → `ui/admin/`, then `python create_zips.py` (always creates and deploys the fresh plugin zip to the `/release` and `/releases` folders).
6. **Testing**:
   - Always verify tests with: `node --test` (263/263 passing).
   - Syntax validation: `node -c <filename>`.
   - Never change business logic or API contracts when performing UI work.
