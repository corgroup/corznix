// Hero slides builder model: what a slide is in the editor, how it is saved,
// how it is checked, and what the live preview is sent.
//
// The server (server/src/modules/heroBanners/service.js) is the authority on
// what may be saved and on which slides are live; the checks and the "is it on
// the website" state here mirror it so an editor sees the answer while typing.
import { makeRowKey } from '../../components/ui/rowHelpers.js';

export const POSITIONS = [
  'TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT',
  'MIDDLE_LEFT', 'MIDDLE_CENTER', 'MIDDLE_RIGHT',
  'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT',
];
export const POSITION_LABEL = {
  TOP_LEFT: 'Top left', TOP_CENTER: 'Top centre', TOP_RIGHT: 'Top right',
  MIDDLE_LEFT: 'Middle left', MIDDLE_CENTER: 'Centre', MIDDLE_RIGHT: 'Middle right',
  BOTTOM_LEFT: 'Bottom left', BOTTOM_CENTER: 'Bottom centre', BOTTOM_RIGHT: 'Bottom right',
};

export const LIMITS = { title: 100, subtitle: 200, ctaLabel: 60, ctaHref: 500, altText: 255 };
export const DURATIONS = [4, 6, 8, 10, 12];
export const DEFAULT_DURATION = 6;
export const DEFAULT_OVERLAY = 55;

// A clock that ticks once a minute, for "is it live yet" (useSyncExternalStore).
export const subscribeClock = (callback) => {
  const timer = setInterval(callback, 30_000);
  return () => clearInterval(timer);
};
export const clockNow = () => Math.floor(Date.now() / 60_000) * 60_000;

const t = (v) => (typeof v === 'string' ? v.trim() : '');
const pad = (n) => String(n).padStart(2, '0');
export const guessMediaType = (url) => (/\/video\/upload\/|\.(mp4|webm|mov)(\?|$)/i.test(url || '') ? 'video' : 'image');

