// Seed + activate the default lifecycle communication templates.
//
// The notification plumbing (notifications/ + communications/) is fully wired:
// every lifecycle business event calls notificationService.emit(), which only
// actually sends when an ACTIVE communication_templates row exists for the
// (templateKey, channel). Out of the box NO templates exist, so nothing sends.
//
// This script creates + ACTIVATES an EMAIL template for every lifecycle policy
// from TEMPLATE_DEFAULTS, so transactional order/return/refund emails work on a
// fresh install. WhatsApp starters are created as DRAFT only — they cannot be
// activated until the business supplies the provider-approved template name
// (provider_template_ref); a human activates those from the CMS.
//
// Idempotent: an existing ACTIVE template for a (key, channel) is left alone;
// an existing DRAFT/ARCHIVED-only key is (re)activated from a fresh version.
//
//   npm run seed:comm-templates
import { pool } from '../src/database/connection/pool.js';
import { NOTIFICATION_POLICIES } from '../src/modules/notifications/policies.js';
import { TEMPLATE_DEFAULTS } from '../src/modules/notifications/templateDefaults.js';
import { communicationRepository } from '../src/modules/communications/repository.js';
import { communicationTemplateService } from '../src/modules/communications/templateService.js';

const summary = { activated: [], draft: [], skipped: [] };

try {
  const all = await communicationRepository.listTemplates();
  const activeKeys = new Set(all.filter((t) => t.status === 'ACTIVE').map((t) => `${t.template_key}|${t.channel}`));
  const anyKeys = new Set(all.map((t) => `${t.template_key}|${t.channel}`));

  for (const policy of Object.values(NOTIFICATION_POLICIES)) {
    const defaults = TEMPLATE_DEFAULTS[policy.templateKey] || {};
    for (const channel of policy.channels) {
      const starter = defaults[channel];
      const id = `${policy.templateKey}|${channel}`;
      if (!starter) { summary.skipped.push(`${id} (no starter copy)`); continue; }
      if (activeKeys.has(id)) { summary.skipped.push(`${id} (already ACTIVE)`); continue; }

      // WhatsApp cannot send without a provider-approved template name.
      const canActivate = channel === 'EMAIL' || Boolean(starter.providerTemplateRef);
      if (!canActivate && anyKeys.has(id)) { summary.skipped.push(`${id} (draft already exists)`); continue; }

      const created = await communicationTemplateService.create({
        templateKey: policy.templateKey,
        channel,
        classification: policy.classification,
        subject: starter.subject ?? null,
        bodyTemplate: starter.bodyTemplate,
        variableSchema: policy.variableSchema,
        providerTemplateRef: starter.providerTemplateRef ?? null,
      });

      if (canActivate) {
        await communicationTemplateService.setStatus({ id: created.id, status: 'ACTIVE' });
        summary.activated.push(`${id} v${created.version}`);
      } else {
        summary.draft.push(`${id} v${created.version} — needs provider_template_ref, activate in CMS`);
      }
      anyKeys.add(id);
    }
  }

  console.log('\nLifecycle communication templates\n');
  console.log(`  ACTIVATED (${summary.activated.length}):`);
  summary.activated.forEach((s) => console.log(`    ✓ ${s}`));
  if (summary.draft.length) {
    console.log(`\n  DRAFT — activate from CMS after adding the provider template name (${summary.draft.length}):`);
    summary.draft.forEach((s) => console.log(`    • ${s}`));
  }
  console.log(`\n  skipped (${summary.skipped.length}): ${summary.skipped.join(', ') || 'none'}`);
  console.log('\nDone. Transactional lifecycle emails will now send when their event fires.\n');
} finally {
  await pool.end();
}
