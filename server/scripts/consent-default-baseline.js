// consent:default-baseline — one-time default-ON marketing for customers who
// already existed when default-ON shipped (owner decision, 2026-09-17).
//
//   node scripts/consent-default-baseline.js            # dry run: prints the plan, writes nothing
//   node scripts/consent-default-baseline.js --apply    # writes DEFAULT_ON_BASELINE grants
//
// Same rule as sign-in: only VERIFIED contacts, only channels the customer has
// never decided about — an existing OFF (or any earlier decision) is left as it
// is. Idempotent: a second --apply finds every channel already decided.
// Suspended customers are skipped. Contacts are printed masked.
const apply = process.argv.includes('--apply');

const { pool, query } = await import('../src/database/connection/pool.js');
const { consentService } = await import('../src/modules/consent/service.js');
const { consentRepository } = await import('../src/modules/consent/repository.js');
const { normalizeEmail, normalizePhone } = await import('../src/utils/normalize.js');

const mask = (channel, key) => (channel === 'EMAIL'
  ? key.replace(/^(.{3}).*(@.*)$/, '$1***$2')
  : `***${key.slice(-3)}`);

try {
  const rows = await query(
    `SELECT c.id AS customer_id, c.status, cc.contact_type, cc.normalized_value
       FROM customers c
       JOIN customer_contacts cc ON cc.customer_id = c.id AND cc.is_verified = 1
      WHERE c.status IN ('ACTIVE', 'PENDING_PROFILE')
      ORDER BY c.created_at`);
  const plan = { grant: [], alreadyDecided: 0, invalid: 0 };
  for (const r of rows) {
    const channel = r.contact_type === 'PHONE' ? 'WHATSAPP' : 'EMAIL';
    const key = channel === 'WHATSAPP' ? normalizePhone(r.normalized_value) : normalizeEmail(r.normalized_value);
    if (!key) { plan.invalid += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    if (await consentRepository.hasMarketingDecision({ customerId: r.customer_id, contactKey: key, channel })) {
      plan.alreadyDecided += 1;
      continue;
    }
    plan.grant.push({ customerId: r.customer_id, channel, key });
  }

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — verified contacts: ${rows.length}, to grant: ${plan.grant.length}, already decided: ${plan.alreadyDecided}, invalid: ${plan.invalid}`);
  for (const g of plan.grant) console.log(`  ${g.channel.padEnd(8)} ${g.customerId.slice(0, 8)} ${mask(g.channel, g.key)}`);

  if (apply) {
    const customers = [...new Set(plan.grant.map((g) => g.customerId))];
    let written = 0;
    for (const id of customers) {
      // Through the service, so the rule (never override a decision) is
      // re-checked at write time, not only at plan time.
      // eslint-disable-next-line no-await-in-loop
      written += (await consentService.applyDefaultMarketing(id, 'DEFAULT_ON_BASELINE')).length;
    }
    console.log(`written: ${written} grant(s)`);
  }
} catch (error) {
  console.error('CONSENT_DEFAULT_BASELINE = FAIL');
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
