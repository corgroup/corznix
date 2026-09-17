import { Link } from 'react-router-dom';
import { SortableList, DragHandle } from '../../../components/ui/SortableList.jsx';
import { makeRowKey } from '../../../components/ui/rowHelpers.js';
import { useAuth } from '../../../auth/useAuth.js';
import { formatRelative } from '../../../utils/format.js';
import { Toggle, Segment } from '../header/HeaderEditors.jsx';
import * as H from './homepageModel.js';

// The homepage Instagram section's editor. The posts are the store's real
// Instagram posts, synced from the account connected in Providers ->
// Instagram: the section shows the newest few automatically, or exactly the
// posts an editor picks, in the editor's order.

const dateOf = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const captionOf = (p) => (p?.caption ? p.caption.trim().split('\n')[0] : '');

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
);

function Thumb({ post }) {
  return post?.coverUrl
    ? <img className="hp-ig-thumb" src={post.coverUrl} alt="" loading="lazy" />
    : <span className="hp-ig-thumb hp-ig-thumb--empty" aria-hidden="true">No picture</span>;
}

/** Why a picked post cannot be on the website, or null when it can. */
function pickProblem(post) {
  if (!post) return 'Not among the synced posts any more — not shown.';
  if (post.status !== 'ACTIVE') return 'Deleted on Instagram — not shown.';
  if (!post.coverUrl) return 'Its picture has not been copied yet — shown after the next sync copies it.';
  return null;
}

function AccountStatus({ instagram }) {
  const { hasPermission } = useAuth();
  const providersLink = hasPermission('providers.read')
    ? <Link to="/platform/providers?tab=Instagram">Providers → Instagram</Link>
    : 'Providers → Instagram (ask an admin)';

  if (instagram.status === 'loading') return <p className="hb-field__hint">Loading your Instagram posts…</p>;
  if (instagram.status === 'error') {
    return (
      <div className="hp-ig-account hp-ig-account--warn" role="alert">
        <p>Your Instagram posts could not be loaded: {instagram.error?.message || 'try again'}.</p>
        <button type="button" className="hb-add hb-add--inline" onClick={instagram.reload}>Try again</button>
      </div>
    );
  }
  const { status, posts } = instagram.data;
  if (!status.connected) {
    return (
      <div className="hp-ig-account hp-ig-account--warn">
        <p>
          <strong>Instagram is not connected.</strong>{' '}
          {posts.length
            ? 'The website keeps showing the posts synced before, but no new ones arrive.'
            : 'Connect the store’s Instagram account and its posts appear here.'}
          {' '}Connect it in {providersLink}.
        </p>
      </div>
    );
  }
  return (
    <div className={`hp-ig-account${status.status === 'AUTH_FAILED' ? ' hp-ig-account--warn' : ''}`}>
      <p>
        Showing posts from <strong>@{status.username}</strong>
        {' · '}{status.posts.live} post{status.posts.live === 1 ? '' : 's'}
        {status.lastSyncedAt ? ` · synced ${formatRelative(status.lastSyncedAt)}` : ' · not synced yet'}
      </p>
      {status.status === 'AUTH_FAILED' && (
        <p>Instagram stopped accepting the access token, so new posts no longer arrive. Reconnect the account in {providersLink}. The website keeps showing the posts it already has.</p>
      )}
      {status.status !== 'AUTH_FAILED' && status.lastSyncError && <p>{status.lastSyncError}</p>}
      <button type="button" className="hb-add hb-add--inline" onClick={instagram.reload}>Reload posts</button>
    </div>
  );
}

