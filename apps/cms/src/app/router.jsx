import { Fragment, lazy } from 'react';
import { createBrowserRouter, createRoutesFromElements, Navigate, Route, RouterProvider, useParams } from 'react-router-dom';
import { RequireStaff } from '../auth/RequireStaff.jsx';
import { RouteError } from './RouteError.jsx';
import { RequirePermission } from '../auth/RequirePermission.jsx';
import { AdminLayout } from '../layout/AdminLayout.jsx';
import LoginPage from '../pages/LoginPage.jsx';
import UnauthorizedPage from '../pages/UnauthorizedPage.jsx';
import NotFoundPage from '../pages/NotFoundPage.jsx';

// Each page is its own chunk, loaded when its route is first opened. The whole
// admin used to ship as one ~1.1 MB script, so the login screen downloaded
// every page. AdminLayout wraps the routed page in <Suspense>; a chunk that
// fails to load (e.g. an old tab after a deploy) lands on RouteError, which
// offers a reload.
const DashboardPage = lazy(() => import('../pages/DashboardPage.jsx'));
const StaffPage = lazy(() => import('../pages/StaffPage.jsx'));
const SettingsPage = lazy(() => import('../pages/SettingsPage.jsx'));
const AuditLogPage = lazy(() => import('../pages/AuditLogPage.jsx'));
const NotificationsPage = lazy(() => import('../pages/NotificationsPage.jsx'));
const ProductsPage = lazy(() => import('../pages/ProductsPage.jsx'));
const ProductNewPage = lazy(() => import('../pages/ProductNewPage.jsx'));
const ProductEditorPage = lazy(() => import('../pages/ProductEditorPage.jsx'));
const CategoriesPage = lazy(() => import('../pages/CategoriesPage.jsx'));
const CollectionsPage = lazy(() => import('../pages/CollectionsPage.jsx'));
const SizeGuidesPage = lazy(() => import('../pages/SizeGuidesPage.jsx'));
const MediaLibraryPage = lazy(() => import('../pages/MediaLibraryPage.jsx'));
const ContentExperiencePage = lazy(() => import('../pages/ContentExperiencePage.jsx'));
const ContentPagesPage = lazy(() => import('../pages/ContentPagesPage.jsx'));
const ContentCampaignsPage = lazy(() => import('../pages/ContentCampaignsPage.jsx'));
const WarehousesPage = lazy(() => import('../pages/WarehousesPage.jsx'));
const WarehouseDetailPage = lazy(() => import('../pages/WarehouseDetailPage.jsx'));
const InventoryPage = lazy(() => import('../pages/InventoryPage.jsx'));
const TransfersPage = lazy(() => import('../pages/TransfersPage.jsx'));
const QuarantinePage = lazy(() => import('../pages/QuarantinePage.jsx'));
const FulfillmentPage = lazy(() => import('../pages/FulfillmentPage.jsx'));
const OrdersPage = lazy(() => import('../pages/OrdersPage.jsx'));
const OrderDetailPage = lazy(() => import('../pages/OrderDetailPage.jsx'));
const ReturnsPage = lazy(() => import('../pages/ReturnsPage.jsx'));
const ReturnDetailPage = lazy(() => import('../pages/ReturnDetailPage.jsx'));
const QcQuestionsPage = lazy(() => import('../pages/QcQuestionsPage.jsx'));
const CustomersPage = lazy(() => import('../pages/CustomersPage.jsx'));
const CustomerDetailPage = lazy(() => import('../pages/CustomerDetailPage.jsx'));
const SubscribersPage = lazy(() => import('../pages/SubscribersPage.jsx'));
const CareersPage = lazy(() => import('../pages/CareersPage.jsx'));
const CareerApplicationDetailPage = lazy(() => import('../pages/CareerApplicationDetailPage.jsx'));
const ReviewsPage = lazy(() => import('../pages/ReviewsPage.jsx'));
const ReviewDetailPage = lazy(() => import('../pages/ReviewDetailPage.jsx'));
const SegmentsPage = lazy(() => import('../pages/SegmentsPage.jsx'));
const SegmentDetailPage = lazy(() => import('../pages/SegmentDetailPage.jsx'));
const PromotionsPage = lazy(() => import('../pages/PromotionsPage.jsx'));
const PromotionDetailPage = lazy(() => import('../pages/PromotionDetailPage.jsx'));
const CommunicationsPage = lazy(() => import('../pages/CommunicationsPage.jsx'));
const ReportsPage = lazy(() => import('../pages/ReportsPage.jsx'));
const ReconciliationPage = lazy(() => import('../pages/ReconciliationPage.jsx'));
const PaymentsPage = lazy(() => import('../pages/PaymentsPage.jsx'));
const ProvidersPage = lazy(() => import('../pages/ProvidersPage.jsx'));
const TaxProfilesPage = lazy(() => import('../pages/TaxProfilesPage.jsx'));
const MessagingPage = lazy(() => import('../pages/messaging/MessagingPage.jsx'));
const CampaignBuilder = lazy(() => import('../pages/messaging/CampaignBuilder.jsx'));
const CampaignDetail = lazy(() => import('../pages/messaging/CampaignDetail.jsx'));
const CartRecoveryPage = lazy(() => import('../pages/messaging/CartRecoveryPage.jsx'));

