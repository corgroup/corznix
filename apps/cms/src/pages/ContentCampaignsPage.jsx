import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { FormField } from '../components/ui/FormField.jsx';
import { Select } from '../components/ui/Select.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { RowsEditor, CellInput, DirtyPill } from '../components/ui/RowsEditor.jsx';
import { withRowKeys, useUnsavedGuard } from '../components/ui/rowHelpers.js';
import { ColorTokenField } from '../components/ui/ColorTokenField.jsx';
import { adminApi } from '../api/adminApi.js';
import PreviewButton from '../components/content/PreviewButton.jsx';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';

const TABS = [['campaigns', 'Campaigns'], ['themes', 'Themes']];

// server/src/modules/content/campaignService.js — THEME_TOKENS + DEFAULT_TOKENS.
const THEME_TOKEN_META = [
  ['announcementBg', 'Announcement background'],
  ['announcementFg', 'Announcement text'],
  ['accent', 'Accent'],
  ['accentContrast', 'Accent contrast'],
  ['bannerBg', 'Banner background'],
  ['bannerFg', 'Banner text'],
];
const THEME_TOKEN_KEYS = THEME_TOKEN_META.map(([k]) => k);
const DEFAULT_TOKENS = {
  announcementBg: '#000000', announcementFg: '#ffffff', accent: '#000000',
  accentContrast: '#ffffff', bannerBg: '#111111', bannerFg: '#ffffff',
};
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function ThemeTokenFields({ tokens, onChange, disabled }) {
  return (
    <div className="builder-section">
      <h4>Colour tokens</h4>
      {THEME_TOKEN_META.map(([key, label]) => (
        <ColorTokenField
          key={key}
          label={label}
          value={tokens[key] ?? ''}
          disabled={disabled}
          onChange={(v) => onChange({ ...tokens, [key]: v })}
        />
      ))}
    </div>
  );
}

const tokensValid = (t) => THEME_TOKEN_KEYS.every((k) => HEX_RE.test(String(t[k] || '').trim()));
const normTokens = (t) => Object.fromEntries(THEME_TOKEN_KEYS.map((k) => [k, String(t[k] || '').trim().toLowerCase()]));

export function ContentCampaignsPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('content.write');
  const canPublish = hasPermission('content.publish');
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') || 'campaigns';

  return (
    <PageShell title="Campaigns & Themes" description="Scheduled campaign overlays and their constrained colour themes. A campaign goes live automatically inside its window once published — resolved at request time, no job to run.">
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
        {tab === 'campaigns' && <CampaignsTab canWrite={canWrite} canPublish={canPublish} />}
        {tab === 'themes' && <ThemesTab canWrite={canWrite} canPublish={canPublish} />}
      </div>
    </PageShell>
  );
}

