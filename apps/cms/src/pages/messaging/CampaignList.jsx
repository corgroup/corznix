import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { StatStrip } from '../../components/ui/StatStrip.jsx';
import { LoadingState } from '../../components/feedback/LoadingState.jsx';
import { ErrorState } from '../../components/feedback/ErrorState.jsx';
import { EmptyState } from '../../components/feedback/EmptyState.jsx';
import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { useAuth } from '../../auth/useAuth.js';
import { CHANNEL_LABEL, STATUS_LABEL, STATUS_TONE, formatDateTime, isCartCampaign } from './campaignModel.js';

const FILTERS = [
  ['ALL', 'All'], ['DRAFT', 'Drafts'], ['SCHEDULED', 'Scheduled'], ['ACTIVE', 'Active'], ['PAUSED', 'Paused'], ['COMPLETED', 'Completed'],
];

export function CampaignList() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const canManage = hasPermission('marketing.manage');
  const campaigns = useApiResource(() => adminApi.marketingCampaigns.list());
  const options = useApiResource(() => adminApi.marketingCampaigns.options());
  const [filter, setFilter] = useState('ALL');

  // Abandoned-cart reminders live in their own section (Marketing → Abandoned Carts).
  const rows = useMemo(() => (campaigns.data ?? []).filter((c) => !isCartCampaign(c)), [campaigns.data]);
  const typeLabel = useMemo(
    () => Object.fromEntries((options.data?.types ?? []).map((t) => [t.key, t.label])),
    [options.data],
  );
  const count = (s) => rows.filter((r) => r.status === s).length;
  const visible = filter === 'ALL' ? rows : rows.filter((r) => r.status === filter);

  const when = (c) => {
    if (c.trigger?.kind === 'EVENT') return c.trigger.label;
    if (c.trigger_type === 'SCHEDULED') return formatDateTime(c.scheduled_at);
    if (c.status === 'COMPLETED') return `Sent ${formatDateTime(c.finished_at || c.started_at)}`;
    return 'Send now';
  };

  return (
    <section>
      <div className="messaging-toolbar">
        <StatStrip
          min={120}
          cards={FILTERS.map(([key, label]) => ({
            label, value: key === 'ALL' ? rows.length : count(key), active: filter === key, onClick: () => setFilter(key),
          }))}
        />
        {canManage && <Button onClick={() => navigate('/messaging/campaigns/new')}>Create campaign</Button>}
      </div>

      {campaigns.status === 'loading' && <LoadingState label="Loading campaigns…" />}
      {campaigns.status === 'error' && <ErrorState message={campaigns.error?.message} onRetry={campaigns.reload} />}
      {campaigns.status === 'ready' && rows.length === 0 && (
        <EmptyState
          title="No campaigns yet"
          message="Create a campaign to announce a collection, run an offer or remind customers about their cart."
        />
      )}
      {campaigns.status === 'ready' && rows.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Campaign</th><th>Type</th><th>Channels</th><th>When</th><th>Status</th></tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/messaging/campaigns/${c.id}`}>{c.name}</Link></td>
                  <td>{typeLabel[c.campaign_type] || c.campaign_type}</td>
                  <td>{c.channels.length ? c.channels.map((ch) => CHANNEL_LABEL[ch.channel]).join(' + ') : '—'}</td>
                  <td className="muted">{when(c)}</td>
                  <td><Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status] || c.status}</Badge></td>
                </tr>
              ))}
              {visible.length === 0 && <tr><td colSpan={5} className="data-table__empty">No campaigns in this view.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default CampaignList;
