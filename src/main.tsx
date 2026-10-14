import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// Handle dynamic chunk load failures (common when app is updated while mobile browser is open)
window.addEventListener('unhandledrejection', (event) => {
  const error = event?.reason;
  const errorMsg = error?.message || String(error);
  if (
    /Loading chunk .* failed/i.test(errorMsg) ||
    /Failed to fetch dynamically imported module/i.test(errorMsg)
  ) {
    const hasReloaded = sessionStorage.getItem('chunk_load_auto_reloaded');
    if (!hasReloaded) {
      sessionStorage.setItem('chunk_load_auto_reloaded', 'true');
      console.warn('[Global] New version detected or chunk load failed, auto-reloading...');
      window.location.reload();
    }
  }
});

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