function ScopeBar({ doc, canPublish, onPublish, loadHistory, onRollback, onDone, extra, previewAsOf }) {
  const [publish, { busy, error }] = useMutation(onPublish);
  const { data: hist, reload } = useApiResource(loadHistory);
  const [rb] = useMutation(onRollback);
  const [open, setOpen] = useState(false);
  return (
    <div className="dash-section" style={{ marginTop: 16 }}>
      <div className="editor-actions">
        <span className={`pill pill--${doc.draftDirty ? 'warn' : 'good'}`}>
          {doc.draftDirty ? 'Unpublished changes' : 'Published'} · working v{doc.workingVersion} · live v{doc.publishedVersion ?? '—'}
        </span>
        {canPublish && <Button variant="success" busy={busy} disabled={!doc.draftDirty} onClick={async () => { await publish(doc.workingVersion); onDone(); reload(); }}>Publish</Button>}
        {previewAsOf && <PreviewButton scope="experience" path="/" asOf={previewAsOf} label="Preview as of start" />}
        <button type="button" className="linkish" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'History'}</button>
        {extra}
      </div>
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {open && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="data-table">
            <thead><tr><th>Version</th><th>State</th><th>When</th><th>Summary</th><th /></tr></thead>
            <tbody>
              {(hist?.publications ?? []).map((p) => (
                <tr key={p.id}>
                  <td>v{p.version}</td><td>{p.state}</td>
                  <td>{p.publishedAt ? new Date(p.publishedAt).toLocaleString() : '—'}</td>
                  <td>{p.changeSummary || '—'}</td>
                  <td>{canPublish && p.state !== 'PUBLISHED' && (
                    <button type="button" className="linkish" onClick={async () => { if (confirm(`Roll back to v${p.version}?`)) { await rb(p.id); onDone(); reload(); } }}>Roll back</button>
                  )}</td>
                </tr>
              ))}
              {(hist?.publications ?? []).length === 0 && <tr><td colSpan={5} className="data-table__empty">Not published yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- campaigns ----------------------------------------------------
function CampaignsTab({ canWrite, canPublish }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.content.campaigns());
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  if (status === 'loading') return <LoadingState label="Loading campaigns…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;

  return (
    <div className="tab-body" style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 280px) 1fr', gap: 20 }}>
      <div>
        <ul className="side-list">
          {data.campaigns.map((c) => (
            <li key={c.slug}>
              <button type="button" className={`side-list__item${selected === c.slug ? ' side-list__item--active' : ''}`} onClick={() => { setSelected(c.slug); setCreating(false); }}>
                {c.name}
                {c.liveNow && <span className="pill pill--good" style={{ marginLeft: 6 }}>LIVE</span>}
                {c.runtimeDisabled && <span className="pill pill--warn" style={{ marginLeft: 6 }}>disabled</span>}
              </button>
            </li>
          ))}
        </ul>
        {canWrite && <Button variant="soft" style={{ marginTop: 8 }} onClick={() => { setCreating(true); setSelected(null); }}>New campaign</Button>}
      </div>
      <div>
        {creating && <NewCampaignForm onClose={() => setCreating(false)} onCreated={(slug) => { setCreating(false); reload(); setSelected(slug); }} />}
        {selected && <CampaignEditor key={selected} slug={selected} canWrite={canWrite} canPublish={canPublish} onChanged={reload} />}
        {!creating && !selected && <p className="tab-body__hint">Select a campaign, or create one. A campaign resolves live only inside its [starts, ends) window, once published.</p>}
      </div>
    </div>
  );
}

function NewCampaignForm({ onClose, onCreated }) {
  const [f, setF] = useState({ name: '', slug: '', campaignKey: '', priority: '100', startsAt: '', endsAt: '', themeKey: '' });
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const [save, { busy, error }] = useMutation((body) => adminApi.content.createCampaign(body));
  return (
    <form className="editor-form" style={{ maxWidth: 560 }} onSubmit={async (e) => {
      e.preventDefault();
      const res = await save({
        name: f.name.trim(), slug: f.slug.trim(), campaignKey: f.campaignKey.trim(),
        priority: Number(f.priority) || 100,
        startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(),
        themeKey: f.themeKey.trim() || null,
        payload: { announcementMode: 'prepend', announcements: [], banner: null },
      });
      onCreated(res.campaign.slug);
    }}>
      <h3>New campaign</h3>
      <FormField id="nc-name" label="Name" value={f.name} onChange={set('name')} required />
      <FormField id="nc-slug" label="Slug (kebab-case)" value={f.slug} onChange={set('slug')} required />
      <FormField id="nc-key" label="Campaign key (lower_snake_case)" value={f.campaignKey} onChange={set('campaignKey')} required />
      <FormField id="nc-prio" label="Priority (0–1000, higher wins)" value={f.priority} onChange={set('priority')} />
      <FormField id="nc-start" label="Starts at" type="datetime-local" value={f.startsAt} onChange={set('startsAt')} required />
      <FormField id="nc-end" label="Ends at" type="datetime-local" value={f.endsAt} onChange={set('endsAt')} required />
      <FormField id="nc-theme" label="Theme key (optional)" value={f.themeKey} onChange={set('themeKey')} />
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      <div className="editor-actions">
        <Button type="submit" busy={busy}>Create</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

function CampaignEditor({ slug, canWrite, canPublish, onChanged }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.content.campaign(slug));
  const [dis, { error: disErr }] = useMutation((disabled) => adminApi.content.setCampaignDisabled(slug, disabled, disabled ? 'CMS toggle' : undefined));
  if (status === 'loading') return <LoadingState label="Loading campaign…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;
  const { document: doc, campaign } = data;
  const refresh = () => { reload(); onChanged(); };

  return (
    <div>
      <CampaignForm key={`${slug}-${doc.workingVersion}`} campaign={campaign} version={doc.workingVersion} canWrite={canWrite} onSaved={refresh} />
      {disErr && <InlineAlert tone="error">{disErr.message}</InlineAlert>}
      <ScopeBar
        doc={doc} canPublish={canPublish}
        onPublish={(v) => adminApi.content.publishCampaign(slug, v)}
        loadHistory={() => adminApi.content.campaignHistory(slug)}
        onRollback={(id) => adminApi.content.rollbackCampaign(slug, id)}
        onDone={refresh}
        previewAsOf={campaign.startsAt}
        extra={canPublish && (
          <button type="button" className="linkish" onClick={async () => { await dis(!campaign.runtime.disabled); refresh(); }}>
            {campaign.runtime.disabled ? 'Re-enable (emergency)' : 'Emergency disable'}
          </button>
        )}
      />
    </div>
  );
}

// ---- TARGET 5 — campaign builder ------------------------------------
function CampaignForm({ campaign, version, canWrite, onSaved }) {
  const toLocal = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');
  const hydrate = () => {
    const p = campaign.payload || {};
    return {
      name: campaign.name, priority: String(campaign.priority),
      startsAt: toLocal(campaign.startsAt), endsAt: toLocal(campaign.endsAt),
      themeKey: campaign.themeKey || '', status: campaign.status,
      announcementMode: p.announcementMode === 'replace' ? 'replace' : 'prepend',
      announcements: withRowKeys((p.announcements || []).map((a) => ({ text: a.text || '', link: a.link || '' }))),
      bannerEnabled: Boolean(p.banner),
      banner: { text: p.banner?.text || '', ctaLabel: p.banner?.ctaLabel || '', ctaPath: p.banner?.ctaPath || '' },
    };
  };
  const [f, setF] = useState(hydrate);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const setBanner = (k) => (v) => setF((s) => ({ ...s, banner: { ...s.banner, [k]: v } }));
  const [save, { busy, error }] = useMutation((body) => adminApi.content.updateCampaign(campaign.slug, body));

  const buildPayload = (st) => ({
    announcementMode: st.announcementMode,
    announcements: st.announcements
      .map((a) => ({ text: (a.text || '').trim(), link: (a.link || '').trim() || null }))
      .filter((a) => a.text),
    banner: st.bannerEnabled
      ? { text: (st.banner.text || '').trim(), ctaLabel: (st.banner.ctaLabel || '').trim() || null, ctaPath: (st.banner.ctaPath || '').trim() || null }
      : null,
  });
  const snapshot = (st) => JSON.stringify({
    name: st.name.trim(), priority: Number(st.priority) || 0, startsAt: st.startsAt, endsAt: st.endsAt,
    themeKey: st.themeKey.trim() || null, status: st.status, payload: buildPayload(st),
  });
  const dirty = snapshot(f) !== snapshot(hydrate());
  useUnsavedGuard(dirty);

  const badLink = f.announcements.find((a) => a.link && (!a.link.startsWith('/') || a.link.includes('//')));
  const clientError = f.bannerEnabled && !f.banner.text.trim() ? 'The banner needs text (or turn the banner off).'
    : badLink ? `Announcement link "${badLink.link}" must be an internal path starting with "/".`
      : null;

  return (
    <form className="editor-form" style={{ maxWidth: 720 }} onSubmit={async (e) => {
      e.preventDefault();
      await save({
        name: f.name.trim(), priority: Number(f.priority) || 0,
        startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(),
        themeKey: f.themeKey.trim() || null, status: f.status, payload: buildPayload(f), expectedVersion: version,
      });
      onSaved();
    }}>
      <h3>{campaign.name} <span className="text-faint">/{campaign.slug}</span> <span style={{ marginLeft: 8 }}><DirtyPill dirty={dirty} /></span></h3>

      <div className="builder-section">
        <h4>Identity &amp; schedule</h4>
        <FormField id="cf-name" label="Name" value={f.name} onChange={set('name')} disabled={!canWrite} required />
        <div className="editor-form__grid">
          <FormField id="cf-prio" label="Priority (0–1000)" value={f.priority} onChange={set('priority')} disabled={!canWrite} />
          <FormField id="cf-theme" label="Theme key (optional)" value={f.themeKey} onChange={set('themeKey')} disabled={!canWrite} />
          <FormField id="cf-start" label="Starts at" type="datetime-local" value={f.startsAt} onChange={set('startsAt')} disabled={!canWrite} />
          <FormField id="cf-end" label="Ends at" type="datetime-local" value={f.endsAt} onChange={set('endsAt')} disabled={!canWrite} />
        </div>
        <Select id="cf-status" label="Status" value={f.status} onChange={set('status')} disabled={!canWrite} options={[['DRAFT', 'DRAFT'], ['SCHEDULED', 'SCHEDULED'], ['ARCHIVED', 'ARCHIVED']]} />
      </div>

      <div className="builder-section">
        <h4>Announcements</h4>
        <Select id="cf-mode" label="Announcement behaviour" value={f.announcementMode} onChange={set('announcementMode')} disabled={!canWrite}
          options={[['prepend', 'Prepend — show above the standing announcements'], ['replace', 'Replace — hide the standing announcements']]} />
        <RowsEditor
          rows={f.announcements}
          onChange={(rows) => set('announcements')(rows)}
          columns={[
            { key: 'text', label: 'Text', render: (r, p, c) => <CellInput value={r.text} onChange={(v) => p({ text: v })} disabled={c.disabled} ariaLabel={`Announcement text, row ${c.index + 1}`} /> },
            { key: 'link', label: 'Link (internal /path, optional)', render: (r, p, c) => <CellInput value={r.link} onChange={(v) => p({ link: v })} disabled={c.disabled} placeholder="/collections/new-arrivals" ariaLabel={`Announcement link, row ${c.index + 1}`} /> },
          ]}
          makeRow={() => ({ text: '', link: '' })}
          addLabel="Add announcement" maxRows={10} disabled={!canWrite} emptyLabel="No campaign announcements."
        />
      </div>

      <div className="builder-section">
        <h4>Banner</h4>
        <label className="form-field" style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={f.bannerEnabled} disabled={!canWrite} onChange={(e) => set('bannerEnabled')(e.target.checked)} />
          Show a campaign banner
        </label>
        {f.bannerEnabled && (
          <>
            <FormField id="cf-bt" label="Banner text *" value={f.banner.text} onChange={setBanner('text')} disabled={!canWrite} />
            <div className="editor-form__grid">
              <FormField id="cf-bl" label="CTA label" value={f.banner.ctaLabel} onChange={setBanner('ctaLabel')} disabled={!canWrite} />
              <FormField id="cf-bp" label="CTA path (internal /path)" value={f.banner.ctaPath} onChange={setBanner('ctaPath')} disabled={!canWrite} />
            </div>
          </>
        )}
      </div>

      {clientError && <InlineAlert tone="warning">{clientError}</InlineAlert>}
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {canWrite && (
        <div className="editor-actions">
          <Button type="submit" busy={busy} disabled={!dirty || Boolean(clientError)}>Save draft</Button>
          <Button variant="secondary" disabled={!dirty} onClick={() => setF(hydrate())}>Discard changes</Button>
        </div>
      )}
    </form>
  );
}

// ---- themes ------------------------------------------------------
function ThemesTab({ canWrite, canPublish }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.content.themes());
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  if (status === 'loading') return <LoadingState label="Loading themes…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;

  return (
    <div className="tab-body" style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) 1fr', gap: 20 }}>
      <div>
        <ul className="side-list">
          {data.themes.map((t) => (
            <li key={t.themeKey}>
              <button type="button" className={`side-list__item${selected === t.themeKey ? ' side-list__item--active' : ''}`} onClick={() => { setSelected(t.themeKey); setCreating(false); }}>
                {t.name}{t.isDefault && <span className="pill pill--good" style={{ marginLeft: 6 }}>default</span>}
              </button>
            </li>
          ))}
        </ul>
        {canWrite && <Button variant="soft" style={{ marginTop: 8 }} onClick={() => { setCreating(true); setSelected(null); }}>New theme</Button>}
      </div>
      <div>
        <p className="tab-body__hint">Each theme is a small fixed set of hex colours applied to the announcement bar and campaign banner.</p>
        {creating && <NewThemeForm onClose={() => setCreating(false)} onCreated={(k) => { setCreating(false); reload(); setSelected(k); }} />}
        {selected && <ThemeEditor key={selected} themeKey={selected} canWrite={canWrite} canPublish={canPublish} onChanged={reload} />}
      </div>
    </div>
  );
}

