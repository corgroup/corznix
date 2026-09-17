import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageShell } from '../../layout/PageShell.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { FormField } from '../../components/ui/FormField.jsx';
import { StatStrip } from '../../components/ui/StatStrip.jsx';
import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../../components/feedback/LoadingState.jsx';
import { ErrorState } from '../../components/feedback/ErrorState.jsx';
import { EmptyState } from '../../components/feedback/EmptyState.jsx';
import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { useMutation, succeeded } from '../../features/catalog/useMutation.js';
import { useAuth } from '../../auth/useAuth.js';
import {
  CHANNEL_LABEL, READ_NOT_REPORTED, STATUS_LABEL, STATUS_TONE, formatDateTime, isCartCampaign, messageLabel, rupeesFromPaise,
} from './campaignModel.js';
import './messaging.css';

const PAGE_SIZE = 25;

// Marketing → Abandoned Carts (the section keeps its original name). Its own section, so it never gets lost among
// campaigns: the reminder settings, the totals, and every reminder actually
// sent — per customer, per channel — straight from the send records.
export function CartRecoveryPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('marketing.manage');
  const canSend = hasPermission('marketing.send');

  const campaigns = useApiResource(async () => {
    const all = await adminApi.marketingCampaigns.list();
    const carts = all.filter(isCartCampaign);
    // Totals come from each campaign's own report.
    return Promise.all(carts.map((c) => adminApi.marketingCampaigns.get(c.id)));
  });
  const [page, setPage] = useState(1);
  const [log, setLog] = useState({ status: 'loading', data: null, error: null });
  const [notice, setNotice] = useState(null);
  const [tester, setTester] = useState(null); // { id, contact, result }
  const [act, actState] = useMutation((fn) => fn());
  const [sendTest, testState] = useMutation(({ id, contact }) => adminApi.marketingCampaigns.test(id, { contact }));

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => adminApi.marketingCampaigns.cartReminders({ page, pageSize: PAGE_SIZE }))
      .then((data) => { if (!cancelled) setLog({ status: 'ready', data, error: null }); })
      .catch((error) => { if (!cancelled) setLog({ status: 'error', data: null, error }); });
    return () => { cancelled = true; };
  }, [page]);

  const run = async (fn, message) => {
    setNotice(null);
    if (await succeeded(act(fn))) { setNotice(message); campaigns.reload(); }
  };

  const rows = campaigns.data ?? [];
  const totals = rows.reduce((t, c) => {
    const r = c.report?.reminders || {};
    return {
      reminders: t.reminders + (r.reminders || 0),
      customers: t.customers + (r.customers || 0),
      converted: t.converted + (r.converted || 0),
      recoveredMinor: t.recoveredMinor + (r.recoveredMinor || 0),
    };
  }, { reminders: 0, customers: 0, converted: 0, recoveredMinor: 0 });
  const totalPages = Math.max(1, Math.ceil((log.data?.total || 0) / PAGE_SIZE));

  return (
    <PageShell
      title="Abandoned Carts"
      description="Automatic reminders on WhatsApp and Email for customers who leave items in their cart. Each reminder shows the product they left and a link that restores their cart."
      actions={canManage && (
        <Button onClick={() => navigate('/messaging/campaigns/new?type=ABANDONED_CART')}>
          {rows.length ? 'New cart reminder' : 'Set up cart reminders'}
        </Button>
      )}
    >
      {notice && <InlineAlert tone="success">{notice}</InlineAlert>}
      {actState.error && <InlineAlert tone="error">{actState.error.message}</InlineAlert>}

      {campaigns.status === 'loading' && <LoadingState label="Loading cart recovery…" />}
      {campaigns.status === 'error' && <ErrorState message={campaigns.error?.message} onRetry={campaigns.reload} />}
      {campaigns.status === 'ready' && rows.length === 0 && (
        <EmptyState title="Cart reminders are not set up" message="Set it up once and customers who leave items in their cart are reminded automatically." />
      )}

      {campaigns.status === 'ready' && rows.length > 0 && (
        <>
          <StatStrip
            min={160}
            cards={[
              { label: 'Reminders sent', value: totals.reminders },
              { label: 'Customers reminded', value: totals.customers },
              { label: 'Orders within 72 h', value: totals.converted, tone: totals.converted ? 'good' : undefined },
              { label: 'Recovered', value: rupeesFromPaise(totals.recoveredMinor), tone: totals.recoveredMinor ? 'good' : undefined },
            ]}
          />

          <section className="panel">
            <h2 className="panel__title">Reminder settings</h2>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Name</th><th>Status</th><th>When</th><th>Channels</th><th>Conditions</th><th /></tr></thead>
                <tbody>
                  {rows.map((c) => {
                    const cfg = c.trigger_config || {};
                    return (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td><Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status] || c.status}</Badge></td>
                        <td className="muted">
                          after {Number(cfg.delayMinutes ?? 240) / 60} h · carts up to {Number(cfg.maxAgeHours ?? 168) / 24} days<br />
                          one reminder per customer every {Number(cfg.cooldownHours ?? 168) / 24} days
                        </td>
                        <td>{c.channels.map((ch) => CHANNEL_LABEL[ch.channel]).join(' + ') || '—'}</td>
                        <td className="muted">
                          {cfg.minCartValueMinor ? `carts from ${rupeesFromPaise(cfg.minCartValueMinor)}` : 'any cart value'}
                          {cfg.couponCode ? <><br />coupon {cfg.couponCode}</> : null}
                        </td>
                        <td className="row-actions">
                          {canSend && c.status === 'ACTIVE' && (
                            <Button size="sm" variant="secondary" busy={actState.busy}
                              onClick={() => run(() => adminApi.marketingCampaigns.pause(c.id), 'Reminders paused. None are sent until you resume them.')}>Pause</Button>
                          )}
                          {canSend && c.status === 'PAUSED' && (
                            <Button size="sm" busy={actState.busy}
                              onClick={() => run(() => adminApi.marketingCampaigns.resume(c.id), 'Reminders resumed.')}>Resume</Button>
                          )}
                          {canSend && c.status === 'DRAFT' && (
                            <Button size="sm" onClick={() => navigate(`/messaging/campaigns/${c.id}/edit?step=6`)}>Review & turn on</Button>
                          )}
                          {canManage && ['DRAFT', 'PAUSED'].includes(c.status) && (
                            <Button size="sm" variant="secondary" onClick={() => navigate(`/messaging/campaigns/${c.id}/edit?step=1`)}>Edit</Button>
                          )}
                          {canSend && (
                            <Button size="sm" variant="secondary"
                              onClick={() => { testState.reset(); setTester(tester?.id === c.id ? null : { id: c.id, contact: '', result: null }); }}>
                              {tester?.id === c.id ? 'Close test' : 'Send test reminder'}
                            </Button>
                          )}
                          {canManage && c.status === 'DRAFT' && (
                            <Button size="sm" variant="danger" busy={actState.busy} onClick={() => {
                              // eslint-disable-next-line no-alert
                              if (window.confirm(`Delete "${c.name}"?`)) run(() => adminApi.marketingCampaigns.remove(c.id), 'Draft deleted.');
                            }}>Delete</Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {tester && (
              <form className="editor-form wizard-block" onSubmit={(e) => {
                e.preventDefault();
                sendTest({ id: tester.id, contact: tester.contact.trim() }).then((result) => setTester((t) => ({ ...t, result }))).catch(() => {});
              }}>
                <p className="muted">
                  Sends the real reminder — the customer’s current cart, product image and a working recovery link — to one customer
                  only, without waiting. Their marketing preference is still checked, and their reminder history is not changed.
                </p>
                <FormField id="cart-test-contact" label="Customer email or phone" value={tester.contact}
                  onChange={(v) => { testState.reset(); setTester((t) => ({ ...t, contact: v, result: null })); }} />
                <Button type="submit" busy={testState.busy} disabled={tester.contact.trim().length < 3}>Send test</Button>
                {testState.error && !testState.busy && <InlineAlert tone="error">{testState.error.message}</InlineAlert>}
                {tester.result && (
                  <InlineAlert tone={tester.result.results.some((r) => r.outcome === 'QUEUED') ? 'success' : 'warning'}>
                    Cart: {tester.result.product || '—'} ({tester.result.itemCount} item{tester.result.itemCount === 1 ? '' : 's'})<br />
                    {tester.result.results.map((r) => (
                      <span key={r.channel}>{CHANNEL_LABEL[r.channel]}: {r.outcome === 'QUEUED' ? 'sent to the provider' : `not sent — ${r.reason}`}<br /></span>
                    ))}
                  </InlineAlert>
                )}
              </form>
            )}
          </section>
        </>
      )}

      <section className="panel">
        <h2 className="panel__title">Customers reminded</h2>
        <p className="muted">
          One row per reminder. Each channel is listed separately with what the provider reported.
          Delivered appears only when the provider confirms delivery; read receipts are {READ_NOT_REPORTED.toLowerCase()}.
        </p>
        {log.status === 'loading' && <LoadingState label="Loading reminders…" />}
        {log.status === 'error' && <ErrorState message={log.error?.message} onRetry={() => setPage((p) => p)} />}
        {log.status === 'ready' && log.data.total === 0 && <EmptyState title="No reminders sent yet" />}
        {log.status === 'ready' && log.data.total > 0 && (
          <>
            <div className="table-wrap">
              <table className="data-table recipient-table">
                <thead>
                  <tr>
                    <th>Customer</th><th>Email</th><th>Phone / WhatsApp</th><th>Cart</th><th>Reminder</th>
                    <th>Channel · status · sent</th><th>Recovery</th>
                  </tr>
                </thead>
                <tbody>
                  {log.data.reminders.map((r) => (
                    <tr key={r.id}>
                      <td>{r.customerName || <span className="muted">No name</span>}</td>
                      <td>{r.email || '—'}</td>
                      <td>{r.phone || '—'}</td>
                      <td>
                        {r.cart.leadProduct || '—'}{r.cart.leadVariant ? ` · ${r.cart.leadVariant}` : ''}
                        <br /><span className="muted">{r.cart.itemCount ? `${r.cart.itemCount} item${r.cart.itemCount === 1 ? '' : 's'} · ` : ''}{rupeesFromPaise(r.cart.subtotalMinor)}</span>
                      </td>
                      <td>{r.reminderType}<br /><span className="muted">{formatDateTime(r.sentAt)}</span></td>
                      <td>
                        {r.channels.length === 0 && <span className="muted">No message recorded</span>}
                        {r.channels.map((ch) => {
                          const label = messageLabel(ch.status, ch.reason);
                          return (
                            <div key={ch.channel} className="channel-line">
                              <strong>{CHANNEL_LABEL[ch.channel]}</strong>{' '}
                              <Badge tone={label.tone}>{label.text}</Badge>
                              <br />
                              <span className="muted">
                                {ch.to}
                                {ch.sentAt ? ` · sent ${formatDateTime(ch.sentAt)}` : ''}
                                {ch.deliveredAt ? ` · delivered ${formatDateTime(ch.deliveredAt)}` : ''}
                                {ch.failedAt ? ` · failed ${formatDateTime(ch.failedAt)}` : ''}
                              </span>
                            </div>
                          );
                        })}
                      </td>
                      <td>
                        {r.recoveredOrder
                          ? <><Badge tone="good">Recovered</Badge><br /><span className="muted">Order {r.recoveredOrder.orderNumber} · {rupeesFromPaise(r.recoveredOrder.totalMinor)}</span></>
                          : <Badge tone="muted">Not recovered</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span className="muted">Page {page} of {totalPages} · {log.data.total} reminders</span>
              <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </>
        )}
      </section>
    </PageShell>
  );
}

export default CartRecoveryPage;
