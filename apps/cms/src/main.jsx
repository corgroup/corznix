import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App.jsx';
// Global stylesheets, in cascade order. Everything else is co-located
// with its component (Sidebar.css, MetricCard.css, …).
import './styles/tokens.css';
import './styles/base.css';
import './styles/controls.css';
import './styles/legacy.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
