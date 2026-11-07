let pluginVersion = '1.20.0';
try {
  pluginVersion = require('../../manifest.json').version;
} catch (e) {
  // fallback
}

const { resolveTenantId, resolveUserId, isClientUser, resolveClientId, resolveClientIdAsync, isUnlinkedClientUserAsync } = require('../utils/tenant.util');
const {
  isMissedActivity,
  activityDisplayStatus
} = require('../utils/lead-event.constants');
const {
  isAdmin,
  hasPermission,
  isSalesAgentScoped,
  applySalesAgentLeadListScope,
  applySalesAgentClientListScope,
  applySalesAgentCreatorScope,
  applySalesAgentTicketScope
} = require('../utils/sales-access.util');
const {
  isEmployeeScoped,
  applyEmployeeProjectListScope,
  applyEmployeeTaskListScope
} = require('../utils/project-access.util');
const { deriveTenantRole, normalizeTenantRoleKey } = require('../utils/tenant-role.util');
const TimeLogService = require('./time-log.service');
const AuditService = require('./audit.service');
const PaymentService = require('./payment.service');
const ExpenseService = require('./expense.service');
const SettingService = require('./setting.service');

function baseFilter(req) {
  return { tenantId: resolveTenantId(req), isDeleted: false };
}

function getModel(req, name) {
  return req.cms?.models.get(name) || null;
}

/**
 * Calculates start and end Date objects based on the period string or explicit from/to dates.
 */
function calculateDateRange(period = 'month', fromInput = null, toInput = null) {
  const now = new Date();
  if (fromInput && toInput) {
    return {
      startDate: new Date(fromInput),
      endDate: new Date(toInput),
      period: 'custom'
    };
  }

  const p = String(period || 'month').toLowerCase().trim();
  let startDate = null;
  let endDate = new Date(now);

  switch (p) {
    case 'today': {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      break;
    }
    case 'week': {
      // Last 7 days
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    }
    case 'quarter': {
      // Last 90 days / current quarter
      const currentQuarter = Math.floor(now.getMonth() / 3);
      startDate = new Date(now.getFullYear(), currentQuarter * 3, 1, 0, 0, 0, 0);
      break;
    }
    case 'year': {
      startDate = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
      break;
    }
    case 'all': {
      startDate = null;
      endDate = null;
      break;
    }
    case 'month':
    default: {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      break;
    }
  }

  return { startDate, endDate, period: p };
}

/**
 * Master catalog of all supported dashboard widgets.
 */
const AVAILABLE_WIDGETS = Object.freeze([
  {
    id: 'sales_pipeline',
    title: 'Sales & Leads Overview',
    description: 'Key metrics for lead generation, pipeline volume, and win conversion.',
    category: 'Sales',
    requiredPermission: 'crm.leads.read',
    defaultEnabled: true
  },
  {
    id: 'opportunities_forecast',
    title: 'Deals & Revenue Forecast',
    description: 'Active opportunities pipeline, weighted deal forecast, and won revenue.',
    category: 'Sales',
    requiredPermission: 'crm.opportunities.read',
    defaultEnabled: true
  },
  {
    id: 'clients_accounts',
    title: 'Client Accounts & Directory',
    description: 'Client account totals, contacts overview, and relationship statistics.',
    category: 'Sales',
    requiredPermission: 'crm.clients.read',
    defaultEnabled: true
  },
  {
    id: 'project_delivery',
    title: 'Project Delivery & Milestones',
    description: 'Active projects, completion progress, and delivery health overview.',
    category: 'Projects',
    requiredPermission: 'crm.projects.read',
    defaultEnabled: true
  },
  {
    id: 'watched_tasks_highlight',
    title: '👁️ Watched Tasks & Followed Deliverables',
    description: 'Highlighted tasks that you are actively monitoring as a watcher or follower.',
    category: 'Projects',
    requiredPermission: 'crm.tasks.read',
    defaultEnabled: true
  },
  {
    id: 'overdue_tasks_watchlist',
    title: 'Overdue Tasks Watchlist',
    description: 'Direct alert list of top overdue tasks requiring urgent action.',
    category: 'Projects',
    requiredPermission: 'crm.tasks.read',
    defaultEnabled: true
  },
  {
    id: 'upcoming_milestones',
    title: 'Upcoming Project Milestones',
    description: 'Upcoming milestone deadlines across active client projects.',
    category: 'Projects',
    requiredPermission: 'crm.projects.read',
    defaultEnabled: true
  },
  {
    id: 'time_billing',
    title: 'Time Tracking & Billable Revenue',
    description: 'Logged hours, billable ratio, and accrued labor value for the period.',
    category: 'Projects',
    requiredPermission: 'crm.time.read',
    defaultEnabled: true
  },
  {
    id: 'finance_invoices',
    title: 'Financial Health & Invoices',
    description: 'Quotations status, open/paid invoices, and payments collected.',
    category: 'Finance',
    requiredPermission: 'crm.finance.read',
    defaultEnabled: true
  },
  {
    id: 'unpaid_invoices_watchlist',
    title: 'Unpaid & Overdue Invoices Watchlist',
    description: 'Top outstanding invoices with balances due and overdue aging alerts.',
    category: 'Finance',
    requiredPermission: 'crm.finance.read',
    defaultEnabled: true
  },
  {
    id: 'sales_orders',
    title: 'Sales Orders & Logistics',
    description: 'Order fulfillment status, dispatch tracking, and delivery progress.',
    category: 'Sales',
    requiredPermission: 'crm.orders.read',
    defaultEnabled: true
  },
  {
    id: 'support_tickets',
    title: 'Support Tickets & SLA Health',
    description: 'Open customer issues, urgent priority items, and SLA countdown alerts.',
    category: 'Support',
    requiredPermission: 'crm.tickets.read',
    defaultEnabled: true
  },
  {
    id: 'customer_health',
    title: 'Customer Success & CSAT Reviews',
    description: 'Account health scoring (0-100), churn risk alerts, and customer satisfaction.',
    category: 'Support',
    requiredPermission: 'crm.customerSuccess.read',
    defaultEnabled: true
  },
  {
    id: 'marketing_campaigns',
    title: 'Marketing Automation & Inflow',
    description: 'Active marketing campaigns, lead attribution, and acquisition ROI.',
    category: 'Marketing',
    requiredPermission: 'crm.marketing.read',
    defaultEnabled: false
  },
  {
    id: 'expenses_approvals',
    title: 'Expenses & Approvals',
    description: 'Pending operational reimbursement requests and approved expenditure.',
    category: 'Finance',
    requiredPermission: 'crm.expenses.read',
    defaultEnabled: true
  },
  {
    id: 'credit_notes',
    title: 'Credit Notes & Balances',
    description: 'Open credit notes, total credited amounts, and client adjustments.',
    category: 'Finance',
    requiredPermission: 'crm.finance.read',
    defaultEnabled: true
  },
  {
    id: 'calendar_schedule',
    title: 'Calendar & Scheduled Events',
    description: 'Today’s scheduled meetings, client calls, demos, and upcoming follow-ups.',
    category: 'General',
    requiredPermission: null,
    defaultEnabled: true
  },
  {
    id: 'quick_actions',
    title: 'Quick Actions Panel',
    description: 'Fast one-click shortcuts tailored to create new records by role.',
    category: 'General',
    requiredPermission: null,
    defaultEnabled: true
  },
  {
    id: 'recent_activity',
    title: 'Recent Activity Stream',
    description: 'Live real-time audit log of team actions and record updates.',
    category: 'General',
    requiredPermission: 'crm.audit.read',
    defaultEnabled: true
  }
]);

