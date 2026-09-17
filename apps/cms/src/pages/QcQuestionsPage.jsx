import { useMemo, useState } from 'react';
import { adminApi } from '../api/adminApi.js';
import { PageShell } from '../layout/PageShell.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Select } from '../components/ui/Select.jsx';
import { StatStrip } from '../components/ui/StatStrip.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { useApiResource } from '../hooks/useApiResource.js';
import { useAuth } from '../auth/useAuth.js';
import { formatRelative } from '../utils/format.js';

const WEEK = 7 * 24 * 3600 * 1000;

export function QcQuestionsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('returns.manage');
  const { status, data, error, reload } = useApiResource(() => adminApi.returns.qcQuestions());
  const [saveErr, setSaveErr] = useState(null);
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState(null);
  const [reqFilter, setReqFilter] = useState(null);
  const [mapFilter, setMapFilter] = useState(null);

  const rows = useMemo(() => data?.questions ?? [], [data]);
  const [mountedAt] = useState(() => Date.now());

  const save = async (question, mappingStatus, delhiveryQuestionId) => {
    setSaveErr(null);
    try {
      await adminApi.returns.updateQcQuestionMapping(question.clientQuestionId, {
        delhiveryMappingStatus: mappingStatus,
        ...(mappingStatus === 'MAPPED' ? { delhiveryQuestionId } : {}),
      });
      reload();
    } catch (e) { setSaveErr(e); }
  };

  const types = useMemo(() => [...new Set(rows.map((r) => r.answerType))].sort(), [rows]);

  const filtered = useMemo(() => {
    let list = [...rows];
    const n = q.trim().toLowerCase();
    if (n) list = list.filter((r) => `${r.clientQuestionId} ${r.prompt}`.toLowerCase().includes(n));
    if (typeFilter) list = list.filter((r) => r.answerType === typeFilter);
    if (reqFilter === 'required') list = list.filter((r) => r.required);
    if (reqFilter === 'info') list = list.filter((r) => !r.required);
    if (mapFilter) list = list.filter((r) => r.delhiveryMappingStatus === mapFilter);
    return list;
  }, [rows, q, typeFilter, reqFilter, mapFilter]);

  const facets = useMemo(() => ({
    total: rows.length,
    active: rows.filter((r) => r.active).length,
    types: types.length,
    mapped: rows.filter((r) => r.delhiveryMappingStatus === 'MAPPED').length,
    recent: rows.filter((r) => r.updatedAt && mountedAt - new Date(r.updatedAt).getTime() < WEEK).length,
  }), [rows, types, mountedAt]);

  const anyFilter = Boolean(q.trim() || typeFilter || reqFilter || mapFilter);
  const clearAll = () => { setQ(''); setTypeFilter(null); setReqFilter(null); setMapFilter(null); };

  if (status === 'error') return <PageShell title="RVP QC Questions"><ErrorState message={error?.message} onRetry={reload} /></PageShell>;
  if (status === 'loading') return <PageShell title="RVP QC Questions"><LoadingState label="Loading…" /></PageShell>;

  return (
    <PageShell
      title="RVP QC Questions"
      description="Delhivery Reverse-Pickup QC 3.0 — question set + account mapping."
    >
      <InlineAlert tone="info">
        Limits: at most 2 QC items per pickup, 6 questions per item. Wording and correct answers are a business
        decision; the seeded set is a spec-aligned starting point. The frontend never constructs QC — it is built
        and evaluated on the server.
      </InlineAlert>

      <StatStrip cards={[
        { label: 'Total questions', value: facets.total, hint: 'Across all types', tone: 'neutral', active: !anyFilter, onClick: clearAll },
        { label: 'Active questions', value: facets.active, hint: 'In use', tone: 'good' },
        { label: 'Question types', value: facets.types, hint: types.join(', ') || '—', tone: 'neutral' },
        { label: 'Mapped to Delhivery', value: facets.mapped, hint: `of ${facets.total}`, tone: facets.mapped === facets.total ? 'good' : 'warn', active: mapFilter === 'MAPPED', onClick: () => setMapFilter(mapFilter === 'MAPPED' ? null : 'MAPPED') },
        { label: 'Recently updated', value: facets.recent, hint: 'Last 7 days', tone: 'neutral' },
      ]} />

      {saveErr && <InlineAlert tone="error">{saveErr.message}</InlineAlert>}

      <div className="wb-toolbar">
        <input className="wb-toolbar__search" type="search" placeholder="Search by ID, question text, or reason…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <Select id="qc-type" label="Type" value={typeFilter} onChange={setTypeFilter}
          options={types.map((t) => [t, t])} includeBlank blankLabel="All types" />
        <Select id="qc-req" label="Required" value={reqFilter} onChange={setReqFilter}
          options={[['required', 'Required'], ['info', 'Informational']]} includeBlank blankLabel="All required" />
        <Select id="qc-map" label="Mapping" value={mapFilter} onChange={setMapFilter}
          options={[['MAPPED', 'Mapped'], ['PENDING', 'Pending'], ['REJECTED', 'Rejected']]} includeBlank blankLabel="All statuses" />
        {anyFilter && <Button variant="ghost" onClick={clearAll}>Clear</Button>}
      </div>

      <p className="wb-count">{filtered.length} of {rows.length} question{rows.length === 1 ? '' : 's'}</p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th><th>Question / prompt</th><th>Type</th><th>Required</th><th>Reasons</th>
              <th>Correct</th><th>Mapping</th><th>Delhivery ID</th><th>Updated</th>{canManage && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {filtered.map((question) => <QcRow key={question.clientQuestionId} q={question} canManage={canManage} onSave={save} />)}
            {filtered.length === 0 && (
              <tr><td colSpan={canManage ? 10 : 9} className="data-table__empty">No questions match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="wb-about">
        <svg className="wb-about__icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" strokeLinecap="round" /></svg>
        <span><strong>About RVP QC</strong>These questions are used during reverse pickup for return / exchange validation. The set is configurable and can be mapped to specific Delhivery accounts.</span>
      </div>
    </PageShell>
  );
}

function QcRow({ q, canManage, onSave }) {
  const [dlvId, setDlvId] = useState(q.delhiveryQuestionId || '');
  return (
    <tr>
      <td><code>{q.clientQuestionId}</code> <span className="text-faint">v{q.version}</span></td>
      <td>{q.prompt}</td>
      <td><span className="chip">{q.answerType}</span></td>
      <td><Badge tone={q.required ? 'good' : 'muted'}>{q.required ? 'Yes' : 'Info'}</Badge></td>
      <td className="text-faint" style={{ fontSize: 12 }}>{q.applicableReturnReasons ? q.applicableReturnReasons.join(', ') : 'all'}</td>
      <td>{(q.correctValue || []).length ? <Badge tone="good">Yes</Badge> : <span className="text-faint">—</span>}</td>
      <td>
        <Badge tone={q.delhiveryMappingStatus === 'MAPPED' ? 'good' : q.delhiveryMappingStatus === 'REJECTED' ? 'warn' : 'muted'}>
          {q.delhiveryMappingStatus === 'MAPPED' ? 'Mapped' : q.delhiveryMappingStatus === 'REJECTED' ? 'Rejected' : 'Default'}
        </Badge>
      </td>
      <td>
        {canManage
          ? <input value={dlvId} onChange={(e) => setDlvId(e.target.value)} placeholder="Delhivery question id" style={{ width: 150 }} />
          : (q.delhiveryQuestionId || <span className="text-faint">—</span>)}
      </td>
      <td className="text-faint">{q.updatedAt ? formatRelative(q.updatedAt) : '—'}</td>
      {canManage && (
        <td style={{ display: 'flex', gap: 4 }}>
          <Button variant="secondary" disabled={!dlvId} onClick={() => onSave(q, 'MAPPED', dlvId)}>Map</Button>
          <Button variant="ghost" onClick={() => onSave(q, 'PENDING')}>Clear</Button>
        </td>
      )}
    </tr>
  );
}

export default QcQuestionsPage;
