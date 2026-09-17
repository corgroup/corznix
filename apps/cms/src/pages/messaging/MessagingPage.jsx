import { useSearchParams } from 'react-router-dom';
import { PageShell } from '../../layout/PageShell.jsx';
import { useAuth } from '../../auth/useAuth.js';
import { CampaignList } from './CampaignList.jsx';
import { MessageTemplatesPanel } from './MessageTemplatesPanel.jsx';
import { WhatsAppTemplates } from './WhatsAppTemplates.jsx';
import './messaging.css';

// CMS → Messaging. One place for everything a customer is sent as marketing:
//   Campaigns          who, when and on which channel (docs/MESSAGING.md)
//   Email Templates    what an email says
//   WhatsApp Templates what a WhatsApp says (approved by Meta)
// Templates are reusable by any number of campaigns. The page needs comms.read
// (Operations manages templates); the Campaigns tab additionally needs
// marketing.read.
const TABS = [
  { key: 'campaigns', label: 'Campaigns', permission: 'marketing.read' },
  { key: 'email', label: 'Email Templates', permission: 'comms.read' },
  { key: 'whatsapp', label: 'WhatsApp Templates', permission: 'comms.read' },
];

export function MessagingPage() {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => hasPermission(t.permission));
  const current = tabs.find((t) => t.key === params.get('tab')) || tabs[0];

  return (
    <PageShell
      title="Campaigns"
      description="Marketing campaigns on WhatsApp and Email — new collections, launches, offers. Abandoned-cart reminders have their own section."
    >
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={current?.key === t.key}
            className={`tabs__tab${current?.key === t.key ? ' tabs__tab--active' : ''}`}
            onClick={() => setParams(t.key === 'campaigns' ? {} : { tab: t.key })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="tabs__panel">
        {current?.key === 'campaigns' && <CampaignList />}
        {current?.key === 'email' && <MessageTemplatesPanel />}
        {current?.key === 'whatsapp' && <WhatsAppTemplates />}
      </div>
    </PageShell>
  );
}

export default MessagingPage;
