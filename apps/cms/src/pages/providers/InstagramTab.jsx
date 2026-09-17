import { useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../../components/feedback/LoadingState.jsx';
import { ErrorState } from '../../components/feedback/ErrorState.jsx';
import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { useAuth } from '../../auth/useAuth.js';
import { normalizeApiError } from '../../utils/errors.js';
import { formatRelative } from '../../utils/format.js';

// Providers -> Instagram. Connects the store's Instagram account through the
// official Instagram API, for the homepage "Real People. Real Style." section.
// An admin pastes a long-lived access token once: the server checks it with
// Instagram, stores it encrypted and renews it before it expires. The token
// is never shown again — not here, not in any response.

const when = (v) => (v ? new Date(v).toLocaleString() : '—');
const rel = (v) => (v ? formatRelative(v) : '—');

const STATUS_LABEL = {
  CONNECTED: ['ok', 'Connected'],
  AUTH_FAILED: ['bad', 'Needs reconnecting'],
};

export function InstagramTab() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('providers.manage');
  const res = useApiResource(() => adminApi.instagram.connection());
  const [live, setLive] = useState(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  if (res.status === 'loading' && !live) return <LoadingState label="Loading Instagram…" />;
  if (res.status === 'error' && !live) return <ErrorState message={res.error?.message} onRetry={res.reload} />;
  const s = live || res.data;

  const act = async (name, fn, describe) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      const out = await fn();
      if (out?.status) setLive(out.status);
      setNotice(describe(out));
    } catch (err) {
      setError(normalizeApiError(err).message);
    } finally {
      setBusy(null);
    }
  };

  const connect = (event) => {
    event.preventDefault();
    const pasted = token.trim();
    if (!pasted) { setError('Paste the access token first.'); return; }
    act('connect', () => adminApi.instagram.connect(pasted), (out) => {
      setToken('');
      if (out.syncError) return `Connected to @${out.status.username}, but the first sync failed: ${out.syncError}`;
      return `Connected to @${out.status.username}. ${out.sync.fetched} post${out.sync.fetched === 1 ? '' : 's'} synced, ${out.sync.coversCopied} picture${out.sync.coversCopied === 1 ? '' : 's'} copied.`;
    });
  };
  const sync = () => act('sync', () => adminApi.instagram.sync(), (out) => (
    `Synced: ${out.sync.added} new, ${out.sync.removed} removed, ${out.sync.coversCopied} picture${out.sync.coversCopied === 1 ? '' : 's'} copied${out.sync.coverFailures ? `, ${out.sync.coverFailures} could not be copied` : ''}.`
  ));
  const disconnect = () => {
    if (!window.confirm(`Disconnect @${s.username}? The token is deleted and no new posts arrive. The posts already synced stay on the homepage.`)) return;
    act('disconnect', () => adminApi.instagram.disconnect(), () => 'Disconnected. The synced posts stay on the homepage until you change the section.');
  };

  const [tone, label] = s.connected ? (STATUS_LABEL[s.status] || ['muted', s.status]) : ['muted', 'Not connected'];

  return (
    <div className="pv-ig">
      <div className="pv-hero">
        <span className="pv-hero__icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="currentColor" />
          </svg>
        </span>
        <div className="pv-hero__body">
          <h3 className="pv-hero__title">Instagram</h3>
          <p className="pv-hero__text">
            The homepage “Real People. Real Style.” section shows the store’s real Instagram reels and posts, through the official Instagram API.
            Connect the account once: the access token is stored encrypted and renewed automatically before it expires. Posts sync every 30 minutes.
          </p>
        </div>
      </div>

      {!s.encryptionAvailable && (
        <InlineAlert tone="error">
          Connecting is switched off on this server: PROVIDER_SECRET_ENCRYPTION_KEY is not set in the backend environment, so the token could not be stored safely.
          Whoever runs the server needs to set it and restart the API.
        </InlineAlert>
      )}
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {notice && <InlineAlert tone="info">{notice}</InlineAlert>}

      <section className="pv-card" aria-labelledby="pv-ig-account">
        <div className="pv-ig-head">
          <h4 id="pv-ig-account" className="pv-card__title">Account</h4>
          <span className={`pv-badge pv-badge--${tone}`}>{label}</span>
        </div>
        {s.connected ? (
          <>
            <dl className="pv-ig-kv">
              <div className="pv-kv"><dt>Instagram account</dt><dd>@{s.username}{s.accountType ? ` · ${s.accountType.toLowerCase().replace('_', ' ')}` : ''}</dd></div>
              <div className="pv-kv"><dt>Last sync</dt><dd title={when(s.lastSyncedAt)}>{s.lastSyncedAt ? rel(s.lastSyncedAt) : 'Not yet'}</dd></div>
              <div className="pv-kv"><dt>Posts on the website’s list</dt><dd>{s.posts.live} live · {s.posts.withCover} with a picture</dd></div>
              <div className="pv-kv"><dt>Token expires</dt><dd>{s.tokenExpiresAt ? when(s.tokenExpiresAt) : 'Known after the first renewal'}</dd></div>
              <div className="pv-kv"><dt>Next renewal</dt><dd>{s.status === 'CONNECTED' ? `from ${when(s.nextRenewalAfter)}` : '—'}</dd></div>
              <div className="pv-kv"><dt>Connected</dt><dd>{when(s.connectedAt)}</dd></div>
            </dl>
            {s.status === 'AUTH_FAILED' && (
              <InlineAlert tone="error">
                Instagram stopped accepting the access token (expired, revoked, or the account password changed), so no new posts arrive.
                Create a new token and paste it below. The website keeps showing the posts it already has.
              </InlineAlert>
            )}
            {s.lastSyncError && <p className="pv-ig-problem">Last problem: {s.lastSyncError}</p>}
            {canManage && (
              <div className="pv-ig-actions">
                <Button variant="info" busy={busy === 'sync'} disabled={Boolean(busy) || s.status !== 'CONNECTED'} onClick={sync}>Sync now</Button>
                <Button variant="warning" busy={busy === 'disconnect'} disabled={Boolean(busy)} onClick={disconnect}>Disconnect</Button>
              </div>
            )}
          </>
        ) : (
          <p className="pv-card__desc">
            No account connected.{s.posts.live ? ` ${s.posts.live} post${s.posts.live === 1 ? '' : 's'} synced before stay on the homepage.` : ' The homepage Instagram section stays hidden until posts are synced.'}
          </p>
        )}
      </section>

      {canManage && (
        <section className="pv-card" aria-labelledby="pv-ig-connect">
          <h4 id="pv-ig-connect" className="pv-card__title">{s.connected ? 'Replace the access token' : 'Connect the account'}</h4>
          <p className="pv-card__desc">The account must be a professional (business or creator) Instagram account.</p>
          <ol className="pv-ig-steps">
            <li>In Meta for Developers, open (or create) the store’s app and add <strong>Instagram API with Instagram login</strong>.</li>
            <li>Under API setup, add the store’s Instagram account and allow the <strong>instagram_business_basic</strong> permission.</li>
            <li>Generate an access token for that account and copy it.</li>
            <li>Paste it here and connect. It is checked with Instagram first, then stored encrypted — it is never shown again.</li>
          </ol>
          <form className="pv-ig-form" onSubmit={connect}>
            <label className="pv-card__label" htmlFor="pv-ig-token">Access token</label>
            <input
              id="pv-ig-token"
              className="pv-ig-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              disabled={Boolean(busy) || !s.encryptionAvailable}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste the long-lived access token"
            />
            <Button type="submit" busy={busy === 'connect'} disabled={Boolean(busy) || !s.encryptionAvailable || !token.trim()}>
              {s.connected ? 'Replace token' : 'Connect Instagram'}
            </Button>
          </form>
        </section>
      )}
    </div>
  );
}

export default InstagramTab;