/**
 * Role-tailored default widget layouts.
 */
const ROLE_DEFAULT_WIDGETS = Object.freeze({
  'crm-manager': [
    'sales_pipeline',
    'opportunities_forecast',
    'clients_accounts',
    'project_delivery',
    'watched_tasks_highlight',
    'overdue_tasks_watchlist',
    'upcoming_milestones',
    'time_billing',
    'finance_invoices',
    'credit_notes',
    'unpaid_invoices_watchlist',
    'sales_orders',
    'calendar_schedule',
    'support_tickets',
    'customer_health',
    'expenses_approvals',
    'quick_actions',
    'recent_activity'
  ],
  'sales-manager': [
    'sales_pipeline',
    'opportunities_forecast',
    'clients_accounts',
    'finance_invoices',
    'sales_orders',
    'calendar_schedule',
    'customer_health',
    'quick_actions',
    'recent_activity'
  ],
  'sales-representative': [
    'sales_pipeline',
    'opportunities_forecast',
    'clients_accounts',
    'finance_invoices',
    'calendar_schedule',
    'sales_orders',
    'quick_actions',
    'recent_activity'
  ],
  'project-manager': [
    'project_delivery',
    'watched_tasks_highlight',
    'overdue_tasks_watchlist',
    'upcoming_milestones',
    'time_billing',
    'clients_accounts',
    'calendar_schedule',
    'quick_actions',
    'recent_activity'
  ],
  'crm-employee': [
    'project_delivery',
    'watched_tasks_highlight',
    'overdue_tasks_watchlist',
    'time_billing',
    'calendar_schedule',
    'quick_actions',
    'recent_activity'
  ],
  'finance-manager': [
    'finance_invoices',
    'credit_notes',
    'unpaid_invoices_watchlist',
    'expenses_approvals',
    'sales_orders',
    'quick_actions',
    'recent_activity'
  ],
  'data-analyst': [
    'sales_pipeline',
    'opportunities_forecast',
    'marketing_campaigns',
    'customer_health',
    'finance_invoices',
    'credit_notes',
    'quick_actions',
    'recent_activity'
  ],
  'support-agent': [
    'support_tickets',
    'customer_health',
    'calendar_schedule',
    'quick_actions',
    'recent_activity'
  ],
  'client': [
    'project_delivery',
    'watched_tasks_highlight',
    'calendar_schedule',
    'support_tickets',
    'unpaid_invoices_watchlist'
  ]
});

/**
 * Returns default enabled widget list for a given role key.
 */
function getDefaultWidgetsForRole(roleKey) {
  const norm = normalizeTenantRoleKey(roleKey);
  if (ROLE_DEFAULT_WIDGETS[norm]) {
    return [...ROLE_DEFAULT_WIDGETS[norm]];
  }
  return [...ROLE_DEFAULT_WIDGETS['crm-manager']];
}

/**
 * Resolves current user's effective role key.
 * Only administrative users are allowed to preview arbitrary roles via ?role= query.
 * For clients and standard employees, the authenticated OpenNext CMS role is strictly enforced.
 */
function resolveCurrentRoleKey(req) {
  if (isClientUser(req)) {
    return 'client';
  }
  const canPreview = isAdmin(req) || hasPermission(req, 'crm.users.manage');
  if (canPreview && req?.query?.role) {
    return normalizeTenantRoleKey(req.query.role);
  }
  const rawRole = req?.user?.role !== undefined ? req.user.role : req?.tenantMembership?.role;
  return deriveTenantRole(rawRole);
}

/**
 * Retrieves the effective widget configuration for the current user/role.
 */
async function getWidgetConfig(req) {
  const roleKey = resolveCurrentRoleKey(req);
  const userId = resolveUserId(req);
  const defaultList = getDefaultWidgetsForRole(roleKey);

  // Check if customized preferences exist in tenant settings
  try {
    const userSettingKey = `dashboard_widgets_user_${userId}`;
    const roleSettingKey = `dashboard_widgets_role_${roleKey}`;

    const settings = await SettingService.getAll(req).catch(() => ({}));
    let customWidgets = null;

    if (settings[userSettingKey] && Array.isArray(settings[userSettingKey])) {
      customWidgets = settings[userSettingKey];
    } else if (settings[roleSettingKey] && Array.isArray(settings[roleSettingKey])) {
      customWidgets = settings[roleSettingKey];
    }

    const activeList = customWidgets || defaultList;

    // Filter by actual permissions granted to user
    const permittedWidgets = AVAILABLE_WIDGETS.filter((w) => {
      if (!w.requiredPermission) return true;
      return hasPermission(req, w.requiredPermission);
    });

    const permittedIds = new Set(permittedWidgets.map((w) => w.id));
    const enabledWidgets = activeList.filter((id) => permittedIds.has(id));

    return {
      role: roleKey,
      enabledWidgets,
      availableWidgets: permittedWidgets,
      defaultWidgets: defaultList
    };
  } catch {
    return {
      role: roleKey,
      enabledWidgets: defaultList,
      availableWidgets: AVAILABLE_WIDGETS,
      defaultWidgets: defaultList
    };
  }
}

/**
 * Saves customized dashboard widget configuration.
 */
async function saveWidgetConfig(req, config) {
  const { enabledWidgets, scope = 'user' } = config || {};
  const userId = resolveUserId(req);
  const roleKey = resolveCurrentRoleKey(req);

  if (!Array.isArray(enabledWidgets)) {
    throw new Error('enabledWidgets must be an array of widget IDs');
  }

  const settingKey = scope === 'role'
    ? `dashboard_widgets_role_${roleKey}`
    : `dashboard_widgets_user_${userId}`;

  await SettingService.updateMany(req, { [settingKey]: enabledWidgets });

  return {
    success: true,
    settingKey,
    enabledWidgets
  };
}

/**
 * Master dashboard summary aggregator supporting period filters and rich widget collections.
 */
