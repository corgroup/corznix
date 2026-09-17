import { useMemo, useState } from 'react';
import { Button } from '../../components/ui/Button.jsx';
import { FormField } from '../../components/ui/FormField.jsx';
import { Select } from '../../components/ui/Select.jsx';
import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../../components/feedback/LoadingState.jsx';
import { ErrorState } from '../../components/feedback/ErrorState.jsx';
import { RowsEditor, CellInput, CellSelect } from '../../components/ui/RowsEditor.jsx';
import { withRowKeys } from '../../components/ui/rowHelpers.js';
import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { useMutation } from '../../features/catalog/useMutation.js';
import { useAuth } from '../../auth/useAuth.js';

const tone = (s) => (s === 'ACTIVE' || s === 'SENT' ? 'good' : s === 'DRAFT' ? 'muted' : 'warn');
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;
const placeholdersIn = (text) => {
  const out = new Set();
  const re = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.add(m[1]);
  return [...out];
};

// editor rows -> variableSchema object.
const rowsToSchema = (rows) => {
  const out = {};
  for (const r of rows) {
    const name = (r.name || '').trim();
    if (!name) continue;
    out[name] = { type: r.type === 'number' ? 'number' : 'string', ...(r.required ? { required: true } : {}) };
  }
  return out;
};

function VariableRowsEditor({ rows, onChange, disabled }) {
  return (
    <RowsEditor
      rows={rows}
      onChange={onChange}
      columns={[
        { key: 'name', label: 'Variable name', width: '40%', render: (row, patch, ctx) => (
          <CellInput value={row.name} onChange={(v) => patch({ name: v })} disabled={ctx.disabled}
            placeholder="orderNumber" ariaLabel={`Variable name, row ${ctx.index + 1}`} />
        ) },
        { key: 'type', label: 'Type', width: '120px', render: (row, patch, ctx) => (
          <CellSelect value={row.type} onChange={(v) => patch({ type: v })} disabled={ctx.disabled}
            options={[['string', 'Text'], ['number', 'Number']]} ariaLabel={`Type, row ${ctx.index + 1}`} />
        ) },
        { key: 'required', label: 'Required', width: '90px', render: (row, patch, ctx) => (
          <input type="checkbox" checked={Boolean(row.required)} disabled={ctx.disabled}
            aria-label={`Required, row ${ctx.index + 1}`} onChange={(e) => patch({ required: e.target.checked })} />
        ) },
      ]}
      makeRow={() => ({ name: '', type: 'string', required: false })}
      addLabel="Add variable" disabled={disabled} emptyLabel="No variables declared."
    />
  );
}

