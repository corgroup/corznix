import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi } from '../../api/adminApi.js';
import { useAuth } from '../../auth/useAuth.js';
import { normalizeApiError } from '../../utils/errors.js';

// Ranges the reporting backend actually supports (server: reportTime.RANGES).
// `custom` is intentionally omitted — the dashboard has no date-picker UI.
export const DASHBOARD_RANGES = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'month_to_date', label: 'Month to date' },
];
const DEFAULT_RANGE = 'last_30_days';

// Each panel loads independently: one failing source degrades only its own
// card, never the whole page. `perm` is the permission the call needs — a
// request that would certainly 403 is never fired (the card shows an
// "access required" state instead).
const SOURCES = {
  overview: { perm: 'reports.read', run: (range) => adminApi.reports.get('overview', { range }) },
  sales: { perm: 'reports.read', run: (range) => adminApi.reports.get('sales', { range }) },
  orders: { perm: 'reports.read', run: (range) => adminApi.reports.get('orders', { range, pageSize: 8 }) },
  products: { perm: 'reports.read', run: (range) => adminApi.reports.get('products', { range }) },
  marketing: { perm: 'reports.read', run: (range) => adminApi.reports.get('marketing', { range }) },
  shipping: { perm: 'catalog.read', run: () => adminApi.catalog.shippingSummary() },
  health: { perm: null, run: () => adminApi.health() },
};
const KEYS = Object.keys(SOURCES);

export function useDashboardData() {
  const { permissions } = useAuth();
  const [range, setRange] = useState(DEFAULT_RANGE);
  // Bumped only by an explicit user "refresh" — an event callback, so no
  // synchronous setState happens inside the load effect.
  const [reloadNonce, setReloadNonce] = useState(0);
  const loadKey = `${range}#${reloadNonce}`;

  // Keyed on a primitive so the effect re-fires exactly once when the staff
  // session resolves (permissions go []→[…]), not on every render.
  const permKey = permissions.join(',');
  const permittedKeys = useMemo(
    () => KEYS.filter((k) => !SOURCES[k].perm || permissions.includes(SOURCES[k].perm)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [permKey],
  );

  // Results are keyed by the loadKey they were fetched for. Anything whose
  // stored key is not the current loadKey is still in flight → "loading".
  const [results, setResults] = useState({});

  useEffect(() => {
    let cancelled = false;
    for (const key of permittedKeys) {
      Promise.resolve()
        .then(() => SOURCES[key].run(range))
        .then((data) => {
          if (!cancelled) setResults((prev) => ({ ...prev, [key]: { loadKey, status: 'ready', data, error: null } }));
        })
        .catch((err) => {
          if (!cancelled) setResults((prev) => ({ ...prev, [key]: { loadKey, status: 'error', data: null, error: normalizeApiError(err) } }));
        });
    }
    return () => { cancelled = true; };
  }, [loadKey, range, permittedKeys]);

  const sections = useMemo(() => {
    const out = {};
    for (const key of KEYS) {
      if (!permittedKeys.includes(key)) {
        out[key] = { status: 'forbidden', data: null, error: null };
        continue;
      }
      const r = results[key];
      out[key] = r && r.loadKey === loadKey ? r : { status: 'loading', data: null, error: null };
    }
    return out;
  }, [results, permittedKeys, loadKey]);

  const reloadAll = useCallback(() => setReloadNonce((n) => n + 1), []);

  return { range, setRange, sections, reloadAll };
}

export default useDashboardData;
