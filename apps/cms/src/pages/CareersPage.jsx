import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { FormField } from '../components/ui/FormField.jsx';
import { StatStrip } from '../components/ui/StatStrip.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';

const TABS = [['jobs', 'Job Postings'], ['applications', 'Applications']];
const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP'];
const EMPLOYMENT_LABELS = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACT: 'Contract', INTERNSHIP: 'Internship' };
const APP_STATUSES = ['NEW', 'UNDER_REVIEW', 'SHORTLISTED', 'INTERVIEW', 'SELECTED', 'REJECTED'];
const APP_STATUS_LABELS = { NEW: 'New', UNDER_REVIEW: 'Under Review', SHORTLISTED: 'Shortlisted', INTERVIEW: 'Interview', SELECTED: 'Selected', REJECTED: 'Rejected' };
const STATUS_TONE = { NEW: 'muted', UNDER_REVIEW: 'warn', SHORTLISTED: 'good', INTERVIEW: 'good', SELECTED: 'good', REJECTED: 'bad' };

export function CareersPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('careers.manage');
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'jobs';

  return (
    <PageShell title="Careers" description="Job postings and candidate applications. Publishing a job here makes it appear on the storefront Careers page immediately.">
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k}
            className={`tabs__tab${tab === k ? ' tabs__tab--active' : ''}`}
            onClick={() => setSp((p) => { const n = new URLSearchParams(p); n.set('tab', k); return n; }, { replace: true })}>
            {label}
          </button>
        ))}
      </div>
      <div className="tabs__panel">
        {tab === 'jobs' && <JobsTab canManage={canManage} />}
        {tab === 'applications' && <ApplicationsTab />}
      </div>
    </PageShell>
  );
}

// ---- Job Postings -------------------------------------------------------

const EMPTY_JOB = {
  title: '', department: '', location: '', employmentType: 'FULL_TIME', summary: '',
  description: '', responsibilities: '', requirements: '',
};

function toJobForm(j) {
  return {
    title: j.title, department: j.department || '', location: j.location || '', employmentType: j.employmentType,
    summary: j.summary || '', description: j.description,
    responsibilities: (j.responsibilities || []).join('\n'), requirements: (j.requirements || []).join('\n'),
  };
}
function toJobBody(f) {
  return {
    title: f.title.trim(), department: f.department.trim() || undefined, location: f.location.trim() || undefined,
    employmentType: f.employmentType, summary: f.summary.trim() || undefined, description: f.description.trim(),
    responsibilities: f.responsibilities.split('\n').map((s) => s.trim()).filter(Boolean),
    requirements: f.requirements.split('\n').map((s) => s.trim()).filter(Boolean),
  };
}

