import { Router } from 'express';
import * as staffController from './controller.js';
import { AppError } from '../../utils/errors.js';
import { authenticateStaff } from '../../middleware/authenticateStaff.js';
import { resolveBrandContext } from '../../middleware/resolveBrandContext.js';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { cmsOriginGuard } from '../../middleware/cmsOriginGuard.js';
import { staffLoginLimiter } from '../../middleware/authRateLimit.js';
import { PERMISSIONS } from './permissions.js';
import adminCatalogRoutes from '../adminCatalog/routes.js';
import catalogSkuRoutes from '../catalogSku/routes.js';
import adminContentRoutes from '../adminContent/routes.js';
import adminWarehouseRoutes from '../adminWarehouses/routes.js';
import adminShippingRoutes from '../adminShipping/routes.js';
import adminPaymentsRoutes from '../adminPayments/routes.js';
import adminInventoryRoutes from '../adminInventory/routes.js';
import warehouseTransferRoutes from '../warehouseTransfers/routes.js';
import inventoryQuarantineRoutes from '../inventoryQuarantine/routes.js';
import orderOpsRoutes from '../orderOps/routes.js';
import fulfillmentAdminRoutes from '../fulfillment/adminRoutes.js';
import returnsAdminRoutes from '../returns/adminRoutes.js';
import customerAdminRoutes from '../customers/adminRoutes.js';
import newsletterAdminRoutes from '../newsletter/adminRoutes.js';
import supportAdminRoutes from '../support/adminRoutes.js';
import internalChatRoutes from '../internalChat/adminRoutes.js';
import reviewAdminRoutes from '../reviews/adminRoutes.js';
import segmentAdminRoutes from '../segments/adminRoutes.js';
import promotionAdminRoutes from '../promotions/adminRoutes.js';
import communicationAdminRoutes from '../communications/adminRoutes.js';
import marketingCampaignAdminRoutes from '../marketingCampaigns/adminRoutes.js';
import careersAdminRoutes from '../careers/adminRoutes.js';
import notificationAdminRoutes from '../notifications/adminRoutes.js';
import staffNotificationRoutes from '../staffNotifications/adminRoutes.js';
import reportingAdminRoutes from '../reporting/adminRoutes.js';
import heroBannerAdminRoutes from '../heroBanners/adminRoutes.js';
import platformAdminRoutes from '../platform/adminRoutes.js';
import instagramAdminRoutes from '../instagram/adminRoutes.js';
import adminAuditRoutes from '../adminAudit/routes.js';
import opsRoutes from '../ops/routes.js';
import documentRoutes from '../documents/routes.js';
import taxRoutes from '../tax/routes.js';
import companyAdminRoutes from '../company/adminRoutes.js';

// Privileged admin surface — the umbrella router for /api/v1/admin. Kept
// entirely separate from the public storefront routers in routes/index.js.
// Applies cmsOriginGuard + staff-session auth once, then mounts the staff
// routes and each admin feature module (Product Studio, Wave 8B).
const router = Router();

router.use(cmsOriginGuard);

// Public (pre-session) — rate limited, generic failures.
router.post('/auth/login', staffLoginLimiter, staffController.login);

// Everything below requires a valid, server-validated staff session.
router.use(authenticateStaff);

// Multi-company CMS (DESIGN.md §5.1) — Phase 2, advisory-only (see the
// module for what that means). Resolves req.brandId/req.brand/req.brandScope
// /req.accessibleBrands on every admin request; /me and the switcher below
// are its first real consumers.
router.use(resolveBrandContext);

router.post('/auth/logout', staffController.logout);
router.get('/me', staffController.me);

// First-login forced password change. Allowed even while must_change_password
// is set (it is how the flag gets cleared).
router.post('/auth/change-password', staffController.changePassword);

// Gate: an account with a temporary password can read /me + change its
// password + log out, and nothing else, until it sets its own password. The
// backend is the authority — a client that skips the CMS screen still can't
// reach any feature route.
router.use((req, res, next) => {
  if (!req.staff?.mustChangePassword) return next();
  const allowed = ['/me', '/auth/change-password', '/auth/logout'];
  if (allowed.includes(req.path)) return next();
  return next(new AppError('PASSWORD_CHANGE_REQUIRED', 'You must set a new password before continuing.', 403));
});

// Company switcher (DESIGN.md §6) — PUT so it's an idempotent "set the
// session's current company", not an action verb. A feature route like any
// other: gated behind the forced-password-change check above like
// everything else past this point.
router.put('/session/brand', staffController.switchBrand);

// Staff roster + management (Settings > User Management, Phase 6). Every
// authorization rule (role ceiling, owner immutability, SUPER_ADMIN
// singleton) lives in staffAuthService, not here — this is thin HTTP
// wiring only.
router.get('/staff', requireStaffPermission(PERMISSIONS.STAFF_READ), staffController.listStaff);
router.post('/staff', requireStaffPermission(PERMISSIONS.STAFF_MANAGE), staffController.createStaff);
router.patch('/staff/:id/status', requireStaffPermission(PERMISSIONS.STAFF_MANAGE), staffController.setStaffStatus);
router.patch('/staff/:id/role', requireStaffPermission(PERMISSIONS.STAFF_MANAGE), staffController.changeStaffRole);
router.post('/staff/reset-password', requireStaffPermission(PERMISSIONS.STAFF_MANAGE), staffController.resetStaffPassword);

