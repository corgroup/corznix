import { Router } from 'express';
import * as c from './controller.js';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';

// CMS content control plane. Mounted under /api/v1/admin (staff session +
// cmsOriginGuard already applied). Reads: content.read. Draft edits:
// content.write. Publishing / rollback of global storefront content:
// content.publish (§97).
const router = Router();
const read = requireStaffPermission(PERMISSIONS.CONTENT_READ);
const write = requireStaffPermission(PERMISSIONS.CONTENT_WRITE);
const pub = requireStaffPermission(PERMISSIONS.CONTENT_PUBLISH);

// ---- navigation --------------------------------------------------------
router.get('/content/navigation', read, c.getNavigation);
router.put('/content/navigation/items', write, c.upsertNavItem);
router.delete('/content/navigation/items/:id', write, c.deleteNavItem);
router.post('/content/navigation/reorder', write, c.reorderNav);
router.put('/content/navigation/settings', write, c.setNavigationSettings);

// ---- mega menus ------------------------------------------------------
router.get('/content/mega-menus', read, c.getMegaMenus);
router.put('/content/mega-menus', write, c.upsertMegaMenu);

// ---- announcements -------------------------------------------------
router.get('/content/announcements', read, c.getAnnouncements);
router.put('/content/announcements', write, c.upsertAnnouncement);
router.put('/content/announcements/settings', write, c.setAnnouncementSettings);
router.delete('/content/announcements/:id', write, c.deleteAnnouncement);
router.post('/content/announcements/reorder', write, c.reorderAnnouncements);

// ---- homepage -----------------------------------------------------
router.get('/content/homepage', read, c.getHomepage);
router.put('/content/homepage/sections', write, c.upsertHomeSection);
router.delete('/content/homepage/sections/:id', write, c.deleteHomeSection);
router.post('/content/homepage/reorder', write, c.reorderHomeSections);

// ---- footer ------------------------------------------------------
router.get('/content/footer', read, c.getFooter);
router.put('/content/footer/groups/:groupKey/links', write, c.setFooterGroupLinks);
router.put('/content/footer/meta', write, c.setFooterMeta);

// ---- content pages ---------------------------------------------
router.get('/content/pages', read, c.listPages);
router.post('/content/pages', write, c.createPage);
router.get('/content/pages/:slug', read, c.getPage);
router.put('/content/pages/:slug', write, c.updatePage);
router.put('/content/pages/:slug/blocks', write, c.setPageBlocks);
router.get('/content/pages/:slug/history', read, c.pageHistory);
router.post('/content/pages/:slug/publish', pub, c.publishPage);
router.post('/content/pages/:slug/rollback', pub, c.rollbackPage);

// ---- FAQ -------------------------------------------------------
router.get('/content/faq', read, c.getFaq);
router.put('/content/faq/items', write, c.setFaqItems);
router.get('/content/faq/history', read, c.faqHistory);
router.post('/content/faq/publish', pub, c.publishFaq);
router.post('/content/faq/rollback', pub, c.rollbackFaq);

// ---- themes ---------------------------------------------------
router.get('/content/themes', read, c.listThemes);
router.post('/content/themes', write, c.createTheme);
router.get('/content/themes/:key', read, c.getTheme);
router.put('/content/themes/:key', write, c.updateTheme);
router.get('/content/themes/:key/history', read, c.themeHistory);
router.post('/content/themes/:key/publish', pub, c.publishTheme);
router.post('/content/themes/:key/rollback', pub, c.rollbackTheme);

// ---- campaigns ----------------------------------------------
router.get('/content/campaigns', read, c.listCampaigns);
router.post('/content/campaigns', write, c.createCampaign);
router.get('/content/campaigns/:slug', read, c.getCampaign);
router.put('/content/campaigns/:slug', write, c.updateCampaign);
router.get('/content/campaigns/:slug/history', read, c.campaignHistory);
router.post('/content/campaigns/:slug/publish', pub, c.publishCampaign);
router.post('/content/campaigns/:slug/rollback', pub, c.rollbackCampaign);
router.post('/content/campaigns/:slug/disable', pub, c.setCampaignDisabled);

// ---- preview tokens ------------------------------------------
router.get('/content/preview-tokens', read, c.listPreviewTokens);
router.post('/content/preview-tokens', read, c.createPreviewToken);
router.delete('/content/preview-tokens/:id', read, c.revokePreviewToken);

// ---- publish / history / rollback (per scope) --------------------
router.get('/content/references', read, c.entityReferences);
router.get('/content/:scope/published', read, c.publishedSnapshot);
router.get('/content/:scope/history', read, c.history);
router.post('/content/:scope/publish', pub, c.publish);
router.post('/content/:scope/rollback', pub, c.rollback);

export default router;
