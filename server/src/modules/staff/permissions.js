// Server-owned RBAC authority for the CMS/admin surface.
//
// The backend is the ONLY authority on what a role may do. The frontend
// receives the resolved permission list purely so it can hide/disable
// navigation it can't use — a hidden button is never a security boundary
// (Wave 8A brief §14/§15/§40). Every privileged route still calls
// requireStaffPermission() regardless of what the client believes.
//
// Wave 8A actively enforces only the foundation permissions (cms.access,
// staff.read). The rest are declared now so 8B+ modules attach to a stable
// vocabulary instead of inventing one per feature.

export const PERMISSIONS = Object.freeze({
  CMS_ACCESS: 'cms.access',

  CATALOG_READ: 'catalog.read',
  CATALOG_WRITE: 'catalog.write',

  INVENTORY_READ: 'inventory.read',
  INVENTORY_ADJUST: 'inventory.adjust',

  WAREHOUSE_READ: 'warehouse.read',
  WAREHOUSE_MANAGE: 'warehouse.manage',

  ORDERS_READ: 'orders.read',
  ORDERS_MANAGE: 'orders.manage',

  FULFILLMENT_READ: 'fulfillment.read',
  FULFILLMENT_MANAGE: 'fulfillment.manage',

  // Returns & exchanges (Wave 8F). `returns.manage` covers the operational
  // lifecycle (approve / pickup / receive / QC / release); `returns.refund` is
  // the separate, higher-privilege gate for money movement — warehouse/QC
  // staff must not be able to issue refunds just because they can pass QC
  // (§109).
  RETURNS_READ: 'returns.read',
  RETURNS_MANAGE: 'returns.manage',
  RETURNS_REFUND: 'returns.refund',

  CUSTOMERS_READ: 'customers.read',
  // Operational customer actions — internal notes, safe profile edits, and
  // ACTIVE<->SUSPENDED. Identity-sensitive; a rung above ordinary support
  // read access (§27). Verified email/phone are NEVER editable here (§20).
  CUSTOMERS_MANAGE: 'customers.manage',

  // Marketing operations (Wave 8G) — subscribers, consent visibility,
  // suppression, and (8G-6/8G-7) promotions, templates, broadcasts.
  // `marketing.send` (actual bulk dispatch) is a separate gate added later.
  MARKETING_READ: 'marketing.read',
  MARKETING_MANAGE: 'marketing.manage',
  CONSENT_READ: 'consent.read',

  // Support / customer service (Wave 8G). `support.manage` covers assign /
  // reply / notes / priority / status — it never grants order or refund
  // mutation (§59).
  SUPPORT_READ: 'support.read',
  SUPPORT_MANAGE: 'support.manage',

  // Product reviews (Wave 8G). Moderation moves status only — it never edits
  // the customer's text (§72).
  REVIEWS_READ: 'reviews.read',
  REVIEWS_MODERATE: 'reviews.moderate',

  // Customer segments (Wave 8G). Saved whitelisted rule definitions used for
  // marketing audiences, promotion eligibility and customer ops. `manage`
  // covers create / edit-revision / snapshot; the CMS never submits SQL (§87).
  SEGMENTS_READ: 'segments.read',
  SEGMENTS_MANAGE: 'segments.manage',

  // Promotions + coupons (Wave 8G). Backend-authoritative pricing rules —
  // `manage` covers create / edit / issue-coupon / pause. Money is always
  // computed server-side; a coupon code is the only thing the client sends.
  PROMOTIONS_READ: 'promotions.read',
  PROMOTIONS_MANAGE: 'promotions.manage',

  // Communication orchestration (Wave 8G). `comms.manage` covers templates +
  // broadcast configuration; `marketing.send` is the separate, higher gate for
  // actually executing a bulk broadcast. Auth OTP is never part of this.
  COMMS_READ: 'comms.read',
  COMMS_MANAGE: 'comms.manage',
  MARKETING_SEND: 'marketing.send',

  CONTENT_READ: 'content.read',
  CONTENT_WRITE: 'content.write',
  // Publishing / scheduling / rolling back global storefront content
  // (navigation, homepage, footer, campaigns) is higher-impact than
  // ordinary content editing — Wave 8E §97/§98.
  CONTENT_PUBLISH: 'content.publish',

  STAFF_READ: 'staff.read',
  STAFF_MANAGE: 'staff.manage',

  // Cross-cutting staff activity trail (WP-12 / GAP-ORD-06). `staff_audit_logs`
  // is written by every admin module; this gates the read-only viewer that
  // finally surfaces it. SUPER_ADMIN-only (business rule 2026-09-04) — not held
  // by ADMIN or any other role. SUPER_ADMIN gets it via ALL_PERMISSIONS.
  AUDIT_READ: 'audit.read',

  SETTINGS_READ: 'settings.read',
  SETTINGS_MANAGE: 'settings.manage',

  // Company-level financial configuration (HSN / GST rates). Not for warehouse
  // packing staff.
  TAX_READ: 'tax.read',
  TAX_MANAGE: 'tax.manage',

  // Reporting & reconciliation (Wave 8H). `reports.read` = operational
  // dashboards / sales / inventory / logistics. `finance.read` is the higher
  // gate for payment / refund / COD / store-credit / reconciliation reports.
  // `reports.export` gates CSV downloads of detail data. `reconciliation.manage`
  // gates working an exception + importing a settlement file. Reports never
  // write business data.
  REPORTS_READ: 'reports.read',
  FINANCE_READ: 'finance.read',

  // Payment monitoring + COD policy control (2026-09-09). Turning COD on or
  // off, and blocking it for a PIN, decides whether money is collected at the
  // door — a business decision, not an operational one. SUPER_ADMIN-only by
  // request: granted through ALL_PERMISSIONS and deliberately absent from
  // every other role's list, exactly like AUDIT_READ.
  PAYMENTS_MANAGE: 'payments.manage',
  REPORTS_EXPORT: 'reports.export',
  RECONCILIATION_MANAGE: 'reconciliation.manage',

  // Provider & platform operations (Wave 8I). `providers.read` = the
  // operational control plane (overview / config / health / webhook inbox /
  // outbox / attempts — all read-only). `providers.manage` gates non-secret
  // config changes (enable / disable / priority / routing bag / rollback).
  // Webhook replay and outbox retry are separate, narrower high-risk gates
  // (§48/§86/§87). Provider secrets are NEVER in this surface.
  PROVIDERS_READ: 'providers.read',
  PROVIDERS_MANAGE: 'providers.manage',
  PROVIDER_WEBHOOKS_REPLAY: 'provider.webhooks.replay',
  PROVIDER_OPERATIONS_RETRY: 'provider.operations.retry',

  // Careers — job postings + candidate applications (2026-09-04). `manage`
  // covers create/edit/publish/close a posting, and status/notes/assignment/
  // outbound email on an application. Resume access is gated by `.read`
  // (same as opening the application) — never a separate, looser gate.
  CAREERS_READ: 'careers.read',
  CAREERS_MANAGE: 'careers.manage',
});

