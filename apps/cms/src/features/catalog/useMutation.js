import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { normalizeApiError } from '../../utils/errors.js';

// Minimal mutation helper: busy flag + normalized error + double-submit
// guard. Returns [run, { busy, error, reset }].
//
// `run` always calls the `fn` from the latest render. It used to be memoised
// on `busy` alone, so a mutation reading component state — the coupon code
// being typed, a customer note, a new promotion's name — sent the value from
// whenever `busy` last changed: usually the empty initial state. "Add code"
// posted {"code":""} and failed validation. The guard lives in a ref for the
// same reason: two clicks in one render must still see each other.
export function useMutation(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fnRef = useRef(fn);
  const busyRef = useRef(false);

  useLayoutEffect(() => {
    fnRef.current = fn;
  });

  const run = useCallback(async (...args) => {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      return await fnRef.current(...args);
    } catch (err) {
      setError(normalizeApiError(err));
      throw err;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  return [run, { busy, error, reset: () => setError(null) }];
}

/**
 * For click handlers. `run` puts a failure in `error` for the page to show and
 * then rethrows it, so awaiting it bare left every failed save as an
 * "Uncaught (in promise)" in the console. This resolves to whether it worked:
 * follow-up steps (close the drawer, clear the form, reload) run only on
 * success, and the page's own error alert shows what went wrong.
 */
export const succeeded = (promise) => Promise.resolve(promise).then(() => true, () => false);

export default useMutation;