// Per-company access grants — the actual Phase 5/6 multi-company piece:
// staff_brand_access.role + permission_overrides_json, per (staff, brand).
// DESIGN.md §3.2: SUPER_ADMIN is the only role that may edit
// staff_brand_access at all — stricter than the general staff.manage gate
// above (which an ADMIN now also holds, business rule 2026-09-05, for
// ordinary staff create/status/role only), so this is a separate,
// explicit role check rather than a permission.
function requireSuperAdmin(req, _res, next) {
  if (req.staff?.role !== 'SUPER_ADMIN') {
    return next(new AppError('SUPER_ADMIN_REQUIRED', 'Only the company owner can manage per-company access grants.', 403));
  }
  next();
}
router.get('/staff/:id/brand-access', requireStaffPermission(PERMISSIONS.STAFF_MANAGE), requireSuperAdmin, staffController.getStaffBrandAccess);
router.put('/staff/:id/brand-access/:brandId', requireStaffPermission(PERMISSIONS.STAFF_MANAGE), requireSuperAdmin, staffController.grantStaffBrandAccess);
router.delete('/staff/:id/brand-access/:brandId', requireStaffPermission(PERMISSIONS.STAFF_MANAGE), requireSuperAdmin, staffController.revokeStaffBrandAccess);

// Wave 8B — Product Studio (catalog.read / catalog.write enforced within).
router.use(adminCatalogRoutes);
// Phase 1B — canonical SKU identity (options / preview / migration readiness).
router.use(catalogSkuRoutes);

// Wave 8E — Content & Experience CMS (content.read / .write / .publish).
router.use(adminContentRoutes);

// Multi-warehouse commerce — CMS Warehouses module (warehouse.* / inventory.*).
router.use(adminWarehouseRoutes);
router.use(adminShippingRoutes);
// COD policy control + payment monitoring (payments.manage — SUPER_ADMIN only).
router.use(adminPaymentsRoutes);
// Standalone Inventory — cross-warehouse search + movement history + low-stock
// thresholds (inventory.read / inventory.adjust).
router.use(adminInventoryRoutes);
// Inter-warehouse transfers — DRAFT -> DISPATCHED -> RECEIVED, moving real
// on-hand between warehouses (inventory.read / inventory.adjust).
router.use(warehouseTransferRoutes);
// QC-FAIL quarantine — the non_sellable bucket: view batches, release back to
// sellable or scrap (inventory.read / inventory.adjust).
router.use(inventoryQuarantineRoutes);

// Order operations — confirm / process orders, book shipments (orders.* / fulfillment.*).
router.use(orderOpsRoutes);
// Standalone Fulfillment — list / detail / state transitions (fulfillment.read / .manage).
router.use(fulfillmentAdminRoutes);

// Returns & Exchanges — inbox / detail / lifecycle actions (returns.* / returns.refund).
router.use(returnsAdminRoutes);

// Customer operations — unified read model + notes + status (customers.* ).
router.use(customerAdminRoutes);

// Newsletter subscribers + marketing suppression (marketing.* ).
router.use(newsletterAdminRoutes);

// Support / customer service (support.* ).
router.use(supportAdminRoutes);

// Internal staff-to-staff messaging — the Communications hub's Internal Chat
// (cms.access gated; per-conversation access is participant membership).
router.use(internalChatRoutes);

// Product reviews + moderation (reviews.read / reviews.moderate).
router.use(reviewAdminRoutes);

// Customer segments — saved whitelisted rule definitions (segments.*).
router.use(segmentAdminRoutes);

// Promotions + coupons — backend-authoritative pricing rules (promotions.*).
router.use(promotionAdminRoutes);

// Communication orchestration — templates + broadcasts (comms.* / marketing.send).
router.use(communicationAdminRoutes);
// Abandoned-cart recovery campaigns (comms.read / comms.manage).
// Offer / New Collection campaigns + reusable audience lists
// (marketing.read / marketing.manage; sending needs marketing.send).
router.use(marketingCampaignAdminRoutes);
// Careers — job postings + applications (careers.read / careers.manage).
router.use(careersAdminRoutes);
// Lifecycle-notification catalogue — read-only view of which order-lifecycle
// events have an ACTIVE template (comms.read).
router.use(notificationAdminRoutes);
// Staff notification feed — the real backing store for the CMS topbar bell
// (broadcast operational events + per-staff read state). Any authenticated
// staff member; written fire-and-forget by domain flows.
router.use(staffNotificationRoutes);

// Reporting + reconciliation (reports.* / finance.read / reconciliation.manage).
router.use(reportingAdminRoutes);
router.use(heroBannerAdminRoutes);

// Provider & platform operations — config / health / webhook inbox / outbox /
// attempts (providers.* / provider.webhooks.replay / provider.operations.retry).
router.use(instagramAdminRoutes);
router.use(platformAdminRoutes);

// Cross-cutting staff audit trail — read-only viewer (audit.read).
router.use(adminAuditRoutes);

// Operational metrics (Wave 8J) — cms.access gated.
router.use(opsRoutes);

// Documents (invoice / packing slip / label) + printing.
router.use(documentRoutes);

// Tax profiles — HSN / GST rate configuration.
router.use(taxRoutes);

// Settings > Company Profile — per-company legal identity (DESIGN.md §6, Phase 6).
router.use(companyAdminRoutes);

export default router;
