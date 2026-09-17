import { useState } from 'react';
import { MediaPicker } from '../components/media/MediaPicker.jsx';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { FormField } from '../components/ui/FormField.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';
import './SettingsPage.css';

const ROLES = ['ADMIN', 'CATALOG_MANAGER', 'OPERATIONS', 'SUPPORT', 'VIEWER'];

function roleLabel(role) {
  return String(role || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Company Profile — legal identity for the CURRENT company. GSTIN/HSN
// validation is the accountant's, not the CMS's — this is a plain editable
// form, same principle as Tax Profiles.
function CompanyProfileTab() {
  const { hasPermission, currentBrand } = useAuth();
  const canManage = hasPermission('settings.manage');
  const profile = useApiResource(() => adminApi.companyProfile.get());
  const [form, setForm] = useState(null);
  const [save, saveState] = useMutation((patch) => adminApi.companyProfile.update(patch));

  const data = form ?? profile.data;
  if (profile.status === 'loading') return <LoadingState label="Loading company profile…" />;
  if (profile.status === 'error') return <ErrorState message={profile.error?.message} onRetry={profile.reload} />;

  const set = (path) => (value) => {
    setForm((prev) => {
      const base = prev ?? profile.data;
      if (path.startsWith('principalAddress.')) {
        const key = path.split('.')[1];
        return { ...base, principalAddress: { ...base.principalAddress, [key]: value } };
      }
      return { ...base, [path]: value };
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    const saved = await save(data);
    setForm(saved);
  };

  return (
    <div className="st-panel">
      <p className="tab-body__hint">
        Legal identity for <strong>{currentBrand?.displayName || currentBrand?.name || 'this company'}</strong>.
        Used on every invoice this company issues — GSTIN and registered address are set once you have them; leave blank until then, never a placeholder.
      </p>
      {saveState.error && <InlineAlert tone="error">{saveState.error.message}</InlineAlert>}
      <CompanyLogo />
      <form className="editor-form" style={{ maxWidth: 640 }} onSubmit={submit}>
        <h3>Legal identity</h3>
        <FormField id="legalName" label="Legal name" value={data?.legalName || ''} onChange={set('legalName')} disabled={!canManage} placeholder="Registered legal name" />
        <FormField id="tradeName" label="Trade name" value={data?.tradeName || ''} onChange={set('tradeName')} disabled={!canManage} placeholder="Brand / trading name, if different" />
        <FormField id="constitution" label="Constitution" value={data?.constitution || ''} onChange={set('constitution')} disabled={!canManage} placeholder="e.g. Private Limited, Proprietorship" />

        <h3>GST</h3>
        <FormField id="gstin" label="GSTIN" value={data?.gstin || ''} onChange={set('gstin')} disabled={!canManage} placeholder="15-character GSTIN" />
        <FormField id="gstRegistrationType" label="GST registration type" value={data?.gstRegistrationType || ''} onChange={set('gstRegistrationType')} disabled={!canManage} placeholder="e.g. Regular" />
        <FormField id="gstStateCode" label="GST state code" value={data?.gstStateCode || ''} onChange={set('gstStateCode')} disabled={!canManage} placeholder="2-digit code, e.g. 09" />
        <FormField id="gstEffectiveFrom" label="GST effective from" type="date" value={data?.gstEffectiveFrom ? String(data.gstEffectiveFrom).slice(0, 10) : ''} onChange={set('gstEffectiveFrom')} disabled={!canManage} />

        <h3>Principal place of business</h3>
        <FormField id="addressLine1" label="Address line 1" value={data?.principalAddress?.addressLine1 || ''} onChange={set('principalAddress.addressLine1')} disabled={!canManage} />
        <FormField id="addressLine2" label="Address line 2" value={data?.principalAddress?.addressLine2 || ''} onChange={set('principalAddress.addressLine2')} disabled={!canManage} />
        <FormField id="city" label="City" value={data?.principalAddress?.city || ''} onChange={set('principalAddress.city')} disabled={!canManage} />
        <FormField id="state" label="State" value={data?.principalAddress?.state || ''} onChange={set('principalAddress.state')} disabled={!canManage} />
        <FormField id="postalCode" label="PIN code" value={data?.principalAddress?.postalCode || ''} onChange={set('principalAddress.postalCode')} disabled={!canManage} />
        <FormField id="country" label="Country" value={data?.principalAddress?.country || 'IN'} onChange={set('principalAddress.country')} disabled={!canManage} maxLength={2} />

        {canManage && (
          <div className="editor-actions"><Button type="submit" busy={saveState.busy}>Save changes</Button></div>
        )}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My Account — the signed-in staff member's own profile + password.
function MyAccountTab() {
  const { staff, changePassword } = useAuth();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [submit, submitState] = useMutation(async () => {
    if (pw.newPassword !== pw.confirmPassword) throw new Error('New password and confirmation do not match.');
    await changePassword(pw.currentPassword, pw.newPassword);
  });
  const [done, setDone] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setDone(false);
    await submit();
    setPw({ currentPassword: '', newPassword: '', confirmPassword: '' });
    setDone(true);
  };

  return (
    <div className="st-panel">
      <h3>Profile</h3>
      <dl className="st-profile-facts">
        <div><dt>Name</dt><dd>{staff?.firstName} {staff?.lastName}</dd></div>
        <div><dt>Email</dt><dd>{staff?.email}</dd></div>
        <div><dt>Role</dt><dd>{roleLabel(staff?.role)}</dd></div>
      </dl>

      <h3>Change password</h3>
      {submitState.error && <InlineAlert tone="error">{submitState.error.message}</InlineAlert>}
      {done && <InlineAlert tone="info">Password updated.</InlineAlert>}
      <form className="editor-form" style={{ maxWidth: 420 }} onSubmit={onSubmit}>
        <FormField id="currentPassword" label="Current password" type="password" autoComplete="current-password"
          value={pw.currentPassword} onChange={(v) => setPw((s) => ({ ...s, currentPassword: v }))} required />
        <FormField id="newPassword" label="New password" type="password" autoComplete="new-password"
          value={pw.newPassword} onChange={(v) => setPw((s) => ({ ...s, newPassword: v }))} required />
        <FormField id="confirmPassword" label="Confirm new password" type="password" autoComplete="new-password"
          value={pw.confirmPassword} onChange={(v) => setPw((s) => ({ ...s, confirmPassword: v }))} required />
        <div className="editor-actions">
          <Button type="submit" busy={submitState.busy} disabled={!pw.currentPassword || !pw.newPassword || !pw.confirmPassword}>
            Update password
          </Button>
        </div>
      </form>
    </div>
  );
}

// Fetches + edits ONE staff member's per-company access — a separate
// component so the fetch only happens once its row is actually expanded,
// not for every row in the roster up front.
function StaffAccessPanel({ memberId, brands }) {
  const access = useApiResource(() => adminApi.getStaffBrandAccess(memberId));
  const [grant, grantState] = useMutation(({ brandId, role }) => adminApi.grantStaffBrandAccess(memberId, brandId, { role }));
  const [revoke, revokeState] = useMutation((brandId) => adminApi.revokeStaffBrandAccess(memberId, brandId));
  const [grantForm, setGrantForm] = useState({ brandId: '', role: 'VIEWER' });

  if (access.status === 'loading') return <LoadingState label="Loading access…" />;
  if (access.status === 'error') return <ErrorState message={access.error?.message} onRetry={access.reload} />;

  const grantedBrandIds = new Set((access.data?.access ?? []).map((a) => a.brandId));
  const grantableBrands = brands.filter((b) => !grantedBrandIds.has(b.id));

  return (
    <div className="st-access-panel">
      {(grantState.error || revokeState.error) && <InlineAlert tone="error">{(grantState.error || revokeState.error).message}</InlineAlert>}
      <table className="data-table">
        <thead><tr><th>Company</th><th>Role in this company</th><th>Overrides</th><th /></tr></thead>
        <tbody>
          {(access.data?.access ?? []).map((a) => (
            <tr key={a.brandId}>
              <td>{a.brandName}</td>
              <td>{roleLabel(a.role)}</td>
              <td className="text-faint">{a.permissionOverrides ? `+${a.permissionOverrides.grant?.length || 0} / -${a.permissionOverrides.revoke?.length || 0}` : '—'}</td>
              <td>
                <Button variant="danger" busy={revokeState.busy}
                  onClick={async () => { await revoke(a.brandId); access.reload(); }}>
                  Revoke
                </Button>
              </td>
            </tr>
          ))}
          {(access.data?.access ?? []).length === 0 && (
            <tr><td colSpan={4} className="data-table__empty">No company access granted yet.</td></tr>
          )}
        </tbody>
      </table>

      {grantableBrands.length > 0 && (
        <form className="st-grant-form" onSubmit={async (e) => {
          e.preventDefault();
          await grant(grantForm);
          setGrantForm({ brandId: '', role: 'VIEWER' });
          access.reload();
        }}>
          <select className="st-inline-select" value={grantForm.brandId} required
            onChange={(e) => setGrantForm((s) => ({ ...s, brandId: e.target.value }))}>
            <option value="" disabled>Grant access to…</option>
            {grantableBrands.map((b) => <option key={b.id} value={b.id}>{b.displayName || b.name}</option>)}
          </select>
          <select className="st-inline-select" value={grantForm.role}
            onChange={(e) => setGrantForm((s) => ({ ...s, role: e.target.value }))}>
            {ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
          <Button type="submit" variant="secondary" busy={grantState.busy} disabled={!grantForm.brandId}>Grant</Button>
        </form>
      )}
      <p className="tab-body__hint">Fine-grained permission overrides (grant/revoke specific permissions on top of a company role) are supported by the API but not yet editable here.</p>
    </div>
  );
}

// One staff member's row, expandable to show/edit their per-company access.
function StaffRow({ member, brands, onReload }) {
  const [expanded, setExpanded] = useState(false);
  const [setStatus, statusState] = useMutation((status) => adminApi.setStaffStatus(member.id, status));
  const [setRole, roleState] = useMutation((role) => adminApi.changeStaffRole(member.id, role));

  const toggleExpand = () => setExpanded((v) => !v);
  const isSuperAdmin = member.role === 'SUPER_ADMIN';

  return (
    <>
      <tr>
        <td>{member.firstName} {member.lastName}</td>
        <td>{member.email}</td>
        <td>
          {isSuperAdmin ? roleLabel(member.role) : (
            <select className="st-inline-select" value={member.role} disabled={roleState.busy}
              onChange={async (e) => { await setRole(e.target.value); onReload(); }}>
              {ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </select>
          )}
        </td>
        <td><span className={`pill pill--${member.status === 'ACTIVE' ? 'good' : 'muted'}`}>{member.status}</span></td>
        <td className="st-row-actions">
          {!isSuperAdmin && (
            <Button variant={member.status === 'ACTIVE' ? 'warning' : 'success'} busy={statusState.busy}
              onClick={async () => { await setStatus(member.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'); onReload(); }}>
              {member.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
            </Button>
          )}
          <Button variant="secondary" onClick={toggleExpand}>{expanded ? 'Hide access' : 'Company access'}</Button>
        </td>
      </tr>
      {expanded && (
        <tr className="st-access-row">
          <td colSpan={5}>
            {isSuperAdmin
              ? <p className="tab-body__hint">SUPER_ADMIN has implicit access to every company — nothing to grant or revoke.</p>
              : <StaffAccessPanel memberId={member.id} brands={brands} />}
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// User Management — SUPER_ADMIN only (staff.manage). List every staff
// member, create new ones, change role/status, and manage per-company
// access (staff_brand_access) — the actual Phase 5/6 multi-company piece.
function UserManagementTab() {
  const { accessibleBrands } = useAuth();
  const staffList = useApiResource(() => adminApi.listStaff());
  const [create, createState] = useMutation((body) => adminApi.createStaff(body));
  const [form, setForm] = useState({ email: '', password: '', firstName: '', lastName: '', role: 'VIEWER' });
  const set = (k) => (v) => setForm((s) => ({ ...s, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    await create(form);
    setForm({ email: '', password: '', firstName: '', lastName: '', role: 'VIEWER' });
    staffList.reload();
  };

  return (
    <div className="st-panel">
      <h3>Add staff member</h3>
      <p className="tab-body__hint">New accounts get a temporary password and must set their own on first login.</p>
      {createState.error && <InlineAlert tone="error">{createState.error.message}</InlineAlert>}
      <form className="editor-form st-create-form" onSubmit={submit}>
        <FormField id="firstName" label="First name" value={form.firstName} onChange={set('firstName')} required />
        <FormField id="lastName" label="Last name" value={form.lastName} onChange={set('lastName')} required />
        <FormField id="email" label="Email" type="email" value={form.email} onChange={set('email')} required />
        <FormField id="password" label="Temporary password" type="password" value={form.password} onChange={set('password')} required />
        <label className="form-field">
          <span>Role (default company)</span>
          <select className="form-field__input" value={form.role} onChange={(e) => set('role')(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
        </label>
        <div className="editor-actions">
          <Button type="submit" busy={createState.busy} disabled={!form.email || !form.password || !form.firstName || !form.lastName}>
            Create staff account
          </Button>
        </div>
      </form>

      <h3>All staff</h3>
      {staffList.status === 'loading' && <LoadingState label="Loading staff…" />}
      {staffList.status === 'error' && <ErrorState message={staffList.error?.message} onRetry={staffList.reload} />}
      {staffList.status === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
            <tbody>
              {staffList.data.staff.map((member) => (
                <StaffRow key={member.id} member={member} brands={accessibleBrands} onReload={staffList.reload} />
              ))}
              {staffList.data.staff.length === 0 && (
                <tr><td colSpan={5} className="data-table__empty">No staff accounts yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
const BASE_TABS = ['Company Profile', 'My Account'];

export function SettingsPage() {
  const { hasPermission } = useAuth();
  const canManageUsers = hasPermission('staff.manage');
  const tabs = canManageUsers ? [...BASE_TABS, 'User Management'] : BASE_TABS;
  const [tab, setTab] = useState('Company Profile');

  return (
    <PageShell title="Settings" description="Company profile, your account, and (if you're the company owner) staff and per-company access.">
      <nav className="st-tabs" aria-label="Settings sections">
        {tabs.map((t) => (
          <button key={t} type="button" className={`st-tab${tab === t ? ' st-tab--active' : ''}`}
            aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      {tab === 'Company Profile' && <CompanyProfileTab />}
      {tab === 'My Account' && <MyAccountTab />}
      {tab === 'User Management' && canManageUsers && <UserManagementTab />}
    </PageShell>
  );
}

export default SettingsPage;

/**
 * Company logo. Its own resource rather than part of the legal-identity
 * form: it saves immediately on pick, and a half-filled GST form should
 * never block changing a logo (or vice versa).
 */
function CompanyLogo() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('settings.manage');
  const { status, data, error, reload } = useApiResource(() => adminApi.brandAppearance.get());
  const [save, { busy, error: saveErr }] = useMutation((patch) => adminApi.brandAppearance.update(patch));

  if (status === 'loading') return <LoadingState label="Loading logo…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">Company logo</h3>
      <p className="settings-section__hint">
        Used on invoices and in the admin console for {data.name}.
      </p>
      {saveErr && <InlineAlert tone="error">{saveErr.message}</InlineAlert>}
      <MediaPicker
        label=""
        hint="Square or wide mark on a transparent background works best. PNG, WebP, SVG-exported PNG. Max 5MB."
        disabled={!canManage || busy}
        value={data.logoMediaId ? { mediaId: data.logoMediaId, url: data.logoUrl } : null}
        onChange={async ({ mediaId }) => { await save({ logoMediaId: mediaId }); reload(); }}
      />
    </section>
  );
}