// Moving between two records of the same kind (/promotions/A -> /promotions/B)
// keeps a detail page mounted with only :id changed. Its data was fetched for
// A and its form state belongs to A, yet Save wrote to whichever id the stale
// closures held — the page showed one record under another's URL. A fresh
// mount per id gives every detail page the right record and clean state.
function ByRouteId({ children }) {
  const { id } = useParams();
  return <Fragment key={id}>{children}</Fragment>;
}

// Legacy /support/:id deep links now open the ticket inside the Communications hub.
function SupportRedirect() {
  const { id } = useParams();
  return <Navigate to={`/communications?c=${id}`} replace />;
}

// Frontend routing is UX only. Every privileged call the pages below make
// is independently authenticated + permission-checked by the backend.
//
// Data router (createBrowserRouter) — required so the product editor can use
// `useBlocker` for unsaved-changes protection. The route tree is unchanged
// from the previous <Routes> form.
const router = createBrowserRouter(
  createRoutesFromElements(
    <Route errorElement={<RouteError />}>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <RequireStaff>
            <AdminLayout />
          </RequireStaff>
        }
      >
        <Route errorElement={<RouteError />}>
          <Route index element={<DashboardPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route
          path="products"
          element={<RequirePermission permission="catalog.read"><ProductsPage /></RequirePermission>}
        />
        <Route
          path="products/new"
          element={<RequirePermission permission="catalog.write"><ProductNewPage /></RequirePermission>}
        />
        <Route
          path="products/:id"
          element={<RequirePermission permission="catalog.read"><ByRouteId><ProductEditorPage /></ByRouteId></RequirePermission>}
        />
        <Route
          path="catalog/categories"
          element={<RequirePermission permission="catalog.read"><CategoriesPage /></RequirePermission>}
        />
        <Route
          path="catalog/collections"
          element={<RequirePermission permission="catalog.read"><CollectionsPage /></RequirePermission>}
        />
        <Route
          path="catalog/size-guides"
          element={<RequirePermission permission="catalog.read"><SizeGuidesPage /></RequirePermission>}
        />
        <Route
          path="media"
          element={<RequirePermission permission="catalog.read"><MediaLibraryPage /></RequirePermission>}
        />
        <Route
          path="content/experience"
          element={<RequirePermission permission="content.read"><ContentExperiencePage /></RequirePermission>}
        />
        <Route
          path="content/policies"
          element={<RequirePermission permission="content.read"><ContentPagesPage /></RequirePermission>}
        />
        <Route
          path="content/campaigns"
          element={<RequirePermission permission="content.read"><ContentCampaignsPage /></RequirePermission>}
        />
        <Route
          path="warehouses"
          element={<RequirePermission permission="warehouse.read"><WarehousesPage /></RequirePermission>}
        />
        <Route
          path="warehouses/:id"
          element={<RequirePermission permission="warehouse.read"><ByRouteId><WarehouseDetailPage /></ByRouteId></RequirePermission>}
        />
        <Route
          path="inventory"
          element={<RequirePermission permission="inventory.read"><InventoryPage /></RequirePermission>}
        />
        <Route
          path="transfers"
          element={<RequirePermission permission="inventory.read"><TransfersPage /></RequirePermission>}
        />
        <Route
          path="quarantine"
          element={<RequirePermission permission="inventory.read"><QuarantinePage /></RequirePermission>}
        />
        <Route
          path="fulfillment"
          element={<RequirePermission permission="fulfillment.read"><FulfillmentPage /></RequirePermission>}
        />
        <Route
          path="orders"
          element={<RequirePermission permission="orders.read"><OrdersPage /></RequirePermission>}
        />
        <Route
          path="orders/:id"
          element={<RequirePermission permission="orders.read"><ByRouteId><OrderDetailPage /></ByRouteId></RequirePermission>}
        />
        <Route
          path="returns"
          element={<RequirePermission permission="returns.read"><ReturnsPage /></RequirePermission>}
        />
        <Route
          path="returns/:id"
          element={<RequirePermission permission="returns.read"><ByRouteId><ReturnDetailPage /></ByRouteId></RequirePermission>}
        />
        <Route
          path="rvp-qc-questions"
          element={<RequirePermission permission="returns.read"><QcQuestionsPage /></RequirePermission>}
        />
        <Route
          path="customers"
          element={<RequirePermission permission="customers.read"><CustomersPage /></RequirePermission>}
        />
        <Route
          path="customers/:id"
          element={<RequirePermission permission="customers.read"><ByRouteId><CustomerDetailPage /></ByRouteId></RequirePermission>}
        />
        <Route
          path="subscribers"
          element={<RequirePermission permission="marketing.read"><SubscribersPage /></RequirePermission>}
        />
        {/* Support Tickets merged into the Communications hub (2026-09-04). */}
        <Route path="support" element={<Navigate to="/communications" replace />} />
        <Route path="support/:id" element={<SupportRedirect />} />
        <Route
          path="reviews"
          element={<RequirePermission permission="reviews.read"><ReviewsPage /></RequirePermission>}
        />
        <Route
          path="reviews/:id"
          element={<RequirePermission permission="reviews.read"><ByRouteId><ReviewDetailPage /></ByRouteId></RequirePermission>}
        />
        <Route
          path="segments"
          element={<RequirePermission permission="segments.read"><SegmentsPage /></RequirePermission>}
        />
        <Route
          path="segments/:id"
          element={<RequirePermission permission="segments.read"><ByRouteId><SegmentDetailPage /></ByRouteId></RequirePermission>}
        />
        <Route
          path="promotions"
          element={<RequirePermission permission="promotions.read"><PromotionsPage /></RequirePermission>}
        />
        <Route
          path="promotions/:id"
          element={<RequirePermission permission="promotions.read"><ByRouteId><PromotionDetailPage /></ByRouteId></RequirePermission>}
        />
        <Route
          path="communications"
          element={<RequirePermission permission="cms.access"><CommunicationsPage /></RequirePermission>}
        />
        {/* Messaging (docs/MESSAGING.md): campaigns, email and WhatsApp templates. */}
        <Route path="messaging" element={<Navigate to="/marketing/campaigns" replace />} />
        <Route
          path="messaging/campaigns/new"
          element={<RequirePermission permission="marketing.manage"><CampaignBuilder key="new" /></RequirePermission>}
        />
        <Route
          path="messaging/campaigns/:id/edit"
          element={<RequirePermission permission="marketing.manage"><ByRouteId><CampaignBuilder /></ByRouteId></RequirePermission>}
        />
        <Route
          path="messaging/campaigns/:id"
          element={<RequirePermission permission="marketing.read"><ByRouteId><CampaignDetail /></ByRouteId></RequirePermission>}
        />
        {/* Marketing → Campaigns and Marketing → Abandoned Carts: two separate
            sections at their original addresses. */}
        <Route
          path="marketing/campaigns"
          element={<RequirePermission permission="comms.read"><MessagingPage /></RequirePermission>}
        />
        <Route
          path="marketing/abandoned-carts"
          element={<RequirePermission permission="marketing.read"><CartRecoveryPage /></RequirePermission>}
        />
        <Route path="communications/templates" element={<Navigate to="/marketing/campaigns?tab=email" replace />} />
        <Route
          path="careers"
          element={<RequirePermission permission="careers.read"><CareersPage /></RequirePermission>}
        />
        <Route
          path="careers/applications/:id"
          element={<RequirePermission permission="careers.read"><ByRouteId><CareerApplicationDetailPage /></ByRouteId></RequirePermission>}
        />
        <Route path="reports" element={<RequirePermission permission="reports.read"><ReportsPage /></RequirePermission>} />
        <Route path="reconciliation" element={<RequirePermission permission="finance.read"><ReconciliationPage /></RequirePermission>} />
        {/* Payment monitoring + COD control. `payments.manage` is held only by
            SUPER_ADMIN; the backend enforces it on every route regardless. */}
        <Route path="payments" element={<RequirePermission permission="payments.manage"><PaymentsPage /></RequirePermission>} />
        <Route path="platform/providers" element={<RequirePermission permission="providers.read"><ProvidersPage /></RequirePermission>} />
        {/* Print Stations disabled (business rule 2026-09-04). Route removed;
            /print-stations now falls through to NotFound. Page component + API
            kept for a possible future dedicated printing workflow. */}
        <Route
          path="tax-profiles"
          element={<RequirePermission permission="tax.read"><TaxProfilesPage /></RequirePermission>}
        />
        <Route
          path="staff"
          element={
            <RequirePermission permission="staff.read">
              <StaffPage />
            </RequirePermission>
          }
        />
        <Route
          path="audit-log"
          element={<RequirePermission permission="audit.read"><AuditLogPage /></RequirePermission>}
        />
        <Route
          path="settings"
          element={<RequirePermission permission="staff.manage"><SettingsPage /></RequirePermission>}
        />
        <Route path="unauthorized" element={<UnauthorizedPage />} />
        <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Route>,
  ),
);

export function AppRouter() {
  return <RouterProvider router={router} />;
}

export default AppRouter;
