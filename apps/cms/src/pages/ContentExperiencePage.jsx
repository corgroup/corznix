import { useSearchParams } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { AnnouncementBuilder } from './experience/announcements/AnnouncementBuilder.jsx';
import { FooterBuilder } from './experience/FooterBuilder.jsx';
import { HeaderBuilder } from './experience/header/HeaderBuilder.jsx';
import { HeroBanners } from './experience/HeroBanners.jsx';
import { HomepageBuilder } from './experience/homepage/HomepageBuilder.jsx';
import { SiteImages } from './experience/SiteImages.jsx';
import { useAuth } from '../auth/useAuth.js';

const TABS = [['header', 'Header & Navigation'], ['announcements', 'Announcements'], ['homepage', 'Homepage'], ['footer', 'Footer'], ['site-images', 'Site Images']];
// Old links (?tab=navigation / ?tab=mega-menus) land on the combined builder.
const TAB_ALIASES = { navigation: 'header', 'mega-menus': 'header' };

export function ContentExperiencePage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('content.write');
  const canPublish = hasPermission('content.publish');
  const [sp, setSp] = useSearchParams();
  const requested = sp.get('tab') || 'header';
  const tab = TAB_ALIASES[requested] || requested;

  return (
    <PageShell title="Experience" description="Header navigation, the announcement bar, the homepage and the footer. Draft freely — changes go live only when you Publish (hero slides go live when saved).">
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k}
            className={`tabs__tab${tab === k ? ' tabs__tab--active' : ''}`}
            onClick={() => setSp((p) => { const n = new URLSearchParams(p); n.set('tab', k); return n; }, { replace: true })}>
            {label}
          </button>
        ))}
      </div>
      <div className="tabs__panel">
        {tab === 'header' && <HeaderBuilder canWrite={canWrite} canPublish={canPublish} />}
        {tab === 'announcements' && <AnnouncementBuilder canWrite={canWrite} canPublish={canPublish} />}
        {tab === 'homepage' && <HomepageTab canWrite={canWrite} canPublish={canPublish} />}
        {tab === 'footer' && <FooterBuilder canWrite={canWrite} canPublish={canPublish} />}
        {tab === 'site-images' && <SiteImages canWrite={canWrite} />}
      </div>
    </PageShell>
  );
}

// Homepage tab: the visual builder (sections, copy, live preview), then the
// hero slides, which have their own schedule and go live when active.
function HomepageTab({ canWrite, canPublish }) {
  return (
    <div className="tab-body">
      <HomepageBuilder canWrite={canWrite} canPublish={canPublish} />
      <hr className="tab-body__rule" />
      <div id="hero-banners">
        <HeroBanners canWrite={canWrite} />
      </div>
    </div>
  );
}

// Footer tab -> apps/cms/src/pages/experience/FooterBuilder.jsx (visual
// 3-column builder). Reuses the same GET/PUT/publish/history/rollback
// contract as before — only the presentation changed.

export default ContentExperiencePage;