/** A stored date as the local yyyy-mm-dd the date input shows. */
export function toDateInput(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// A slide shows from the very start of its start date to the very end of its
// end date, in the editor's time zone — the end date is its last day.
const dayStart = (v) => new Date(`${v}T00:00:00`);
const dayEnd = (v) => new Date(`${v}T23:59:59.999`);
const showDate = (v) => dayStart(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export function hydrate(b) {
  return {
    _k: b.id || makeRowKey(),
    id: b.id || null,
    isNew: !b.id,
    mediaId: b.mediaId || null,
    mediaUrl: b.mediaUrl || null,
    mediaType: b.mediaType || (b.mediaUrl ? guessMediaType(b.mediaUrl) : null),
    mobileMediaId: b.mobileMediaId || null,
    mobileMediaUrl: b.mobileMediaUrl || null,
    mobileMediaType: b.mobileMediaType || (b.mobileMediaUrl ? guessMediaType(b.mobileMediaUrl) : null),
    title: b.title ?? '',
    subtitle: b.subtitle ?? '',
    ctaLabel: b.ctaLabel ?? '',
    ctaHref: b.ctaHref ?? '',
    altText: b.altText ?? '',
    active: b.status === 'ACTIVE',
    startsAt: toDateInput(b.startsAt),
    endsAt: toDateInput(b.endsAt),
    textPosition: b.textPosition || 'BOTTOM_LEFT',
    mobileTextPosition: b.mobileTextPosition || 'BOTTOM_LEFT',
    textTheme: b.textTheme || 'LIGHT',
    overlay: Number.isInteger(b.overlay) ? b.overlay : DEFAULT_OVERLAY,
    durationSeconds: Number.isInteger(b.durationSeconds) ? b.durationSeconds : DEFAULT_DURATION,
  };
}

/** A new slide starts switched off, so nothing half-made reaches the website. */
export const newSlide = () => hydrate({});

export function serialize(s) {
  return {
    mediaId: s.mediaId || null,
    mobileMediaId: s.mobileMediaId || null,
    title: t(s.title) || null,
    subtitle: t(s.subtitle) || null,
    ctaLabel: t(s.ctaLabel) || null,
    ctaHref: t(s.ctaHref) || null,
    altText: t(s.altText) || null,
    status: s.active ? 'ACTIVE' : 'INACTIVE',
    startsAt: s.startsAt ? dayStart(s.startsAt).toISOString() : null,
    endsAt: s.endsAt ? dayEnd(s.endsAt).toISOString() : null,
    textPosition: s.textPosition,
    mobileTextPosition: s.mobileTextPosition,
    textTheme: s.textTheme,
    overlay: s.overlay,
    durationSeconds: s.durationSeconds,
  };
}

/** The button's problem, or null. Mirrors the server's assertSlide. */
export function linkProblem(s) {
  const label = t(s.ctaLabel);
  const href = t(s.ctaHref);
  if (label && !href) return 'The button needs a link — or clear the button text.';
  if (href && !label) return 'The button needs text — or clear its link.';
  if (href && !(/^\/(?!\/)\S*$/.test(href) || /^https:\/\/\S+$/i.test(href))) {
    return 'The button link must be a page on this website (starting with “/”) or a full https:// address.';
  }
  return null;
}

export function validate(s) {
  const errors = [];
  const labels = { title: 'The title', subtitle: 'The line under the title', ctaLabel: 'The button text', ctaHref: 'The button link', altText: 'The picture description' };
  for (const [key, label] of Object.entries(labels)) {
    if (s[key].length > LIMITS[key]) errors.push(`${label} is longer than ${LIMITS[key]} characters.`);
  }
  if (s.active && !s.mediaId) errors.push('Choose a desktop picture or video before switching the slide on.');
  const link = linkProblem(s);
  if (link) errors.push(link);
  if (s.startsAt && s.endsAt && s.endsAt < s.startsAt) errors.push('The end date is before the start date.');
  return { errors };
}

/** live / off / no-media / scheduled / ended — whether the website shows it right now. */
export function slideState(s, now) {
  if (!s.active) return 'off';
  if (!s.mediaId) return 'no-media';
  if (s.startsAt && dayStart(s.startsAt).getTime() > now) return 'scheduled';
  if (s.endsAt && dayEnd(s.endsAt).getTime() < now) return 'ended';
  return 'live';
}

export const STATE_PILL = {
  live: ['good', 'Live'],
  off: ['muted', 'Off'],
  'no-media': ['warn', 'Needs a picture'],
  scheduled: ['info', 'Scheduled'],
  ended: ['muted', 'Ended'],
};

export function stateNote(s, state) {
  switch (state) {
    case 'live': return 'On the website now.';
    case 'off': return 'Switched off — not on the website.';
    case 'no-media': return 'Switched on, but it has no desktop picture yet, so it is not on the website.';
    case 'scheduled': return `Not on the website yet — it starts on ${showDate(s.startsAt)}.`;
    case 'ended': return `Not on the website any more — it ended on ${showDate(s.endsAt)}.`;
    default: return '';
  }
}

export const slideTitle = (s, i = null) => t(s.title) || (i === null ? 'Untitled slide' : `Slide ${i + 1} (no title)`);

export function slideMeta(s, state) {
  const kind = !s.mediaId ? 'no picture' : s.mediaType === 'video' ? 'video' : 'picture';
  const phone = s.mobileMediaId ? ' + phone version' : '';
  if (state === 'scheduled') return `${kind}${phone} · from ${showDate(s.startsAt)}`;
  if (state === 'ended') return `${kind}${phone} · ended ${showDate(s.endsAt)}`;
  return `${kind}${phone}${s.mediaType === 'video' ? '' : ` · ${s.durationSeconds} s`}`;
}

/** The storefront's public slide shape (server heroBanners/service.js toPublic). */
export function toPublic(s) {
  return {
    id: s._k,
    mediaUrl: s.mediaUrl,
    mediaType: s.mediaType,
    mobileMediaUrl: s.mobileMediaId ? s.mobileMediaUrl : null,
    mobileMediaType: s.mobileMediaId ? s.mobileMediaType : null,
    title: t(s.title) || null,
    subtitle: t(s.subtitle) || null,
    ctaLabel: t(s.ctaLabel) || null,
    ctaHref: t(s.ctaHref) || null,
    altText: t(s.altText) || null,
    textPosition: s.textPosition,
    mobileTextPosition: s.mobileTextPosition,
    textTheme: s.textTheme,
    overlay: s.overlay,
    durationSeconds: s.durationSeconds,
  };
}

/**
 * The preview shows the website's hero with the unsaved edits: the slides that
 * would be live, in order. The slide being edited is always shown and held on
 * screen — even when it is switched off or outside its dates, which the
 * preview's caption then says.
 */
export function previewMessage(slides, current, now) {
  const showable = (s) => Boolean(s.mediaId && s.mediaUrl);
  const live = slides.filter((s) => showable(s) && slideState(s, now) === 'live');
  const focus = current && showable(current) ? current : null;
  const shown = focus && !live.includes(focus) ? slides.filter((s) => live.includes(s) || s === focus) : live;
  return {
    type: 'hero',
    data: { configured: slides.length > 0, banners: shown.map(toPublic) },
    ui: { focusId: focus ? focus._k : null },
  };
}

export function previewCaption(current, now) {
  if (!current) return 'Add a slide to see it here';
  if (!current.mediaUrl) return 'Choose a desktop picture to see this slide';
  const state = slideState(current, now);
  if (state === 'live') return `Showing “${slideTitle(current)}” — as on the website`;
  return `Showing “${slideTitle(current)}” here only — ${stateNote(current, state).replace(/\.$/, '').toLowerCase()}`;
}