// ---- TARGET 6 — new theme colour editor ----------------------------
function NewThemeForm({ onClose, onCreated }) {
  const [f, setF] = useState({ name: '', themeKey: '' });
  const [tokens, setTokens] = useState({ ...DEFAULT_TOKENS });
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const [save, { busy, error }] = useMutation((body) => adminApi.content.createTheme(body));
  const valid = tokensValid(tokens);
  return (
    <form className="editor-form" style={{ maxWidth: 560 }} onSubmit={async (e) => {
      e.preventDefault();
      const res = await save({ name: f.name.trim(), themeKey: f.themeKey.trim(), tokens: normTokens(tokens) });
      onCreated(res.theme.themeKey);
    }}>
      <h3>New theme</h3>
      <FormField id="nt-name" label="Name" value={f.name} onChange={set('name')} required />
      <FormField id="nt-key" label="Theme key (lower_snake_case)" value={f.themeKey} onChange={set('themeKey')} required />
      <ThemeTokenFields tokens={tokens} onChange={setTokens} disabled={false} />
      {!valid && <InlineAlert tone="warning">Every colour must be a hex value like #3a1f67.</InlineAlert>}
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      <div className="editor-actions">
        <Button type="submit" busy={busy} disabled={!f.name.trim() || !f.themeKey.trim() || !valid}>Create</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

function ThemeEditor({ themeKey, canWrite, canPublish, onChanged }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.content.theme(themeKey));
  if (status === 'loading') return <LoadingState label="Loading theme…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;
  const { document: doc, theme } = data;
  const refresh = () => { reload(); onChanged(); };
  return (
    <div>
      <ThemeForm key={`${themeKey}-${doc.workingVersion}`} theme={theme} version={doc.workingVersion} canWrite={canWrite} onSaved={refresh} />
      <ScopeBar
        doc={doc} canPublish={canPublish}
        onPublish={(v) => adminApi.content.publishTheme(themeKey, v)}
        loadHistory={() => adminApi.content.themeHistory(themeKey)}
        onRollback={(id) => adminApi.content.rollbackTheme(themeKey, id)}
        onDone={refresh}
      />
    </div>
  );
}

// ---- TARGET 7 — theme colour editor ------------------------------
function ThemeForm({ theme, version, canWrite, onSaved }) {
  const hydrate = () => ({
    name: theme.name,
    isDefault: Boolean(theme.isDefault),
    tokens: { ...DEFAULT_TOKENS, ...(theme.tokens || {}) },
  });
  const [f, setF] = useState(hydrate);
  const [save, { busy, error }] = useMutation((body) => adminApi.content.updateTheme(theme.themeKey, body));
  const valid = tokensValid(f.tokens);
  const snapshot = (st) => JSON.stringify({ name: st.name.trim(), isDefault: st.isDefault, tokens: normTokens(st.tokens) });
  const dirty = snapshot(f) !== snapshot(hydrate());
  useUnsavedGuard(dirty);

  return (
    <form className="editor-form" style={{ maxWidth: 560 }} onSubmit={async (e) => {
      e.preventDefault();
      await save({
        name: f.name.trim(), tokens: normTokens(f.tokens),
        ...(f.isDefault && !theme.isDefault ? { isDefault: true } : {}),
        expectedVersion: version,
      });
      onSaved();
    }}>
      <h3>{theme.name} <span className="text-faint">{theme.themeKey}</span> <span style={{ marginLeft: 8 }}><DirtyPill dirty={dirty} /></span></h3>
      <FormField id="tf-name" label="Name" value={f.name} onChange={(v) => setF((s) => ({ ...s, name: v }))} disabled={!canWrite} required />
      <label className="form-field" style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={f.isDefault} disabled={!canWrite || theme.isDefault} onChange={(e) => setF((s) => ({ ...s, isDefault: e.target.checked }))} />
        Default (base) theme
      </label>
      <ThemeTokenFields tokens={f.tokens} onChange={(t) => setF((s) => ({ ...s, tokens: t }))} disabled={!canWrite} />
      {!valid && <InlineAlert tone="warning">Every colour must be a hex value like #3a1f67.</InlineAlert>}
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {canWrite && (
        <div className="editor-actions">
          <Button type="submit" busy={busy} disabled={!dirty || !valid}>Save draft</Button>
          <Button variant="secondary" disabled={!dirty} onClick={() => setF(hydrate())}>Discard changes</Button>
        </div>
      )}
    </form>
  );
}

export default ContentCampaignsPage;
