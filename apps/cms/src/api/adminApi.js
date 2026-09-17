import { apiClient } from './apiClient.js';

// Thin boundary over the backend admin API. Unwraps the `{ data: ... }`
// envelope once, here. All privileged authority lives server-side; these
// calls only ever read/act on what the staff session is allowed to.
const unwrap = (response) => response?.data;

export const adminApi = {
  login: (email, password) =>
    apiClient.post('/api/v1/admin/auth/login', { email, password }).then(unwrap),
  logout: () => apiClient.post('/api/v1/admin/auth/logout').then(unwrap),
  me: () => apiClient.get('/api/v1/admin/me').then(unwrap),
  // Multi-company (DESIGN.md §6) — the company switcher.
  switchBrand: (brandId) => apiClient.put('/api/v1/admin/session/brand', { brandId }).then(unwrap),
  changePassword: (currentPassword, newPassword) =>
    apiClient.post('/api/v1/admin/auth/change-password', { currentPassword, newPassword }).then(unwrap),
  listStaff: () => apiClient.get('/api/v1/admin/staff').then(unwrap),
  // Settings > User Management (Phase 6, SUPER_ADMIN only — staff.manage).
  createStaff: (body) => apiClient.post('/api/v1/admin/staff', body).then(unwrap),
  setStaffStatus: (id, status) => apiClient.patch(`/api/v1/admin/staff/${id}/status`, { status }).then(unwrap),
  changeStaffRole: (id, role) => apiClient.patch(`/api/v1/admin/staff/${id}/role`, { role }).then(unwrap),
  resetStaffPassword: (email, newPassword) => apiClient.post('/api/v1/admin/staff/reset-password', { email, newPassword }).then(unwrap),
  getStaffBrandAccess: (id) => apiClient.get(`/api/v1/admin/staff/${id}/brand-access`).then(unwrap),
  grantStaffBrandAccess: (id, brandId, body) => apiClient.put(`/api/v1/admin/staff/${id}/brand-access/${brandId}`, body).then(unwrap),
  revokeStaffBrandAccess: (id, brandId) => apiClient.delete(`/api/v1/admin/staff/${id}/brand-access/${brandId}`).then(unwrap),

  // Settings > Company Profile (Phase 6).
  // Company logo. brands.logo_media_id existed since the multi-company work
  // but had no endpoint and no screen until now.
  brandAppearance: {
    get: () => apiClient.get('/api/v1/admin/brand-appearance').then(unwrap),
    update: (patch) => apiClient.patch('/api/v1/admin/brand-appearance', patch).then(unwrap),
  },

  companyProfile: {
    get: () => apiClient.get('/api/v1/admin/company-profile').then(unwrap),
    update: (patch) => apiClient.patch('/api/v1/admin/company-profile', patch).then(unwrap),
  },

  // Real system health — reused from the shared backend, never faked.
  health: () => apiClient.get('/api/v1/health'),

  // --- Staff notification feed (CMS topbar bell) ---
  notifications: {
    feed: (params) => apiClient.get(`/api/v1/admin/notifications${toQuery(params)}`).then(unwrap),
    unreadCount: () => apiClient.get('/api/v1/admin/notifications/unread-count').then(unwrap),
    markRead: (ids) => apiClient.post('/api/v1/admin/notifications/read', { ids }).then(unwrap),
    markAllRead: () => apiClient.post('/api/v1/admin/notifications/read-all', {}).then(unwrap),
  },

  // --- Staff audit-log viewer (WP-12 / GAP-ORD-06) — read-only ---
  audit: {
    list: (params) => apiClient.get(`/api/v1/admin/audit-logs${toQuery(params)}`).then(unwrap),
    facets: () => apiClient.get('/api/v1/admin/audit-logs/facets').then(unwrap),
  },

  // --- Product Studio (Wave 8B) ---
  catalog: {
    listProducts: (params) => apiClient.get(`/api/v1/admin/products${toQuery(params)}`).then(unwrap),
    productFacets: () => apiClient.get('/api/v1/admin/products/facets').then(unwrap),
    getProduct: (id) => apiClient.get(`/api/v1/admin/products/${id}`).then(unwrap),
    createProduct: (body) => apiClient.post('/api/v1/admin/products', body).then(unwrap),
    updateProduct: (id, body) => apiClient.patch(`/api/v1/admin/products/${id}`, body).then(unwrap),
    setStatus: (id, status) => apiClient.patch(`/api/v1/admin/products/${id}/status`, { status }).then(unwrap),
    bulkStatus: (ids, status) => apiClient.post('/api/v1/admin/products/bulk-status', { ids, status }).then(unwrap),
    createVariant: (productId, body) => apiClient.post(`/api/v1/admin/products/${productId}/variants`, body).then(unwrap),
    updateVariant: (variantId, body) => apiClient.patch(`/api/v1/admin/variants/${variantId}`, body).then(unwrap),
    createSku: (productId, body) => apiClient.post(`/api/v1/admin/products/${productId}/skus`, body).then(unwrap),
    updateSku: (skuId, body) => apiClient.patch(`/api/v1/admin/skus/${skuId}`, body).then(unwrap),
    putShipping: (productId, body) => apiClient.put(`/api/v1/admin/products/${productId}/shipping`, body).then(unwrap),
    assignSizeGuide: (productId, sizeGuideId) => apiClient.put(`/api/v1/admin/products/${productId}/size-guide`, { sizeGuideId }).then(unwrap),
    sizeGuides: () => apiClient.get('/api/v1/admin/catalog/size-guides').then(unwrap),
    categories: () => apiClient.get('/api/v1/admin/catalog/categories').then(unwrap),
    collections: () => apiClient.get('/api/v1/admin/catalog/collections').then(unwrap),
    shippingSummary: () => apiClient.get('/api/v1/admin/catalog/shipping-summary').then(unwrap),

    // --- Wave 8D: Size Guide Studio ---
    sizeGuideFacets: () => apiClient.get('/api/v1/admin/catalog/size-guides/facets').then(unwrap),
    sizeGuidesExportUrl: () => `${import.meta.env.VITE_API_BASE_URL}/api/v1/admin/catalog/size-guides/export`,
    getSizeGuide: (id) => apiClient.get(`/api/v1/admin/catalog/size-guides/${id}`).then(unwrap),
    createSizeGuide: (body) => apiClient.post('/api/v1/admin/catalog/size-guides', body).then(unwrap),
    updateSizeGuide: (id, body) => apiClient.patch(`/api/v1/admin/catalog/size-guides/${id}`, body).then(unwrap),
    setSizeGuideRows: (id, rows) => apiClient.put(`/api/v1/admin/catalog/size-guides/${id}/rows`, { rows }).then(unwrap),
    setSizeGuideStatus: (id, status) => apiClient.patch(`/api/v1/admin/catalog/size-guides/${id}/status`, { status }).then(unwrap),
    deleteSizeGuide: (id) => apiClient.delete(`/api/v1/admin/catalog/size-guides/${id}`).then(unwrap),

    // --- Phase 1B: canonical SKU identity ---
    skuOptions: () => apiClient.get('/api/v1/admin/catalog/sku/options').then(unwrap),
    createTypeCode: (body) => apiClient.post('/api/v1/admin/catalog/sku/type-codes', body).then(unwrap),
    createFitCode: (body) => apiClient.post('/api/v1/admin/catalog/sku/fit-codes', body).then(unwrap),
    skuPreview: (variantId, sizeCode) => apiClient.post('/api/v1/admin/catalog/sku/preview', { variantId, sizeCode }).then(unwrap),
    skuIdentity: (skuId) => apiClient.get(`/api/v1/admin/catalog/sku/${skuId}/identity`).then(unwrap),
    skuMigrationReadiness: () => apiClient.get('/api/v1/admin/catalog/sku/migration-readiness').then(unwrap),

    // --- Wave 8D: Categories ---
    categoryFacets: () => apiClient.get('/api/v1/admin/catalog/categories/facets').then(unwrap),
    categoriesExportUrl: () => `${import.meta.env.VITE_API_BASE_URL}/api/v1/admin/catalog/categories/export`,
    getCategory: (id) => apiClient.get(`/api/v1/admin/catalog/categories/${id}`).then(unwrap),
    createCategory: (body) => apiClient.post('/api/v1/admin/catalog/categories', body).then(unwrap),
    updateCategory: (id, body) => apiClient.patch(`/api/v1/admin/catalog/categories/${id}`, body).then(unwrap),
    setCategoryStatus: (id, status) => apiClient.patch(`/api/v1/admin/catalog/categories/${id}/status`, { status }).then(unwrap),
    deleteCategory: (id, { confirmReferences = false } = {}) => apiClient.delete(`/api/v1/admin/catalog/categories/${id}${confirmReferences ? '?confirmReferences=true' : ''}`).then(unwrap),
    getProductCategories: (productId) => apiClient.get(`/api/v1/admin/products/${productId}/categories`).then(unwrap),
    setProductCategories: (productId, categories) => apiClient.put(`/api/v1/admin/products/${productId}/categories`, { categories }).then(unwrap),

    // --- Wave 8D: Collections ---
    collectionFacets: () => apiClient.get('/api/v1/admin/catalog/collections/facets').then(unwrap),
    collectionsExportUrl: () => `${import.meta.env.VITE_API_BASE_URL}/api/v1/admin/catalog/collections/export`,
    getCollection: (id) => apiClient.get(`/api/v1/admin/catalog/collections/${id}`).then(unwrap),
    createCollection: (body) => apiClient.post('/api/v1/admin/catalog/collections', body).then(unwrap),
    updateCollection: (id, body) => apiClient.patch(`/api/v1/admin/catalog/collections/${id}`, body).then(unwrap),
    setCollectionStatus: (id, status) => apiClient.patch(`/api/v1/admin/catalog/collections/${id}/status`, { status }).then(unwrap),
    deleteCollection: (id, { confirmReferences = false } = {}) => apiClient.delete(`/api/v1/admin/catalog/collections/${id}${confirmReferences ? '?confirmReferences=true' : ''}`).then(unwrap),
    setCollectionMembers: (id, productIds) => apiClient.put(`/api/v1/admin/catalog/collections/${id}/members`, { productIds }).then(unwrap),
    addCollectionMember: (id, productId) => apiClient.post(`/api/v1/admin/catalog/collections/${id}/members`, { productId }).then(unwrap),
    removeCollectionMember: (id, productId) => apiClient.delete(`/api/v1/admin/catalog/collections/${id}/members/${productId}`).then(unwrap),
    reorderCollection: (id, orderedProductIds) => apiClient.post(`/api/v1/admin/catalog/collections/${id}/reorder`, { orderedProductIds }).then(unwrap),

    // --- Wave 8D: Media Library + product media mapping ---
    listMedia: (params) => apiClient.get(`/api/v1/admin/catalog/media${toQuery(params)}`).then(unwrap),
    getMediaAsset: (id) => apiClient.get(`/api/v1/admin/catalog/media/${id}`).then(unwrap),
    uploadMediaAsset: (file) => {
      const fd = new FormData();
      fd.append('file', file);
      return apiClient.post('/api/v1/admin/catalog/media', fd).then(unwrap);
    },
    deleteMediaAsset: (id, force) => apiClient.delete(`/api/v1/admin/catalog/media/${id}${force ? '?force=true' : ''}`).then(unwrap),
    listProductMedia: (productId) => apiClient.get(`/api/v1/admin/products/${productId}/media`).then(unwrap),
    attachProductMedia: (productId, body) => apiClient.post(`/api/v1/admin/products/${productId}/media`, body).then(unwrap),
    updateProductMedia: (productId, mappingId, body) => apiClient.patch(`/api/v1/admin/products/${productId}/media/${mappingId}`, body).then(unwrap),
    detachProductMedia: (productId, mappingId) => apiClient.delete(`/api/v1/admin/products/${productId}/media/${mappingId}`).then(unwrap),
    setProductMediaPrimary: (productId, mappingId) => apiClient.post(`/api/v1/admin/products/${productId}/media/${mappingId}/primary`).then(unwrap),
    reorderProductMedia: (productId, body) => apiClient.post(`/api/v1/admin/products/${productId}/media/reorder`, body).then(unwrap),
    replaceProductMedia: (productId, mappingId, file) => {
      const fd = new FormData();
      fd.append('file', file);
      return apiClient.post(`/api/v1/admin/products/${productId}/media/${mappingId}/replace`, fd).then(unwrap);
    },

    // --- Wave 8D: site media ---
    siteMedia: () => apiClient.get('/api/v1/admin/catalog/site-media').then(unwrap),
    setSiteMedia: (key, mediaId, altText) => apiClient.put(`/api/v1/admin/catalog/site-media/${key}`, { mediaId, altText }).then(unwrap),
  },

  // --- Wave 8E: Content & Experience CMS ---
  content: {
    // Homepage hero banners. Full CRUD from the CMS — no asset ids by hand.
    heroBanners: () => apiClient.get('/api/v1/admin/content/hero-banners').then(unwrap),
    createHeroBanner: (body) => apiClient.post('/api/v1/admin/content/hero-banners', body).then(unwrap),
    updateHeroBanner: (id, body) => apiClient.patch(`/api/v1/admin/content/hero-banners/${id}`, body).then(unwrap),
    deleteHeroBanner: (id) => apiClient.delete(`/api/v1/admin/content/hero-banners/${id}`).then(unwrap),
    duplicateHeroBanner: (id) => apiClient.post(`/api/v1/admin/content/hero-banners/${id}/duplicate`, {}).then(unwrap),
    reorderHeroBanners: (orderedIds) => apiClient.put('/api/v1/admin/content/hero-banners/reorder', { orderedIds }).then(unwrap),
    // A store with no slides yet: turn the built-in hero into editable slides.
    importHeroBanners: () => apiClient.post('/api/v1/admin/content/hero-banners/import-current', {}).then(unwrap),
    navigation: () => apiClient.get('/api/v1/admin/content/navigation').then(unwrap),
    upsertNavItem: (body) => apiClient.put('/api/v1/admin/content/navigation/items', body).then(unwrap),
    deleteNavItem: (id, expectedVersion) => apiClient.delete(`/api/v1/admin/content/navigation/items/${id}?expectedVersion=${expectedVersion}`).then(unwrap),
    reorderNav: (orderedIds, parentId, expectedVersion) => apiClient.post('/api/v1/admin/content/navigation/reorder', { orderedIds, parentId, expectedVersion }).then(unwrap),
    setNavigationSettings: (settings, expectedVersion) => apiClient.put('/api/v1/admin/content/navigation/settings', { settings, expectedVersion }).then(unwrap),
    megaMenus: () => apiClient.get('/api/v1/admin/content/mega-menus').then(unwrap),
    upsertMegaMenu: (body) => apiClient.put('/api/v1/admin/content/mega-menus', body).then(unwrap),
    announcements: () => apiClient.get('/api/v1/admin/content/announcements').then(unwrap),
    upsertAnnouncement: (body) => apiClient.put('/api/v1/admin/content/announcements', body).then(unwrap),
    deleteAnnouncement: (id, expectedVersion) => apiClient.delete(`/api/v1/admin/content/announcements/${id}?expectedVersion=${expectedVersion}`).then(unwrap),
    reorderAnnouncements: (orderedIds, expectedVersion) => apiClient.post('/api/v1/admin/content/announcements/reorder', { orderedIds, expectedVersion }).then(unwrap),
    setAnnouncementSettings: (settings, expectedVersion) => apiClient.put('/api/v1/admin/content/announcements/settings', { settings, expectedVersion }).then(unwrap),
    homepage: () => apiClient.get('/api/v1/admin/content/homepage').then(unwrap),
    upsertHomeSection: (body) => apiClient.put('/api/v1/admin/content/homepage/sections', body).then(unwrap),
    deleteHomeSection: (id, expectedVersion) => apiClient.delete(`/api/v1/admin/content/homepage/sections/${id}?expectedVersion=${expectedVersion}`).then(unwrap),
    reorderHomeSections: (orderedIds, expectedVersion) => apiClient.post('/api/v1/admin/content/homepage/reorder', { orderedIds, expectedVersion }).then(unwrap),
    footer: () => apiClient.get('/api/v1/admin/content/footer').then(unwrap),
    setFooterGroupLinks: (groupKey, links, expectedVersion) => apiClient.put(`/api/v1/admin/content/footer/groups/${groupKey}/links`, { links, expectedVersion }).then(unwrap),
    setFooterMeta: (meta, expectedVersion) => apiClient.put('/api/v1/admin/content/footer/meta', { meta, expectedVersion }).then(unwrap),
    history: (scope) => apiClient.get(`/api/v1/admin/content/${scope}/history`).then(unwrap),
    published: (scope) => apiClient.get(`/api/v1/admin/content/${scope}/published`).then(unwrap),
    references: (type, id) => apiClient.get(`/api/v1/admin/content/references?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`).then(unwrap),
    publish: (scope, expectedVersion) => apiClient.post(`/api/v1/admin/content/${scope}/publish`, { expectedVersion }).then(unwrap),
    rollback: (scope, targetPublicationId) => apiClient.post(`/api/v1/admin/content/${scope}/rollback`, { targetPublicationId }).then(unwrap),

    // Wave 8E Phase 5 — static pages + FAQ
    pages: () => apiClient.get('/api/v1/admin/content/pages').then(unwrap),
    createPage: (body) => apiClient.post('/api/v1/admin/content/pages', body).then(unwrap),
    page: (slug) => apiClient.get(`/api/v1/admin/content/pages/${slug}`).then(unwrap),
    updatePage: (slug, body) => apiClient.put(`/api/v1/admin/content/pages/${slug}`, body).then(unwrap),
    setPageBlocks: (slug, blocks, expectedVersion) => apiClient.put(`/api/v1/admin/content/pages/${slug}/blocks`, { blocks, expectedVersion }).then(unwrap),
    pageHistory: (slug) => apiClient.get(`/api/v1/admin/content/pages/${slug}/history`).then(unwrap),
    publishPage: (slug, expectedVersion) => apiClient.post(`/api/v1/admin/content/pages/${slug}/publish`, { expectedVersion }).then(unwrap),
    rollbackPage: (slug, targetPublicationId) => apiClient.post(`/api/v1/admin/content/pages/${slug}/rollback`, { targetPublicationId }).then(unwrap),
    faq: () => apiClient.get('/api/v1/admin/content/faq').then(unwrap),
    setFaqItems: (items, expectedVersion) => apiClient.put('/api/v1/admin/content/faq/items', { items, expectedVersion }).then(unwrap),
    faqHistory: () => apiClient.get('/api/v1/admin/content/faq/history').then(unwrap),
    publishFaq: (expectedVersion) => apiClient.post('/api/v1/admin/content/faq/publish', { expectedVersion }).then(unwrap),
    rollbackFaq: (targetPublicationId) => apiClient.post('/api/v1/admin/content/faq/rollback', { targetPublicationId }).then(unwrap),

    // Wave 8E Phase 6 — themes + campaigns
    themes: () => apiClient.get('/api/v1/admin/content/themes').then(unwrap),
    createTheme: (body) => apiClient.post('/api/v1/admin/content/themes', body).then(unwrap),
    theme: (key) => apiClient.get(`/api/v1/admin/content/themes/${key}`).then(unwrap),
    updateTheme: (key, body) => apiClient.put(`/api/v1/admin/content/themes/${key}`, body).then(unwrap),
    themeHistory: (key) => apiClient.get(`/api/v1/admin/content/themes/${key}/history`).then(unwrap),
    publishTheme: (key, expectedVersion) => apiClient.post(`/api/v1/admin/content/themes/${key}/publish`, { expectedVersion }).then(unwrap),
    rollbackTheme: (key, targetPublicationId) => apiClient.post(`/api/v1/admin/content/themes/${key}/rollback`, { targetPublicationId }).then(unwrap),
    campaigns: () => apiClient.get('/api/v1/admin/content/campaigns').then(unwrap),
    createCampaign: (body) => apiClient.post('/api/v1/admin/content/campaigns', body).then(unwrap),
    campaign: (slug) => apiClient.get(`/api/v1/admin/content/campaigns/${slug}`).then(unwrap),
    updateCampaign: (slug, body) => apiClient.put(`/api/v1/admin/content/campaigns/${slug}`, body).then(unwrap),
    campaignHistory: (slug) => apiClient.get(`/api/v1/admin/content/campaigns/${slug}/history`).then(unwrap),
    publishCampaign: (slug, expectedVersion) => apiClient.post(`/api/v1/admin/content/campaigns/${slug}/publish`, { expectedVersion }).then(unwrap),
    rollbackCampaign: (slug, targetPublicationId) => apiClient.post(`/api/v1/admin/content/campaigns/${slug}/rollback`, { targetPublicationId }).then(unwrap),
    setCampaignDisabled: (slug, disabled, reason) => apiClient.post(`/api/v1/admin/content/campaigns/${slug}/disable`, { disabled, reason }).then(unwrap),

    // Wave 8E Phase 7 — preview tokens
    previewTokens: () => apiClient.get('/api/v1/admin/content/preview-tokens').then(unwrap),
    createPreviewToken: (body) => apiClient.post('/api/v1/admin/content/preview-tokens', body).then(unwrap),
    revokePreviewToken: (id) => apiClient.delete(`/api/v1/admin/content/preview-tokens/${id}`).then(unwrap),
  },

  // --- Careers: job postings + applications ---
  careers: {
    listJobs: (status) => apiClient.get(`/api/v1/admin/careers/jobs${status ? `?status=${status}` : ''}`).then(unwrap),
    getJob: (id) => apiClient.get(`/api/v1/admin/careers/jobs/${id}`).then(unwrap),
    createJob: (body) => apiClient.post('/api/v1/admin/careers/jobs', body).then(unwrap),
    updateJob: (id, body) => apiClient.patch(`/api/v1/admin/careers/jobs/${id}`, body).then(unwrap),
    setJobStatus: (id, status) => apiClient.post(`/api/v1/admin/careers/jobs/${id}/status`, { status }).then(unwrap),
    applicationFacets: () => apiClient.get('/api/v1/admin/careers/applications/facets').then(unwrap),
    listApplications: (params) => apiClient.get(`/api/v1/admin/careers/applications${toQuery(params)}`).then(unwrap),
    getApplication: (id) => apiClient.get(`/api/v1/admin/careers/applications/${id}`).then(unwrap),
    resumeUrl: (id) => `${import.meta.env.VITE_API_BASE_URL}/api/v1/admin/careers/applications/${id}/resume`,
    setApplicationStatus: (id, status) => apiClient.post(`/api/v1/admin/careers/applications/${id}/status`, { status }).then(unwrap),
    addNote: (id, note) => apiClient.post(`/api/v1/admin/careers/applications/${id}/notes`, { note }).then(unwrap),
    assign: (id, staffId, expectedVersion) => apiClient.post(`/api/v1/admin/careers/applications/${id}/assign`, { staffId, expectedVersion }).then(unwrap),
    sendEmail: (id, subject, message) => apiClient.post(`/api/v1/admin/careers/applications/${id}/email`, { subject, message }).then(unwrap),
  },

  // --- Multi-warehouse commerce (CMS Warehouses module) ---
  // --- Standalone Fulfillment (WP-11) ---
  fulfillments: {
    list: (params) => apiClient.get(`/api/v1/admin/fulfillments${toQuery(params)}`).then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/fulfillments/${id}`).then(unwrap),
    transition: (id, toStatus, note) =>
      apiClient.post(`/api/v1/admin/fulfillments/${id}/transition`, note ? { toStatus, note } : { toStatus }).then(unwrap),
  },

  // --- Standalone Inventory (WP-12) ---
  inventory: {
    list: (params) => apiClient.get(`/api/v1/admin/inventory${toQuery(params)}`).then(unwrap),
    exportUrl: (params) => `${import.meta.env.VITE_API_BASE_URL}/api/v1/admin/inventory/export${toQuery(params)}`,
    detail: (warehouseId, skuId) => apiClient.get(`/api/v1/admin/inventory/${warehouseId}/${skuId}`).then(unwrap),
    setThreshold: (warehouseId, skuId, threshold) =>
      apiClient.patch(`/api/v1/admin/inventory/${warehouseId}/${skuId}/threshold`, { threshold }).then(unwrap),
  },

  // --- Inter-warehouse transfers (WP-12 / GAP-INV-04) ---
  transfers: {
    list: (params) => apiClient.get(`/api/v1/admin/warehouse-transfers${toQuery(params)}`).then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/warehouse-transfers/${id}`).then(unwrap),
    create: (body) => apiClient.post('/api/v1/admin/warehouse-transfers', body).then(unwrap),
    dispatch: (id) => apiClient.post(`/api/v1/admin/warehouse-transfers/${id}/dispatch`, {}).then(unwrap),
    receive: (id, received) => apiClient.post(`/api/v1/admin/warehouse-transfers/${id}/receive`, received ? { received } : {}).then(unwrap),
    cancel: (id) => apiClient.post(`/api/v1/admin/warehouse-transfers/${id}/cancel`, {}).then(unwrap),
  },

  // --- QC-FAIL quarantine (WP-12 / GAP-INV-03) ---
  quarantine: {
    list: (params) => apiClient.get(`/api/v1/admin/inventory-quarantine${toQuery(params)}`).then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/inventory-quarantine/${id}`).then(unwrap),
    dispose: (id, body) => apiClient.post(`/api/v1/admin/inventory-quarantine/${id}/dispose`, body).then(unwrap),
  },

  warehouses: {
    list: (params) => apiClient.get(`/api/v1/admin/warehouses${toQuery(params)}`).then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/warehouses/${id}`).then(unwrap),
    create: (body) => apiClient.post('/api/v1/admin/warehouses', body).then(unwrap),
    update: (id, body) => apiClient.patch(`/api/v1/admin/warehouses/${id}`, body).then(unwrap),
    setStatus: (id, status) => apiClient.patch(`/api/v1/admin/warehouses/${id}/status`, { status }).then(unwrap),
    assignStaff: (id, staffUserId) => apiClient.post(`/api/v1/admin/warehouses/${id}/staff`, { staffUserId }).then(unwrap),
    unassignStaff: (id, staffUserId) => apiClient.delete(`/api/v1/admin/warehouses/${id}/staff/${staffUserId}`).then(unwrap),
    inventory: (id, params) => apiClient.get(`/api/v1/admin/warehouses/${id}/inventory${toQuery(params)}`).then(unwrap),
    adjustInventory: (id, body) => apiClient.post(`/api/v1/admin/warehouses/${id}/inventory/adjust`, body).then(unwrap),
    setDefault: (id) => apiClient.patch(`/api/v1/admin/warehouses/${id}/default`).then(unwrap),
    // What CORCOTTON can prove locally about each warehouse's carrier mapping.
    // Not a provider diff — carriers expose no read endpoint — so the Warehouses
    // list and the carrier panel on a warehouse are answering from one source.
    providerSyncStatus: (providerCode) =>
      apiClient.get(`/api/v1/admin/warehouses/provider-sync-status${providerCode ? `?providerCode=${encodeURIComponent(providerCode)}` : ''}`).then(unwrap),
    // Phase 2 §35 — carrier pickup-location mapping
    setProviderLocation: (id, providerCode, body) =>
      apiClient.put(`/api/v1/admin/warehouses/${id}/provider-locations/${providerCode}`, body).then(unwrap),
    removeProviderLocation: (id, providerCode) =>
      apiClient.delete(`/api/v1/admin/warehouses/${id}/provider-locations/${providerCode}`).then(unwrap),
  },

  // --- Order operations (confirm / process / book) ---
  orders: {
    list: (params) => apiClient.get(`/api/v1/admin/orders${toQuery(params)}`).then(unwrap),
    facets: () => apiClient.get('/api/v1/admin/orders/facets').then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/orders/${id}`).then(unwrap),
    timeline: (id) => apiClient.get(`/api/v1/admin/orders/${id}/timeline`).then(unwrap),
    linkedReturns: (id) => apiClient.get(`/api/v1/admin/orders/${id}/returns`).then(unwrap),
    confirm: (id, expectedAllocationFingerprint) =>
      apiClient.post(`/api/v1/admin/orders/${id}/confirm`, expectedAllocationFingerprint ? { expectedAllocationFingerprint } : {}).then(unwrap),
    startProcessing: (id) => apiClient.post(`/api/v1/admin/orders/${id}/start-processing`).then(unwrap),
    cancel: (id, reason) => apiClient.post(`/api/v1/admin/orders/${id}/cancel`, reason ? { reason } : {}).then(unwrap),
    // Paying the customer back after a cancellation. Separate permission
    // (returns.refund), and safe to call twice: the server replays the
    // existing refund rather than sending a second one.
    retryCancellationRefund: (id) => apiClient.post(`/api/v1/admin/orders/${id}/refund`, {}).then(unwrap),
    bookShipment: (shipmentId, idempotencyKey) =>
      apiClient.post(`/api/v1/admin/shipments/${shipmentId}/book`, { idempotencyKey }).then(unwrap),
    // Phase 2 §27/§28/§30/§31 — post-booking operational actions
    fetchShipmentLabel: (shipmentId, size) =>
      apiClient.post(`/api/v1/admin/shipments/${shipmentId}/label`, size ? { size } : {}).then(unwrap),
    markShipmentLabelPrinted: (shipmentId) =>
      apiClient.post(`/api/v1/admin/shipments/${shipmentId}/label/printed`, {}).then(unwrap),
    // One operator action: confirm package + book with the carrier + fetch label.
    manifestShipment: (shipmentId, body) =>
      apiClient.post(`/api/v1/admin/shipments/${shipmentId}/manifest`, body).then(unwrap),
    requestShipmentPickup: (shipmentId, body) =>
      apiClient.post(`/api/v1/admin/shipments/${shipmentId}/pickup`, body).then(unwrap),
    cancelShipmentAtProvider: (shipmentId, reason) =>
      apiClient.post(`/api/v1/admin/shipments/${shipmentId}/cancel`, reason ? { reason } : {}).then(unwrap),
    confirmShipmentPackage: (shipmentId, pkg) =>
      apiClient.post(`/api/v1/admin/shipments/${shipmentId}/package`, pkg).then(unwrap),
    runShipmentAutomation: (shipmentId) =>
      apiClient.post(`/api/v1/admin/shipments/${shipmentId}/automation/run`, {}).then(unwrap),
    reconcileShipment: (shipmentId) =>
      apiClient.post(`/api/v1/admin/shipments/${shipmentId}/reconcile`, {}).then(unwrap),
    listShipmentCarrierDocuments: (shipmentId) =>
      apiClient.get(`/api/v1/admin/shipments/${shipmentId}/carrier-documents`).then(unwrap),
    fetchShipmentCarrierDocument: (shipmentId, docType) =>
      apiClient.post(`/api/v1/admin/shipments/${shipmentId}/carrier-documents/fetch`, { docType }).then(unwrap),
    getShipmentNdr: (shipmentId) =>
      apiClient.get(`/api/v1/admin/shipments/${shipmentId}/ndr`).then(unwrap),
    submitShipmentNdrAction: (shipmentId, action, instructions) =>
      apiClient.post(`/api/v1/admin/shipments/${shipmentId}/ndr/action`, instructions ? { action, instructions } : { action }).then(unwrap),
    refreshNdrAction: (actionId) =>
      apiClient.post(`/api/v1/admin/ndr-actions/${actionId}/refresh`, {}).then(unwrap),
  },

  // --- Documents + printing (8C-3/8C-4/8C-5) ---
  documents: {
    forOrder: (orderId) => apiClient.get(`/api/v1/admin/orders/${orderId}/documents`).then(unwrap),
    invoice: (orderId) => apiClient.get(`/api/v1/admin/orders/${orderId}/invoice`).then(unwrap),
    regenerateInvoice: (orderId) => apiClient.post(`/api/v1/admin/orders/${orderId}/invoice`).then(unwrap),
    view: (docId) => apiClient.get(`/api/v1/admin/documents/${docId}`).then(unwrap),
    downloadUrl: (docId) => `${import.meta.env.VITE_API_BASE_URL}/api/v1/admin/documents/${docId}/download`,
    render: (docId) => apiClient.post(`/api/v1/admin/documents/${docId}/render`).then(unwrap),
    packingSlip: (fulfillmentId) => apiClient.post(`/api/v1/admin/fulfillments/${fulfillmentId}/packing-slip`).then(unwrap),
    label: (shipmentId) => apiClient.post(`/api/v1/admin/shipments/${shipmentId}/label`).then(unwrap),
    print: (documentId, printerId, copies) => apiClient.post('/api/v1/admin/print-jobs', { documentId, printerId, copies }).then(unwrap),
  },
  tax: {
    list: () => apiClient.get('/api/v1/admin/tax-profiles').then(unwrap),
    gaps: () => apiClient.get('/api/v1/admin/tax-profiles/gaps').then(unwrap),
    create: (body) => apiClient.post('/api/v1/admin/tax-profiles', body).then(unwrap),
    patch: (id, body) => apiClient.patch(`/api/v1/admin/tax-profiles/${id}`, body).then(unwrap),
    assign: (productId, taxProfileId) => apiClient.post('/api/v1/admin/tax-profiles/assign', { productId, taxProfileId }).then(unwrap),
  },
  // --- Customer operations (Wave 8G) ---
  customers: {
    list: (params) => apiClient.get(`/api/v1/admin/customers${toQuery(params)}`).then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/customers/${id}`).then(unwrap),
    update: (id, body) => apiClient.patch(`/api/v1/admin/customers/${id}`, body).then(unwrap),
    addNote: (id, body) => apiClient.post(`/api/v1/admin/customers/${id}/notes`, { body }).then(unwrap),
    setStatus: (id, status, reason) => apiClient.post(`/api/v1/admin/customers/${id}/status`, { status, reason }).then(unwrap),
  },

  // --- Subscribers & consent (Wave 8G) ---
  subscribers: {
    list: (params) => apiClient.get(`/api/v1/admin/subscribers${toQuery(params)}`).then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/subscribers/${id}`).then(unwrap),
    suppress: (body) => apiClient.post('/api/v1/admin/suppressions', body).then(unwrap),
    releaseSuppression: (body) => apiClient.post('/api/v1/admin/suppressions/release', body).then(unwrap),
  },

  // --- Support / customer queries (Wave 8G + Communications hub) ---
  support: {
    list: (params) => apiClient.get(`/api/v1/admin/support/tickets${toQuery(params)}`).then(unwrap),
    facets: () => apiClient.get('/api/v1/admin/support/facets').then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/support/tickets/${id}`).then(unwrap),
    assign: (id, staffId, expectedVersion) => apiClient.post(`/api/v1/admin/support/tickets/${id}/assign`, { staffId, expectedVersion }).then(unwrap),
    reply: (id, body, visibility, notifyWarehouse = false) =>
      apiClient.post(`/api/v1/admin/support/tickets/${id}/reply`, { body, visibility, notifyWarehouse }).then(unwrap),
    priority: (id, priority) => apiClient.post(`/api/v1/admin/support/tickets/${id}/priority`, { priority }).then(unwrap),
    status: (id, status) => apiClient.post(`/api/v1/admin/support/tickets/${id}/status`, { status }).then(unwrap),
  },

  // --- Internal staff-to-staff messaging (Communications hub, Phase B) ---
  internal: {
    list: () => apiClient.get('/api/v1/admin/internal/conversations').then(unwrap),
    unreadCount: () => apiClient.get('/api/v1/admin/internal/conversations/unread-count').then(unwrap),
    directory: () => apiClient.get('/api/v1/admin/internal/directory').then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/internal/conversations/${id}`).then(unwrap),
    openDirect: (body) => apiClient.post('/api/v1/admin/internal/conversations/direct', body).then(unwrap),
    createGroup: (body) => apiClient.post('/api/v1/admin/internal/conversations/group', body).then(unwrap),
    sendMessage: (id, body, mentions = []) => apiClient.post(`/api/v1/admin/internal/conversations/${id}/messages`, { body, mentions }).then(unwrap),
    markRead: (id, lastMessageId) => apiClient.post(`/api/v1/admin/internal/conversations/${id}/read`, { lastMessageId }).then(unwrap),
  },

  // --- Product reviews + moderation (Wave 8G) ---
  reviews: {
    list: (params) => apiClient.get(`/api/v1/admin/reviews${toQuery(params)}`).then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/reviews/${id}`).then(unwrap),
    moderate: (id, action, expectedVersion, reason) =>
      apiClient.post(`/api/v1/admin/reviews/${id}/moderate`, { action, expectedVersion, ...(reason ? { reason } : {}) }).then(unwrap),
    rebuildAggregates: () => apiClient.post('/api/v1/admin/reviews/aggregates/rebuild', {}).then(unwrap),
  },

  // --- Customer segments (Wave 8G) ---
  segments: {
    attributes: () => apiClient.get('/api/v1/admin/segments/meta/attributes').then(unwrap),
    list: (params) => apiClient.get(`/api/v1/admin/segments${toQuery(params)}`).then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/segments/${id}`).then(unwrap),
    create: (body) => apiClient.post('/api/v1/admin/segments', body).then(unwrap),
    updateMeta: (id, body) => apiClient.patch(`/api/v1/admin/segments/${id}`, body).then(unwrap),
    addRevision: (id, definition) => apiClient.post(`/api/v1/admin/segments/${id}/revisions`, { definition }).then(unwrap),
    previewAdhoc: (definition, sampleSize = 10) => apiClient.post('/api/v1/admin/segments/preview', { definition, sampleSize }).then(unwrap),
    preview: (id, sampleSize = 10) => apiClient.post(`/api/v1/admin/segments/${id}/preview`, { sampleSize }).then(unwrap),
    audience: (id, params) => apiClient.get(`/api/v1/admin/segments/${id}/audience${toQuery(params)}`).then(unwrap),
    snapshot: (id, reason) => apiClient.post(`/api/v1/admin/segments/${id}/snapshot`, reason ? { reason } : {}).then(unwrap),
  },

  // --- Promotions + coupons (Wave 8G) ---
  promotions: {
    list: (params) => apiClient.get(`/api/v1/admin/promotions${toQuery(params)}`).then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/promotions/${id}`).then(unwrap),
    create: (body) => apiClient.post('/api/v1/admin/promotions', body).then(unwrap),
    update: (id, body) => apiClient.patch(`/api/v1/admin/promotions/${id}`, body).then(unwrap),
    addCoupon: (id, code) => apiClient.post(`/api/v1/admin/promotions/${id}/coupons`, { code }).then(unwrap),
  },

  // --- Communication orchestration (Wave 8G) ---
  communications: {
    listNotificationPolicies: () => apiClient.get('/api/v1/admin/communications/notification-policies').then(unwrap),
    listTemplates: (params) => apiClient.get(`/api/v1/admin/communications/templates${toQuery(params)}`).then(unwrap),
    getTemplate: (id) => apiClient.get(`/api/v1/admin/communications/templates/${id}`).then(unwrap),
    createTemplate: (body) => apiClient.post('/api/v1/admin/communications/templates', body).then(unwrap),
    setTemplateStatus: (id, status) => apiClient.post(`/api/v1/admin/communications/templates/${id}/status`, { status }).then(unwrap),
    dispatch: () => apiClient.post('/api/v1/admin/communications/dispatch', {}).then(unwrap),
  },

  // --- Messaging campaigns (every campaign type, incl. abandoned cart) + audience lists ---
  // Reading and editing is marketing.read / marketing.manage; every call that
  // can put a message in front of a customer needs marketing.send.
  marketingCampaigns: {
    // Campaign types and the triggers available today.
    options: () => apiClient.get('/api/v1/admin/marketing/campaign-options').then(unwrap),
    list: () => apiClient.get('/api/v1/admin/marketing/campaigns').then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/marketing/campaigns/${id}`).then(unwrap),
    create: (body) => apiClient.post('/api/v1/admin/marketing/campaigns', body).then(unwrap),
    update: (id, body) => apiClient.patch(`/api/v1/admin/marketing/campaigns/${id}`, body).then(unwrap),
    remove: (id) => apiClient.delete(`/api/v1/admin/marketing/campaigns/${id}`).then(unwrap),
    duplicate: (id) => apiClient.post(`/api/v1/admin/marketing/campaigns/${id}/duplicate`, {}).then(unwrap),
    // Real per-recipient rows (paged): campaign audience, and cart reminders.
    recipients: (id, params) => apiClient.get(`/api/v1/admin/marketing/campaigns/${id}/recipients${toQuery(params)}`).then(unwrap),
    cartReminders: (params) => apiClient.get(`/api/v1/admin/marketing/cart-recovery/reminders${toQuery(params)}`).then(unwrap),
    readiness: (id) => apiClient.get(`/api/v1/admin/marketing/campaigns/${id}/readiness`).then(unwrap),
    // The real consent lookups, not an estimate — what the confirm screen shows.
    audiencePreview: (id) => apiClient.get(`/api/v1/admin/marketing/campaigns/${id}/audience-preview`).then(unwrap),
    test: (id, body) => apiClient.post(`/api/v1/admin/marketing/campaigns/${id}/test`, body).then(unwrap),
    activate: (id) => apiClient.post(`/api/v1/admin/marketing/campaigns/${id}/activate`, {}).then(unwrap),
    pause: (id) => apiClient.post(`/api/v1/admin/marketing/campaigns/${id}/pause`, {}).then(unwrap),
    resume: (id) => apiClient.post(`/api/v1/admin/marketing/campaigns/${id}/resume`, {}).then(unwrap),
    cancel: (id) => apiClient.post(`/api/v1/admin/marketing/campaigns/${id}/cancel`, {}).then(unwrap),
    run: () => apiClient.post('/api/v1/admin/marketing/campaigns/run', {}).then(unwrap),

    listAudiences: () => apiClient.get('/api/v1/admin/marketing/audience-lists').then(unwrap),
    getAudience: (listId) => apiClient.get(`/api/v1/admin/marketing/audience-lists/${listId}`).then(unwrap),
    // multipart — the shared client leaves the Content-Type to the browser.
    uploadAudience: (file, name) => {
      const form = new FormData();
      form.append('file', file);
      if (name) form.append('name', name);
      return apiClient.post('/api/v1/admin/marketing/audience-lists', form).then(unwrap);
    },
    confirmAudience: (listId) => apiClient.post(`/api/v1/admin/marketing/audience-lists/${listId}/confirm`, {}).then(unwrap),
    discardAudience: (listId) => apiClient.delete(`/api/v1/admin/marketing/audience-lists/${listId}`).then(unwrap),
  },

  // --- Returns & Exchanges (Wave 8F) ---
  returns: {
    list: (params) => apiClient.get(`/api/v1/admin/returns${toQuery(params)}`).then(unwrap),
    exportUrl: (params) => `${import.meta.env.VITE_API_BASE_URL}/api/v1/admin/returns/export${toQuery(params)}`,
    get: (id) => apiClient.get(`/api/v1/admin/returns/${id}`).then(unwrap),
    approve: (id) => apiClient.post(`/api/v1/admin/returns/${id}/approve`).then(unwrap),
    reject: (id, reason) => apiClient.post(`/api/v1/admin/returns/${id}/reject`, reason ? { reason } : {}).then(unwrap),
    preparePickup: (id) => apiClient.post(`/api/v1/admin/returns/${id}/prepare-pickup`).then(unwrap),
    bookPickup: (id) => apiClient.post(`/api/v1/admin/returns/${id}/book-pickup`, {}).then(unwrap),
    markReceived: (id) => apiClient.post(`/api/v1/admin/returns/${id}/mark-received`).then(unwrap),
    qc: (id, result) => apiClient.post(`/api/v1/admin/returns/${id}/qc`, { result }).then(unwrap),
    releaseReplacement: (id) => apiClient.post(`/api/v1/admin/returns/${id}/release-replacement`).then(unwrap),
    complete: (id) => apiClient.post(`/api/v1/admin/returns/${id}/complete`).then(unwrap),
    retryRefund: (id, body) => apiClient.post(`/api/v1/admin/returns/${id}/retry-refund`, body ?? {}).then(unwrap),
    // COD payouts are settled by a person, not a provider.
    settlePayout: (id, body) => apiClient.post(`/api/v1/admin/returns/${id}/settle-payout`, body).then(unwrap),
    // POST, not GET: the full account number must never sit in a URL or a
    // proxy log. Every call is audited server-side.
    revealPayout: (id) => apiClient.post(`/api/v1/admin/returns/${id}/payout-destination`, {}).then(unwrap),
    reconcileReverse: (shipmentId, providerOutcome) => apiClient.post(`/api/v1/admin/reverse-shipments/${shipmentId}/reconcile`, { providerOutcome }).then(unwrap),
    // Phase 2 · Slice 19 — RVP QC 3.0
    qcSnapshot: (id) => apiClient.get(`/api/v1/admin/returns/${id}/qc-snapshot`).then(unwrap),
    qcQuestions: () => apiClient.get('/api/v1/admin/qc-questions').then(unwrap),
    updateQcQuestionMapping: (clientQuestionId, body) => apiClient.patch(`/api/v1/admin/qc-questions/${clientQuestionId}/mapping`, body).then(unwrap),
  },

  printStations: {
    list: () => apiClient.get('/api/v1/admin/print-stations').then(unwrap),
    create: (body) => apiClient.post('/api/v1/admin/print-stations', body).then(unwrap),
    patch: (id, body) => apiClient.patch(`/api/v1/admin/print-stations/${id}`, body).then(unwrap),
    printers: (id) => apiClient.get(`/api/v1/admin/print-stations/${id}/printers`).then(unwrap),
    createPrinter: (body) => apiClient.post('/api/v1/admin/printers', body).then(unwrap),
    patchPrinter: (id, body) => apiClient.patch(`/api/v1/admin/printers/${id}`, body).then(unwrap),
    jobs: (params) => apiClient.get(`/api/v1/admin/print-jobs${toQuery(params)}`).then(unwrap),
  },

  // --- Reporting + reconciliation (Wave 8H) ---
  reports: {
    meta: () => apiClient.get('/api/v1/admin/reports/meta').then(unwrap),
    get: (name, params) => apiClient.get(`/api/v1/admin/reports/${name}${toQuery(params)}`).then(unwrap),
    exportUrl: (name, params) => `${import.meta.env.VITE_API_BASE_URL}/api/v1/admin/reports/export/${name}${toQuery(params)}`,
  },
  reconciliation: {
    list: (params) => apiClient.get(`/api/v1/admin/reconciliation/exceptions${toQuery(params)}`).then(unwrap),
    get: (id) => apiClient.get(`/api/v1/admin/reconciliation/exceptions/${id}`).then(unwrap),
    scan: () => apiClient.post('/api/v1/admin/reconciliation/scan', {}).then(unwrap),
    act: (id, action, note) => apiClient.post(`/api/v1/admin/reconciliation/exceptions/${id}/act`, { action, note }).then(unwrap),
    importSettlement: (body) => apiClient.post('/api/v1/admin/reconciliation/settlement-import', body).then(unwrap),
  },

  // --- Provider & platform operations (Wave 8I) ---
  // COD policy control + payment monitoring. Every one of these is
  // `payments.manage`, which only SUPER_ADMIN holds — the backend enforces it
  // regardless of what the CMS renders.
  payments: {
    codPolicy: (params = {}) => {
      const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
      return apiClient.get(`/api/v1/admin/payments/cod-policy${q ? `?${q}` : ''}`).then(unwrap);
    },
    setCodSettings: (body) => apiClient.put('/api/v1/admin/payments/cod-policy/settings', body).then(unwrap),
    setPin: (postalCode, body) => apiClient.put(`/api/v1/admin/payments/cod-policy/pins/${encodeURIComponent(postalCode)}`, body).then(unwrap),
    clearPin: (postalCode) => apiClient.delete(`/api/v1/admin/payments/cod-policy/pins/${encodeURIComponent(postalCode)}`).then(unwrap),
    saveValueRule: (rule) => (rule.id
      ? apiClient.put(`/api/v1/admin/payments/cod-policy/value-rules/${encodeURIComponent(rule.id)}`, rule).then(unwrap)
      : apiClient.post('/api/v1/admin/payments/cod-policy/value-rules', rule).then(unwrap)),
    archiveValueRule: (id) => apiClient.delete(`/api/v1/admin/payments/cod-policy/value-rules/${encodeURIComponent(id)}`).then(unwrap),
    saveRiskRule: (riskLevel, body) => apiClient.put(`/api/v1/admin/payments/cod-policy/risk-rules/${encodeURIComponent(riskLevel)}`, body).then(unwrap),
    monitor: (range) => apiClient.get(`/api/v1/admin/payments/monitor${range ? `?range=${encodeURIComponent(range)}` : ''}`).then(unwrap),
  },

  shipping: {
    // Phase 2 §6 — customer shipping charge policy
    getPricingPolicy: () => apiClient.get('/api/v1/admin/shipping/pricing-policy').then(unwrap),
    updatePricingPolicy: (body) => apiClient.put('/api/v1/admin/shipping/pricing-policy', body).then(unwrap),
    // Owner Delivery — CORCOTTON-operated last-mile per PIN (migration 071)
    ownerDelivery: () => apiClient.get('/api/v1/admin/shipping/owner-delivery').then(unwrap),
    setOwnerDeliveryEnabled: (enabled) => apiClient.put('/api/v1/admin/shipping/owner-delivery/settings', { enabled }).then(unwrap),
    createOwnerDeliveryZone: (body) => apiClient.post('/api/v1/admin/shipping/owner-delivery/zones', body).then(unwrap),
    updateOwnerDeliveryZone: (id, body) => apiClient.put(`/api/v1/admin/shipping/owner-delivery/zones/${id}`, body).then(unwrap),
    deleteOwnerDeliveryZone: (id) => apiClient.delete(`/api/v1/admin/shipping/owner-delivery/zones/${id}`).then(unwrap),
  },

  // The store's Instagram account (CMS -> Providers -> Instagram) and the posts
  // synced from it, which the homepage Instagram section shows.
  instagram: {
    connection: () => apiClient.get('/api/v1/admin/providers/social/INSTAGRAM/connection').then(unwrap),
    connect: (accessToken) => apiClient.put('/api/v1/admin/providers/social/INSTAGRAM/connection', { accessToken }).then(unwrap),
    sync: () => apiClient.post('/api/v1/admin/providers/social/INSTAGRAM/sync', {}).then(unwrap),
    disconnect: () => apiClient.delete('/api/v1/admin/providers/social/INSTAGRAM/connection').then(unwrap),
    posts: () => apiClient.get('/api/v1/admin/instagram/posts').then(unwrap),
  },

  providers: {
    overview: () => apiClient.get('/api/v1/admin/providers').then(unwrap),
    get: (capability, key) => apiClient.get(`/api/v1/admin/providers/${capability}/${key}`).then(unwrap),
    health: (capability, key) => apiClient.get(`/api/v1/admin/providers/${capability}/${key}/health`).then(unwrap),
    update: (capability, key, body) => apiClient.patch(`/api/v1/admin/providers/${capability}/${key}`, body).then(unwrap),
    rollback: (capability, key, toVersion) => apiClient.post(`/api/v1/admin/providers/${capability}/${key}/rollback`, { toVersion }).then(unwrap),
    recomputeHealth: () => apiClient.post('/api/v1/admin/providers/health/recompute', {}).then(unwrap),
    webhooks: (params) => apiClient.get(`/api/v1/admin/provider-webhooks${toQuery(params)}`).then(unwrap),
    webhook: (id) => apiClient.get(`/api/v1/admin/provider-webhooks/${id}`).then(unwrap),
    replayWebhook: (id) => apiClient.post(`/api/v1/admin/provider-webhooks/${id}/replay`, {}).then(unwrap),
    outbox: (params) => apiClient.get(`/api/v1/admin/provider-outbox${toQuery(params)}`).then(unwrap),
    retryOutbox: (id) => apiClient.post(`/api/v1/admin/provider-outbox/${id}/retry`, {}).then(unwrap),
    cancelOutbox: (id) => apiClient.post(`/api/v1/admin/provider-outbox/${id}/cancel`, {}).then(unwrap),
    attempts: (params) => apiClient.get(`/api/v1/admin/provider-attempts${toQuery(params)}`).then(unwrap),
  },
};

function toQuery(params = {}) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : '';
}

export default adminApi;
