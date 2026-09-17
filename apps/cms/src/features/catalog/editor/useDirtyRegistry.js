import { useCallback, useRef, useState } from 'react';

// Central record of which editor sections have unsaved edits. Sections call
// `report(key, bool)` from an effect keyed on their own dirty flag; the state
// update only fires when a section's dirtiness actually flips, so typing in a
// field does not cascade a re-render of the whole editor.
export function useDirtyRegistry() {
  const setRef = useRef(new Set());
  const [dirtyKeys, setDirtyKeys] = useState([]);

  const report = useCallback((key, isDirty) => {
    const s = setRef.current;
    const had = s.has(key);
    if (Boolean(isDirty) === had) return;
    if (isDirty) s.add(key); else s.delete(key);
    setDirtyKeys([...s]);
  }, []);

  const reset = useCallback(() => {
    setRef.current = new Set();
    setDirtyKeys([]);
  }, []);

  return { dirtyKeys, report, reset };
}

export default useDirtyRegistry;
