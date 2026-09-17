import { useEffect, useRef, useState } from 'react';
import { PREVIEW_DEVICES } from './previewDevices.js';
import './LivePreview.css';

// Live visual preview of a CMS edit, rendered by the REAL storefront.
//
// The iframe loads the storefront's /__cms-preview route, which mounts the
// storefront's own components (Header, MegaMenu, MobileMenu, AnnouncementBar,
// homepage sections) with the storefront's own CSS. This component only
// sends it the current, unsaved draft. There is no second copy of the
// storefront's markup or styles in the CMS, so the preview cannot drift from
// what customers see: it IS what customers see, fed with draft data.
//
// Protocol (window.postMessage, origin-checked on both sides):
//   storefront -> CMS  { source: 'corcotton-preview', type: 'ready' }
//   CMS -> storefront  { source: 'corcotton-cms', type, data, ui }
//   storefront -> CMS  { source: 'corcotton-preview', type: 'ui', ui }  (customer-style clicks in the preview)

const STOREFRONT = (import.meta.env.VITE_STOREFRONT_URL || 'http://localhost:5173').replace(/\/+$/, '');
const STOREFRONT_ORIGIN = new URL(STOREFRONT).origin;
const READY_TIMEOUT_MS = 15000;

const DeviceIcon = ({ kind }) => {
  const paths = {
    desktop: 'M3 5h18v11H3zM8 20h8M12 16v4',
    tablet: 'M6 3h12v18H6zM11 18h2',
    mobile: 'M8 3h8v18H8zM11 18h2',
  };
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[kind]} />
    </svg>
  );
};

export function LivePreview({
  message,               // { type, data, ui } — memoised by the caller
  device,
  onDeviceChange,
  devices = ['desktop', 'tablet', 'mobile'],
  height = 560,
  onUi,                  // (ui) => void — a click inside the preview
  title = 'Live preview',
}) {
  const frameRef = useRef(null);
  const stageRef = useRef(null);
  const messageRef = useRef(message);
  const onUiRef = useRef(onUi);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [stageWidth, setStageWidth] = useState(0);

  // Callers may rebuild `message` on every render; only a real content change
  // is sent to the storefront.
  const messageKey = JSON.stringify(message ?? null);

  useEffect(() => { messageRef.current = message; onUiRef.current = onUi; }, [message, onUi]);

  const post = (msg) => {
    if (!msg) return;
    frameRef.current?.contentWindow?.postMessage({ source: 'corcotton-cms', ...msg }, STOREFRONT_ORIGIN);
  };

  useEffect(() => {
    const onMessage = (event) => {
      if (event.origin !== STOREFRONT_ORIGIN || event.source !== frameRef.current?.contentWindow) return;
      const d = event.data;
      if (!d || d.source !== 'corcotton-preview') return;
      if (d.type === 'ready') {
        setReady(true);
        setFailed(false);
        // The storefront (re)loaded: it has nothing until it is told.
        post(messageRef.current);
      } else if (d.type === 'ui') {
        onUiRef.current?.(d.ui || {});
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (ready) return undefined;
    const t = setTimeout(() => setFailed(true), READY_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [ready, reloadKey]);

  useEffect(() => { if (ready) post(messageRef.current); }, [ready, messageKey]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const width = PREVIEW_DEVICES[device]?.width ?? PREVIEW_DEVICES.desktop.width;
  const scale = stageWidth ? Math.min(1, stageWidth / width) : 1;

  const reload = () => { setReady(false); setFailed(false); setReloadKey((k) => k + 1); };

  return (
    <div className="live-preview">
      <div className="live-preview__bar">
        <div className="live-preview__heading">
          <span className="live-preview__title">{title}</span>
          <span className="live-preview__badge">Unsaved edits included · not live</span>
        </div>
        <div className="live-preview__tools">
          <div className="live-preview__devices" role="group" aria-label="Preview size">
            {devices.map((k) => (
              <button key={k} type="button" aria-pressed={device === k}
                className={`live-preview__device${device === k ? ' live-preview__device--active' : ''}`}
                onClick={() => onDeviceChange?.(k)}>
                <DeviceIcon kind={k} />
                <span>{PREVIEW_DEVICES[k].label}</span>
              </button>
            ))}
          </div>
          <button type="button" className="live-preview__reload" onClick={reload} aria-label="Reload preview" title="Reload preview">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></svg>
          </button>
        </div>
      </div>

      <div ref={stageRef} className="live-preview__stage" style={{ height }}>
        <div className="live-preview__viewport" style={{ width: width * scale, height }}>
          <iframe
            key={reloadKey}
            ref={frameRef}
            title={`${title} (${PREVIEW_DEVICES[device]?.label})`}
            src={`${STOREFRONT}/__cms-preview`}
            // Scripts + its own origin (it calls the public API); no top
            // navigation, popups or form posts out of the preview.
            sandbox="allow-scripts allow-same-origin"
            className="live-preview__frame"
            style={{ width, height: height / scale, transform: `scale(${scale})` }}
          />
        </div>
        {!ready && !failed && <div className="live-preview__overlay" role="status">Loading the storefront preview…</div>}
        {failed && (
          <div className="live-preview__overlay live-preview__overlay--error" role="alert">
            <p>The storefront preview did not respond.</p>
            <p className="live-preview__hint">Expected it at <code>{STOREFRONT}/__cms-preview</code>. Check that the storefront is running and allows this CMS (VITE_CMS_URL).</p>
            <button type="button" className="live-preview__retry" onClick={reload}>Try again</button>
          </div>
        )}
      </div>
    </div>
  );
}
