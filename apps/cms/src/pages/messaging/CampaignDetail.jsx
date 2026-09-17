import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { PageShell } from '../../layout/PageShell.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { StatStrip } from '../../components/ui/StatStrip.jsx';
import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../../components/feedback/LoadingState.jsx';
import { ErrorState } from '../../components/feedback/ErrorState.jsx';
import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { useMutation, succeeded } from '../../features/catalog/useMutation.js';
import { useAuth } from '../../auth/useAuth.js';
import {
  CHANNEL_LABEL, READ_NOT_REPORTED, RUN_STATUS_LABEL, STATUS_LABEL, STATUS_TONE,
  deliveryLabel, describeAudience, describeRunTrigger, formatDateTime, isCartCampaign, rupeesFromPaise, sourceLabel, templateLabel,
} from './campaignModel.js';
import './messaging.css';

// Messaging → a campaign: what it is, what it has done, and the controls that
// are valid for its current state (and only those).
export function CampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('marketing.manage');
  const canSend = hasPermission('marketing.send');

  const detail = useApiResource(() => adminApi.marketingCampaigns.get(id));
  const options = useApiResource(() => adminApi.marketingCampaigns.options());
  const lists = useApiResource(() => adminApi.marketingCampaigns.listAudiences());
  const [notice, setNotice] = useState(location.state?.notice || null);
  const [act, actState] = useMutation((fn) => fn());

  const run = async (fn, message, after) => {
    setNotice(null);
    if (await succeeded(act(fn))) {
      setNotice(message);
      if (after) after(); else detail.reload();
    }
  };

  if (detail.status === 'ready' && isCartCampaign(detail.data)) return <Navigate to="/marketing/abandoned-carts" replace />;
  if (detail.status === 'loading') return <PageShell title="Campaign"><LoadingState label="Loading campaign…" /></PageShell>;
  if (detail.status === 'error') return <PageShell title="Campaign"><ErrorState message={detail.error?.message} onRetry={detail.reload} /></PageShell>;

  const c = detail.data;
  const typeLabel = (options.data?.types ?? []).find((t) => t.key === c.campaign_type)?.label || c.campaign_type;
  const perCustomer = Boolean(c.trigger?.perCustomer);
  const funnel = c.report?.funnel || {};
  const reminders = c.report?.reminders;

  const actions = (
    <>
      <Button variant="ghost" onClick={() => navigate('/marketing/campaigns')}>All campaigns</Button>
      {canManage && ['DRAFT', 'PAUSED'].includes(c.status) && (
        <Button variant="secondary" onClick={() => navigate(`/messaging/campaigns/${c.id}/edit?step=1`)}>Edit</Button>
      )}
      {canManage && (
        <Button variant="secondary" busy={actState.busy} onClick={() => run(
          () => adminApi.marketingCampaigns.duplicate(c.id).then((copy) => navigate(`/messaging/campaigns/${copy.id}/edit?step=3`)),
          'Copy created.', () => {},
        )}>Duplicate</Button>
      )}
      {canSend && c.status === 'DRAFT' && (
        <Button onClick={() => navigate(`/messaging/campaigns/${c.id}/edit?step=6`)}>Review & activate</Button>
      )}
      {canSend && ['ACTIVE', 'SCHEDULED'].includes(c.status) && (
        <Button variant="secondary" busy={actState.busy}
          onClick={() => run(() => adminApi.marketingCampaigns.pause(c.id), 'Campaign paused. Nothing more is sent until you resume it.')}>Pause</Button>
      )}
      {canSend && c.status === 'PAUSED' && (
        <Button busy={actState.busy} onClick={() => run(() => adminApi.marketingCampaigns.resume(c.id), 'Campaign resumed.')}>Resume</Button>
      )}
      {canSend && ['SCHEDULED', 'ACTIVE', 'PAUSED'].includes(c.status) && (
        <Button variant="danger" busy={actState.busy} onClick={() => {
          // eslint-disable-next-line no-alert
          if (window.confirm('Cancel this campaign? Messages not yet sent will not be sent. This cannot be undone.')) {
            run(() => adminApi.marketingCampaigns.cancel(c.id), 'Campaign cancelled.');
          }
        }}>Cancel campaign</Button>
      )}
      {canManage && c.status === 'DRAFT' && (
        <Button variant="danger" busy={actState.busy} onClick={() => {
          // eslint-disable-next-line no-alert
          if (window.confirm('Delete this draft?')) run(() => adminApi.marketingCampaigns.remove(c.id), 'Draft deleted.', () => navigate('/marketing/campaigns'));
        }}>Delete draft</Button>
      )}
    </>
  );

  return (
    <PageShell title={c.name} description={`${typeLabel} campaign`} actions={actions}>
      {notice && <InlineAlert tone="success">{notice}</InlineAlert>}
      {actState.error && <InlineAlert tone="error">{actState.error.message}</InlineAlert>}

      <section className="panel">
        <dl className="summary-list">
          <dt>Status</dt><dd><Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status] || c.status}</Badge></dd>
          <dt>Channels</dt><dd>{c.channels.map((ch) => `${CHANNEL_LABEL[ch.channel]} — ${templateLabel(ch.templateKey)}`).join(', ') || '—'}</dd>
          <dt>Audience</dt><dd>{perCustomer ? 'Each customer with an abandoned cart' : describeAudience(c.audience_sources, lists.data ?? [])}</dd>
          <dt>Trigger</dt>
          <dd>
            {c.trigger?.label || '—'}
            {c.trigger_type === 'SCHEDULED' && ` — ${formatDateTime(c.scheduled_at)}`}
            {c.trigger_event === 'cart.abandoned' && c.trigger_config && (
              ` — after ${Number(c.trigger_config.delayMinutes) / 60} h, carts up to ${Number(c.trigger_config.maxAgeHours) / 24} days old, at most one reminder every ${Number(c.trigger_config.cooldownHours) / 24} days${c.trigger_config.minCartValueMinor ? `, carts from ${rupeesFromPaise(c.trigger_config.minCartValueMinor)}` : ''}`
            )}
          </dd>
          {c.started_at && (<><dt>Started</dt><dd>{formatDateTime(c.started_at)}</dd></>)}
          {c.finished_at && (<><dt>Finished</dt><dd>{formatDateTime(c.finished_at)}</dd></>)}
        </dl>
      </section>

      {reminders && (
        <section className="panel">
          <h2 className="panel__title">Reminders</h2>
          <StatStrip min={140} cards={[
            { label: 'Reminders sent', value: reminders.reminders },
            { label: 'Customers reminded', value: reminders.customers },
            { label: 'Ordered within 72 h', value: reminders.converted, tone: reminders.converted ? 'good' : undefined },
            { label: 'Recovered', value: rupeesFromPaise(reminders.recoveredMinor) },
          ]} />
          {reminders.lastSentAt && <p className="muted">Last reminder {formatDateTime(reminders.lastSentAt)}</p>}
        </section>
      )}

      {!perCustomer && c.runs?.length > 0 && (
        <section className="panel">
          <h2 className="panel__title">Summary</h2>
          <StatStrip min={130} cards={[
            { label: 'Total audience', value: (funnel.EMAIL?.audience || 0) + (funnel.WHATSAPP?.audience || 0) },
            { label: 'Total sent', value: (funnel.EMAIL?.providerAccepted || 0) + (funnel.WHATSAPP?.providerAccepted || 0), tone: 'good' },
            { label: 'Delivered', value: (funnel.EMAIL?.delivered || 0) + (funnel.WHATSAPP?.delivered || 0) },
            { label: 'Failed', value: (funnel.EMAIL?.failed || 0) + (funnel.WHATSAPP?.failed || 0), tone: ((funnel.EMAIL?.failed || 0) + (funnel.WHATSAPP?.failed || 0)) ? 'bad' : undefined },
            { label: 'Read', value: '—', hint: READ_NOT_REPORTED },
            { label: 'Email sent', value: funnel.EMAIL?.providerAccepted || 0 },
            { label: 'WhatsApp sent', value: funnel.WHATSAPP?.providerAccepted || 0 },
          ]} />
          <p className="muted">
            Sent means the provider accepted the message. Delivered counts only provider delivery confirmations, and read receipts are {READ_NOT_REPORTED.toLowerCase()}.
          </p>
        </section>
      )}

      {!perCustomer && c.runs?.length > 0 && <AudienceTable campaignId={c.id} lists={lists.data ?? []} />}

      {c.runs?.length > 0 && (
        <section className="panel">
          <h2 className="panel__title">Runs</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Trigger</th><th>Started</th><th>Recipients</th><th>Waiting</th><th>Status</th></tr></thead>
              <tbody>
                {c.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{describeRunTrigger(r.trigger_key)}</td>
                    <td>{formatDateTime(r.started_at)}</td>
                    <td>{r.recipients}</td>
                    <td>{r.pending}</td>
                    <td>{RUN_STATUS_LABEL[r.status] || r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {['WHATSAPP', 'EMAIL'].map((channel) => {
        const f = funnel[channel];
        if (!f || (!f.audience && !Object.keys(f.testSends || {}).length)) return null;
        return (
          <section className="panel" key={channel}>
            <h2 className="panel__title">{CHANNEL_LABEL[channel]} results</h2>
            <StatStrip min={120} cards={[
              { label: 'Audience', value: f.audience },
              { label: 'Eligible', value: f.eligible },
              { label: 'Queued', value: f.queued },
              { label: 'Accepted by provider', value: f.providerAccepted, tone: 'good' },
              { label: 'Delivered', value: f.delivered },
              { label: 'Failed', value: f.failed, tone: f.failed ? 'bad' : undefined },
              { label: 'Not sent (preferences)', value: f.suppressedAtSend + f.suppressedAtSnapshot },
              { label: 'Still sending', value: f.inFlight + f.pending },
            ]} />
            <p className="muted">
              Delivered only counts delivery receipts from the provider ({f.deliveryReceipts.toLowerCase()}); accepted means the provider took the message.
              {Object.keys(f.testSends || {}).length > 0 && ` Test sends are not counted above.`}
            </p>
            {f.failureReasons.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Why not delivered</th><th>Messages</th></tr></thead>
                  <tbody>{f.failureReasons.map((r) => <tr key={r.reason || 'unknown'}><td>{r.reason || 'Unknown'}</td><td>{r.n}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}

      {c.report?.reasons?.length > 0 && (
        <section className="panel">
          <h2 className="panel__title">Who was not messaged, and why</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Channel</th><th>Reason</th><th>Contacts</th></tr></thead>
              <tbody>
                {c.report.reasons.map((r, i) => (
                  <tr key={`${r.channel}-${r.reason}-${i}`}><td>{CHANNEL_LABEL[r.channel]}</td><td>{r.reason}</td><td>{r.n}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </PageShell>
  );
}

const PAGE_SIZE = 50;

/** Everyone in the campaign's audience, per channel, with what actually happened. */
function AudienceTable({ campaignId, lists }) {
  const [page, setPage] = useState(1);
  const [channel, setChannel] = useState('');
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => adminApi.marketingCampaigns.recipients(campaignId, { page, pageSize: PAGE_SIZE, ...(channel ? { channel } : {}) }))
      .then((data) => { if (!cancelled) setState({ status: 'ready', data, error: null }); })
      .catch((error) => { if (!cancelled) setState({ status: 'error', data: null, error }); });
    return () => { cancelled = true; };
  }, [campaignId, page, channel]);

  const total = state.data?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <section className="panel">
      <div className="panel__header-row">
        <h2 className="panel__title">Audience</h2>
        <div className="segmented" role="group" aria-label="Channel">
          {[['', 'All'], ['EMAIL', 'Email'], ['WHATSAPP', 'WhatsApp']].map(([key, label]) => (
            <button key={key || 'all'} type="button" className={`segmented__btn${channel === key ? ' is-active' : ''}`}
              onClick={() => { setChannel(key); setPage(1); }}>{label}</button>
          ))}
        </div>
      </div>
      {state.status === 'loading' && <LoadingState label="Loading audience…" />}
      {state.status === 'error' && <ErrorState message={state.error?.message} onRetry={() => setPage((p) => p)} />}
      {state.status === 'ready' && (
        <>
          <div className="table-wrap">
            <table className="data-table recipient-table">
              <thead>
                <tr>
                  <th>Customer</th><th>Email</th><th>Phone / WhatsApp</th><th>Audience</th><th>Channel</th>
                  <th>Sent</th><th>Delivery status</th><th>Read</th><th>Failure reason</th>
                </tr>
              </thead>
              <tbody>
                {state.data.recipients.map((r) => {
                  const label = deliveryLabel(r);
                  return (
                    <tr key={r.id}>
                      <td>{r.customerName || <span className="muted">No name</span>}</td>
                      <td>{r.email || '—'}</td>
                      <td>{r.phone || '—'}</td>
                      <td className="muted">{sourceLabel(r.source, lists)}</td>
                      <td><strong>{CHANNEL_LABEL[r.channel]}</strong><br /><span className="muted">{r.to}</span></td>
                      <td>{r.sentAt ? formatDateTime(r.sentAt) : '—'}</td>
                      <td><span className={`badge-pill badge-pill--${label.tone}`}>{label.text}</span>{r.deliveredAt ? <><br /><span className="muted">{formatDateTime(r.deliveredAt)}</span></> : null}</td>
                      <td className="muted">—</td>
                      <td>{r.messageStatus === 'FAILED' || r.state === 'FAILED' ? (r.failureReason || r.stateReason || '—') : '—'}</td>
                    </tr>
                  );
                })}
                {state.data.recipients.length === 0 && <tr><td colSpan={9} className="data-table__empty">No recipients.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <span className="muted">Page {page} of {pages} · {total} recipient{total === 1 ? '' : 's'} (one row per channel)</span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </>
      )}
    </section>
  );
}

export default CampaignDetail;
