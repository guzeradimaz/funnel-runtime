import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FunnelPage } from './funnel/FunnelPage';
import { AdminPage } from './admin/AdminPage';
import { DashboardPage } from './dashboard/DashboardPage';
import './styles.css';

// Three screens, so a pathname switch is enough; no router dependency.
function App() {
  const path = location.pathname.replace(/\/+$/, '');
  if (path === '/admin' || path === '/dashboard') {
    document.title = path === '/admin' ? 'Funnel versions' : 'Funnel analytics';
    return (
      <>
        <nav className="topnav">
          <a href="/admin" className={path === '/admin' ? 'current' : ''}>Версии</a>
          <a href="/dashboard" className={path === '/dashboard' ? 'current' : ''}>Аналитика</a>
          <a href="/" target="_blank" rel="noreferrer">Воронка ↗</a>
        </nav>
        {path === '/admin' ? <AdminPage /> : <DashboardPage />}
      </>
    );
  }
  return <FunnelPage />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
