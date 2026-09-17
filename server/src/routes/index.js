import { Router } from 'express';
import { isDatabaseConnected } from '../database/connection/pool.js';
import { resolveStorefrontBrand } from '../middleware/resolveStorefrontBrand.js';

import brandsRoutes from '../modules/brands/routes.js';
import authRoutes from '../modules/auth/routes.js';
import usersRoutes from '../modules/users/routes.js';
import rolesRoutes from '../modules/roles/routes.js';
import mediaRoutes from '../modules/media/routes.js';
import sitemapRoutes from '../modules/seo/sitemap.js';
import productsRoutes from '../modules/products/routes.js';
import collectionsRoutes from '../modules/collections/routes.js';
import searchRoutes from '../modules/search/routes.js';
import sizeGuidesRoutes from '../modules/sizeGuides/routes.js';
import addressesRoutes from '../modules/addresses/routes.js';
import customersRoutes from '../modules/customers/routes.js';
import ordersRoutes from '../modules/orders/routes.js';
import returnsRoutes from '../modules/returns/routes.js';
import storeCreditRoutes from '../modules/storeCredit/routes.js';
import newsletterRoutes from '../modules/newsletter/routes.js';
import consentUnsubscribeRoutes from '../modules/consent/unsubscribeRoutes.js';
import careersRoutes from '../modules/careers/routes.js';
import supportRoutes from '../modules/support/routes.js';
import reviewRoutes from '../modules/reviews/routes.js';
import communicationRoutes from '../modules/communications/routes.js';
import contentRoutes from '../modules/content/routes.js';
import cartRoutes from '../modules/cart/routes.js';
import checkoutRoutes from '../modules/checkout/routes.js';
import shippingRoutes from '../modules/shipping/routes.js';
import paymentRoutes from '../modules/payments/routes.js';
import platformWebhookRoutes from '../modules/platform/routes.js';
import adminRoutes from '../modules/staff/routes.js';
import geoRoutes from '../modules/geo/routes.js';

const router = Router();

/**
 * Never requires a live database connection — reports db status instead
 * of failing, so the frontends can distinguish "API is up, DB is down"
 * from "API is unreachable".
 * @type {import('@cor-group/shared-types').HealthResponse}
 */
router.get('/health', async (req, res) => {
  const connected = await isDatabaseConnected();
  res.json({
    status: 'ok',
    service: 'cor-group-server',
    timestamp: new Date().toISOString(),
    db: connected ? 'connected' : 'not_connected',
  });
});

// Wave 8J-1 — split probes. Liveness = "the event loop is up" (never touches
// the DB, so a k8s/systemd restarter doesn't kill a healthy process during a
// brief DB blip). Readiness = "safe to route critical traffic here" and does
// require the DB. Neither leaks config.
router.get('/health/live', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});
router.get('/health/ready', async (req, res) => {
  const connected = await isDatabaseConnected();
  res.status(connected ? 200 : 503).json({
    status: connected ? 'ready' : 'not_ready',
    checks: { database: connected ? 'ok' : 'unavailable' },
  });
});

// Multi-company (DESIGN.md §5.1) — Phase 4. Resolves req.brandId/req.brand
// from the request's Origin/Host before any storefront route runs. Skips
// /admin and /platform internally (see the middleware's own header comment).
router.use(resolveStorefrontBrand);

router.use('/brands', brandsRoutes);
router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/roles', rolesRoutes);
router.use('/media', mediaRoutes);
router.use('/products', productsRoutes);
router.use('/', sitemapRoutes);
router.use('/collections', collectionsRoutes);
router.use('/search', searchRoutes);
router.use('/size-guides', sizeGuidesRoutes);
router.use('/addresses', addressesRoutes);
// Reference geography for the address forms. Public: the checkout needs it
// before anyone signs in.
router.use('/geo', geoRoutes);
router.use('/customers', customersRoutes);
router.use('/orders', ordersRoutes);
router.use('/returns', returnsRoutes);
router.use('/store-credit', storeCreditRoutes);
router.use('/newsletter', newsletterRoutes);
router.use('/consent', consentUnsubscribeRoutes);
router.use('/careers', careersRoutes);
router.use('/support', supportRoutes);
router.use('/reviews', reviewRoutes);
router.use('/communications', communicationRoutes);
router.use('/content', contentRoutes);
router.use('/cart', cartRoutes);
router.use('/checkout', checkoutRoutes);
router.use('/shipping', shippingRoutes);
router.use('/payments', paymentRoutes);
router.use('/platform', platformWebhookRoutes);

// Privileged CMS/admin surface — separate namespace, staff-session
// authenticated, backend RBAC enforced (Wave 8A). Never mix storefront
// mutation routes in here.
router.use('/admin', adminRoutes);

export default router;
