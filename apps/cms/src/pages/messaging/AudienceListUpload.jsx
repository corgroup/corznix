import { useRef, useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import { StatStrip } from '../../components/ui/StatStrip.jsx';
import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { adminApi } from '../../api/adminApi.js';
import { useMutation, succeeded } from '../../features/catalog/useMutation.js';

// Upload a .csv / .xlsx contact list, review what is in it, then confirm.
// Nothing becomes audience until the import is confirmed, and being in a list
// is never consent: each contact is still checked when the campaign sends.
export function AudienceListUpload({ onConfirmed }) {
  const fileRef = useRef(null);
  const [pending, setPending] = useState(null);
  const [upload, uploadState] = useMutation((file) => adminApi.marketingCampaigns.uploadAudience(file, file.name));
  const [act, actState] = useMutation((fn) => fn());

  const choose = (file) => {
    if (!file) return;
    upload(file).then(setPending).catch(() => {});
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="messaging-upload">
      <div className="form-row">
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.tsv,text/csv" disabled={uploadState.busy}
          onChange={(e) => choose(e.target.files?.[0])} aria-label="Upload a contact list" />
        {uploadState.busy && <span className="muted">Reading file…</span>}
      </div>
      <p className="muted">A .csv or .xlsx file with Name, Phone and Email columns.</p>
      {(uploadState.error || actState.error) && <InlineAlert tone="error">{(uploadState.error || actState.error).message}</InlineAlert>}

      {pending && (
        <div className="panel panel--inset">
          <h4>{pending.filename}</h4>
          <StatStrip
            min={120}
            cards={[
              { label: 'Rows', value: pending.counts.total },
              { label: 'Usable', value: pending.counts.valid, tone: 'good' },
              { label: 'Invalid', value: pending.counts.invalid, tone: pending.counts.invalid ? 'bad' : undefined },
              { label: 'Duplicates', value: pending.counts.duplicate },
              { label: 'Existing customers', value: pending.counts.existingCustomers },
              { label: 'New contacts', value: pending.counts.newExternalContacts },
            ]}
          />
          {pending.samples?.INVALID?.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Row</th><th>Name</th><th>Phone</th><th>Email</th><th>Problem</th></tr></thead>
                <tbody>
                  {pending.samples.INVALID.map((r) => (
                    <tr key={`i-${r.source_row}`}>
                      <td>{r.source_row}</td><td>{r.raw_name || '—'}</td><td>{r.raw_phone || '—'}</td>
                      <td>{r.raw_email || '—'}</td><td>{r.invalid_reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <InlineAlert tone="info">{pending.note}</InlineAlert>
          <div className="form-row">
            <Button busy={actState.busy} onClick={async () => {
              if (await succeeded(act(() => adminApi.marketingCampaigns.confirmAudience(pending.listId)))) {
                const listId = pending.listId;
                setPending(null);
                onConfirmed?.(listId);
              }
            }}>Use this list</Button>
            <Button variant="ghost" busy={actState.busy} onClick={async () => {
              if (await succeeded(act(() => adminApi.marketingCampaigns.discardAudience(pending.listId)))) setPending(null);
            }}>Discard</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default AudienceListUpload;
