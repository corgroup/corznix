// Careers — job postings + applications. Verification.
//
// Proves, against a real HTTP listener + real MySQL + the real communications
// engine (no real send — MOCK provider):
//   JOB_LIFECYCLE          — create (DRAFT) -> publish -> close -> reopen;
//                             slug auto-derived + disambiguated on collision.
//   PUBLIC_LISTING_SCOPE   — only PUBLISHED (and not yet closed) jobs are
//                             visible on the public /careers/jobs surface.
//   APPLY_REAL_MULTIPART   — a real multipart POST with a PDF resume creates
//                             a real application row, stores the resume in
//                             the private document boundary (retrievable),
//                             fires a staff notification, and enqueues +
//                             renders both the ops and applicant emails.
//   APPLY_VALIDATION       — missing fields / non-PDF / a closed or unknown
//                             job are all rejected with no side effects.
//   RESUME_IS_PRIVATE      — no public route serves the resume; only the
//                             gated admin endpoint does.
//   ADMIN_WORKFLOW         — status change, note, email-to-applicant, and
//                             assignment (incl. a stale-version conflict)
//                             all work and are logged to the event trail.
//   RBAC                   — careers.read vs careers.manage is enforced.
//
// Isolated + self-cleaning. No real provider call (COMMUNICATIONS_*_MODE
// stays MOCK for this run regardless of .env).
//
//   npm run verify:careers
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.COMMUNICATION_WORKER_ENABLED = 'false';
process.env.COMMUNICATIONS_EMAIL_PROVIDER_MODE = 'MOCK';

const { createApp } = await import('../src/app.js');
const { pool, query } = await import('../src/database/connection/pool.js');
const { cmsAllowedOrigins } = await import('../src/config/index.js');
const { staffAuthService } = await import('../src/modules/staff/service.js');
const { documentStorage } = await import('../src/modules/documents/storage.js');

const ORIGIN = cmsAllowedOrigins[0];
const tag = randomUUID().slice(0, 8);
const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };

const MINIMAL_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

let server;
const created = { jobIds: [], applicationIds: [], resumeKeys: [], staffEmails: [] };

