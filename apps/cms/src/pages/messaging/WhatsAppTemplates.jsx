import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../../components/feedback/LoadingState.jsx';
import { ErrorState } from '../../components/feedback/ErrorState.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { templateLabel } from './campaignModel.js';

// Messaging → WhatsApp Templates. WhatsApp messages can only be sent on a
// template Meta has approved; this lists the ones this store can send on.
// Phase 3 syncs them from Meta (names, approval status, variables) so nothing
// here is typed in by hand.
export function WhatsAppTemplates() {
  const { status, data, error, reload } = useApiResource(() => adminApi.communications.listTemplates({ channel: 'WHATSAPP' }));
  const rows = (data?.templates ?? []).filter((t) => t.channel === 'WHATSAPP');

  return (
    <section>
      <InlineAlert tone="info">
        WhatsApp templates are created and approved in Meta. Automatic sync from Meta is coming next; until then this
        list shows the approved templates already set up for sending.
      </InlineAlert>
      {status === 'loading' && <LoadingState label="Loading WhatsApp templates…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Used for</th><th>Meta template</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>{templateLabel(t.templateKey)}</td>
                  <td>{t.providerTemplateRef ? <code>{t.providerTemplateRef}</code> : <span className="muted">Not connected to Meta</span>}</td>
                  <td>{t.classification === 'MARKETING' ? 'Marketing' : 'Transactional'}</td>
                  <td><Badge tone={t.status === 'ACTIVE' ? 'good' : 'warn'}>{t.status === 'ACTIVE' ? 'Available' : 'Not available'}</Badge></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={4} className="data-table__empty">No WhatsApp templates yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default WhatsAppTemplates;