// WP-07 — the order-lifecycle notification catalogue.
function LifecycleNotifications({ canManage, onChange }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.communications.listNotificationPolicies());
  const policies = data?.policies ?? [];
  const [createDraft, createState] = useMutation((payload) => adminApi.communications.createTemplate(payload));
  const [busyKey, setBusyKey] = useState(null);

  const create = async (policy, ch) => {
    const key = `${policy.templateKey}|${ch.channel}`;
    setBusyKey(key);
    try {
      await createDraft({
        templateKey: policy.templateKey,
        channel: ch.channel,
        classification: policy.classification,
        subject: ch.channel === 'EMAIL' ? ch.starter.subject : undefined,
        bodyTemplate: ch.starter.bodyTemplate,
        variableSchema: policy.variableSchema,
        providerTemplateRef: ch.channel === 'WHATSAPP' && ch.starter.providerTemplateRef ? ch.starter.providerTemplateRef : undefined,
      });
      reload();
      onChange?.();
    } finally {
      setBusyKey(null);
    }
  };

  const chLabel = (ch) => {
    if (ch.status === 'ACTIVE') return <span className="pill pill--good">{ch.channel} · active v{ch.activeVersion}</span>;
    if (ch.status === 'DRAFT_ONLY') return <span className="pill pill--muted">{ch.channel} · draft v{ch.latestVersion} — activate below</span>;
    return <span className="pill pill--muted">{ch.channel} · not set</span>;
  };

  return (
    <section>
      <h3>Order-lifecycle notifications</h3>
      <p style={{ maxWidth: 640, color: 'var(--text-muted)' }}>
        Each event sends only once an <strong>ACTIVE</strong> template exists for its channel. Create a draft from
        the default copy, review / edit it in <em>Templates</em> below, then Activate. WhatsApp also needs an
        approved provider template name.
      </p>
      {status === 'loading' && <LoadingState label="Loading lifecycle notifications…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {createState.error && <InlineAlert tone="error">{createState.error.message}</InlineAlert>}
      {status === 'ready' && (
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Event</th><th>Template key</th><th>Channels</th><th>Fires when</th></tr></thead>
          <tbody>
            {policies.map((p) => (
              <tr key={p.event}>
                <td><strong>{p.label}</strong></td>
                <td><code>{p.templateKey}</code></td>
                <td>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                    {p.channels.map((ch) => (
                      <span key={ch.channel} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        {chLabel(ch)}
                        {canManage && ch.status === 'MISSING' && ch.starter && (
                          <button
                            type="button"
                            className="btn btn--secondary"
                            disabled={busyKey === `${p.templateKey}|${ch.channel}`}
                            onClick={() => create(p, ch)}
                          >
                            Create draft
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                </td>
                <td style={{ color: 'var(--text-muted)' }}>{p.description}</td>
              </tr>
            ))}
            {policies.length === 0 && <tr><td colSpan={4} className="data-table__empty">No lifecycle policies.</td></tr>}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

// ---- TARGET 10 — template create with a structured variable table -------
function Templates({ canManage }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.communications.listTemplates());
  const rows = data?.templates ?? [];
  const [form, setForm] = useState({ templateKey: '', channel: 'EMAIL', classification: 'TRANSACTIONAL', subject: '', bodyTemplate: '', providerTemplateRef: '' });
  const [vars, setVars] = useState(() => withRowKeys([]));
  const set = (k) => (v) => setForm((s) => ({ ...s, [k]: v }));

  const declared = useMemo(() => new Set(vars.map((r) => (r.name || '').trim()).filter(Boolean)), [vars]);
  const dupNames = vars.map((r) => (r.name || '').trim()).filter((n, i, a) => n && a.indexOf(n) !== i);
  const badNames = vars.map((r) => (r.name || '').trim()).filter((n) => n && !NAME_RE.test(n));
  const undeclared = [...new Set([...placeholdersIn(form.bodyTemplate), ...placeholdersIn(form.subject)])].filter((n) => !declared.has(n));
  const clientError = dupNames.length ? `Duplicate variable: ${dupNames[0]}`
    : badNames.length ? `Invalid variable name: ${badNames[0]} (letters and digits, must start with a letter)`
      : undeclared.length ? `Placeholder {{${undeclared[0]}}} is used but not declared as a variable`
        : form.channel === 'EMAIL' && !form.subject.trim() ? 'Email templates need a subject'
          : null;

  const [create, createState] = useMutation(() => adminApi.communications.createTemplate({
    templateKey: form.templateKey.trim(),
    channel: form.channel,
    classification: form.classification,
    bodyTemplate: form.bodyTemplate,
    variableSchema: rowsToSchema(vars),
    subject: form.channel === 'EMAIL' ? form.subject : undefined,
    providerTemplateRef: form.channel === 'WHATSAPP' && form.providerTemplateRef ? form.providerTemplateRef : undefined,
  }));
  const [setStatus, statusState] = useMutation(({ id, s }) => adminApi.communications.setTemplateStatus(id, s));

  const submit = async () => {
    await create();
    setForm((s) => ({ ...s, templateKey: '', subject: '', bodyTemplate: '', providerTemplateRef: '' }));
    setVars(withRowKeys([]));
    reload();
  };

  return (
    <section>
      <h3>Templates</h3>
      {canManage && (
        <div className="editor-form" style={{ maxWidth: 640, marginBottom: 20 }}>
          <FormField id="tpl-key" label="Template key (dotted lowercase, e.g. order.placed)" value={form.templateKey} onChange={set('templateKey')} />
          <div className="editor-form__grid">
            <Select id="tpl-ch" label="Channel" value={form.channel} onChange={set('channel')} options={[['EMAIL', 'Email'], ['WHATSAPP', 'WhatsApp']]} />
            <Select id="tpl-class" label="Classification" value={form.classification} onChange={set('classification')} options={[['TRANSACTIONAL', 'Transactional'], ['MARKETING', 'Marketing']]} />
          </div>
          {form.channel === 'EMAIL' && (
            <FormField id="tpl-subj" label="Subject (may use {{variables}})" value={form.subject} onChange={set('subject')} />
          )}
          {form.channel === 'WHATSAPP' && (
            <FormField id="tpl-ref" label="Approved WhatsApp template name (needed for a real send)" value={form.providerTemplateRef} onChange={set('providerTemplateRef')} />
          )}
          <div className="form-field">
            <label htmlFor="tpl-body">Body — use <code>{'{{variable}}'}</code> placeholders</label>
            <textarea id="tpl-body" rows={4} value={form.bodyTemplate} onChange={(e) => set('bodyTemplate')(e.target.value)} />
          </div>
          <div className="form-field">
            <label>Variables</label>
            <VariableRowsEditor rows={vars} onChange={setVars} disabled={false} />
          </div>
          {clientError && <InlineAlert tone="warning">{clientError}</InlineAlert>}
          {createState.error && <InlineAlert tone="error">{createState.error.message}</InlineAlert>}
          <div className="editor-actions">
            <Button busy={createState.busy} disabled={!form.templateKey.trim() || !form.bodyTemplate.trim() || Boolean(clientError)} onClick={submit}>Create version</Button>
          </div>
        </div>
      )}
      {status === 'loading' && <LoadingState label="Loading templates…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Key</th><th>Channel</th><th>Class</th><th>v</th><th>Variables</th><th>Provider ref</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td><code>{t.templateKey}</code></td><td>{t.channel}</td><td>{t.classification}</td><td>{t.version}</td>
                <td>{Object.keys(t.variableSchema || {}).length
                  ? Object.entries(t.variableSchema).map(([n, d]) => `${n}${d?.required ? '*' : ''}`).join(', ')
                  : '—'}</td>
                <td>{t.channel === 'WHATSAPP' ? (t.providerTemplateRef ? <code>{t.providerTemplateRef}</code> : <span className="pill pill--warn">missing — real send will fail</span>) : '—'}</td>
                <td><span className={`pill pill--${tone(t.status)}`}>{t.status}</span></td>
                <td>{canManage && t.status !== 'ACTIVE' && <button type="button" className="btn btn--secondary" disabled={statusState.busy} onClick={async () => { await setStatus({ id: t.id, s: 'ACTIVE' }); reload(); }}>Activate</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="data-table__empty">No templates.</td></tr>}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

/**
 * Messaging → Email Templates (and the lifecycle notification templates).
 * Phase 2 replaces the body editor with the visual email builder; the
 * template store, versions and ACTIVE/DRAFT lifecycle stay the same.
 * Broadcasts were retired in favour of campaigns (docs/MESSAGING.md).
 */
export function MessageTemplatesPanel() {
  const { hasPermission } = useAuth();
  const [ver, setVer] = useState(0);
  return (
    <>
      <LifecycleNotifications key={`lc-${ver}`} canManage={hasPermission('comms.manage')} onChange={() => setVer((v) => v + 1)} />
      <Templates key={`tpl-${ver}`} canManage={hasPermission('comms.manage')} />
    </>
  );
}

export default MessageTemplatesPanel;