export const STAFF_ROLES = Object.freeze([
  'SUPER_ADMIN',
  'ADMIN',
  'CATALOG_MANAGER',
  'OPERATIONS',
  'SUPPORT',
  'VIEWER',
]);

const P = PERMISSIONS;
const ALL_PERMISSIONS = Object.freeze(Object.values(P));
const ALL_READS = Object.freeze(Object.values(P).filter((p) => p.endsWith('.read')));

// Centralised role -> permission mapping. Adjust here only; nothing else in
// the codebase (and nothing in the frontend) redefines authority.
const ROLE_PERMISSIONS = Object.freeze({
  SUPER_ADMIN: ALL_PERMISSIONS,

  ADMIN: Object.freeze([
    P.CMS_ACCESS,
    P.CATALOG_READ, P.CATALOG_WRITE,
    P.INVENTORY_READ, P.INVENTORY_ADJUST,
    P.WAREHOUSE_READ, P.WAREHOUSE_MANAGE,
    P.ORDERS_READ, P.ORDERS_MANAGE,
    P.FULFILLMENT_READ, P.FULFILLMENT_MANAGE,
    P.RETURNS_READ, P.RETURNS_MANAGE, P.RETURNS_REFUND,
    P.CUSTOMERS_READ, P.CUSTOMERS_MANAGE,
    P.MARKETING_READ, P.MARKETING_MANAGE, P.CONSENT_READ,
    P.SUPPORT_READ, P.SUPPORT_MANAGE,
    P.REVIEWS_READ, P.REVIEWS_MODERATE,
    P.SEGMENTS_READ, P.SEGMENTS_MANAGE,
    P.PROMOTIONS_READ, P.PROMOTIONS_MANAGE,
    P.COMMS_READ, P.COMMS_MANAGE, P.MARKETING_SEND,
    P.CONTENT_READ, P.CONTENT_WRITE, P.CONTENT_PUBLISH,
    P.REPORTS_READ, P.FINANCE_READ, P.REPORTS_EXPORT, P.RECONCILIATION_MANAGE,
    P.PROVIDERS_READ, P.PROVIDERS_MANAGE, P.PROVIDER_WEBHOOKS_REPLAY, P.PROVIDER_OPERATIONS_RETRY,
    P.STAFF_READ,
    // Business rule (2026-09-05): an ADMIN may create/manage ordinary staff
    // (CATALOG_MANAGER/OPERATIONS/SUPPORT/VIEWER) — never another ADMIN or
    // SUPER_ADMIN account. staff.manage's own service-layer role-ceiling
    // check (ADMIN_CEILING_ROLES, staff/service.js) is what actually
    // enforces that ceiling on every create/status/role/password-reset/
    // brand-access call; only a real company owner (SUPER_ADMIN) can create
    // or touch an ADMIN-tier account.
    P.STAFF_MANAGE,
    // audit.read is SUPER_ADMIN-only (business rule 2026-09-04) — the full
    // administrative trail is a privileged oversight surface. SUPER_ADMIN gets
    // it via ALL_PERMISSIONS; no other role carries it.
    P.SETTINGS_READ,
    P.TAX_READ, P.TAX_MANAGE,
    P.CAREERS_READ, P.CAREERS_MANAGE,
  ]),

  CATALOG_MANAGER: Object.freeze([
    P.CMS_ACCESS,
    P.CATALOG_READ, P.CATALOG_WRITE,
    P.INVENTORY_READ,
    // Reviews attach to catalog products — the catalog owner moderates them
    // (§160: review moderation only where explicitly permitted).
    P.REVIEWS_READ, P.REVIEWS_MODERATE,
    P.CONTENT_READ, P.CONTENT_WRITE,
    P.SETTINGS_READ,
    P.TAX_READ,
  ]),

  OPERATIONS: Object.freeze([
    P.CMS_ACCESS,
    P.CATALOG_READ,
    P.INVENTORY_READ, P.INVENTORY_ADJUST,
    P.ORDERS_READ, P.ORDERS_MANAGE,
    P.FULFILLMENT_READ, P.FULFILLMENT_MANAGE,
    // Operational returns lifecycle, but NOT returns.refund (§109).
    P.RETURNS_READ, P.RETURNS_MANAGE,
    P.CUSTOMERS_READ, P.CUSTOMERS_MANAGE,
    P.CONSENT_READ,
    P.SUPPORT_READ, P.SUPPORT_MANAGE,
    P.REVIEWS_READ, P.REVIEWS_MODERATE,
    P.SEGMENTS_READ,
    P.PROMOTIONS_READ,
    P.COMMS_READ,
    P.REPORTS_READ,
    P.PROVIDERS_READ,
    P.SETTINGS_READ,
    P.CAREERS_READ, P.CAREERS_MANAGE,
  ]),

  SUPPORT: Object.freeze([
    P.CMS_ACCESS,
    P.CATALOG_READ,
    P.INVENTORY_READ,
    P.ORDERS_READ,
    P.FULFILLMENT_READ,
    P.RETURNS_READ,
    P.CUSTOMERS_READ,
    P.CONSENT_READ,
    P.SUPPORT_READ, P.SUPPORT_MANAGE,
    P.REVIEWS_READ,
    P.CAREERS_READ,
  ]),

  // Read-everything EXCEPT staff.read — staff identity/roster visibility is
  // a privileged concern, so VIEWER is a clean negative case for the
  // permission-denied (403) path.
  VIEWER: Object.freeze([P.CMS_ACCESS, ...ALL_READS.filter((p) => p !== P.STAFF_READ && p !== P.FINANCE_READ && p !== P.AUDIT_READ)]),
});

