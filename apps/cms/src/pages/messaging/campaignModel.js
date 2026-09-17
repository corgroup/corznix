// Shared vocabulary for Messaging → Campaigns (docs/MESSAGING.md). Everything
// the admin reads is a plain word; codes stay behind these maps.

export const STATUS_TONE = {
  DRAFT: 'muted', SCHEDULED: 'warn', ACTIVE: 'good', PAUSED: 'warn', COMPLETED: 'good', CANCELLED: 'muted',
};

export const STATUS_LABEL = {
  DRAFT: 'Draft', SCHEDULED: 'Scheduled', ACTIVE: 'Active', PAUSED: 'Paused', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};

export const CHANNEL_LABEL = { EMAIL: 'Email', WHATSAPP: 'WhatsApp' };

export const REGISTERED_FILTER_LABEL = {
  ALL: 'All registered customers',
  NEW_USERS: 'New customers (last 30 days)',
  HAS_ORDERED: 'Customers who have ordered',
  NEVER_ORDERED: 'Customers who have never ordered',
};

export const SOURCE_LABEL = {
  REGISTERED_USERS: 'Registered customers',
  SEGMENT: 'Customer segment',
  EMAIL_SUBSCRIBERS: 'Email newsletter subscribers',
  WHATSAPP_SUBSCRIBERS: 'WhatsApp subscribers',
  LIST: 'Uploaded list',
};

export const RUN_STATUS_LABEL = { RUNNING: 'Sending', PAUSED: 'Paused', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };

/** "send_now" → "Sent when activated", "scheduled:<iso>" → the date, … */
export function describeRunTrigger(key) {
  if (key === 'send_now') return 'Sent when activated';
  if (key === 'migrated') return 'Before the campaign builder';
  if (String(key).startsWith('scheduled:')) return `Scheduled for ${formatDateTime(String(key).slice(10))}`;
  return key;
}

export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/** <input type="datetime-local"> value in the admin's own timezone. */
export function toLocalInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function describeAudience(sources, lists = [], segments = []) {
  if (!sources?.length) return 'No audience chosen';
  return sources.map((s) => {
    if (s.type === 'REGISTERED_USERS') return REGISTERED_FILTER_LABEL[s.filter || 'ALL'];
    if (s.type === 'LIST') return `List: ${lists.find((l) => l.id === s.listId)?.name || 'uploaded list'}`;
    if (s.type === 'SEGMENT') return `Segment: ${segments.find((g) => g.id === s.segmentId)?.name || 'customer segment'}`;
    return SOURCE_LABEL[s.type] || s.type;
  }).join(' · ');
}

/** "marketing.new_collection" -> "New collection" — the admin never reads a key. */
export function templateLabel(key) {
  const last = String(key || '').split('.').pop().replace(/_/g, ' ').trim();
  return last ? last.charAt(0).toUpperCase() + last.slice(1) : '—';
}

export const rupeesFromPaise = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN')}`;

// ---- recipient-level status, in words ------------------------------------
const REASON_LABEL = {
  NO_CONSENT: 'marketing turned off',
  FREQUENCY_CAP: 'already messaged in the last 24 h',
  SUPPRESSED_CONSENT_REVOKED: 'unsubscribed',
  INVALID_ENDPOINT: 'invalid contact',
  NO_VERIFIED_CONTACT: 'no verified contact',
  RECIPIENT_INVALID: 'the provider rejected the number or address',
  PROVIDER_NOT_CONFIGURED: 'provider not configured',
};
export const reasonLabel = (reason) => (reason ? REASON_LABEL[reason] || reason : null);

/**
 * One recipient × channel, as the admin should read it. `state` is what the
 * campaign decided; `messageStatus` is what the messaging engine / provider
 * did. Delivered is shown only when a provider confirmed delivery.
 */
export function deliveryLabel({ state, stateReason, messageStatus, failureReason }) {
  if (state === 'SUPPRESSED') return { text: `Not sent — ${reasonLabel(stateReason) || 'not eligible'}`, tone: 'muted' };
  if (state === 'CANCELLED') return { text: 'Cancelled before sending', tone: 'muted' };
  if (state === 'PENDING') return { text: 'Waiting to send', tone: 'warn' };
  if (state === 'FAILED' && !messageStatus) return { text: `Failed — ${reasonLabel(stateReason) || 'error'}`, tone: 'bad' };
  return messageLabel(messageStatus, failureReason);
}

export function messageLabel(status, reason) {
  switch (status) {
    case 'QUEUED': case 'SENDING': return { text: 'Sending', tone: 'warn' };
    case 'SENT': return { text: 'Accepted by provider', tone: 'good' };
    case 'DELIVERED': return { text: 'Delivered', tone: 'good' };
    case 'FAILED': return { text: `Failed${reason ? ` — ${reasonLabel(reason)}` : ''}`, tone: 'bad' };
    case 'SUPPRESSED': return { text: `Not sent — ${reasonLabel(reason) || 'not eligible'}`, tone: 'muted' };
    case 'UNKNOWN': return { text: 'Unconfirmed by provider', tone: 'warn' };
    default: return { text: '—', tone: 'muted' };
  }
}

export function sourceLabel(source, lists = [], segments = []) {
  const [type, id = ''] = String(source || '').split(':');
  // Rows written before migration 126 hold a truncated id: match by prefix.
  const byId = (rows) => (id ? rows.find((row) => row.id === id || (id.length >= 30 && row.id.startsWith(id))) : null);
  if (type === 'REGISTERED_USERS') return REGISTERED_FILTER_LABEL[id || 'ALL'];
  if (type === 'LIST') return `List: ${byId(lists)?.name || 'uploaded list'}`;
  if (type === 'SEGMENT') return `Segment: ${byId(segments)?.name || 'customer segment'}`;
  return SOURCE_LABEL[type] || source || '—';
}

export const isCartCampaign = (c) => c?.trigger_event === 'cart.abandoned' || c?.campaign_type === 'ABANDONED_CART';

// Providers used today report acceptance, not delivery or read receipts.
export const READ_NOT_REPORTED = 'Not reported by provider';
