// Which customer notifications can actually send right now, and which cannot.
//
// A lifecycle event only produces a message when an ACTIVE
// communication_templates row exists for its (templateKey, channel). WhatsApp
// starters are seeded as DRAFT on purpose — they cannot be activated until the
// business supplies the provider-approved template name and a human activates
// them in the CMS. Nothing failed loudly when one stayed DRAFT: the enqueue
// threw TEMPLATE_NOT_AVAILABLE, the notification layer treated that as a quiet
// code, and the caller discarded the result. "The customer never got it" and
// "we never tried" looked identical from the outside.
//
// This is the answer to "why did no WhatsApp arrive for Order Confirmed?"
// without reading any code. Read-only — it writes nothing.
//
//   npm run report:notification-readiness
import { pool, query } from '../src/database/connection/pool.js';
import { NOTIFICATION_POLICIES } from '../src/modules/notifications/policies.js';
import { TEMPLATE_DEFAULTS } from '../src/modules/notifications/templateDefaults.js';
import { META_TEMPLATE_CONTRACT } from '../src/modules/communications/providers.js';

const rows = await query('SELECT template_key, channel, status, provider_template_ref FROM communication_templates');
const byKey = new Map(rows.map((r) => [`${r.template_key}|${r.channel}`, r]));

const report = [];
for (const [eventKey, policy] of Object.entries(NOTIFICATION_POLICIES)) {
  for (const channel of policy.channels) {
    const id = `${policy.templateKey}|${channel}`;
    const row = byKey.get(id);
    const ref = row?.provider_template_ref || TEMPLATE_DEFAULTS[policy.templateKey]?.[channel]?.providerTemplateRef || null;

    let state;
    let why = '';
    if (!row) { state = 'CANNOT SEND'; why = 'no template row — run seed:comm-templates'; }
    else if (row.status !== 'ACTIVE') { state = 'CANNOT SEND'; why = `template is ${row.status} — activate it in the CMS`; }
    else if (channel === 'WHATSAPP' && !ref) { state = 'CANNOT SEND'; why = 'no provider_template_ref — set the approved Meta template name'; }
    else state = 'ready';

    // An ACTIVE WhatsApp template still sends a broken message when the policy
    // does not fill every positional slot the approved template declares.
    let slots = '';
    if (channel === 'WHATSAPP' && ref) {
      const contract = META_TEMPLATE_CONTRACT[ref];
      if (!contract) slots = `template "${ref}" not in META_TEMPLATE_CONTRACT`;
      else {
        const needed = [...(contract.header || []), ...contract.body];
        const probe = {
          orderNumber: 'X', orderId: 'o', shipmentId: 's', customerName: 'N', amount: '1',
          paymentReference: 'p', paymentDate: 'd', awb: 'A', estimatedDelivery: 'E',
          refundAmount: '9', resolutionType: 'R', pickupAddress: 'P', deliveryWindow: 'W',
          attemptDate: 'T', supportNumber: 'S', issueType: 'I', affectedStage: 'G', reason: 'r',
          itemsSummary: 'Item x1', purchaseWording: 'order', shippingSnapshot: { estimatedDays: 3 },
        };
        let vars = {};
        try { vars = policy.variables(probe) || {}; } catch { vars = {}; }
        const missing = needed.filter((n) => vars[n] === undefined || vars[n] === null || vars[n] === '');
        if (missing.length) { state = 'BROKEN MESSAGE'; slots = `blank slots: ${missing.join(', ')}`; }
      }
    }
    report.push({ event: eventKey, channel, template: policy.templateKey, ref: ref || '-', state, note: why || slots });
  }
}

const pad = (s, n) => String(s).padEnd(n);
const bad = report.filter((r) => r.state !== 'ready');
console.log('');
console.log(`${pad('EVENT', 30)}${pad('CH', 10)}${pad('PROVIDER TEMPLATE', 26)}${pad('STATE', 16)}NOTE`);
console.log('-'.repeat(120));
for (const r of report) console.log(`${pad(r.event, 30)}${pad(r.channel, 10)}${pad(r.ref, 26)}${pad(r.state, 16)}${r.note}`);
console.log('');
console.log(bad.length
  ? `${bad.length} of ${report.length} channel(s) will NOT reach the customer as written:\n  ${bad.map((r) => `${r.event}/${r.channel} — ${r.note}`).join('\n  ')}`
  : `All ${report.length} channels are ready to send.`);
console.log('');

await pool.end();
process.exit(0);