export function isValidRole(role) {
  return STAFF_ROLES.includes(role);
}

/** @returns {string[]} the resolved permission list for a role (empty for an unknown role). */
export function resolvePermissions(role) {
  return [...(ROLE_PERMISSIONS[role] || [])];
}

// Multi-company (DESIGN.md §5.2/§8, Phase 5) — "staff_brand_access.role +
// overrides" enforced in requireStaffPermission. `overrides` is the
// per-(staff, brand) `permission_overrides_json` column: null/absent means
// "just the role's own permissions" (today's behaviour for every existing
// grant — nobody has an override yet). When present, `{ grant, revoke }`
// additively grants specific extra permissions beyond the role's base set,
// or revokes ones the role would otherwise have — a narrow, explicit
// escape hatch, never a second role system.
export function resolveEffectivePermissions(role, overrides = null) {
  const base = new Set(resolvePermissions(role));
  if (overrides?.grant) for (const p of overrides.grant) base.add(p);
  if (overrides?.revoke) for (const p of overrides.revoke) base.delete(p);
  return [...base];
}

export function roleHasPermission(role, permission) {
  return (ROLE_PERMISSIONS[role] || []).includes(permission);
}

/** Is this a real permission string? Used to validate a company-access
 * override's grant/revoke lists (Phase 6 User Management UI) before they
 * ever reach the database. */
export function isValidPermission(permission) {
  return ALL_PERMISSIONS.includes(permission);
}
