import { useState } from 'react';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { FormField } from '../components/ui/FormField.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';

export function PrintStationsPage() {
  const { status, data, error, reload } = useApiResource(() => adminApi.printStations.list());
  const warehouses = useApiResource(() => adminApi.warehouses.list());
  const [station, setStation] = useState({ warehouseId: '', name: '' });
  const [printer, setPrinter] = useState({ printStationId: '', name: '', printerType: 'A4_PDF' });
  const [createStation, csState] = useMutation((body) => adminApi.printStations.create(body));
  const [createPrinter, cpState] = useMutation((body) => adminApi.printStations.createPrinter(body));

  const stations = data?.stations ?? [];
  const err = csState.error || cpState.error;

  return (
    <PageShell title="Print Stations" description="Packing / dispatch desks and their printers, one set per warehouse. Documents can only be printed at their own warehouse.">
      {err && <InlineAlert tone="error">{err.message}</InlineAlert>}

      <form className="editor-form" style={{ maxWidth: 560, marginBottom: 24 }} onSubmit={async (e) => { e.preventDefault(); await createStation(station); setStation({ warehouseId: '', name: '' }); reload(); }}>
        <h3>New station</h3>
        <label className="form-field">
          <span className="form-field__label">Warehouse</span>
          <select className="form-field__input" value={station.warehouseId} onChange={(e) => setStation((s) => ({ ...s, warehouseId: e.target.value }))} required>
            <option value="">Select…</option>
            {(warehouses.data?.warehouses ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
        <FormField id="stName" label="Name" value={station.name} onChange={(v) => setStation((s) => ({ ...s, name: v }))} required placeholder="Packing Desk" />
        <div className="editor-actions"><Button type="submit" busy={csState.busy} disabled={!station.warehouseId || !station.name.trim()}>Create station</Button></div>
      </form>

      {status === 'loading' && <LoadingState label="Loading stations…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && stations.map((s) => (
        <div key={s.id} className="table-wrap" style={{ marginBottom: 20 }}>
          <h3>{s.name} <span className={`pill pill--${s.status === 'ACTIVE' ? 'good' : 'muted'}`}>{s.status}</span></h3>
          <table className="data-table">
            <thead><tr><th>Printer</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>
              {(s.printers ?? []).map((p) => (
                <tr key={p.id}><td>{p.name}</td><td>{p.printer_type}</td><td>{p.status}</td></tr>
              ))}
              {(s.printers ?? []).length === 0 && <tr><td colSpan={3} className="data-table__empty">No printers.</td></tr>}
            </tbody>
          </table>
          <form className="editor-form" style={{ maxWidth: 480, marginTop: 8 }} onSubmit={async (e) => {
            e.preventDefault();
            await createPrinter({ ...printer, printStationId: s.id });
            setPrinter({ printStationId: '', name: '', printerType: 'A4_PDF' });
            reload();
          }}>
            <FormField id={`pn-${s.id}`} label="Add printer" value={printer.printStationId === s.id ? printer.name : ''} onChange={(v) => setPrinter({ printStationId: s.id, name: v, printerType: printer.printerType })} placeholder="Label 1" />
            <label className="form-field">
              <span className="form-field__label">Type</span>
              <select className="form-field__input" value={printer.printStationId === s.id ? printer.printerType : 'A4_PDF'} onChange={(e) => setPrinter((pr) => ({ ...pr, printStationId: s.id, printerType: e.target.value }))}>
                <option value="A4_PDF">A4 PDF</option>
                <option value="LABEL_4X6_PDF">4×6 label (PDF)</option>
                <option value="ZPL">ZPL</option>
              </select>
            </label>
            <div className="editor-actions"><Button type="submit" variant="soft" busy={cpState.busy} disabled={printer.printStationId !== s.id || !printer.name.trim()}>Add printer</Button></div>
          </form>
        </div>
      ))}
    </PageShell>
  );
}

export default PrintStationsPage;