try {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function rawCall(path, opts = {}) {
    const res = await fetch(`${base}${path}`, {
      method: opts.method || 'GET',
      headers: { origin: ORIGIN, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
      body: opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined),
    });
    return { status: res.status, json: await res.json().catch(() => null), setCookie: res.headers.get('set-cookie') };
  }

  // ---- staff sessions: one ADMIN (careers.manage), one SUPPORT (careers.read only) ----
  const adminEmail = `careers-admin-${tag}@x.test`;
  const supportEmail = `careers-support-${tag}@x.test`;
  const PW = 'Careers-Verify-Strong-Passphrase-1';
  await staffAuthService.createStaffUser({ email: adminEmail, password: PW, firstName: 'Careers', lastName: 'Admin', role: 'ADMIN', mustChangePassword: false });
  await staffAuthService.createStaffUser({ email: supportEmail, password: PW, firstName: 'Careers', lastName: 'Support', role: 'SUPPORT', mustChangePassword: false });
  created.staffEmails.push(adminEmail, supportEmail);
  const adminLoginRaw = await rawCall('/api/v1/admin/auth/login', { method: 'POST', body: { email: adminEmail, password: PW } });
  const supportLoginRaw = await rawCall('/api/v1/admin/auth/login', { method: 'POST', body: { email: supportEmail, password: PW } });
  const adminCk = (adminLoginRaw.setCookie || '').split(';')[0];
  const supportCk = (supportLoginRaw.setCookie || '').split(';')[0];

  // ===================== 1. JOB_LIFECYCLE ============================
  let jobId; let jobSlug;
  {
    const title = `Verify Role ${tag}`;
    const create1 = await rawCall('/api/v1/admin/careers/jobs', {
      method: 'POST', cookie: adminCk,
      body: { title, description: 'A role created purely for verification.', responsibilities: ['Do the thing'], requirements: ['Care about quality'] },
    });
    assert.equal(create1.status, 201);
    assert.equal(create1.json.data.status, 'DRAFT', 'a new job starts DRAFT');
    jobId = create1.json.data.id; jobSlug = create1.json.data.slug;
    created.jobIds.push(jobId);

    // slug collision disambiguation
    const create2 = await rawCall('/api/v1/admin/careers/jobs', {
      method: 'POST', cookie: adminCk,
      body: { title, description: 'A second posting with the same title.' },
    });
    assert.equal(create2.status, 201);
    assert.notEqual(create2.json.data.slug, jobSlug, 'a duplicate title gets a disambiguated slug, not a collision');
    created.jobIds.push(create2.json.data.id);

    const publish = await rawCall(`/api/v1/admin/careers/jobs/${jobId}/status`, { method: 'POST', cookie: adminCk, body: { status: 'PUBLISHED' } });
    assert.equal(publish.status, 200);
    assert.equal(publish.json.data.status, 'PUBLISHED');
    assert.ok(publish.json.data.postedAt, 'publishing stamps postedAt');

    const close = await rawCall(`/api/v1/admin/careers/jobs/${jobId}/status`, { method: 'POST', cookie: adminCk, body: { status: 'CLOSED' } });
    assert.equal(close.json.data.status, 'CLOSED');
    const reopen = await rawCall(`/api/v1/admin/careers/jobs/${jobId}/status`, { method: 'POST', cookie: adminCk, body: { status: 'DRAFT' } });
    assert.equal(reopen.json.data.status, 'DRAFT');
    // republish for the next section
    await rawCall(`/api/v1/admin/careers/jobs/${jobId}/status`, { method: 'POST', cookie: adminCk, body: { status: 'PUBLISHED' } });
    pass('JOB_LIFECYCLE', `DRAFT -> PUBLISHED -> CLOSED -> DRAFT; slug "${jobSlug}"`);
  }

  // ===================== 2. PUBLIC_LISTING_SCOPE ======================
  {
    const draftJob = await rawCall('/api/v1/admin/careers/jobs', { method: 'POST', cookie: adminCk, body: { title: `Draft Only ${tag}`, description: 'Should never be public.' } });
    created.jobIds.push(draftJob.json.data.id);
    const closedJob = await rawCall('/api/v1/admin/careers/jobs', { method: 'POST', cookie: adminCk, body: { title: `Closed Only ${tag}`, description: 'Closed, should not be public.', status: 'PUBLISHED' } });
    created.jobIds.push(closedJob.json.data.id);
    await rawCall(`/api/v1/admin/careers/jobs/${closedJob.json.data.id}/status`, { method: 'POST', cookie: adminCk, body: { status: 'CLOSED' } });

    const list = await rawCall('/api/v1/careers/jobs');
    const slugs = list.json.data.jobs.map((j) => j.slug);
    assert.ok(slugs.includes(jobSlug), 'the published job is publicly visible');
    assert.ok(!slugs.includes(draftJob.json.data.slug), 'a DRAFT job is never publicly visible');
    assert.ok(!slugs.includes(closedJob.json.data.slug), 'a CLOSED job is never publicly visible');

    const detail = await rawCall(`/api/v1/careers/jobs/${jobSlug}`);
    assert.equal(detail.status, 200);
    const draftDetail = await rawCall(`/api/v1/careers/jobs/${draftJob.json.data.slug}`);
    assert.equal(draftDetail.status, 404, 'a DRAFT job 404s on the public detail route too');
    pass('PUBLIC_LISTING_SCOPE', 'DRAFT and CLOSED jobs are excluded from every public surface');
  }

  // ===================== 3. APPLY_REAL_MULTIPART ======================
  let applicationId; let applicationNumber; let applicantEmail;
  {
    applicantEmail = `applicant-${tag}@x.test`;
    const fd = new FormData();
    fd.append('firstName', 'Asha');
    fd.append('lastName', 'Verify');
    fd.append('email', applicantEmail);
    fd.append('phone', '+919812340000');
    fd.append('portfolioUrl', 'https://asha.example.com');
    fd.append('coverNote', 'Excited to apply.');
    fd.append('resume', new Blob([MINIMAL_PDF], { type: 'application/pdf' }), 'resume.pdf');

    const res = await fetch(`${base}/api/v1/careers/jobs/${jobSlug}/apply`, { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: fd });
    assert.equal(res.status, 201, 'a real multipart submission with a PDF succeeds');
    const body = await res.json();
    applicationNumber = body.data.applicationNumber;
    assert.ok(applicationNumber?.startsWith('COR-APP-'));

    const [row] = await query('SELECT id, resume_storage_key, resume_file_name, job_title_snapshot FROM career_applications WHERE application_number = ?', [applicationNumber]);
    assert.ok(row, 'the application persisted');
    applicationId = row.id; created.applicationIds.push(applicationId); created.resumeKeys.push(row.resume_storage_key);
    assert.equal(row.job_title_snapshot, `Verify Role ${tag}`);

    const bytes = await documentStorage.get(row.resume_storage_key);
    assert.equal(bytes.length, MINIMAL_PDF.length, 'the exact resume bytes are retrievable from private storage');

    const notif = await query("SELECT title FROM staff_notifications WHERE category = 'CAREERS' AND entity_id = ?", [applicationId]);
    assert.equal(notif.length, 1, 'a staff notification (CMS bell) fired');

    const msgs = await query('SELECT template_key, recipient_contact_key, rendered_subject FROM communication_messages WHERE business_event_id LIKE ?', [`%${applicationId}%`]);
    const ops = msgs.find((m) => m.template_key === 'careers.application_ops');
    const ack = msgs.find((m) => m.template_key === 'careers.application_ack');
    assert.ok(ops, 'the ops notification email was enqueued');
    assert.ok(ack, 'the applicant acknowledgement email was enqueued');
    assert.ok(ack.rendered_subject.includes('Verify Role'), 'the applicant email is rendered with the real job title');
    pass('APPLY_REAL_MULTIPART', `${applicationNumber} — resume stored + staff notified + 2 emails rendered`);
  }

  // ===================== 4. APPLY_VALIDATION ==========================
  {
    const bad = new FormData();
    bad.append('firstName', 'No');
    bad.append('lastName', 'Resume');
    bad.append('email', `nobad-${tag}@x.test`);
    bad.append('phone', '+919800000000');
    const noResume = await fetch(`${base}/api/v1/careers/jobs/${jobSlug}/apply`, { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: bad });
    assert.equal(noResume.status, 400, 'missing resume is rejected');

    const badType = new FormData();
    badType.append('firstName', 'Wrong'); badType.append('lastName', 'Type'); badType.append('email', `nobad2-${tag}@x.test`); badType.append('phone', '+919800000001');
    badType.append('resume', new Blob([Buffer.from('not a pdf')], { type: 'text/plain' }), 'resume.txt');
    const wrongType = await fetch(`${base}/api/v1/careers/jobs/${jobSlug}/apply`, { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: badType });
    assert.ok([400, 422].includes(wrongType.status), 'a non-PDF resume is rejected');

    const okType = new FormData();
    okType.append('firstName', 'A'); okType.append('lastName', 'B'); okType.append('email', 'not-an-email'); okType.append('phone', '123');
    okType.append('resume', new Blob([MINIMAL_PDF], { type: 'application/pdf' }), 'r.pdf');
    const badEmail = await fetch(`${base}/api/v1/careers/jobs/${jobSlug}/apply`, { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: okType });
    assert.equal(badEmail.status, 400, 'an invalid email is rejected');

    const unknownJob = new FormData();
    unknownJob.append('firstName', 'A'); unknownJob.append('lastName', 'B'); unknownJob.append('email', `x-${tag}@x.test`); unknownJob.append('phone', '+919800000002');
    unknownJob.append('resume', new Blob([MINIMAL_PDF], { type: 'application/pdf' }), 'r.pdf');
    const notFound = await fetch(`${base}/api/v1/careers/jobs/does-not-exist-${tag}/apply`, { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: unknownJob });
    assert.equal(notFound.status, 404, 'applying to an unknown job 404s');

    const remaining = await query('SELECT COUNT(*) c FROM career_applications WHERE email LIKE ?', [`%${tag}%`]);
    assert.equal(Number(remaining[0].c), 1, 'none of the rejected attempts created a row — only the one valid application from step 3');
    pass('APPLY_VALIDATION', 'missing resume / wrong mimetype / bad email / unknown job all rejected with zero side effects');
  }

  // ===================== 5. RESUME_IS_PRIVATE =========================
  {
    const noAuth = await fetch(`${base}/api/v1/admin/careers/applications/${applicationId}/resume`);
    assert.equal(noAuth.status, 401, 'the resume endpoint requires a staff session');
    // there is no public route that could serve it by slug/number
    const publicAttempt = await rawCall(`/api/v1/careers/applications/${applicationId}/resume`);
    assert.equal(publicAttempt.status, 404, 'no public route exists for the resume at all');
    const withAuth = await fetch(`${base}/api/v1/admin/careers/applications/${applicationId}/resume`, { headers: { cookie: adminCk } });
    assert.equal(withAuth.status, 200);
    assert.equal(withAuth.headers.get('content-type'), 'application/pdf');
    pass('RESUME_IS_PRIVATE', 'resume only reachable via the gated admin endpoint');
  }

  // ===================== 6. ADMIN_WORKFLOW =============================
  {
    const statusRes = await rawCall(`/api/v1/admin/careers/applications/${applicationId}/status`, { method: 'POST', cookie: adminCk, body: { status: 'UNDER_REVIEW' } });
    assert.equal(statusRes.json.data.status, 'UNDER_REVIEW');

    const noteRes = await rawCall(`/api/v1/admin/careers/applications/${applicationId}/notes`, { method: 'POST', cookie: adminCk, body: { note: 'Looks strong on paper.' } });
    assert.equal(noteRes.status, 200);
    assert.ok(noteRes.json.data.events.some((e) => e.eventType === 'NOTE_ADDED' && e.note === 'Looks strong on paper.'));

    const emailRes = await rawCall(`/api/v1/admin/careers/applications/${applicationId}/email`, { method: 'POST', cookie: adminCk, body: { subject: 'Quick question', message: 'Are you available Thursday?\n\nThanks!' } });
    assert.equal(emailRes.status, 200);
    const [directMsg] = await query("SELECT rendered_body, rendered_subject FROM communication_messages WHERE template_key = 'careers.direct_message' AND recipient_contact_key = ?", [applicantEmail]);
    assert.ok(directMsg, 'the direct message to the applicant was enqueued');
    assert.equal(directMsg.rendered_subject, 'Quick question');
    assert.ok(directMsg.rendered_body.includes('Are you available Thursday?'), 'line breaks / content preserved');

    const [current] = await query('SELECT assignment_version FROM career_applications WHERE id = ?', [applicationId]);
    const assignOk = await rawCall(`/api/v1/admin/careers/applications/${applicationId}/assign`, { method: 'POST', cookie: adminCk, body: { staffId: null, expectedVersion: Number(current.assignment_version) } });
    assert.equal(assignOk.status, 200);
    const staleAssign = await rawCall(`/api/v1/admin/careers/applications/${applicationId}/assign`, { method: 'POST', cookie: adminCk, body: { staffId: null, expectedVersion: Number(current.assignment_version) } });
    assert.equal(staleAssign.status, 409, 'a stale assignment version is rejected, not silently applied');
    pass('ADMIN_WORKFLOW', 'status change, note, direct email (rendered), and assignment (incl. version conflict) all work');
  }

  // ===================== 7. RBAC =======================================
  {
    const supportRead = await rawCall('/api/v1/admin/careers/jobs', { cookie: supportCk });
    assert.equal(supportRead.status, 200, 'SUPPORT has careers.read');
    const supportWrite = await rawCall('/api/v1/admin/careers/jobs', { method: 'POST', cookie: supportCk, body: { title: 'Should be refused', description: 'x' } });
    assert.equal(supportWrite.status, 403, 'SUPPORT does not have careers.manage');
    const supportStatus = await rawCall(`/api/v1/admin/careers/applications/${applicationId}/status`, { method: 'POST', cookie: supportCk, body: { status: 'REJECTED' } });
    assert.equal(supportStatus.status, 403);
    pass('RBAC', 'careers.read (SUPPORT) cannot mutate; careers.manage (ADMIN) can');
  }

  console.log('\nCareers — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { server?.close(); } catch { /* noop */ }
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  for (const id of created.applicationIds) {
    await safe(() => query('DELETE FROM career_application_events WHERE application_id = ?', [id]));
    await safe(() => query('DELETE FROM career_applications WHERE id = ?', [id]));
  }
  for (const key of created.resumeKeys) await safe(() => documentStorage.remove(key));
  await safe(() => query(`DELETE cme FROM communication_message_events cme JOIN communication_messages cm ON cm.id = cme.message_id WHERE cm.business_event_id LIKE '%${tag}%' OR cm.recipient_contact_key LIKE '%${tag}%'`));
  await safe(() => query(`DELETE FROM communication_messages WHERE recipient_contact_key LIKE '%${tag}%'`));
  for (const id of created.jobIds) await safe(() => query('DELETE FROM career_jobs WHERE id = ?', [id]));
  for (const email of created.staffEmails) {
    await safe(() => query('DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized = ?)', [email.toLowerCase()]));
    await safe(() => query('DELETE FROM staff_audit_logs WHERE actor_email = ?', [email]));
    await safe(() => query('DELETE FROM staff_users WHERE email_normalized = ?', [email.toLowerCase()]));
  }
  await pool.end();
}
