// HTTP request-boundary behaviour: status classification, response hygiene,
// and the security headers the app claims to send.
//
// Boots the real app on an ephemeral port (createApp().listen(0)) rather than
// asserting against the middleware in isolation, because what matters is what
// actually reaches a client.
//
// The finding that prompted this: `express.json()` rejects malformed and
// oversized bodies with a plain Error, which fell through to the catch-all and
// was returned as HTTP 500 INTERNAL_ERROR. Ordinary bad requests were being
// counted and alerted on as server faults, and any client retrying on 5xx
// would retry forever a request that could never succeed.
//
// Read-only: makes no database writes.
//
//   npm run verify:error-boundary --workspace=server
process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';

const { createApp } = await import('../src/app.js');
const { pool } = await import('../src/database/connection/pool.js');

const results = {};
let failures = 0;

const pass = (name, detail = '') => {
  results[name] = `PASS${detail ? ` (${detail})` : ''}`;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
};
const fail = (name, detail) => {
  results[name] = `FAIL: ${detail}`;
  failures += 1;
  console.error(`  FAIL  ${name} — ${detail}`);
};

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function raw(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON — that is itself a finding */ }
  return { status: res.status, text, json, headers: res.headers };
}

try {
  // ---- 1. client errors must not be reported as server faults -------------
  {
    const res = await raw('/api/v1/auth/otp/request', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json',
    });
    if (res.status === 400 && res.json?.error?.code === 'MALFORMED_JSON') {
      pass('malformed_json_is_400', `${res.status} ${res.json.error.code}`);
    } else {
      fail('malformed_json_is_400', `got ${res.status} ${res.json?.error?.code}`);
    }

    // The parser's own message quotes the offending input and describes
    // internals; a fixed message is returned instead.
    const message = String(res.json?.error?.message ?? '');
    if (/position \d|line \d|JSON at position/i.test(message)) {
      fail('malformed_json_message_is_generic', `echoes parser internals: ${message}`);
    } else {
      pass('malformed_json_message_is_generic');
    }
  }

  {
    const oversized = JSON.stringify({ a: 'x'.repeat(2 * 1024 * 1024) });
    const res = await raw('/api/v1/auth/otp/request', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: oversized,
    });
    if (res.status === 413 && res.json?.error?.code === 'PAYLOAD_TOO_LARGE') {
      pass('oversized_body_is_413', `${res.status} ${res.json.error.code}`);
    } else {
      fail('oversized_body_is_413', `got ${res.status} ${res.json?.error?.code}`);
    }
  }

  // ---- 2. routing and auth boundaries -------------------------------------
  {
    const res = await raw('/api/v1/nope');
    if (res.status === 404 && res.json?.error?.code === 'NOT_FOUND') pass('unknown_route_is_404');
    else fail('unknown_route_is_404', `got ${res.status} ${res.json?.error?.code}`);
  }

  {
    const res = await raw('/api/v1/orders');
    if (res.status === 401 && res.json?.error?.code === 'AUTH_REQUIRED') pass('customer_route_requires_auth');
    else fail('customer_route_requires_auth', `got ${res.status} ${res.json?.error?.code}`);
  }

  {
    const res = await raw('/api/v1/admin/products');
    if (res.status === 401) pass('admin_route_requires_staff_auth', `${res.status} ${res.json?.error?.code}`);
    else fail('admin_route_requires_staff_auth', `got ${res.status} ${res.json?.error?.code}`);
  }

  // ---- 3. no internals in any error response ------------------------------
  {
    const probes = [
      ['/api/v1/nope', {}],
      ['/api/v1/orders', {}],
      ['/api/v1/admin/products', {}],
      ['/api/v1/auth/otp/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }],
    ];
    const leaks = [];
    for (const [path, opts] of probes) {
      // eslint-disable-next-line no-await-in-loop
      const res = await raw(path, opts);
      // A stack frame, a filesystem path, or a SQL fragment reaching a client
      // is a disclosure regardless of how harmless the individual string is.
      if (/\bat [\w.]+ \(|node_modules|[A-Za-z]:\\\\|\/src\/modules\/|SELECT .* FROM /i.test(res.text)) {
        leaks.push(`${path}: ${res.text.slice(0, 120)}`);
      }
    }
    if (leaks.length) fail('no_internals_in_error_bodies', leaks.join(' | '));
    else pass('no_internals_in_error_bodies', `${probes.length} responses checked`);
  }

  // ---- 4. security headers actually on the wire ---------------------------
  {
    const res = await raw('/api/v1/products');
    const required = {
      'content-security-policy': /default-src/,
      'strict-transport-security': /max-age=\d+/,
      'x-content-type-options': /nosniff/,
      'referrer-policy': /no-referrer|strict-origin/,
      'x-frame-options': /SAMEORIGIN|DENY/i,
      'cross-origin-resource-policy': /same-origin|same-site/,
    };
    const missing = Object.entries(required)
      .filter(([header, pattern]) => !pattern.test(res.headers.get(header) ?? ''))
      .map(([header]) => header);
    if (missing.length) fail('security_headers_present', `missing//unexpected: ${missing.join(', ')}`);
    else pass('security_headers_present', `${Object.keys(required).length} headers verified`);

    // frame-ancestors is what actually stops framing in modern browsers;
    // X-Frame-Options alone is legacy.
    if (/frame-ancestors/.test(res.headers.get('content-security-policy') ?? '')) {
      pass('csp_sets_frame_ancestors');
    } else {
      fail('csp_sets_frame_ancestors', 'CSP has no frame-ancestors directive');
    }
  }

  // ---- 5. correlation id is minted for every response ---------------------
  {
    const res = await raw('/api/v1/nope');
    if (res.headers.get('x-request-id') && res.headers.get('x-correlation-id')) {
      pass('errors_carry_correlation_ids');
    } else {
      fail('errors_carry_correlation_ids', 'an error response had no request/correlation id to trace it by');
    }
  }

  console.log(`\n${JSON.stringify(results, null, 2)}`);
  console.log(`\nERROR_BOUNDARY = ${failures ? 'FAIL' : 'PASS'}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}

if (failures) process.exit(1);