async function getSummary(req) {
  const base = baseFilter(req);
  const { period = 'month', from = null, to = null } = req.query || {};
  const { startDate, endDate, period: activePeriod } = calculateDateRange(period, from, to);
  const roleKey = resolveCurrentRoleKey(req);
  const isClientRole = roleKey === 'client';

  const canFinance = hasPermission(req, 'crm.finance.read');
  const canOrders = !isClientRole && hasPermission(req, 'crm.orders.read');
  const canAudit = !isClientRole && hasPermission(req, 'crm.audit.read');
  const canProjects = hasPermission(req, 'crm.projects.read');
  const canTasks = hasPermission(req, 'crm.tasks.read');
  const canTime = !isClientRole && hasPermission(req, 'crm.time.read');
  const canExpenses = !isClientRole && hasPermission(req, 'crm.expenses.read');
  const canExpensesApprove = !isClientRole && hasPermission(req, 'crm.expenses.approve');
  const canOpps = !isClientRole && hasPermission(req, 'crm.opportunities.read');
  const canTickets = hasPermission(req, 'crm.tickets.read');
  const canSuccess = hasPermission(req, 'crm.customerSuccess.read');
  const canMarketing = !isClientRole && hasPermission(req, 'crm.marketing.read');

  let totalLeads = 0;
  let newLeads = 0;
  let wonLeads = 0;
  let totalClients = 0;
  let totalSalesOrders = 0;
  let approvedSalesOrders = 0;
  let totalProjects = 0;
  let activeProjects = 0;
  let openTasks = 0;
  let overdueTasks = 0;
  let loggedHoursThisMonth = 0;
  let billableHoursThisMonth = 0;
  let billableAmountThisMonth = 0;
  let draftQuotations = 0;
  let sentQuotations = 0;
  let acceptedQuotations = 0;
  let unpaidInvoices = 0;
  let overdueInvoices = 0;
  let paidInvoices = 0;
  let totalPaymentsThisMonth = 0;
  let pendingExpenseApprovals = 0;
  let pendingPortalApprovals = 0;
  let approvedExpensesThisMonth = 0;
  let defaultCurrency = 'INR';
  let recentAudit = [];

  // Rich widget collections
  let overdueTasksList = [];
  let watchedTasksList = [];
  let blockedAwaitingClientTasks = [];
  let watchedOpenTasks = 0;
  let watchedOverdueTasks = 0;
  let upcomingMilestones = [];
  let unpaidInvoicesList = [];
  let urgentTicketsList = [];
  let opportunitiesSummary = null;
  let customerHealthSummary = null;
  let marketingSummary = null;

  // Contracts & Legal Agreements
  let totalContracts = 0;
  let activeContracts = 0;
  let activeContractsValue = 0;
  let expiringContracts30d = 0;
  let awaitingSignature = 0;
  let expiringContractsList = [];

  // Product & Service Catalogue
  let totalProducts = 0;
  let activeProducts = 0;
  let lowStockProducts = 0;
  let topProductCategories = [];
  let recentProductsList = [];

  // Credit Notes & Balances
  let totalCreditNotes = 0;
  let openCreditNotes = 0;
  let totalCreditedAmount = 0;
  let remainingCreditBalance = 0;
  let openCreditNotesList = [];

  // Calendar & Scheduled Client Events
  let scheduledEventsToday = 0;
  let scheduledEventsThisWeek = 0;
  let scheduledEventsThisMonth = 0;
  let overdueEventsCount = 0;
  let upcomingCalendarEvents = [];
  let allCalendarEvents = [];

  try {
    const settings = await SettingService.getAll(req).catch(() => ({}));
    defaultCurrency = settings.default_currency || 'INR';

    const stages = await SettingService.getPipelineStages(req).catch(() => ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']);
    const wonStage = SettingService.resolveWonStage(stages);
    const newStage = stages[0] || 'New';

    const clientUser = isClientUser(req);
    let userClientId = null;
    if (clientUser) {
      userClientId = (await resolveClientIdAsync(req)) || resolveClientId(req);
      if (!userClientId) {
        const widgetConfig = await getWidgetConfig(req).catch(() => ({
          role: 'client',
          enabledWidgets: getDefaultWidgetsForRole('client'),
          availableWidgets: AVAILABLE_WIDGETS
        }));
        return {
          period: activePeriod,
          dateRange: { startDate, endDate },
          unlinkedClient: true,
          message: 'Client email ID not found in CRM records',
          widgetConfig,
          sales: {
            totalLeads: 0,
            newLeads: 0,
            wonLeads: 0,
            totalClients: 0,
            totalSalesOrders: 0,
            approvedSalesOrders: 0,
            totalProjects: 0,
            activeProjects: 0,
            openTasks: 0,
            overdueTasks: 0,
            loggedHoursThisMonth: 0,
            billableHoursThisMonth: 0,
            billableAmountThisMonth: 0
          },
          finance: {
            draftQuotations: 0,
            sentQuotations: 0,
            acceptedQuotations: 0,
            unpaidInvoices: 0,
            overdueInvoices: 0,
            paidInvoices: 0,
            totalPaymentsThisMonth: 0,
            defaultCurrency
          },
          expenses: {
            pendingApprovals: 0,
            approvedThisMonth: 0,
            defaultCurrency
          },
          totalLeads: 0,
          newLeads: 0,
          wonLeads: 0,
          totalClients: 0,
          totalSalesOrders: 0,
          approvedSalesOrders: 0,
          totalProjects: 0,
          activeProjects: 0,
          openTasks: 0,
          overdueTasks: 0,
          overdueTasksList: [],
          watchedTasksList: [],
          watchedOpenTasks: 0,
          watchedOverdueTasks: 0,
          upcomingMilestones: [],
          unpaidInvoicesList: [],
          urgentTicketsList: [],
          opportunitiesSummary: {
            totalOpportunities: 0,
            pipelineValue: 0,
            weightedForecast: 0,
            wonValue: 0
          },
          customerHealthSummary: {
            averageHealthScore: 0,
            highRiskCount: 0,
            averageCsat: '5.0'
          },
          marketingSummary: {
            activeCampaigns: 0,
            totalCampaigns: 0
          },
          contractsSummary: {
            totalContracts: 0,
            activeContracts: 0,
            activeContractsValue: 0,
            expiringContracts30d: 0,
            awaitingSignature: 0,
            expiringContractsList: []
          },
          productsSummary: {
            totalProducts: 0,
            activeProducts: 0,
            lowStockProducts: 0,
            topProductCategories: [],
            recentProductsList: []
          },
          creditNotesSummary: {
            totalCreditNotes: 0,
            openCreditNotes: 0,
            totalCreditedAmount: 0,
            remainingCreditBalance: 0,
            openCreditNotesList: []
          },
          calendarSummary: {
            scheduledEventsToday: 0,
            scheduledEventsThisWeek: 0,
            scheduledEventsThisMonth: 0,
            overdueEventsCount: 0,
            upcomingCalendarEvents: [],
            allCalendarEvents: []
          },
          loggedHoursThisMonth: 0,
          billableHoursThisMonth: 0,
          billableAmountThisMonth: 0,
          draftQuotations: 0,
          sentQuotations: 0,
          acceptedQuotations: 0,
          unpaidInvoices: 0,
          overdueInvoices: 0,
          paidInvoices: 0,
          totalPaymentsThisMonth: 0,
          pendingExpenseApprovals: 0,
          approvedExpensesThisMonth: 0,
          defaultCurrency,
          recentAudit: []
        };
      }
    }

    let leadFilter = { ...base };
    let clientFilter = { ...base };

    if (clientUser) {
      leadFilter = { ...base, clientId: userClientId };
      clientFilter = { ...base, _id: userClientId };
    } else if (isSalesAgentScoped(req)) {
      leadFilter = applySalesAgentLeadListScope(req, leadFilter);
      clientFilter = await applySalesAgentClientListScope(
        req,
        clientFilter,
        (request) => getModel(request, 'Lead')
      );
    }

    const Lead = getModel(req, 'Lead');
    if (Lead && !isClientRole) {
      const dateScopedLeadQuery = startDate
        ? { ...leadFilter, createdAt: { $gte: startDate, $lte: endDate } }
        : leadFilter;

      [totalLeads, newLeads, wonLeads] = await Promise.all([
        Lead.countDocuments(leadFilter),
        Lead.countDocuments({ ...dateScopedLeadQuery, stage: newStage }),
        Lead.countDocuments({ ...dateScopedLeadQuery, stage: wonStage })
      ]);
    }

    const Company = getModel(req, 'Company');
    if (Company) {
      totalClients = await Company.countDocuments(clientFilter);
    }

    if (canOrders) {
      const SalesOrder = getModel(req, 'SalesOrder');
      if (SalesOrder) {
        let orderFilter = clientUser ? { ...base, clientId: userClientId } : base;
        if (!clientUser && isSalesAgentScoped(req)) {
          orderFilter = applySalesAgentCreatorScope(req, orderFilter);
        }
        const orderDateQuery = startDate ? { orderDate: { $gte: startDate, $lte: endDate } } : {};
        [totalSalesOrders, approvedSalesOrders] = await Promise.all([
          SalesOrder.countDocuments({ ...orderFilter, ...orderDateQuery }),
          SalesOrder.countDocuments({ ...orderFilter, status: { $in: ['Approved', 'Processing', 'Completed'] }, ...orderDateQuery })
        ]);
      }
    }

    if (canProjects) {
      const Project = getModel(req, 'Project');
      if (Project) {
        let projectFilter = { ...base };
        if (clientUser) {
          projectFilter = { ...base, clientId: userClientId };
        } else if (isEmployeeScoped(req)) {
          projectFilter = await applyEmployeeProjectListScope(req, projectFilter);
        }
        totalProjects = await Project.countDocuments(projectFilter);
        activeProjects = await Project.countDocuments({
          ...projectFilter,
          status: { $nin: ['Completed', 'Cancelled'] }
        });

        // Upcoming Milestones query
        const Milestone = getModel(req, 'Milestone');
        if (Milestone) {
          try {
            let clientProjectIds = [];
            if (clientUser) {
              const clientProjects = await Project.find(projectFilter).select('_id').lean();
              clientProjectIds = clientProjects.map((p) => String(p._id));
            }
            const milestoneFilter = {
              ...base,
              status: { $nin: ['Completed', 'Cancelled'] },
              deadline: { $gte: new Date() }
            };
            if (clientUser) {
              milestoneFilter.projectId = { $in: clientProjectIds };
            }
            const milestoneDocs = await Milestone.find(milestoneFilter)
              .sort({ deadline: 1 })
              .limit(5)
              .lean();

            // Populate project name
            const projectIds = milestoneDocs.map((m) => m.projectId).filter(Boolean);
            let projectMap = new Map();
            if (projectIds.length > 0) {
              try {
                const qRes = Project.find({ _id: { $in: projectIds } }, { name: 1 });
                const projects = typeof qRes?.lean === 'function' ? await qRes.lean() : (Array.isArray(qRes) ? qRes : await qRes);
                if (Array.isArray(projects)) {
                  projectMap = new Map(projects.map((p) => [String(p._id), p.name]));
                }
              } catch {
                // ignore
              }
            }

            upcomingMilestones = milestoneDocs.map((m) => ({
              id: m._id,
              title: m.title || 'Untitled Milestone',
              projectId: m.projectId,
              projectName: projectMap.get(String(m.projectId)) || 'Project',
              deadline: m.deadline,
              cost: m.cost || 0,
              status: m.status || 'Planned'
            }));
          } catch {
            upcomingMilestones = [];
          }
        }
      }
    }

    if (canTasks) {
      const Task = getModel(req, 'Task');
      if (Task) {
        let taskFilter = { ...base };
        if (clientUser) {
          const ProjectModel = getModel(req, 'Project');
          let clientProjectIds = [];
          if (ProjectModel) {
            const clientProjects = await ProjectModel.find({
              ...base,
              clientId: userClientId
            }).select('_id').lean();
            clientProjectIds = clientProjects.map((p) => String(p._id));
          }
          taskFilter = {
            ...base,
            $or: [
              { clientId: userClientId },
              { projectId: { $in: clientProjectIds } }
            ]
          };
        } else if (isEmployeeScoped(req)) {
          taskFilter = await applyEmployeeTaskListScope(req, taskFilter);
        }
        openTasks = await Task.countDocuments({
          ...taskFilter,
          status: { $nin: ['Completed'] }
        });
        overdueTasks = await Task.countDocuments({
          ...taskFilter,
          status: { $nin: ['Completed'] },
          dueDate: { $lt: new Date(), $ne: null }
        });

        // Overdue Tasks watchlist list
        try {
          const overdueDocs = await Task.find({
            ...taskFilter,
            status: { $nin: ['Completed'] },
            dueDate: { $lt: new Date(), $ne: null }
          })
            .sort({ dueDate: 1 })
            .limit(5)
            .lean();

          overdueTasksList = overdueDocs.map((t) => ({
            id: t._id,
            title: t.title || 'Untitled Task',
            projectId: t.projectId,
            priority: t.priority || 'Medium',
            status: t.status || 'To Do',
            dueDate: t.dueDate,
            assignedTo: Array.isArray(t.assignedTo) ? t.assignedTo : [t.assignedTo].filter(Boolean)
          }));
        } catch {
          overdueTasksList = [];
        }

        // Highlighted Watched / Followed Tasks query (for user's personalized monitor)
        const currentUserId = resolveUserId(req);
        if (currentUserId) {
          try {
            const watchedFilter = {
              ...base,
              followers: currentUserId,
              status: { $nin: ['Completed'] },
              isArchived: { $ne: true }
            };

            [watchedOpenTasks, watchedOverdueTasks] = await Promise.all([
              Task.countDocuments(watchedFilter),
              Task.countDocuments({
                ...watchedFilter,
                dueDate: { $lt: new Date(), $ne: null }
              })
            ]);

            const watchedDocs = await Task.find(watchedFilter)
              .sort({ dueDate: 1, priority: -1 })
              .limit(8)
              .lean();

            const watchedProjectIds = [...new Set(watchedDocs.map((t) => t.projectId).filter(Boolean))];
            const ProjectModel = getModel(req, 'Project');
            let watchedProjectMap = new Map();
            if (ProjectModel && watchedProjectIds.length > 0 && typeof ProjectModel.find === 'function') {
              try {
                const queryResult = ProjectModel.find({ _id: { $in: watchedProjectIds } }, { name: 1 });
                const pRows = typeof queryResult?.lean === 'function' ? await queryResult.lean() : (Array.isArray(queryResult) ? queryResult : await queryResult);
                if (Array.isArray(pRows)) {
                  watchedProjectMap = new Map(pRows.map((p) => [String(p._id), p.name]));
                }
              } catch {
                // fallback if mock doesn't support direct lean
              }
            }

            watchedTasksList = watchedDocs.map((t) => ({
              id: t._id,
              title: t.title || 'Untitled Task',
              projectId: t.projectId,
              projectName: watchedProjectMap.get(String(t.projectId)) || 'General Deliverable',
              priority: t.priority || 'Medium',
              status: t.status || 'To Do',
              dueDate: t.dueDate,
              isOverdue: Boolean(t.dueDate && new Date(t.dueDate) < new Date()),
              assignedUsername: t.assignedUsername || 'Unassigned',
              assignedTo: Array.isArray(t.assignedTo) ? t.assignedTo : [t.assignedTo].filter(Boolean),
              followerCount: Array.isArray(t.followers) ? t.followers.length : 1,
              subtasksTotal: Array.isArray(t.subtasks) ? t.subtasks.length : 0,
              subtasksCompleted: Array.isArray(t.subtasks) ? t.subtasks.filter((st) => st.isCompleted).length : 0
            }));
          } catch {
            watchedTasksList = [];
          }
        }

        // Tasks blocked because prerequisite task is completed but awaiting client reply
        try {
          const dependentTasks = await Task.find({
            ...taskFilter,
            dependsOnTaskId: { $exists: true, $ne: null, $nin: ['', 'none', 'null', 'undefined'] },
            status: { $nin: ['Completed', 'Cancelled'] }
          })
            .select('title projectId status dependsOnTaskId')
            .lean();

          if (dependentTasks.length) {
            const depIds = [...new Set(dependentTasks.map((t) => String(t.dependsOnTaskId)).filter(Boolean))];
            const depTasks = await Task.find({
              tenantId: resolveTenantId(req),
              isDeleted: false,
              _id: { $in: depIds },
              status: 'Completed'
            })
              .select('title status clientFeedbackStatus clientNotifiedAt clientNotifiedEmail projectId')
              .lean();

            const depMap = new Map(depTasks.map((d) => [String(d._id), d]));
            const allPIds = [...new Set([...dependentTasks.map((t) => t.projectId), ...depTasks.map((d) => d.projectId)].filter(Boolean))];
            const ProjectModel = getModel(req, 'Project');
            let pMap = new Map();
            if (ProjectModel && allPIds.length) {
              try {
                const qRes = ProjectModel.find({ _id: { $in: allPIds } }, { name: 1 });
                const pRows = typeof qRes?.lean === 'function' ? await qRes.lean() : (Array.isArray(qRes) ? qRes : await qRes);
                if (Array.isArray(pRows)) {
                  pMap = new Map(pRows.map((p) => [String(p._id), p.name]));
                }
              } catch {
                // ignore
              }
            }

            for (const t of dependentTasks) {
              const depTask = depMap.get(String(t.dependsOnTaskId));
              if (depTask) {
                const isAwaitingReply = !depTask.clientFeedbackStatus ||
                  depTask.clientFeedbackStatus === 'Not Replied' ||
                  depTask.clientFeedbackStatus === 'Awaiting Reply' ||
                  depTask.clientFeedbackStatus === 'Pending Review' ||
                  depTask.clientFeedbackStatus === 'Pending Feedback';

                if (isAwaitingReply && depTask.clientFeedbackStatus !== 'Satisfied') {
                  blockedAwaitingClientTasks.push({
                    taskId: String(t._id),
                    taskTitle: t.title,
                    projectId: t.projectId,
                    projectName: pMap.get(String(t.projectId)) || 'Project',
                    dependsOnTaskId: String(depTask._id),
                    dependsOnTaskTitle: depTask.title,
                    dependsOnTaskStatus: depTask.status,
                    clientFeedbackStatus: depTask.clientFeedbackStatus || 'Not Replied',
                    clientNotifiedAt: depTask.clientNotifiedAt || null,
                    clientNotifiedEmail: depTask.clientNotifiedEmail || null,
                    alertMessage: `Task "${t.title}" is dependent on "${depTask.title}" which is completed but client status is ⏳ Awaiting Reply. Can you talk and resend email to client?`
                  });
                }
              }
            }
          }
        } catch (err) {
          console.warn('[DashboardService] Blocked tasks calculation error:', err.message);
          blockedAwaitingClientTasks = [];
        }
      }
    }

    if (canTime) {
      const monthTotals = await TimeLogService.sumHoursThisMonth(req, { startDate, endDate }).catch(() => ({
        totalHours: 0,
        billableAmount: 0
      }));
      const billableTotals = await TimeLogService.sumHoursThisMonth(req, { billableOnly: true, startDate, endDate }).catch(
        () => ({ totalHours: 0, billableAmount: 0 })
      );
      loggedHoursThisMonth = monthTotals.totalHours || 0;
      billableHoursThisMonth = billableTotals.totalHours || 0;
      billableAmountThisMonth = monthTotals.billableAmount || 0;
    }

    if (canFinance) {
      const Estimate = getModel(req, 'Estimate');
      if (Estimate) {
        let estimateBase = clientUser ? { ...base, clientId: userClientId } : base;
        if (!clientUser && isSalesAgentScoped(req)) {
          estimateBase = applySalesAgentCreatorScope(req, estimateBase);
        }
        const estimateDateQuery = startDate ? { createdAt: { $gte: startDate, $lte: endDate } } : {};
        [draftQuotations, sentQuotations, acceptedQuotations] = await Promise.all([
          Estimate.countDocuments({ ...estimateBase, status: 'Draft', ...estimateDateQuery }),
          Estimate.countDocuments({ ...estimateBase, status: 'Sent', ...estimateDateQuery }),
          Estimate.countDocuments({ ...estimateBase, status: 'Accepted', ...estimateDateQuery })
        ]);
      }

      const Invoice = getModel(req, 'Invoice');
      if (Invoice) {
        let invoiceBase = clientUser ? { ...base, clientId: userClientId } : base;
        if (!clientUser && isSalesAgentScoped(req)) {
          invoiceBase = applySalesAgentCreatorScope(req, invoiceBase);
        }
        const invoiceDateQuery = startDate ? { issueDate: { $gte: startDate, $lte: endDate } } : {};
        [unpaidInvoices, overdueInvoices, paidInvoices] = await Promise.all([
          Invoice.countDocuments({
            ...invoiceBase,
            balanceDue: { $gt: 0 },
            status: { $nin: ['Cancelled', 'Draft'] },
            ...invoiceDateQuery
          }),
          Invoice.countDocuments({
            ...invoiceBase,
            balanceDue: { $gt: 0 },
            dueDate: { $lt: new Date() },
            status: { $nin: ['Cancelled', 'Paid', 'Draft'] }
          }),
          Invoice.countDocuments({ ...invoiceBase, status: 'Paid', ...invoiceDateQuery })
        ]);

        // Unpaid & Overdue Invoices watchlist
        try {
          const unpaidDocs = await Invoice.find({
            ...invoiceBase,
            balanceDue: { $gt: 0 },
            status: { $nin: ['Cancelled', 'Draft'] }
          })
            .sort({ dueDate: 1 })
            .limit(5)
            .lean();

          unpaidInvoicesList = unpaidDocs.map((inv) => ({
            id: inv._id,
            invoiceNumber: inv.invoiceNumber || 'INV',
            clientId: inv.clientId,
            clientName: inv.clientName || 'Client',
            totalAmount: inv.totalAmount || 0,
            balanceDue: inv.balanceDue || 0,
            dueDate: inv.dueDate,
            status: inv.status || 'Sent',
            isOverdue: inv.dueDate ? new Date(inv.dueDate) < new Date() : false
          }));
        } catch {
          unpaidInvoicesList = [];
        }
      }

      totalPaymentsThisMonth = await PaymentService.sumThisMonth(req, { startDate, endDate }).catch(() => 0);
    }

    if (canExpenses) {
      if (canExpensesApprove) {
        pendingExpenseApprovals = await ExpenseService.countPendingApproval(req).catch(() => 0);
      }
      approvedExpensesThisMonth = await ExpenseService.sumApprovedThisMonth(req, { startDate, endDate }).catch(() => 0);
    }

    if (!clientUser) {
      const ClientPortalAccess = getModel(req, 'ClientPortalAccess');
      if (ClientPortalAccess) {
        try {
          pendingPortalApprovals = await ClientPortalAccess.countDocuments({
            ...base,
            status: 'Pending_Approval'
          });
        } catch (_) {}
      }
    }

    // Opportunities Pipeline Summary
    if (canOpps) {
      const Opportunity = getModel(req, 'Opportunity');
      if (Opportunity) {
        try {
          const oppBase = clientUser ? { ...base, clientId: userClientId } : base;
          const oppDocs = await Opportunity.find(oppBase).lean();
          const totalOpps = oppDocs.length;
          const pipelineValue = oppDocs
            .filter((o) => o.stage !== 'Lost' && o.stage !== 'Won')
            .reduce((sum, o) => sum + (Number(o.value) || 0), 0);
          const weightedForecast = oppDocs
            .filter((o) => o.stage !== 'Lost')
            .reduce((sum, o) => sum + ((Number(o.value) || 0) * (Number(o.probability) || 0)) / 100, 0);
          const wonValue = oppDocs
            .filter((o) => o.stage === 'Won')
            .reduce((sum, o) => sum + (Number(o.value) || 0), 0);

          opportunitiesSummary = {
            totalOpportunities: totalOpps,
            pipelineValue,
            weightedForecast,
            wonValue
          };
        } catch {
          opportunitiesSummary = null;
        }
      }
    }

    // Customer Support Tickets & SLA
    if (canTickets) {
      const Ticket = getModel(req, 'Ticket');
      if (Ticket) {
        try {
          const ticketBase = clientUser ? { ...base, clientId: userClientId } : base;
          const [openTickets, urgentTickets, breachedTickets] = await Promise.all([
            Ticket.countDocuments({ ...ticketBase, status: { $nin: ['Resolved', 'Closed'] } }),
            Ticket.countDocuments({ ...ticketBase, status: { $nin: ['Resolved', 'Closed'] }, priority: { $in: ['Urgent', 'High'] } }),
            Ticket.countDocuments({ ...ticketBase, status: { $nin: ['Resolved', 'Closed'] }, slaDeadline: { $lt: new Date(), $ne: null } })
          ]);

          const urgentDocs = await Ticket.find({
            ...ticketBase,
            status: { $nin: ['Resolved', 'Closed'] },
            priority: { $in: ['Urgent', 'High'] }
          })
            .sort({ createdAt: -1 })
            .limit(5)
            .lean();

          urgentTicketsList = urgentDocs.map((t) => ({
            id: t._id,
            ticketNumber: t.ticketNumber || 'TCK',
            subject: t.subject || 'Support Ticket',
            priority: t.priority || 'High',
            status: t.status || 'Open',
            slaDeadline: t.slaDeadline,
            createdAt: t.createdAt
          }));

          opportunitiesSummary = opportunitiesSummary || {};
          opportunitiesSummary.ticketStats = {
            openTickets,
            urgentTickets,
            breachedTickets
          };
        } catch {
          urgentTicketsList = [];
        }
      }
    }

    // Customer Success & Health Index
    if (canSuccess && !clientUser) {
      const CustomerHealth = getModel(req, 'CustomerHealth');
      if (CustomerHealth) {
        try {
          const healthDocs = await CustomerHealth.find({ ...base }).lean();
          if (healthDocs.length > 0) {
            const avgHealth = Math.round(
              healthDocs.reduce((sum, h) => sum + (Number(h.healthScore) || 75), 0) / healthDocs.length
            );
            const highRiskCount = healthDocs.filter((h) => (Number(h.healthScore) || 75) < 50).length;
            const csatReviews = healthDocs.filter((h) => h.csatRating !== undefined && h.csatRating !== null);
            const avgCsat = csatReviews.length > 0
              ? (csatReviews.reduce((sum, h) => sum + Number(h.csatRating), 0) / csatReviews.length).toFixed(1)
              : '4.8';

            customerHealthSummary = {
              averageHealthScore: avgHealth,
              highRiskCount,
              averageCsat: avgCsat
            };
          }
        } catch {
          customerHealthSummary = null;
        }
      }
    }

    // Marketing Automation Summary
    if (canMarketing && !clientUser) {
      const MarketingCampaign = getModel(req, 'MarketingCampaign');
      if (MarketingCampaign) {
        try {
          const [activeCampaigns, totalLeadsCount] = await Promise.all([
            MarketingCampaign.countDocuments({ ...base, status: 'Active' }),
            MarketingCampaign.countDocuments({ ...base })
          ]);
          marketingSummary = {
            activeCampaigns,
            totalCampaigns: totalLeadsCount
          };
        } catch {
          marketingSummary = null;
        }
      }
    }

    // Credit Notes & Balances
    if (canFinance) {
      const CreditNote = getModel(req, 'CreditNote');
      if (CreditNote) {
        try {
          const creditBase = clientUser ? { ...base, clientId: userClientId } : base;
          [totalCreditNotes, openCreditNotes] = await Promise.all([
            CreditNote.countDocuments(creditBase),
            CreditNote.countDocuments({ ...creditBase, status: { $in: ['Open', 'Partially Applied'] } })
          ]);

          const creditDocs = await CreditNote.find({
            ...creditBase,
            status: { $nin: ['Void', 'Draft'] }
          }).select('totalAmount remainingBalance').lean();

          totalCreditedAmount = creditDocs.reduce((sum, cn) => sum + (Number(cn.totalAmount) || 0), 0);
          remainingCreditBalance = creditDocs.reduce((sum, cn) => sum + (Number(cn.remainingBalance) || 0), 0);

          const openDocs = await CreditNote.find({
            ...creditBase,
            status: { $in: ['Open', 'Partially Applied'] }
          })
            .sort({ creditDate: -1 })
            .limit(5)
            .lean();

          openCreditNotesList = openDocs.map((cn) => ({
            id: cn._id,
            creditNoteNumber: cn.creditNoteNumber || 'CN',
            clientId: cn.clientId,
            clientName: cn.clientName || 'Client',
            totalAmount: cn.totalAmount || 0,
            remainingBalance: cn.remainingBalance || 0,
            currency: cn.currency || defaultCurrency,
            status: cn.status || 'Open',
            creditDate: cn.creditDate
          }));
        } catch {
          // ignore
        }
      }
    }

    // Calendar & Scheduled Client Events
    scheduledEventsToday = 0;
    scheduledEventsThisWeek = 0;
    scheduledEventsThisMonth = 0;
    overdueEventsCount = 0;
    upcomingCalendarEvents = [];
    allCalendarEvents = [];

    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      const endOfWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      const ClientEvent = getModel(req, 'ClientEvent');
      const LeadEvent = getModel(req, 'LeadEvent');
      const FollowUp = getModel(req, 'FollowUp');
      const LeadModel = getModel(req, 'Lead');
      const CompanyModel = getModel(req, 'Company');

      const ceFilter = clientUser ? { ...base, clientId: userClientId } : base;

      const [ceDocs, leDocs, fuDocs] = await Promise.all([
        ClientEvent ? ClientEvent.find({ ...ceFilter, isDeleted: { $ne: true } }).sort({ eventDate: 1 }).limit(100).lean() : [],
        (LeadEvent && !clientUser && !isClientRole) ? LeadEvent.find({ ...base, isDeleted: { $ne: true } }).sort({ eventDate: 1 }).limit(100).lean() : [],
        (FollowUp && !clientUser && !isClientRole) ? FollowUp.find({ ...base, isDeleted: { $ne: true } }).sort({ dueDate: 1 }).limit(100).lean() : []
      ]);

      // Collect lead and client IDs for name hydration
      const leadIds = [...new Set([
        ...leDocs.map((e) => String(e.leadId)).filter(Boolean),
        ...fuDocs.map((f) => String(f.leadId)).filter(Boolean)
      ])];

      const clientIds = [...new Set(ceDocs.map((e) => String(e.clientId)).filter(Boolean))];

      let leadMap = new Map();
      if (LeadModel && leadIds.length) {
        try {
          const lDocs = await LeadModel.find({ _id: { $in: leadIds } }, { firstName: 1, lastName: 1, company: 1, email: 1, phone: 1 }).lean();
          if (Array.isArray(lDocs)) {
            leadMap = new Map(lDocs.map((l) => [
              String(l._id),
              {
                name: [l.firstName, l.lastName].filter(Boolean).join(' ') || l.company || 'Lead',
                company: l.company || '',
                email: l.email || '',
                phone: l.phone || ''
              }
            ]));
          }
        } catch {}
      }

      let companyMap = new Map();
      if (CompanyModel && clientIds.length) {
        try {
          const cDocs = await CompanyModel.find({ _id: { $in: clientIds } }, { name: 1, email: 1, phone: 1 }).lean();
          if (Array.isArray(cDocs)) {
            companyMap = new Map(cDocs.map((c) => [
              String(c._id),
              { name: c.name || 'Client', email: c.email || '', phone: c.phone || '' }
            ]));
          }
        } catch {}
      }

      const rawEvents = [
        ...ceDocs.map((e) => {
          const comp = companyMap.get(String(e.clientId));
          const evDate = new Date(e.eventDate);
          const isOver = evDate < startOfDay && e.status === 'Open';
          const isTod = evDate >= startOfDay && evDate <= endOfDay;
          return {
            id: String(e._id),
            title: e.title || 'Client Meeting',
            type: e.eventType || 'Meeting',
            category: (e.eventType || '').toLowerCase().includes('call') ? 'call' : ((e.eventType || '').toLowerCase().includes('follow') ? 'followup' : 'meeting'),
            entityType: 'Client',
            entityId: String(e.clientId || ''),
            entityName: comp?.name || 'Client Account',
            date: e.eventDate,
            status: e.status || 'Open',
            isOverdue: isOver,
            isToday: isTod,
            description: e.description || '',
            attendees: Array.isArray(e.attendees) ? e.attendees : [],
            durationMinutes: e.durationMinutes || 0,
            nextAction: e.nextAction || '',
            createdAt: e.createdAt || null
          };
        }),
        ...leDocs.map((e) => {
          const ld = leadMap.get(String(e.leadId));
          const evDate = new Date(e.eventDate);
          const isOver = evDate < startOfDay && e.status === 'Open';
          const isTod = evDate >= startOfDay && evDate <= endOfDay;
          return {
            id: String(e._id),
            title: e.title || 'Lead Interaction',
            type: e.eventType || 'Call',
            category: (e.eventType || '').toLowerCase().includes('call') ? 'call' : ((e.eventType || '').toLowerCase().includes('follow') ? 'followup' : 'meeting'),
            entityType: 'Lead',
            entityId: String(e.leadId || ''),
            entityName: ld ? (ld.name + (ld.company ? ` (${ld.company})` : '')) : 'Lead Record',
            date: e.eventDate,
            status: e.status || 'Open',
            isOverdue: isOver,
            isToday: isTod,
            description: e.description || '',
            durationMinutes: 0,
            createdAt: e.createdAt || null,
            kind: e.kind || 'logged',
            // Scheduled activity never completed by its due time.
            isMissed: isMissedActivity(e),
            displayStatus: activityDisplayStatus(e)
          };
        }),
        ...fuDocs.map((f) => {
          const ld = leadMap.get(String(f.leadId));
          const fuDate = new Date(f.dueDate);
          const isOver = fuDate < startOfDay && f.status === 'Open';
          const isTod = fuDate >= startOfDay && fuDate <= endOfDay;
          return {
            id: String(f._id),
            title: f.title || 'Lead Follow-up',
            type: 'Follow-up',
            category: 'followup',
            entityType: 'Lead',
            entityId: String(f.leadId || ''),
            entityName: ld ? (ld.name + (ld.company ? ` (${ld.company})` : '')) : 'Lead Record',
            date: f.dueDate,
            status: f.status || 'Open',
            isOverdue: isOver,
            isToday: isTod,
            description: f.notes || '',
            durationMinutes: 0,
            createdAt: f.createdAt || null
          };
        })
      ];

      rawEvents.sort((a, b) => new Date(a.date) - new Date(b.date));

      // Calculate accurate counts
      for (const ev of rawEvents) {
        if (ev.status === 'Open') {
          const d = new Date(ev.date);
          if (ev.isOverdue) {
            overdueEventsCount++;
          }
          if (ev.isToday || ev.isOverdue) {
            scheduledEventsToday++;
          }
          if (d >= startOfDay && d <= endOfWeek) {
            scheduledEventsThisWeek++;
          }
          if (d >= startOfMonth && d <= endOfMonth) {
            scheduledEventsThisMonth++;
          }
        }
      }

      allCalendarEvents = rawEvents;
      upcomingCalendarEvents = rawEvents.filter((ev) => ev.status === 'Open' || ev.isToday || ev.isOverdue).slice(0, 10);
    } catch (err) {
      console.warn('[DashboardService] Calendar events calculation error:', err.message);
    }

    if (canAudit && !clientUser && !isClientRole) {
      recentAudit = await AuditService.getRecent(req, 10).catch(() => []);
    }
  } catch {
    // Models may not be loaded yet during early boot
  }

  // Get active widget layout configuration
  const widgetConfig = await getWidgetConfig(req).catch(() => ({
    role: resolveCurrentRoleKey(req),
    enabledWidgets: getDefaultWidgetsForRole(resolveCurrentRoleKey(req)),
    availableWidgets: AVAILABLE_WIDGETS
  }));

  const sales = {
    totalLeads,
    newLeads,
    wonLeads,
    totalClients,
    totalSalesOrders: canOrders ? totalSalesOrders : undefined,
    approvedSalesOrders: canOrders ? approvedSalesOrders : undefined,
    totalProjects: canProjects ? totalProjects : undefined,
    activeProjects: canProjects ? activeProjects : undefined,
    openTasks: canTasks ? openTasks : undefined,
    overdueTasks: canTasks ? overdueTasks : undefined,
    loggedHoursThisMonth: canTime ? loggedHoursThisMonth : undefined,
    billableHoursThisMonth: canTime ? billableHoursThisMonth : undefined,
    billableAmountThisMonth: canTime ? billableAmountThisMonth : undefined
  };

  const finance = canFinance
    ? {
        draftQuotations,
        sentQuotations,
        acceptedQuotations,
        unpaidInvoices,
        overdueInvoices,
        paidInvoices,
        totalPaymentsThisMonth,
        defaultCurrency
      }
    : null;

  const expenses = canExpenses
    ? {
        pendingApprovals: canExpensesApprove ? pendingExpenseApprovals : undefined,
        approvedThisMonth: approvedExpensesThisMonth,
        defaultCurrency
      }
    : null;

  return {
    period: activePeriod,
    dateRange: {
      startDate,
      endDate
    },
    widgetConfig,
    sales,
    finance,
    expenses,
    totalLeads,
    newLeads,
    wonLeads,
    totalClients,
    totalSalesOrders: canOrders ? totalSalesOrders : undefined,
    approvedSalesOrders: canOrders ? approvedSalesOrders : undefined,
    totalProjects: canProjects ? totalProjects : undefined,
    activeProjects: canProjects ? activeProjects : undefined,
    openTasks: canTasks ? openTasks : undefined,
    overdueTasks: canTasks ? overdueTasks : undefined,
    overdueTasksList,
    blockedAwaitingClientTasks: canTasks ? blockedAwaitingClientTasks : [],
    watchedTasksList: canTasks ? watchedTasksList : [],
    watchedOpenTasks: canTasks ? watchedOpenTasks : 0,
    watchedOverdueTasks: canTasks ? watchedOverdueTasks : 0,
    upcomingMilestones,
    unpaidInvoicesList,
    urgentTicketsList,
    opportunitiesSummary,
    customerHealthSummary,
    marketingSummary,
    // Credit Notes metrics
    creditNotesSummary: {
      totalCreditNotes,
      openCreditNotes,
      totalCreditedAmount,
      remainingCreditBalance,
      openCreditNotesList
    },
    // Calendar & Schedule metrics
    calendarSummary: {
      scheduledEventsToday,
      scheduledEventsThisWeek,
      scheduledEventsThisMonth,
      overdueEventsCount,
      upcomingCalendarEvents,
      allCalendarEvents
    },
    loggedHoursThisMonth: canTime ? loggedHoursThisMonth : undefined,
    billableHoursThisMonth: canTime ? billableHoursThisMonth : undefined,
    billableAmountThisMonth: canTime ? billableAmountThisMonth : undefined,
    draftQuotations: canFinance ? draftQuotations : undefined,
    sentQuotations: canFinance ? sentQuotations : undefined,
    acceptedQuotations: canFinance ? acceptedQuotations : undefined,
    unpaidInvoices: canFinance ? unpaidInvoices : undefined,
    overdueInvoices: canFinance ? overdueInvoices : undefined,
    paidInvoices: canFinance ? paidInvoices : undefined,
    totalPaymentsThisMonth: canFinance ? totalPaymentsThisMonth : undefined,
    pendingExpenseApprovals: canExpenses && canExpensesApprove ? pendingExpenseApprovals : undefined,
    pendingPortalApprovals: !isClientRole ? pendingPortalApprovals : undefined,
    approvedExpensesThisMonth: canExpenses ? approvedExpensesThisMonth : undefined,
    defaultCurrency,
    recentAudit: canAudit ? recentAudit : []
  };
}

function getHealth() {
  return {
    status: 'ok',
    plugin: 'openext-crm-suite',
    version: pluginVersion,
    phase: 2
  };
}

module.exports = {
  AVAILABLE_WIDGETS,
  ROLE_DEFAULT_WIDGETS,
  getDefaultWidgetsForRole,
  getWidgetConfig,
  saveWidgetConfig,
  getSummary,
  getHealth
};
