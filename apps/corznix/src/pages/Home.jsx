import { useEffect, useState } from 'react';
import { apiClient } from '../services/apiClient.js';

export default function Home() {
  const [state, setState] = useState({ status: 'checking' });

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get('/api/v1/health')
      .then((data) => {
        if (!cancelled) setState({ status: 'ok', data });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: 'error', message: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="page">
      <h1>Corznix</h1>
      <p>Brand: {import.meta.env.VITE_BRAND_SLUG}</p>
      {state.status === 'checking' && <p className="health-status health-status--checking">Checking API connection…</p>}
      {state.status === 'error' && (
        <p className="health-status health-status--error">
          API unreachable at {import.meta.env.VITE_API_BASE_URL} — {state.message}
        </p>
      )}
      {state.status === 'ok' && (
        <p className="health-status health-status--ok">
          API connected — database: <strong>{state.data.db}</strong>
        </p>
      )}
    </main>
  );
}
