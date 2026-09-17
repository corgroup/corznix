import { communicationRepository } from '../communications/repository.js';
import { NOTIFICATION_POLICIES } from './policies.js';
import { TEMPLATE_DEFAULTS } from './templateDefaults.js';

// WP-07 — the lifecycle-notification catalogue the CMS renders. Merges the
// policy registry (what events exist + their canonical variable schema) with
// the current template state (does an ACTIVE template exist per channel) and
// the starter content (what a one-click "create draft" would pre-fill).
//
// Read-only. Creating / activating a template still goes through the existing
// POST /communications/templates + /status endpoints — this only tells the
// CMS what to create.

/**
 * @returns {Promise<Array<{
 *   event: string, label: string, description: string, policyKey: string,
 *   templateKey: string, classification: string,
 *   variableSchema: Record<string, object>,
 *   channels: Array<{
 *     channel: 'EMAIL'|'WHATSAPP', status: 'ACTIVE'|'DRAFT_ONLY'|'MISSING',
 *     activeVersion: number|null, latestVersion: number|null,
 *     starter: { subject?: string, bodyTemplate: string, providerTemplateRef?: string } | null
 *   }>
 * }>>}
 */
export async function buildNotificationCatalog() {
  const templates = await communicationRepository.listTemplates();
  const byKeyChannel = new Map(); // "key|channel" -> { active?: row, latestVersion: number }
  for (const t of templates) {
    const k = `${t.template_key}|${t.channel}`;
    const entry = byKeyChannel.get(k) || { active: null, latestVersion: 0 };
    entry.latestVersion = Math.max(entry.latestVersion, Number(t.version));
    if (t.status === 'ACTIVE') entry.active = t;
    byKeyChannel.set(k, entry);
  }

  return Object.entries(NOTIFICATION_POLICIES).map(([event, policy]) => ({
    event,
    label: policy.label,
    description: policy.description,
    policyKey: policy.policyKey,
    templateKey: policy.templateKey,
    classification: policy.classification,
    variableSchema: policy.variableSchema,
    channels: policy.channels.map((channel) => {
      const entry = byKeyChannel.get(`${policy.templateKey}|${channel}`) || null;
      const status = entry?.active ? 'ACTIVE' : entry ? 'DRAFT_ONLY' : 'MISSING';
      return {
        channel,
        status,
        activeVersion: entry?.active ? Number(entry.active.version) : null,
        latestVersion: entry ? entry.latestVersion : null,
        starter: TEMPLATE_DEFAULTS[policy.templateKey]?.[channel] ?? null,
      };
    }),
  }));
}
