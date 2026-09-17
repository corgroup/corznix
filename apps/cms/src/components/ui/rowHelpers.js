import { useEffect } from 'react';

// Shared helpers for the structured row / matrix editors (Phase 1A).
// Kept out of RowsEditor.jsx so that file only exports components
// (react-refresh/only-export-components).

let seq = 0;
export const makeRowKey = () => `r${Date.now().toString(36)}${(seq += 1)}`;

// Attach a stable client key to each row so React keeps input focus across
// reorders. Returns a new array of shallow-cloned rows.
export function withRowKeys(rows) {
  return (rows || []).map((r) => (r && r._k ? r : { ...r, _k: makeRowKey() }));
}

// Strip the client-only `_k` before serialising to the API.
export function stripRowKeys(rows) {
  return (rows || []).map(({ _k, ...rest }) => rest); // eslint-disable-line no-unused-vars
}

// Warn on browser close / reload while a form has unsaved edits. Router
// navigation still works — the CMS uses inline "Unsaved changes" pills for
// that, matching the existing content editors.
export function useUnsavedGuard(dirty) {
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
