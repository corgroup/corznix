import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';

const APP_STATUSES = ['NEW', 'UNDER_REVIEW', 'SHORTLISTED', 'INTERVIEW', 'SELECTED', 'REJECTED'];
const APP_STATUS_LABELS = { NEW: 'New', UNDER_REVIEW: 'Under Review', SHORTLISTED: 'Shortlisted', INTERVIEW: 'Interview', SELECTED: 'Selected', REJECTED: 'Rejected' };
const STATUS_TONE = { NEW: 'muted', UNDER_REVIEW: 'warn', SHORTLISTED: 'good', INTERVIEW: 'good', SELECTED: 'good', REJECTED: 'bad' };
const EVENT_LABELS = {
  APPLICATION_RECEIVED: 'Application received', STATUS_CHANGED: 'Status changed',
  NOTE_ADDED: 'Internal note', EMAIL_SENT: 'Email sent', ASSIGNED: 'Reassigned',
};

export function CareerApplicationDetailPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('careers.manage');
  const app = useApiResource(() => adminApi.careers.getApplication(id));
  const staffRes = useApiResource(() => adminApi.listStaff());

  const [setStatus, statusState] = useMutation((status) => adminApi.careers.setApplicationStatus(id, status));
  const [note, setNote] = useState('');
  const [addNote, noteState] = useMutation((n) => adminApi.careers.addNote(id, n));
  const [assign, assignState] = useMutation(({ staffId, expectedVersion }) => adminApi.careers.assign(id, staffId, expectedVersion));
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sendEmail, emailState] = useMutation(({ s, m }) => adminApi.careers.sendEmail(id, s, m));

  if (app.status === 'loading') return <PageShell title="Application"><LoadingState label="Loading application…" /></PageShell>;
  if (app.status === 'error') return <PageShell title="Application"><ErrorState message={app.error?.message} onRetry={app.reload} /></PageShell>;

  const a = app.data;
  const staff = staffRes.data?.staff ?? [];
  const anyError = statusState.error || noteState.error || assignState.error || emailState.error;

  return (
    <PageShell
      title={`${a.firstName} ${a.lastName}`}
      description={`Applied for ${a.jobTitleSnapshot} · ${a.applicationNumber}`}
    >
      <div className="editor-actions" style={{ marginBottom: 16 }}>
        <Link className="linkish" to="/careers?tab=applications">← All applications</Link>
        <span className={`pill pill--${STATUS_TONE[a.status]}`}>{APP_STATUS_LABELS[a.status]}</span>
      </div>
      {anyError && <InlineAlert tone="error">{anyError.message}</InlineAlert>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(280px, 340px)', gap: 20, alignItems: 'start' }}>
        <div>
          <div className="dash-section" style={{ marginBottom: 16 }}>
            <h3>Applicant</h3>
            <dl className="editor-form__grid" style={{ rowGap: 4 }}>
              <div><dt className="text-faint">Name</dt><dd>{a.firstName} {a.lastName}</dd></div>
              <div><dt className="text-faint">Email</dt><dd><a href={`mailto:${a.email}`}>{a.email}</a></dd></div>
              <div><dt className="text-faint">Phone</dt><dd><a href={`tel:${a.phone}`}>{a.phone}</a></dd></div>
              <div><dt className="text-faint">Job</dt><dd>{a.jobTitleSnapshot}</dd></div>
              {a.portfolioUrl && <div><dt className="text-faint">Portfolio</dt><dd><a href={a.portfolioUrl} target="_blank" rel="noreferrer">{a.portfolioUrl}</a></dd></div>}
              {a.linkedinUrl && <div><dt className="text-faint">LinkedIn</dt><dd><a href={a.linkedinUrl} target="_blank" rel="noreferrer">{a.linkedinUrl}</a></dd></div>}
              <div><dt className="text-faint">Submitted</dt><dd>{new Date(a.submittedAt).toLocaleString()}</dd></div>
            </dl>
            {a.coverNote && (
              <>
                <p className="text-faint" style={{ marginBottom: 2 }}>Cover note</p>
                <p style={{ whiteSpace: 'pre-wrap' }}>{a.coverNote}</p>
              </>
            )}
            <a className="btn btn--secondary" style={{ display: 'inline-block', marginTop: 8 }}
              href={adminApi.careers.resumeUrl(a.id)} target="_blank" rel="noreferrer">
              View resume ({a.resumeFileName})
            </a>
          </div>

          <div className="dash-section" style={{ marginBottom: 16 }}>
            <h3>Activity</h3>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(a.events || []).map((ev) => (
                <li key={ev.id} style={{ borderLeft: '2px solid var(--border)', paddingLeft: 10 }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>
                    {EVENT_LABELS[ev.eventType] || ev.eventType}
                    {ev.eventType === 'STATUS_CHANGED' && ` — ${APP_STATUS_LABELS[ev.fromStatus] || ev.fromStatus} → ${APP_STATUS_LABELS[ev.toStatus] || ev.toStatus}`}
                  </p>
                  {ev.note && <p style={{ margin: '2px 0', whiteSpace: 'pre-wrap' }}>{ev.note}</p>}
                  {ev.detail?.subject && <p className="text-faint" style={{ margin: '2px 0' }}>Subject: {ev.detail.subject}</p>}
                  <p className="text-faint" style={{ margin: 0, fontSize: 11 }}>
                    {ev.staffEmail ? `${ev.staffEmail} · ` : ''}{new Date(ev.createdAt).toLocaleString()}
                  </p>
                </li>
              ))}
              {(!a.events || a.events.length === 0) && <li className="text-faint">No activity yet.</li>}
            </ul>
          </div>

          {canManage && (
            <div className="dash-section">
              <h3>Contact applicant</h3>
              <p className="tab-body__hint">Sends a real email to {a.email} and logs it on this application.</p>
              <label className="form-field"><span className="form-field__label">Subject</span>
                <input className="form-field__input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Re: your application" />
              </label>
              <label className="form-field"><span className="form-field__label">Message</span>
                <textarea className="form-field__input" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Write your message…" />
              </label>
              <div className="editor-actions">
                <Button busy={emailState.busy} disabled={!subject.trim() || !message.trim()}
                  onClick={async () => { await sendEmail({ s: subject, m: message }); setSubject(''); setMessage(''); app.reload(); }}>
                  Send email
                </Button>
              </div>
            </div>
          )}
        </div>

        <div>
          {canManage && (
            <div className="dash-section" style={{ marginBottom: 16 }}>
              <h3>Status</h3>
              <label className="form-field"><span className="form-field__label">Application status</span>
                <select className="form-field__input" value={a.status} disabled={statusState.busy}
                  onChange={async (e) => { await setStatus(e.target.value); app.reload(); }}>
                  {APP_STATUSES.map((s) => <option key={s} value={s}>{APP_STATUS_LABELS[s]}</option>)}
                </select>
              </label>

              <label className="form-field"><span className="form-field__label">Assigned to</span>
                <select className="form-field__input" value={a.assignedStaffId || ''} disabled={assignState.busy || staffRes.status !== 'ready'}
                  onChange={async (e) => { await assign({ staffId: e.target.value || null, expectedVersion: a.assignmentVersion }); app.reload(); }}>
                  <option value="">Unassigned</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.firstName} {s.lastName} ({s.email})</option>)}
                </select>
              </label>
            </div>
          )}

          <div className="dash-section">
            <h3>Add internal note</h3>
            <p className="tab-body__hint">Visible to staff only — never sent to the applicant.</p>
            <textarea className="form-field__input" rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Interview feedback, next steps…" />
            <div className="editor-actions">
              <Button variant="soft" busy={noteState.busy} disabled={!note.trim()}
                onClick={async () => { await addNote(note); setNote(''); app.reload(); }}>
                Add note
              </Button>
            </div>
          </div>
        </div>
      </div>
    </PageShell>
  );
}

export default CareerApplicationDetailPage;
