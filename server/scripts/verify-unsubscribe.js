// verify:unsubscribe — the unsubscribe link in every marketing email.
//
// Proves, against the real database and the real HTTP route:
//   - a genuine link withdraws MARKETING and NEWSLETTER for that address, and
//     the consent gate then refuses marketing to it;
//   - a forged or altered token changes nothing (400), so nobody can
//     unsubscribe somebody else;
//   - clicking twice is harmless;
//   - the one-click (RFC 8058) endpoint does the same.
// Uses a throwaway example.com address and removes every row it wrote.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { pool, query } = await import('../src/database/connection/pool.js');
const { createApp } = await import('../src/app.js');
const { consentService } = await import('../src/modules/consent/service.js');
const { unsubscribeToken, unsubscribeUrl } = await import('../src/modules/consent/unsubscribe.js');
const { storefrontBaseUrl } = await import('../src/config/index.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const email = `verify.unsub.${randomUUID().slice(0, 8)}@example.com`;
const other = `verify.unsub.other.${randomUUID().slice(0, 8)}@example.com`;

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: storefrontBaseUrl }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const marketable = async (key, purpose) => (await consentService.isMarketable({ contactKey: key, channel: 'EMAIL', purpose })).marketable;

try {
  for (const key of [email, other]) {
    for (const purpose of ['MARKETING', 'NEWSLETTER']) {
      // eslint-disable-next-line no-await-in-loop
      await consentService.record({ contactKey: key, channel: 'EMAIL', purpose, action: 'GRANTED', source: 'STAFF_RECORDED' });
    }
  }
  assert.equal(await marketable(email, 'MARKETING'), true, 'fixture starts opted in');

  const url = unsubscribeUrl('EMAIL', email);
  assert.ok(url.startsWith(`${storefrontBaseUrl}/unsubscribe?t=`), `link points at the storefront page: ${url}`);
  pass('LINK_POINTS_AT_THE_STOREFRONT_PAGE');

  // Forged: the other address's payload with this address's signature.
  const [, sig] = unsubscribeToken('EMAIL', email).split('.');
  const forgedPayload = Buffer.from(`EMAIL:${other}`).toString('base64url');
  const forged = await post('/api/v1/consent/unsubscribe', { token: `${forgedPayload}.${sig}` });
  assert.equal(forged.status, 400, `forged token refused, got ${forged.status}`);
  assert.equal(forged.json?.error?.code, 'UNSUBSCRIBE_LINK_INVALID');
  assert.equal(await marketable(other, 'MARKETING'), true, 'a forged link changed nothing');
  pass('FORGED_TOKEN_CHANGES_NOTHING');

  const ok = await post('/api/v1/consent/unsubscribe', { token: unsubscribeToken('EMAIL', email) });
  assert.equal(ok.status, 200, `unsubscribe -> ${ok.status} ${JSON.stringify(ok.json)}`);
  assert.equal(await marketable(email, 'MARKETING'), false, 'MARKETING withdrawn');
  assert.equal(await marketable(email, 'NEWSLETTER'), false, 'NEWSLETTER withdrawn');
  assert.equal(await marketable(other, 'MARKETING'), true, 'nobody else was affected');
  pass('LINK_WITHDRAWS_MARKETING_AND_NEWSLETTER');

  const again = await post('/api/v1/consent/unsubscribe', { token: unsubscribeToken('EMAIL', email) });
  assert.equal(again.status, 200, 'a second click is harmless');
  pass('SECOND_CLICK_IS_HARMLESS');

  const oneClick = await post(`/api/v1/consent/unsubscribe/one-click?t=${encodeURIComponent(unsubscribeToken('EMAIL', other))}`);
  assert.equal(oneClick.status, 200, `one-click -> ${oneClick.status} ${JSON.stringify(oneClick.json)}`);
  assert.equal(await marketable(other, 'MARKETING'), false, 'one-click withdrew marketing');
  pass('ONE_CLICK_ENDPOINT_WORKS');

  console.log('\nUnsubscribe — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('\nUNSUBSCRIBE_VERIFICATION = FAIL');
  console.error(error);
  process.exitCode = 1;
} finally {
  await query('DELETE FROM consent_records WHERE contact_key IN (?, ?)', [email, other]).catch((e) => console.error('cleanup consent_records', e.message));
  await query('DELETE FROM consent_state WHERE contact_key IN (?, ?)', [email, other]).catch((e) => console.error('cleanup consent_state', e.message));
  await query('DELETE FROM marketing_suppressions WHERE contact_key IN (?, ?)', [email, other]).catch((e) => console.error('cleanup marketing_suppressions', e.message));
  server.close();
  await pool.end();
}
