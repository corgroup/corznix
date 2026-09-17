// Announcement bar builder model: what a message is in the editor, how it is
// saved, how it is checked, whether it is live, and what the preview is sent.
//
// The server (content/navigationService.js + entityLinks.js) is the authority;
// the checks and "is it live" here mirror it so an editor sees the answer
// while typing.
import { same, entityOf, entityRoute, routeForLink, isValidPath } from '../header/headerModel.js';

export { subscribeClock, clockNow } from '../heroModel.js';

export const LIMITS = { text: 300, comfortable: 60 };
export const AUTOPLAY_CHOICES = [3, 4, 5, 6, 8, 10];
export const DEFAULT_SETTINGS = { autoplaySeconds: 4, showClock: true, dismissible: true, dismissVersion: 'v1' };

const t = (v) => (typeof v === 'string' ? v.trim() : '');
const pad = (n) => String(n).padStart(2, '0');

/** A stored instant as the local yyyy-mm-ddThh:mm a datetime-local input shows. */
export function toLocalInput(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** The input's local time as an instant (the input has no time zone of its own). */
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

// ---- messages -------------------------------------------------------------------

export function hydrate(a) {
  const path = a.linkType ? routeForLink(a.linkType, a.linkTarget, a.externalUrl) || '' : '';
  return {
    _k: a.id,
    id: a.id,
    isNew: false,
    announcementKey: a.announcementKey,
    text: a.text || '',
    enabled: a.status === 'ACTIVE',
    link: { path, ref: a.linkRefId ? { type: a.linkRefType, id: a.linkRefId } : null, label: '' },
    startsAt: toLocalInput(a.startsAt),
    expiresAt: toLocalInput(a.expiresAt),
  };
}

/** Called from a click handler: the key is made once, not on every render. */
export function newMessage() {
  const key = `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  return { ...hydrate({ id: null, announcementKey: key, status: 'ACTIVE' }), _k: key, isNew: true };
}

const slugOf = (path, prefix) => {
  const m = new RegExp(`^/${prefix}/([^/?#]+)/?$`).exec(t(path));
  return m ? decodeURIComponent(m[1]) : null;
};

/** The stored link columns for a link row, the way the server stores them. */
function linkFields(link) {
  const none = { linkType: null, linkTarget: null, externalUrl: null, linkRefType: null, linkRefId: null };
  if (link?.ref?.id) {
    const page = link.ref.type === 'PAGE';
    return { ...none, linkType: page ? 'CONTENT_PAGE' : 'COLLECTION', linkTarget: slugOf(link.path, page ? 'pages' : 'collections'), linkRefType: link.ref.type, linkRefId: link.ref.id };
  }
  const p = t(link?.path);
  if (!p) return none;
  if (/^https?:\/\//i.test(p)) return { ...none, linkType: 'EXTERNAL', externalUrl: p };
  if (p === '/') return { ...none, linkType: 'HOME' };
  if (p === '/search') return { ...none, linkType: 'SEARCH' };
  if (slugOf(p, 'collections')) return { ...none, linkType: 'COLLECTION', linkTarget: slugOf(p, 'collections') };
  if (slugOf(p, 'pages')) return { ...none, linkType: 'CONTENT_PAGE', linkTarget: slugOf(p, 'pages') };
  if (slugOf(p, 'products')) return { ...none, linkType: 'PRODUCT', linkTarget: slugOf(p, 'products') };
  return { ...none, linkType: 'CUSTOM_INTERNAL', linkTarget: p };
}

export function serialize(m) {
  return {
    ...(m.id ? { id: m.id } : {}),
    announcementKey: m.announcementKey,
    text: t(m.text),
    status: m.enabled ? 'ACTIVE' : 'DISABLED',
    ...linkFields(m.link),
    startsAt: fromLocalInput(m.startsAt),
    expiresAt: fromLocalInput(m.expiresAt),
  };
}

export function validate(m, entities) {
  const errors = [];
  const warnings = [];
  const text = t(m.text);
  if (!text) errors.push('Write the message.');
  else if (text.length > LIMITS.text) errors.push(`The message is longer than ${LIMITS.text} characters.`);
  else if (text.length > LIMITS.comfortable) warnings.push(`Long messages are cut off on phones — about ${LIMITS.comfortable} characters fit on one line.`);
  const entity = entityOf(m.link, entities);
  if (m.link?.ref && entities && !entity) errors.push('The page this message links to no longer exists — choose another or remove the link.');
  if (!m.link?.ref && t(m.link?.path) && !isValidPath(m.link.path)) errors.push('The link must start with "/" (a page on this website) or https://.');
  if (entity && !entity.active) warnings.push(`“${entity.name}” is switched off, so the message shows without its link until it is back on.`);
  if (m.startsAt && m.expiresAt && m.expiresAt <= m.startsAt) errors.push('The end is not after the start.');
  return { errors, warnings };
}

// ---- bar settings -----------------------------------------------------------------

export const hydrateSettings = (s) => ({ ...DEFAULT_SETTINGS, ...(s || {}), showAgain: false, nextDismissVersion: null });

export const serializeSettings = (s) => ({
  autoplaySeconds: s.autoplaySeconds,
  showClock: Boolean(s.showClock),
  dismissible: Boolean(s.dismissible),
  dismissVersion: s.showAgain && s.nextDismissVersion ? s.nextDismissVersion : s.dismissVersion,
});

export function validateSettings(s) {
  const errors = [];
  if (!Number.isInteger(s.autoplaySeconds) || s.autoplaySeconds < 3 || s.autoplaySeconds > 15) errors.push('Choose how long each message shows (3 to 15 seconds).');
  return errors;
}

// ---- live / changed ---------------------------------------------------------------

/** The slide the server's snapshot would hold for this message (links as routes; references are not compared). */
function snapshotSlide(m) {
  const s = serialize(m);
  const slide = { id: s.announcementKey, text: s.text };
  if (s.linkType) slide.link = routeForLink(s.linkType, s.linkTarget, s.externalUrl);
  if (s.startsAt) slide.startsAt = s.startsAt;
  if (s.expiresAt) slide.expiresAt = s.expiresAt;
  return slide;
}
const withoutRef = (slide) => {
  const { ref, ...rest } = slide || {};
  void ref;
  return rest;
};

/** live / changed / new / pending / off / going-off / scheduled / ended. */
export function messageState(m, published, now) {
  if (m.isNew) return 'new';
  const pub = (published?.slides || []).find((p) => p.id === m.announcementKey);
  if (!m.enabled) return pub ? 'going-off' : 'off';
  if (!pub) return 'pending';
  if (!same(snapshotSlide(m), withoutRef(pub))) return 'changed';
  if (m.expiresAt && new Date(m.expiresAt).getTime() <= now) return 'ended';
  if (m.startsAt && new Date(m.startsAt).getTime() > now) return 'scheduled';
  return 'live';
}

export const STATE_PILL = {
  live: ['good', 'Live'], changed: ['info', 'Changed'], new: ['info', 'New'], pending: ['info', 'Not live yet'],
  off: ['muted', 'Off'], 'going-off': ['warn', 'Turning off'], scheduled: ['info', 'Scheduled'], ended: ['muted', 'Ended'],
};

/** True when the saved draft differs from what the website shows. */
export function unpublished(messages, settings, published) {
  if (!published) return true;
  const draft = {
    dismissVersion: serializeSettings(settings).dismissVersion,
    settings: (({ dismissVersion, ...rest }) => { void dismissVersion; return rest; })(serializeSettings(settings)),
    slides: messages.filter((m) => m.enabled && !m.isNew).map(snapshotSlide),
  };
  const live = {
    dismissVersion: published.dismissVersion,
    settings: published.settings || null,
    slides: (published.slides || []).map(withoutRef),
  };
  return !same(draft, live);
}

export const messageTitle = (m) => t(m.text) || 'New message';

export function messageMeta(m, entities) {
  const entity = entityOf(m.link, entities);
  const link = entity ? `→ ${entity.name}` : t(m.link?.path) ? `→ ${t(m.link.path)}` : 'no link';
  const when = (v) => new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const schedule = m.startsAt && m.expiresAt ? ` · ${when(m.startsAt)} – ${when(m.expiresAt)}`
    : m.startsAt ? ` · from ${when(m.startsAt)}` : m.expiresAt ? ` · until ${when(m.expiresAt)}` : '';
  return `${link}${schedule}`;
}

// ---- preview ------------------------------------------------------------------------

const inWindow = (m, now) => !(m.startsAt && new Date(m.startsAt).getTime() > now) && !(m.expiresAt && new Date(m.expiresAt).getTime() <= now);

/** The storefront slide for a message: the link resolved the way the server resolves it. */
function previewSlide(m, entities) {
  const slide = { id: m._k, text: t(m.text) };
  const entity = entityOf(m.link, entities);
  if (entity) {
    if (entity.active) slide.link = entityRoute(entity);
  } else if (!m.link?.ref && t(m.link?.path) && isValidPath(m.link.path)) {
    slide.link = t(m.link.path);
  }
  return slide;
}

/**
 * The bar as the website would show it right now with these edits, holding
 * the message being edited on screen — even when it is switched off or
 * outside its dates, which the caption then says.
 */
export function previewMessage({ messages, settings, current, entities, now }) {
  const shown = messages.filter((m) => t(m.text) && ((m.enabled && inWindow(m, now)) || m === current));
  const s = serializeSettings(settings);
  return {
    type: 'announcements',
    data: {
      slides: shown.map((m) => previewSlide(m, entities)),
      settings: { autoplaySeconds: s.autoplaySeconds, showClock: s.showClock, dismissible: s.dismissible },
    },
    ui: { announcementFocusId: current && t(current.text) ? current._k : null },
  };
}

export function previewCaption(current, now) {
  if (!current) return 'Add a message to see it in the bar';
  if (!t(current.text)) return 'Write the message to see it in the bar';
  if (!current.enabled) return 'Showing this message here only — it is switched off';
  if (current.startsAt && new Date(current.startsAt).getTime() > now) return 'Showing this message here only — it has not started yet';
  if (current.expiresAt && new Date(current.expiresAt).getTime() <= now) return 'Showing this message here only — it has ended';
  return 'Showing the message being edited, held on screen';
}
