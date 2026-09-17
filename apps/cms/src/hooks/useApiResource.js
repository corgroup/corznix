import { useCallback, useEffect, useState } from 'react';
import { normalizeApiError } from '../utils/errors.js';

// Read-only GET helper: loading/data/error + a `reload`. The fetch runs in
// the effect's async continuation (never a synchronous setState in the
// effect body), and `reload` just bumps a nonce the effect depends on.
export function useApiResource(fetcher) {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState({ status: 'loading', data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => fetcher())
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: 'error', data: null, error: normalizeApiError(err) });
      });
    return () => {
      cancelled = true;
    };
    // `fetcher` is an inline arrow; re-run is driven by `nonce` only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const reload = useCallback(() => {
    setState({ status: 'loading', data: null, error: null });
    setNonce((n) => n + 1);
  }, []);

  return { ...state, reload };
}

export default useApiResource;
