/**
 * Roles for Razorpay Payment Gateway + integration permissions for other plugins.
 */
module.exports = {
  pages: [
    {
      id: 'payments',
      label: 'Payments',
      features: ['configure', 'test', 'view_status'],
    },
  ],
  roles: [
    {
      id: 'payments-viewer',
      name: 'Payments Viewer',
      baseRole: 3,
      permissions: ['payments.read'],
      pages: [{ id: 'payments', features: ['view_status'] }],
    },
    {
      id: 'payments-operator',
      name: 'Payments Operator',
      baseRole: 2,
      permissions: ['payments.read', 'payments.create_order', 'payments.verify'],
      pages: [{ id: 'payments', features: ['view_status'] }],
    },
    {
      id: 'payments-integrator',
      name: 'Plugin Integrator',
      baseRole: 2,
      permissions: [
        'payments.read',
        'payments.create_order',
        'payments.verify',
        'payments.integrate',
      ],
      pages: [{ id: 'payments', features: ['view_status'] }],
    },
    {
      id: 'payments-admin',
      name: 'Payments Admin',
      baseRole: 1,
      permissions: [
        'payments.read',
        'payments.configure',
        'payments.create_order',
        'payments.verify',
        'payments.integrate',
      ],
      pages: [{ id: 'payments', features: ['configure', 'test', 'view_status'] }],
    },
  ],
};