export function InstagramSectionEditor({ section, onChange, instagram, disabled, text, set }) {
  const c = section.config;
  const mode = c.mode === 'PICKED' ? 'PICKED' : 'LATEST';
  const limit = Number.isInteger(c.limit) ? c.limit : H.DEFAULT_IG_LIMIT;
  const posts = instagram.status === 'ready' ? instagram.data.posts : [];
  const byId = new Map(posts.map((p) => [p.igMediaId, p]));
  const pickedIds = new Set(section.picks.map((p) => p.igMediaId));
  const shown = H.instagramPreviewPosts(section, posts);
  const available = posts.filter((p) => p.status === 'ACTIVE' && p.coverUrl && !pickedIds.has(p.igMediaId));
  const full = section.picks.length >= H.LIMITS.igPicks;

  const setPicks = (picks) => onChange({ ...section, picks });
  const patchPick = (k, part) => setPicks(section.picks.map((p) => (p._k === k ? { ...p, ...part } : p)));
  const addPick = (post) => setPicks([...section.picks, { _k: makeRowKey(), igMediaId: post.igMediaId, enabled: true }]);

  return (
    <>
      {text('eyebrow', 'Small line above the heading', H.LIMITS.eyebrow)}
      {text('heading', 'Heading', H.LIMITS.heading)}
      <div className="hb-grid__full">
        {text('description', 'Line under the heading', H.LIMITS.description, { multiline: true, hint: 'The “Explore Instagram” link under it opens the Instagram address in Footer → Social links.' })}
      </div>

      <div className="hb-grid__full">
        <AccountStatus instagram={instagram} />
      </div>

      <div className="hb-grid__full">
        <Segment label="Which posts" value={mode} disabled={disabled}
          options={[['LATEST', 'Latest posts, automatically'], ['PICKED', 'Posts I choose']]}
          onChange={(v) => set({ mode: v })} />
      </div>

      {mode === 'LATEST' && (
        <div className="hb-grid__full">
          <Segment label="How many" value={String(limit)} disabled={disabled}
            options={H.IG_LIMIT_CHOICES.map((n) => [String(n), `${n} posts`])}
            onChange={(v) => set({ limit: Number(v) })} />
          <p className="hb-field__hint">New posts appear on their own after each sync (every 30 minutes); a post deleted on Instagram drops out.</p>
          {shown.length > 0 && (
            <ul className="hp-ig-strip" aria-label="Posts the website shows now">
              {shown.map((p) => (
                <li key={p.id}><img className="hp-ig-thumb" src={p.coverUrl} alt={p.caption || `Instagram ${p.kind}`} loading="lazy" /></li>
              ))}
            </ul>
          )}
        </div>
      )}

      {mode === 'PICKED' && (
        <div className="hb-grid__full">
          <div className="hb-rows">
            <div className="hb-rows__head">
              <span className="hb-rows__title">Your picks</span>
              <span className="hb-panel__hint">{section.picks.length}/{H.LIMITS.igPicks} · drag to reorder</span>
            </div>
            {section.picks.length === 0 && <p className="hb-rows__empty">No posts picked yet — choose from your posts below.</p>}
            <SortableList
              label="Your picks"
              items={section.picks}
              getKey={(p) => p._k}
              disabled={disabled}
              onReorder={setPicks}
              renderItem={(pick, i, { handleProps }) => {
                const post = byId.get(pick.igMediaId);
                const problem = instagram.status === 'ready' ? pickProblem(post) : null;
                return (
                  <div className="hp-list-row">
                    <DragHandle {...handleProps} disabled={disabled} />
                    <div className="hp-list-row__fields hp-ig-pick">
                      <Thumb post={post} />
                      <div className="hp-ig-pick__text">
                        <span className="hp-ig-pick__caption">{captionOf(post) || (post ? `Instagram ${post.kind}` : `Post ${pick.igMediaId}`)}</span>
                        <span className="hb-field__hint">{post ? `${post.kind === 'reel' ? 'Reel' : 'Post'} · ${dateOf(post.postedAt)}` : ''}</span>
                        {problem && <span className="hb-field__hint hb-field__hint--warn">{problem}</span>}
                      </div>
                      <Toggle checked={pick.enabled} disabled={disabled} label={pick.enabled ? 'Shown' : 'Hidden'} onChange={(v) => patchPick(pick._k, { enabled: v })} />
                    </div>
                    <button type="button" className="hb-icon-btn hb-icon-btn--danger" disabled={disabled}
                      aria-label={`Remove pick ${i + 1}`} onClick={() => setPicks(section.picks.filter((p) => p._k !== pick._k))}>
                      <TrashIcon />
                    </button>
                  </div>
                );
              }}
            />
          </div>

          {!disabled && instagram.status === 'ready' && (
            <div className="hb-rows">
              <div className="hb-rows__head">
                <span className="hb-rows__title">Your Instagram posts</span>
                <span className="hb-panel__hint">{full ? `Limit of ${H.LIMITS.igPicks} reached` : 'click a post to add it'}</span>
              </div>
              {available.length === 0
                ? <p className="hb-rows__empty">{posts.length ? 'Every post with a picture is already picked.' : 'No synced posts yet.'}</p>
                : (
                  <ul className="hp-ig-grid">
                    {available.map((p) => (
                      <li key={p.igMediaId}>
                        <button type="button" className="hp-ig-grid__item" disabled={full} onClick={() => addPick(p)}
                          aria-label={`Add ${p.kind} from ${dateOf(p.postedAt)}${captionOf(p) ? `: ${captionOf(p).slice(0, 60)}` : ''}`}>
                          <Thumb post={p} />
                          <span className="hp-ig-grid__meta">{p.kind === 'reel' ? 'Reel' : 'Post'} · {dateOf(p.postedAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          )}
        </div>
      )}

      <div className="hb-grid__full">
        <Segment label="Move to the next post every" disabled={disabled}
          value={String(Number.isInteger(c.autoplaySeconds) ? c.autoplaySeconds : H.DEFAULT_AUTOPLAY)}
          options={H.AUTOPLAY_CHOICES.map((n) => [String(n), `${n} seconds`])}
          onChange={(v) => set({ autoplaySeconds: Number(v) })} />
        <p className="hb-field__hint">It pauses while a visitor hovers, swipes or plays a post, and never moves for people who turned off motion.</p>
      </div>
    </>
  );
}
