import { useState } from 'react';
import { Button } from '../ui/Button.jsx';
import { InlineAlert } from '../feedback/InlineAlert.jsx';
import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { useMutation } from '../../features/catalog/useMutation.js';
import PreviewButton from './PreviewButton.jsx';

// Shared draft -> publish -> history/rollback bar for every Experience tab
// (navigation, mega menus, announcements, homepage, footer). Moved out of
// ContentExperiencePage.jsx so the footer builder can reuse it verbatim
// instead of re-implementing publish/history/rollback.
export function PublishBar({ scope, doc, canPublish, onDone }) {
  const [publish, { busy, error }] = useMutation(() => adminApi.content.publish(scope, doc.workingVersion));
  const { data: hist, reload } = useApiResource(() => adminApi.content.history(scope));
  const [rb] = useMutation((id) => adminApi.content.rollback(scope, id));
  const [open, setOpen] = useState(false);

  return (
    <div className="dash-section" style={{ marginTop: 16 }}>
      <div className="editor-actions">
        <span className={`pill pill--${doc.draftDirty ? 'warn' : 'good'}`}>
          {doc.draftDirty ? 'Unpublished changes' : 'Published'} · working v{doc.workingVersion} · live v{doc.publishedVersion ?? '—'}
        </span>
        {canPublish && <Button variant="success" busy={busy} disabled={!doc.draftDirty} onClick={async () => { await publish(); onDone(); reload(); }}>Publish {scope}</Button>}
        <PreviewButton scope={scope === 'homepage' ? 'homepage' : 'header'} path="/" />
        <button type="button" className="linkish" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'History'}</button>
      </div>
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {open && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="data-table">
            <thead><tr><th>Version</th><th>State</th><th>By</th><th>When</th><th>Summary</th><th /></tr></thead>
            <tbody>
              {(hist?.publications ?? []).map((p) => (
                <tr key={p.id}>
                  <td>v{p.version}</td><td>{p.state}</td><td>{p.publishedBy || '—'}</td>
                  <td>{p.publishedAt ? new Date(p.publishedAt).toLocaleString() : '—'}</td>
                  <td>{p.changeSummary || '—'}</td>
                  <td>{canPublish && p.state !== 'PUBLISHED' && (
                    <button type="button" className="linkish" onClick={async () => { if (confirm(`Roll back to v${p.version}? A new version is published from it.`)) { await rb(p.id); onDone(); reload(); } }}>Roll back to this</button>
                  )}</td>
                </tr>
              ))}
              {(hist?.publications ?? []).length === 0 && <tr><td colSpan={6} className="data-table__empty">Not published yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default PublishBar;
