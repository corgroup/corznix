export function LoadingState({ label = 'Loading…', fullscreen = false }) {
  return (
    <div className={fullscreen ? 'state state--fullscreen' : 'state'} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export default LoadingState;
