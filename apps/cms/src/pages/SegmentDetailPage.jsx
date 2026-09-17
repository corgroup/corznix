import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';

const when = (d) => (d ? new Date(d).toLocaleString() : '—');
const blankFor = (meta) => {
  const a = meta[0];
  return { attribute: a.attribute, operator: a.operators[0], value: a.valueType === 'bool' ? true : a.valueType === 'int' ? 0 : '' };
};

function ValueInput({ def, cond, onChange }) {
  const many = cond.operator === 'IN' || cond.operator === 'NOT_IN';
  if (def.valueType === 'bool') {
    return (
      <select className="form-field__input" style={{ maxWidth: 110 }} value={String(cond.value)} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">true</option><option value="false">false</option>
      </select>
    );
  }
  if (def.enum && !many) {
    return (
      <select className="form-field__input" style={{ maxWidth: 180 }} value={cond.value} onChange={(e) => onChange(e.target.value)}>
        {def.enum.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  }
  if (many) {
    return (
      <input className="form-field__input" style={{ maxWidth: 240 }} placeholder="comma,separated"
        value={Array.isArray(cond.value) ? cond.value.join(',') : ''}
        onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
    );
  }
  return (
    <input className="form-field__input" style={{ maxWidth: 200 }}
      type={def.valueType === 'int' ? 'number' : def.valueType === 'date' ? 'date' : 'text'}
      value={cond.value ?? ''}
      onChange={(e) => onChange(def.valueType === 'int' ? Number(e.target.value) : e.target.value)} />
  );
}

export function SegmentDetailPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('segments.manage');
  const meta = useApiResource(() => adminApi.segments.attributes());
  const { status, data: seg, error, reload } = useApiResource(() => adminApi.segments.get(id));

  const attrs = useMemo(() => meta.data?.attributes ?? [], [meta.data]);
  const attrMap = useMemo(() => Object.fromEntries(attrs.map((a) => [a.attribute, a])), [attrs]);

  const [draft, setDraft] = useState(null); // { match, conditions }
  const working = draft ?? (seg ? { match: seg.matchMode || 'ALL', conditions: seg.definition?.conditions ?? [] } : null);

  const [preview, setPreview] = useState(null);
  const [previewRun, previewState] = useMutation((def) => adminApi.segments.previewAdhoc(def, 10));
  const [saveRun, saveState] = useMutation((def) => adminApi.segments.addRevision(id, def));
  const [snapRun, snapState] = useMutation(() => adminApi.segments.snapshot(id, 'MANUAL'));
  const [audRun, audState] = useMutation((params) => adminApi.segments.audience(id, params));
  // The server has always accepted ACTIVE/ARCHIVED here; the CMS had no
  // control for it, so a segment could never be retired once created.
  const [statusRun, statusState] = useMutation((next) => adminApi.segments.updateMeta(id, { status: next }));
  const [audience, setAudience] = useState(null);
  const [aud, setAud] = useState({ channel: 'EMAIL', purpose: 'MARKETING' });

  if (status === 'loading' || meta.status === 'loading') return <PageShell title="Segment"><LoadingState label="Loading…" /></PageShell>;
  if (status === 'error') return <PageShell title="Segment"><ErrorState message={error?.message} onRetry={reload} /></PageShell>;

  const toggleStatus = async () => {
    const archiving = seg.status === 'ACTIVE';
    // An archived segment matches nobody, so a promotion limited to it
    // silently stops applying — say so before it happens.
    if (archiving && !confirm('Archive this segment? Any promotion limited to it will stop applying to anyone until the segment is restored.')) return;
    await statusRun(archiving ? 'ARCHIVED' : 'ACTIVE');
    reload();
  };

  const setCond = (i, patch) => {
    const next = { ...working, conditions: working.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) };
    setDraft(next); setPreview(null);
  };
  const changeAttr = (i, attribute) => {
    const d = attrMap[attribute];
    setCond(i, { attribute, operator: d.operators[0], value: d.valueType === 'bool' ? true : d.valueType === 'int' ? 0 : '', channel: d.requiresChannelPurpose ? 'EMAIL' : undefined, purpose: d.requiresChannelPurpose ? 'MARKETING' : undefined });
  };
  const addCond = () => { setDraft({ ...working, conditions: [...working.conditions, blankFor(attrs)] }); setPreview(null); };
  const removeCond = (i) => { setDraft({ ...working, conditions: working.conditions.filter((_, j) => j !== i) }); setPreview(null); };

  return (
    <PageShell title={seg.name} description={`Key: ${seg.key} · revision ${seg.revision ?? '—'} · ${seg.status}`}>
      <InlineAlert tone="info">
        Conditions are structured and validated on the server, which compiles them into a parameterized query. Editing the rule creates a new revision — anything that already referenced an older revision keeps evaluating that exact rule.
      </InlineAlert>

      {canManage && (
        <div className="editor-actions" style={{ margin: '12px 0' }}>
          <Button variant={seg.status === 'ACTIVE' ? 'warning' : 'success'} busy={statusState.busy} onClick={toggleStatus}>
            {seg.status === 'ACTIVE' ? 'Archive segment' : 'Restore segment'}
          </Button>
        </div>
      )}
      {statusState.error && <InlineAlert tone="error">{statusState.error.message}</InlineAlert>}

      <h3>Rule</h3>
      <div className="editor-actions" style={{ marginBottom: 12 }}>
        <label>Match{' '}
          <select className="form-field__input" style={{ maxWidth: 120 }} value={working.match}
            disabled={!canManage} onChange={(e) => { setDraft({ ...working, match: e.target.value }); setPreview(null); }}>
            <option value="ALL">ALL (AND)</option><option value="ANY">ANY (OR)</option>
          </select>
        </label>
      </div>

      {working.conditions.map((c, i) => {
        const def = attrMap[c.attribute] ?? attrs[0];
        return (
          <div key={i} className="editor-actions" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
            <select className="form-field__input" style={{ maxWidth: 220 }} value={c.attribute} disabled={!canManage} onChange={(e) => changeAttr(i, e.target.value)}>
              {attrs.map((a) => <option key={a.attribute} value={a.attribute}>{a.attribute}</option>)}
            </select>
            <select className="form-field__input" style={{ maxWidth: 110 }} value={c.operator} disabled={!canManage} onChange={(e) => setCond(i, { operator: e.target.value })}>
              {def.operators.map((op) => <option key={op} value={op}>{op}</option>)}
            </select>
            <ValueInput def={def} cond={c} onChange={(value) => setCond(i, { value })} />
            {def.requiresChannelPurpose && (
              <>
                <select className="form-field__input" style={{ maxWidth: 130 }} value={c.channel || 'EMAIL'} disabled={!canManage} onChange={(e) => setCond(i, { channel: e.target.value })}>
                  <option>EMAIL</option><option>WHATSAPP</option>
                </select>
                <select className="form-field__input" style={{ maxWidth: 140 }} value={c.purpose || 'MARKETING'} disabled={!canManage} onChange={(e) => setCond(i, { purpose: e.target.value })}>
                  <option>MARKETING</option><option>NEWSLETTER</option>
                </select>
              </>
            )}
            {canManage && working.conditions.length > 1 && <button type="button" className="btn btn--secondary" onClick={() => removeCond(i)}>✕</button>}
          </div>
        );
      })}

      {canManage && <Button variant="soft" onClick={addCond}>Add condition</Button>}

      <div className="editor-actions" style={{ marginTop: 16, gap: 8 }}>
        <Button variant="info" busy={previewState.busy} onClick={async () => { setPreview(await previewRun(working)); }}>Preview count</Button>
        {canManage && <Button busy={saveState.busy} disabled={!draft} onClick={async () => { await saveRun(working); setDraft(null); setPreview(null); reload(); }}>Save as new revision</Button>}
        {canManage && <Button variant="secondary" busy={snapState.busy} onClick={async () => { await snapRun(); reload(); }}>Snapshot membership</Button>}
      </div>
      {previewState.error && <InlineAlert tone="error">{previewState.error.message}</InlineAlert>}
      {saveState.error && <InlineAlert tone="error">{saveState.error.message}</InlineAlert>}
      {preview && (
        <div style={{ marginTop: 12 }}>
          <p><strong>{preview.count}</strong> customers match. Sample (masked):</p>
          <ul>{preview.sample.map((s) => <li key={s.id}>{s.name || '—'} · {s.status} · since {when(s.since)}</li>)}</ul>
        </div>
      )}

      <h3>Marketing audience (consent-gated)</h3>
      <div className="editor-actions" style={{ gap: 8 }}>
        <select className="form-field__input" style={{ maxWidth: 130 }} value={aud.channel} onChange={(e) => setAud({ ...aud, channel: e.target.value })}>
          <option>EMAIL</option><option>WHATSAPP</option>
        </select>
        <select className="form-field__input" style={{ maxWidth: 140 }} value={aud.purpose} onChange={(e) => setAud({ ...aud, purpose: e.target.value })}>
          <option>MARKETING</option><option>NEWSLETTER</option>
        </select>
        <Button variant="info" busy={audState.busy} onClick={async () => { setAudience(await audRun(aud)); }}>Resolve</Button>
      </div>
      {audState.error && <InlineAlert tone="error">{audState.error.message}</InlineAlert>}
      {audience && (
        <p style={{ marginTop: 8 }}>
          Segment {audience.segmentCount} · <strong>marketable {audience.marketableCount}</strong> · suppressed/unconsented {audience.suppressedOrUnconsented}
          {' '}(revision {audience.revision})
        </p>
      )}

      <h3>Revisions</h3>
      <ul>
        {(seg.revisions ?? []).map((r) => (
          <li key={r.id}>
            r{r.revision} · {r.matchMode} · {r.definition.conditions.length} condition(s) · {r.createdBy || 'system'} · {when(r.at)}
            {r.id === seg.currentRevisionId ? ' · current' : ''}
          </li>
        ))}
      </ul>

      {(seg.snapshots ?? []).length > 0 && (
        <>
          <h3>Snapshots</h3>
          <ul>
            {seg.snapshots.map((sn) => (
              <li key={sn.id}>{when(sn.at)} · {sn.reason} · {sn.memberCount} members · from revision {sn.revision}</li>
            ))}
          </ul>
        </>
      )}
    </PageShell>
  );
}

export default SegmentDetailPage;
