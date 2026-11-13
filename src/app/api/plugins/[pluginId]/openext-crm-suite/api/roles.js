'use strict';

/**
 * OpenNext CMS Plugin Roles Definition for OpenExt CRM Suite.
 *
 * Defines available pages, feature capabilities per page, and plugin roles.
 */
module.exports = {
  pages: [
    { id: 'dashboard', label: 'Dashboard', features: ['view-stats'] },
    { id: 'leads', label: 'Leads', features: ['list', 'create', 'edit', 'delete', 'convert', 'qualify'] },
    { id: 'contacts', label: 'Contacts', features: ['list', 'create', 'edit', 'delete'] },
    { id: 'clients', label: 'Clients', features: ['list', 'create', 'edit', 'delete'] },
    { id: 'data-quality', label: 'Data Quality', features: ['view', 'manage'] },
    { id: 'projects', label: 'Projects', features: ['list', 'create', 'edit', 'delete', 'members'] },
    { id: 'tasks', label: 'Tasks', features: ['list', 'create', 'edit', 'delete', 'comments', 'status'] },
    { id: 'time-logs', label: 'Time Logs', features: ['list', 'create', 'delete'] },
    { id: 'expenses', label: 'Expenses', features: ['list', 'create', 'submit', 'approve', 'reject'] },
    { id: 'quotations', label: 'Quotations', features: ['list', 'create', 'edit', 'delete', 'send', 'accept', 'reject', 'convert', 'approve-discount'] },
    { id: 'sales-orders', label: 'Sales Orders', features: ['list', 'create', 'edit', 'delete', 'dispatch', 'confirm-delivery', 'cancel', 'return'] },
    { id: 'invoices', label: 'Invoices', features: ['list', 'create', 'edit', 'delete', 'send', 'cancel', 'templates', 'recurring', 'credit-notes', 'archive', 'write-off'] },
    { id: 'payments', label: 'Payments', features: ['list', 'create', 'edit', 'delete'] },
    { id: 'samples', label: 'Sample Requests', features: ['list', 'create', 'approve', 'feedback', 'request', 'cancel'] },
    { id: 'opportunities', label: 'Opportunities', features: ['list', 'create', 'edit', 'delete', 'convert'] },
    { id: 'tickets', label: 'Support Tickets', features: ['list', 'create', 'status', 'resolve', 'delete'] },
    { id: 'customer-success', label: 'Customer Success', features: ['view-summary', 'view-health', 'submit-csat'] },
    { id: 'marketing', label: 'Marketing Automation', features: ['list', 'create', 'edit', 'delete', 'execute'] },
    { id: 'analytics-ai', label: 'AI Intelligence', features: ['view-dashboard', 'view-forecasting', 'view-behavior', 'view-demand', 'apply-nba'] },
    { id: 'reports', label: 'Reports', features: ['view', 'export'] },
    { id: 'audit', label: 'Audit History', features: ['view'] },
    { id: 'settings', label: 'Settings', features: ['manage'] },
    { id: 'security', label: 'Tenant Security', features: ['manage'] },
    // CMS URL segment of workspace-extension pages (/runtime/openext-crm-suite/extension/<id>/<page>).
    // Not in the sidebar (GET /admin-nav hides it); the extension's own permissions decide each page.
    { id: 'extension', label: 'Extension Pages', features: ['view'] }
  ],
  roles: [
    {
      id: 'crm-manager',
      name: 'CRM Manager',
      baseRole: 2,
      permissions: [
        'crm.dashboard.view',
        'crm.leads.read',
        'crm.leads.write',
        'crm.leads.delete',
        'crm.leads.convert',
        'crm.leads.duplicate.override',
        'crm.contacts.read',
        'crm.contacts.write',
        'crm.contacts.delete',
        'crm.clients.read',
        'crm.clients.write',
        'crm.clients.delete',
        'crm.clients.duplicate.override',
        'crm.dataQuality.read',
        'crm.dataQuality.manage',
        'crm.projects.read',
        'crm.projects.write',
        'crm.projects.delete',
        'crm.tasks.read',
        'crm.tasks.write',
        'crm.tasks.delete',
        'crm.time.read',
        'crm.time.write',
        'crm.time.delete',
        'crm.expenses.read',
        'crm.expenses.write',
        'crm.expenses.delete',
        'crm.expenses.approve',
        'crm.finance.read',
        'crm.finance.write',
        'crm.finance.delete',
        'crm.contracts.read',
        'crm.contracts.write',
        'crm.contracts.delete',
        'crm.samples.read',
        'crm.samples.write',
        'crm.samples.approve',
        'crm.samples.feedback',
        'crm.opportunities.read',
        'crm.opportunities.write',
        'crm.opportunities.delete',
        'crm.quotes.approveDiscount',
        'crm.orders.read',
        'crm.orders.write',
        'crm.orders.delete',
        'crm.tickets.read',
        'crm.tickets.write',
        'crm.tickets.delete',
        'crm.tickets.resolve',
        'crm.customerSuccess.read',
        'crm.customerSuccess.manage',
        'crm.marketing.read',
        'crm.marketing.write',
        'crm.marketing.delete',
        'crm.analytics.read',
        'crm.ai.read',
        'crm.ai.write',
        'crm.audit.read',
        'crm.reports.read',
        'crm.reports.export',
        'crm.settings.manage',
        'crm.users.manage'
      ],
      pages: '*'
    },
    {
      id: 'sales-manager',
      name: 'Sales Manager',
      baseRole: 2,
      permissions: [
        'crm.dashboard.view',
        'crm.leads.read',
        'crm.leads.write',
        'crm.leads.delete',
        'crm.leads.convert',
        'crm.leads.duplicate.override',
        'crm.contacts.read',
        'crm.contacts.write',
        'crm.contacts.delete',
        'crm.clients.read',
        'crm.clients.write',
        'crm.clients.delete',
        'crm.clients.duplicate.override',
        'crm.dataQuality.read',
        'crm.dataQuality.manage',
        'crm.projects.read',
        'crm.projects.write',
        'crm.tasks.read',
        'crm.tasks.write',
        'crm.time.read',
        'crm.time.write',
        'crm.expenses.read',
        'crm.expenses.write',
        'crm.expenses.approve',
        'crm.finance.read',
        'crm.finance.write',
        'crm.contracts.read',
        'crm.contracts.write',
        'crm.samples.read',
        'crm.samples.write',
        'crm.samples.approve',
        'crm.samples.feedback',
        'crm.opportunities.read',
        'crm.opportunities.write',
        'crm.orders.read',
        'crm.orders.write',
        'crm.tickets.read',
        'crm.customerSuccess.read',
        'crm.marketing.read',
        'crm.marketing.write',
        'crm.analytics.read',
        'crm.ai.read',
        'crm.audit.read',
        'crm.reports.read',
        'crm.reports.export'
      ],
      pages: [
        'dashboard',
        { id: 'leads', features: ['list', 'create', 'edit', 'delete', 'convert', 'qualify'] },
        { id: 'contacts', features: ['list', 'create', 'edit', 'delete'] },
        { id: 'clients', features: ['list', 'create', 'edit', 'delete'] },
        { id: 'data-quality', features: ['view'] },
        { id: 'projects', features: ['list', 'create', 'edit', 'members'] },
        { id: 'tasks', features: ['list', 'create', 'edit', 'comments', 'status'] },
        { id: 'time-logs', features: ['list', 'create'] },
        { id: 'expenses', features: ['list', 'create', 'submit', 'approve', 'reject'] },
        { id: 'quotations', features: ['list', 'create', 'edit', 'delete', 'send', 'accept', 'reject', 'convert', 'approve-discount'] },
        { id: 'sales-orders', features: ['list', 'create', 'edit', 'delete', 'dispatch', 'confirm-delivery', 'cancel'] },
        { id: 'invoices', features: ['list', 'create', 'send', 'cancel'] },
        { id: 'payments', features: ['list', 'create', 'edit', 'delete'] },
        { id: 'samples', features: ['list', 'create', 'approve', 'feedback'] },
        { id: 'opportunities', features: ['list', 'create', 'edit', 'delete', 'convert'] },
        { id: 'reports', features: ['view', 'export'] },
        { id: 'tickets', features: ['list', 'create', 'status', 'resolve'] },
        // Workspace-extension pages (e.g. Travel → Travellers): the CMS opens them under this page id;
        // which extension pages a user sees is decided by the extension's own permissions.
        { id: 'extension', features: ['view'] }
      ]
    },
    {
      id: 'sales-representative',
      name: 'Sales Representative',
      baseRole: 3,
      permissions: [
        'crm.dashboard.view',
        'crm.leads.read',
        'crm.leads.write',
        'crm.leads.convert',
        'crm.leads.export',
        'crm.contacts.read',
        'crm.contacts.write',
        'crm.clients.read',
        'crm.clients.write',
        'crm.projects.read',
        'crm.tasks.read',
        'crm.tasks.write',
        'crm.time.read',
        'crm.time.write',
        'crm.expenses.read',
        'crm.expenses.write',
        'crm.finance.read',
        'crm.quotes.write',
        'crm.contracts.read',
        'crm.samples.read',
        'crm.samples.write',
        'crm.samples.export',
        'crm.opportunities.read',
        'crm.opportunities.write',
        'crm.opportunities.export',
        'crm.orders.read',
        'crm.orders.write',
        'crm.tickets.read',
        'crm.tickets.write'
      ],
      pages: [
        'dashboard',
        { id: 'leads', features: ['list', 'create', 'edit', 'convert', 'qualify'] },
        { id: 'contacts', features: ['list', 'create', 'edit'] },
        { id: 'opportunities', features: ['list', 'create', 'edit', 'convert'] },
        { id: 'samples', features: ['list', 'create'] },
        { id: 'clients', features: ['list', 'create', 'edit'] },
        { id: 'projects', features: ['list'] },
        { id: 'tasks', features: ['list', 'create', 'comments', 'status'] },
        { id: 'time-logs', features: ['list', 'create'] },
        { id: 'expenses', features: ['list', 'create', 'submit'] },
        { id: 'quotations', features: ['list', 'create', 'edit', 'send'] },
        { id: 'sales-orders', features: ['list', 'create'] },
        { id: 'invoices', features: ['list'] },
        { id: 'payments', features: ['list'] },
        { id: 'tickets', features: ['list', 'create'] },
        // Workspace-extension pages (e.g. Travel → Travellers): the CMS opens them under this page id;
        // which extension pages a user sees is decided by the extension's own permissions.
        { id: 'extension', features: ['view'] }
      ]
    },
    {
      id: 'project-manager',
      name: 'Project Manager',
      baseRole: 2,
      permissions: [
        'crm.dashboard.view',
        'crm.clients.read',
        'crm.projects.read',
        'crm.projects.write',
        'crm.projects.delete',
        'crm.tasks.read',
        'crm.tasks.write',
        'crm.tasks.delete',
        'crm.time.read',
        'crm.time.write',
        'crm.time.delete',
        'crm.expenses.read',
        'crm.expenses.write',
        'crm.reports.read',
        'crm.tickets.read',
        'crm.tickets.write',
        'crm.tickets.resolve'
      ],
      pages: [
        'dashboard',
        { id: 'projects', features: ['list', 'create', 'edit', 'delete', 'members'] },
        { id: 'tasks', features: ['list', 'create', 'edit', 'delete', 'comments', 'status'] },
        { id: 'time-logs', features: ['list', 'create', 'delete'] },
        { id: 'expenses', features: ['list', 'create', 'submit'] },
        { id: 'reports', features: ['view'] },
        { id: 'tickets', features: ['list', 'create', 'status', 'resolve'] },
        // Workspace-extension pages (e.g. Travel → Travellers): the CMS opens them under this page id;
        // which extension pages a user sees is decided by the extension's own permissions.
        { id: 'extension', features: ['view'] }
      ]
    },
    {
      id: 'crm-employee',
      name: 'Employee',
      baseRole: 3,
      permissions: [
        'crm.dashboard.view',
        'crm.projects.read',
        'crm.tasks.read',
        'crm.tasks.write',
        'crm.time.read',
        'crm.time.write',
        'crm.expenses.read',
        'crm.expenses.write',
        'crm.tickets.read',
        'crm.tickets.write'
      ],
      pages: [
        'dashboard',
        { id: 'projects', features: ['list'] },
        { id: 'tasks', features: ['list', 'comments', 'status'] },
        { id: 'time-logs', features: ['list', 'create'] },
        { id: 'expenses', features: ['list', 'create', 'submit'] },
        { id: 'tickets', features: ['list', 'create', 'status'] },
        // Workspace-extension pages (e.g. Travel → Travellers): the CMS opens them under this page id;
        // which extension pages a user sees is decided by the extension's own permissions.
        { id: 'extension', features: ['view'] }
      ]
    },
    {
      id: 'finance-manager',
      name: 'Finance Manager',
      baseRole: 2,
      permissions: [
        'crm.dashboard.view',
        'crm.clients.read',
        'crm.finance.read',
        'crm.finance.write',
        'crm.finance.delete',
        'crm.orders.read',
        'crm.orders.write',
        'crm.orders.delete',
        'crm.contracts.read',
        'crm.contracts.write',
        'crm.contracts.delete',
        'crm.expenses.read',
        'crm.expenses.write',
        'crm.expenses.approve',
        'crm.samples.read',
        'crm.samples.write',
        'crm.samples.feedback',
        'crm.reports.read',
        'crm.reports.export',
        'crm.audit.read'
      ],
      pages: [
        'dashboard',
        { id: 'clients', features: ['list'] },
        { id: 'quotations', features: ['list', 'create', 'edit', 'delete', 'send', 'accept', 'reject', 'convert', 'approve-discount'] },
        { id: 'sales-orders', features: ['list', 'create', 'edit', 'delete', 'dispatch', 'confirm-delivery', 'cancel'] },
        { id: 'samples', features: ['list', 'create', 'feedback'] },
        { id: 'invoices', features: ['list', 'create', 'send', 'cancel'] },
        { id: 'payments', features: ['list', 'create', 'edit', 'delete'] },
        { id: 'expenses', features: ['list', 'create', 'submit', 'approve', 'reject'] },
        { id: 'reports', features: ['view', 'export'] },
        { id: 'audit', features: ['view'] },
        // Workspace-extension pages (e.g. Travel → Travellers): the CMS opens them under this page id;
        // which extension pages a user sees is decided by the extension's own permissions.
        { id: 'extension', features: ['view'] }
      ]
    },
    {
      id: 'support-agent',
      name: 'Support Agent',
      baseRole: 3,
      permissions: [
        'crm.dashboard.view',
        'crm.tickets.read',
        'crm.tickets.write',
        'crm.tickets.resolve',
        'crm.tickets.delete',
        'crm.customerSuccess.read'
      ],
      pages: [
        'dashboard',
        { id: 'tickets', features: ['list', 'create', 'status', 'resolve', 'delete'] },
        { id: 'customer-success', features: ['view-summary', 'view-health', 'submit-csat'] },
        // Workspace-extension pages (e.g. Travel → Travellers): the CMS opens them under this page id;
        // which extension pages a user sees is decided by the extension's own permissions.
        { id: 'extension', features: ['view'] }
      ]
    },
    {
      id: 'client',
      name: 'Client / Customer Portal',
      baseRole: 3,
      permissions: [
        'crm.projects.read',
        'crm.tasks.read',
        'crm.time.read',
        'crm.expenses.read',
        'crm.finance.read',
        'crm.orders.read',
        // Read-only, and the server narrows it to their own account's deals —
        // needed so a portal user can pick the deal a sample is for.
        'crm.opportunities.read',
        'crm.contracts.read',
        'crm.samples.read',
        'crm.samples.feedback',
        // Requesting (and calling off) a sample against their own deal.
        'crm.samples.request',
        // Raising a return is the one order write a client is trusted with, and
        // the refund amount is still calculated server-side.
        'crm.orders.return',
        'crm.tickets.read',
        'crm.tickets.write',
        'crm.customerSuccess.read',
        'crm.customerSuccess.manage'
      ],
      pages: [
        // No Dashboard: the CRM dashboard is an internal sales view, so the
        // portal has no Dashboard page and cannot reach that route.
        { id: 'projects', features: ['list'] },
        { id: 'tasks', features: ['list', 'comments'] },
        { id: 'samples', features: ['list', 'feedback', 'request', 'cancel'] },
        { id: 'quotations', features: ['list', 'accept', 'reject'] },
        { id: 'sales-orders', features: ['list', 'cancel', 'return'] },
        { id: 'invoices', features: ['list'] },
        { id: 'payments', features: ['list'] },
        { id: 'customer-success', features: ['view-summary', 'submit-csat'] },
        { id: 'tickets', features: ['list', 'create'] }
      ]
    }
  ]
};
