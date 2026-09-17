// Sidebar information architecture for the whole CMS. Only Wave 8A routes
// are `status: 'active'`; everything else is `'planned'` and renders
// disabled purely for orientation (Wave 8A brief §42). An item with a
// `permission` is hidden entirely from a role that lacks it — but that is
// a UX convenience, never a security boundary.
export const NAV_SECTIONS = [
  {
    id: 'overview',
    label: null,
    items: [{ label: 'Dashboard', to: '/', icon: 'grid', status: 'active' }],
  },
  {
    id: 'catalog',
    label: 'Catalog',
    items: [
      { label: 'Products', to: '/products', icon: 'tag', status: 'active', permission: 'catalog.read' },
      { label: 'Categories', to: '/catalog/categories', icon: 'layers', status: 'active', permission: 'catalog.read' },
      { label: 'Collections', to: '/catalog/collections', icon: 'layers', status: 'active', permission: 'catalog.read' },
      { label: 'Size Guides', to: '/catalog/size-guides', icon: 'ruler', status: 'active', permission: 'catalog.read' },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      { label: 'Warehouses', to: '/warehouses', icon: 'box', status: 'active', permission: 'warehouse.read' },
      { label: 'Inventory', to: '/inventory', icon: 'box', status: 'active', permission: 'inventory.read' },
      { label: 'Transfers', to: '/transfers', icon: 'truck', status: 'active', permission: 'inventory.read' },
      { label: 'Quarantine', to: '/quarantine', icon: 'box', status: 'active', permission: 'inventory.read' },
      { label: 'Orders', to: '/orders', icon: 'cart', status: 'active', permission: 'orders.read' },
      { label: 'Returns & Exchanges', to: '/returns', icon: 'truck', status: 'active', permission: 'returns.read' },
      { label: 'RVP QC Questions', to: '/rvp-qc-questions', icon: 'box', status: 'active', permission: 'returns.read' },
      { label: 'Fulfillment', to: '/fulfillment', icon: 'truck', status: 'active', permission: 'fulfillment.read' },
      // Print Stations disabled (business rule 2026-09-04) — labels/invoices are
      // downloaded and printed manually. Route + backend kept dormant for a
      // possible future dedicated printing workflow.
    ],
  },
  {
    // Wave 8G information architecture (§149) — customer operations grouped
    // apart from warehouse/order operations.
    id: 'customers',
    label: 'Customers',
    items: [
      { label: 'Customers', to: '/customers', icon: 'users', status: 'active', permission: 'customers.read' },
      { label: 'Customer Segments', to: '/segments', icon: 'users', status: 'active', permission: 'segments.read' },
      { label: 'Subscribers & Consent', to: '/subscribers', icon: 'megaphone', status: 'active', permission: 'marketing.read' },
    ],
  },
  {
    id: 'support',
    label: 'Support & Reviews',
    items: [
      { label: 'Communications', to: '/communications', icon: 'megaphone', status: 'active', permission: 'cms.access' },
      { label: 'Product Reviews', to: '/reviews', icon: 'star', status: 'active', permission: 'reviews.read' },
      { label: 'Careers', to: '/careers', icon: 'users', status: 'active', permission: 'careers.read' },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    items: [
      { label: 'Promotions & Coupons', to: '/promotions', icon: 'megaphone', status: 'active', permission: 'promotions.read' },
      { label: 'Campaigns', to: '/marketing/campaigns', icon: 'megaphone', status: 'active', permission: 'comms.read' },
      { label: 'Abandoned Carts', to: '/marketing/abandoned-carts', icon: 'megaphone', status: 'active', permission: 'marketing.read' },
    ],
  },
  {
    // Wave 8H — reporting is a read-only projection layer, grouped on its own.
    id: 'analytics',
    label: 'Analytics',
    items: [
      { label: 'Reports', to: '/reports', icon: 'grid', status: 'active', permission: 'reports.read' },
      { label: 'Reconciliation', to: '/reconciliation', icon: 'doc', status: 'active', permission: 'finance.read' },
      // Payment monitoring + COD control. `payments.manage` is SUPER_ADMIN-only,
      // so this entry is simply absent for everyone else — and the backend
      // enforces it regardless of what the nav shows.
      { label: 'Payments', to: '/payments', icon: 'doc', status: 'active', permission: 'payments.manage' },
    ],
  },
  {
    id: 'content',
    label: 'Content',
    items: [
      { label: 'Experience', to: '/content/experience', icon: 'menu', status: 'active', permission: 'content.read' },
      { label: 'Pages & FAQ', to: '/content/policies', icon: 'doc', status: 'active', permission: 'content.read' },
      { label: 'Campaigns & Themes', to: '/content/campaigns', icon: 'megaphone', status: 'active', permission: 'content.read' },
    ],
  },
  {
    id: 'media',
    label: 'Media',
    items: [
      { label: 'Media', to: '/media', icon: 'image', status: 'active', permission: 'catalog.read' },
    ],
  },
  {
    id: 'platform',
    label: 'Platform',
    items: [
      { label: 'Providers', to: '/platform/providers', icon: 'cog', status: 'active', permission: 'providers.read' },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [
      { label: 'Staff / Access', to: '/staff', icon: 'shield', status: 'active', permission: 'staff.read' },
      { label: 'Audit Log', to: '/audit-log', icon: 'doc', status: 'active', permission: 'audit.read' },
      { label: 'Tax Profiles', to: '/tax-profiles', icon: 'doc', status: 'active', permission: 'tax.read' },
      { label: 'Settings', to: '/settings', icon: 'cog', status: 'active', permission: 'staff.manage' },
    ],
  },
];

export default NAV_SECTIONS;
