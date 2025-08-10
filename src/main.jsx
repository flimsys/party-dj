import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';

// Simple error boundary to show runtime errors
class ErrorBoundary extends React.Component {
  constructor(p){ super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error){ return { error }; }
  componentDidCatch(error, info){ console.error('Runtime error:', error, info); }
  render(){
    if (this.state.error) {
      return (
        <div style={{padding:16, background:'#fee2e2', color:'#991b1b', fontFamily:'system-ui'}}>
          <h2 style={{marginTop:0}}>Something went wrong</h2>
          <div style={{whiteSpace:'pre-wrap'}}>{String(this.state.error?.message || this.state.error)}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// -------------------------------
// Service worker: auto-update + banner
// -------------------------------
if ('serviceWorker' in navigator) {
  let reloading = false;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // 1) Auto-check on launch
      reg.update().catch(() => {});

      // 2) If a new worker is already waiting at startup → apply immediately
      if (reg.waiting) {
        // Store reference for banner (in case you want to show it instead)
        window.__pdjSWWaiting = reg.waiting;
        // Auto-apply on launch
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }

      // 3) If a fresh update arrives while the app is running, show banner
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            // New version ready (but not active yet). Save & notify the app.
            window.__pdjSWWaiting = reg.waiting || sw; // waiting usually
            window.dispatchEvent(new Event('pdj-sw-update-ready'));
          }
        });
      });

      // 4) When the new SW takes control → reload once
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });

      // Optional: periodic background check (every 15 minutes)
      setInterval(() => reg.update().catch(() => {}), 15 * 60 * 1000);
    }).catch(() => {});
  });
}
