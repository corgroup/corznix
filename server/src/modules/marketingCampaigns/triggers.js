import { z } from 'zod';

/**
 * What can make a campaign run (docs/MESSAGING.md).
 *
 * A trigger is registered here once its emitter exists. The CMS offers only
 * `available` triggers, so an admin can never pick one that would silently
 * never fire. Adding a trigger = an entry here + the code that emits it.
 *
 *   kind ONE_OFF   runs once, then the campaign completes (send now, schedule)
 *   kind EVENT     stays ACTIVE and runs for every matching event
 *
 * `perCustomer` events (abandoned cart) choose their own recipient — the
 * customer the event is about — so such a campaign has no audience step.
 */
const cartAbandonedConfig = z.object({
  delayMinutes: z.coerce.number().int().min(5).max(20160).default(240),
  maxAgeHours: z.coerce.number().int().min(1).max(2160).default(168),
  cooldownHours: z.coerce.number().int().min(1).max(2160).default(168),
  minCartValueMinor: z.coerce.number().int().min(0).max(100_000_000).default(0),
  couponCode: z.string().trim().max(40).nullable().optional(),
}).strict();

export const TRIGGERS = Object.freeze({
  send_now: {
    key: 'send_now', type: 'SEND_NOW', kind: 'ONE_OFF', available: true,
    label: 'Send now', description: 'Sends to the audience as soon as you activate it.',
  },
  scheduled: {
    key: 'scheduled', type: 'SCHEDULED', kind: 'ONE_OFF', available: true,
    label: 'Schedule', description: 'Sends automatically at the date and time you choose.',
  },
  'cart.abandoned': {
    key: 'cart.abandoned', type: 'EVENT', kind: 'EVENT', available: true, perCustomer: true,
    label: 'Abandoned cart', description: 'Reminds each customer who leaves items in their cart, after the wait you set.',
    configSchema: cartAbandonedConfig,
  },
  'collection.published': {
    key: 'collection.published', type: 'EVENT', kind: 'EVENT', available: false,
    label: 'Collection published', description: 'When a collection goes live with at least one photographed product.',
  },
  'product.published': {
    key: 'product.published', type: 'EVENT', kind: 'EVENT', available: false,
    label: 'Product published', description: 'When a product goes live.',
  },
  'customer.created': {
    key: 'customer.created', type: 'EVENT', kind: 'EVENT', available: false, perCustomer: true,
    label: 'Customer created', description: 'When a new customer signs up.',
  },
  'order.delivered': {
    key: 'order.delivered', type: 'EVENT', kind: 'EVENT', available: false, perCustomer: true,
    label: 'Order delivered (marketing follow-up)', description: 'A marketing follow-up after delivery, such as a review request.',
  },
});

/** The trigger a campaign row is configured with. */
export function triggerOf(campaign) {
  if (campaign.trigger_type === 'EVENT') return TRIGGERS[campaign.trigger_event] || null;
  return campaign.trigger_type === 'SCHEDULED' ? TRIGGERS.scheduled : TRIGGERS.send_now;
}

/** For the CMS: what can be picked today. */
export const availableTriggers = () => Object.values(TRIGGERS)
  .filter((t) => t.available)
  .map(({ key, type, kind, label, description, perCustomer = false }) => ({ key, type, kind, label, description, perCustomer }));