function JobsTab({ canManage }) {
  const jobs = useApiResource(() => adminApi.careers.listJobs());
  const [editingId, setEditingId] = useState(null); // null | 'new' | id
  const [form, setForm] = useState(EMPTY_JOB);
  const [save, saveState] = useMutation((body) => (editingId === 'new' ? adminApi.careers.createJob(body) : adminApi.careers.updateJob(editingId, body)));
  const [setStatus, statusState] = useMutation(({ id, status }) => adminApi.careers.setJobStatus(id, status));

  if (jobs.status === 'loading') return <LoadingState label="Loading job postings…" />;
  if (jobs.status === 'error') return <ErrorState message={jobs.error?.message} onRetry={jobs.reload} />;

  const rows = jobs.data?.jobs ?? [];
  const set = (k) => (v) => setForm((s) => ({ ...s, [k]: v }));
  const startCreate = () => { setForm(EMPTY_JOB); setEditingId('new'); };
  const startEdit = (j) => { setForm(toJobForm(j)); setEditingId(j.id); };
  const cancel = () => { setEditingId(null); setForm(EMPTY_JOB); };

  const submit = async (e) => {
    e.preventDefault();
    await save(toJobBody(form));
    cancel();
    jobs.reload();
  };

  return (
    <div className="tab-body">
      {(saveState.error || statusState.error) && <InlineAlert tone="error">{(saveState.error || statusState.error).message}</InlineAlert>}

      <StatStrip cards={[
        { label: 'Total postings', value: rows.length },
        { label: 'Published', value: rows.filter((j) => j.status === 'PUBLISHED').length, tone: 'good' },
        { label: 'Draft', value: rows.filter((j) => j.status === 'DRAFT').length },
        { label: 'Closed', value: rows.filter((j) => j.status === 'CLOSED').length, tone: 'muted' },
        { label: 'Applications received', value: rows.reduce((s, j) => s + (j.applicationCount || 0), 0) },
      ]} />

      {canManage && !editingId && <Button style={{ margin: '16px 0' }} onClick={startCreate}>New job posting</Button>}

      {editingId && (
        <form className="editor-form" style={{ maxWidth: 720, margin: '16px 0' }} onSubmit={submit}>
          <h3>{editingId === 'new' ? 'New job posting' : 'Edit job posting'}</h3>
          <div className="editor-form__grid">
            <FormField id="cj-title" label="Job title" value={form.title} onChange={set('title')} required />
            <FormField id="cj-dept" label="Department" value={form.department} onChange={set('department')} placeholder="Customer Experience" />
            <FormField id="cj-loc" label="Location" value={form.location} onChange={set('location')} placeholder="Remote (India)" />
            <label className="form-field"><span className="form-field__label">Employment type</span>
              <select className="form-field__input" value={form.employmentType} onChange={(e) => set('employmentType')(e.target.value)}>
                {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{EMPLOYMENT_LABELS[t]}</option>)}
              </select>
            </label>
          </div>
          <FormField id="cj-summary" label="Short summary (shown in the job list)" value={form.summary} onChange={set('summary')} placeholder="One sentence — what this role owns." />
          <label className="form-field"><span className="form-field__label">Description</span>
            <textarea className="form-field__input" rows={5} value={form.description} onChange={(e) => set('description')(e.target.value)} required />
          </label>
          <label className="form-field"><span className="form-field__label">Responsibilities (one per line)</span>
            <textarea className="form-field__input" rows={4} value={form.responsibilities} onChange={(e) => set('responsibilities')(e.target.value)} />
          </label>
          <label className="form-field"><span className="form-field__label">Requirements (one per line)</span>
            <textarea className="form-field__input" rows={4} value={form.requirements} onChange={(e) => set('requirements')(e.target.value)} />
          </label>
          <div className="editor-actions">
            <Button type="submit" busy={saveState.busy} disabled={!form.title.trim() || !form.description.trim()}>
              {editingId === 'new' ? 'Create posting' : 'Save changes'}
            </Button>
            <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
          </div>
        </form>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Title</th><th>Department</th><th>Location</th><th>Type</th><th>Applications</th><th>Status</th>{canManage && <th>Actions</th>}</tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={canManage ? 7 : 6} className="data-table__empty">No job postings yet.</td></tr>}
            {rows.map((j) => (
              <tr key={j.id}>
                <td>{j.title}</td>
                <td className="text-faint">{j.department || '—'}</td>
                <td className="text-faint">{j.location || '—'}</td>
                <td className="text-faint">{EMPLOYMENT_LABELS[j.employmentType]}</td>
                <td>{j.applicationCount || 0}</td>
                <td><span className={`pill pill--${j.status === 'PUBLISHED' ? 'good' : j.status === 'CLOSED' ? 'muted' : 'warn'}`}>{j.status}</span></td>
                {canManage && (
                  <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <Button variant="info" onClick={() => startEdit(j)}>Edit</Button>
                    {j.status !== 'PUBLISHED' && (
                      <Button variant="success" busy={statusState.busy} onClick={async () => { await setStatus({ id: j.id, status: 'PUBLISHED' }); jobs.reload(); }}>Publish</Button>
                    )}
                    {j.status === 'PUBLISHED' && (
                      <Button variant="ghost" busy={statusState.busy} onClick={async () => { await setStatus({ id: j.id, status: 'CLOSED' }); jobs.reload(); }}>Close</Button>
                    )}
                    {j.status === 'CLOSED' && (
                      <Button variant="secondary" busy={statusState.busy} onClick={async () => { await setStatus({ id: j.id, status: 'DRAFT' }); jobs.reload(); }}>Reopen as draft</Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Applications ---------------------------------------------------------

function ApplicationsTab() {
  const [status, setStatus] = useState('');
  const [jobId, setJobId] = useState('');
  const [q, setQ] = useState('');
  const facets = useApiResource(() => adminApi.careers.applicationFacets());
  const jobsRes = useApiResource(() => adminApi.careers.listJobs());
  const apps = useApiResource(() => adminApi.careers.listApplications({ status: status || undefined, jobId: jobId || undefined, q: q || undefined, limit: 100 }));

  if (apps.status === 'loading') return <LoadingState label="Loading applications…" />;
  if (apps.status === 'error') return <ErrorState message={apps.error?.message} onRetry={apps.reload} />;

  const rows = apps.data?.applications ?? [];
  const f = facets.data?.facets ?? {};
  const jobs = jobsRes.data?.jobs ?? [];

  return (
    <div className="tab-body">
      <StatStrip cards={APP_STATUSES.map((s) => ({
        label: APP_STATUS_LABELS[s], value: f[s] ?? 0, tone: status === s ? 'good' : undefined,
        onClick: () => setStatus(status === s ? '' : s), active: status === s,
      }))} />

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', margin: '16px 0', flexWrap: 'wrap' }}>
        <label className="form-field" style={{ minWidth: 220 }}><span className="form-field__label">Job</span>
          <select className="form-field__input" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">All job postings</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
          </select>
        </label>
        <FormField id="app-q" label="Search name / email / reference" value={q} onChange={setQ} placeholder="Search…" />
        {(status || jobId || q) && <Button variant="ghost" onClick={() => { setStatus(''); setJobId(''); setQ(''); }}>Clear filters</Button>}
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Applicant</th><th>Job</th><th>Reference</th><th>Submitted</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="data-table__empty">No applications match these filters.</td></tr>}
            {rows.map((a) => (
              <tr key={a.id}>
                <td>{a.firstName} {a.lastName}<br /><span className="text-faint">{a.email}</span></td>
                <td>{a.jobTitleSnapshot}</td>
                <td className="text-faint">{a.applicationNumber}</td>
                <td className="text-faint">{new Date(a.submittedAt).toLocaleString()}</td>
                <td><span className={`pill pill--${STATUS_TONE[a.status]}`}>{APP_STATUS_LABELS[a.status]}</span></td>
                <td><Link className="linkish" to={`/careers/applications/${a.id}`}>Open</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default CareersPage;
