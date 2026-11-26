import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { ThemeProvider } from './theme';
import { AboutPage } from './pages/About';
import { CandidatesPage } from './pages/Candidates';
import { DuplicatesPage } from './pages/Duplicates';
import { LoginPage } from './pages/Login';
import { ManageSourcesPage } from './pages/ManageSources';
import { NotFoundPage } from './pages/NotFound';
import { OverviewPage } from './pages/Overview';
import { ProxiesPage } from './pages/Proxies';
import { ProxyTestsPage } from './pages/ProxyTests';
import { RunDetailPage } from './pages/RunDetail';
import { RunsPage } from './pages/Runs';
import { SettingsPage } from './pages/Settings';
import { SourceDetailPage } from './pages/SourceDetail';
import { WorkbenchPage } from './pages/Workbench';

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="boot">
        <div className="boot-panel">
          <div className="boot-brand">
            <span className="brand-mark">LX</span>
            <strong>LX 音源监测</strong>
          </div>
          <div className="boot-skeleton" aria-hidden="true">
            <span className="boot-line w40" />
            <span className="boot-line w70" />
            <span className="boot-block" />
            <span className="boot-line w55" />
          </div>
          <p className="muted small">正在验证登录状态…</p>
        </div>
      </div>
    );
  }
  if (status === 'anon') {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <RequireAuth>
                  <Layout />
                </RequireAuth>
              }
            >
              <Route path="/" element={<WorkbenchPage />} />
              <Route path="/sources" element={<OverviewPage />} />
              <Route path="/s/:id" element={<SourceDetailPage />} />
              <Route path="/candidates" element={<CandidatesPage />} />
              <Route path="/admin/duplicates" element={<DuplicatesPage />} />
              <Route path="/runs" element={<RunsPage />} />
              <Route path="/runs/:runId" element={<RunDetailPage />} />
              <Route path="/admin" element={<Navigate to="/admin/settings" replace />} />
              <Route path="/admin/sources" element={<ManageSourcesPage />} />
              <Route path="/admin/settings" element={<SettingsPage />} />
              <Route path="/admin/proxies" element={<ProxiesPage />} />
              <Route path="/admin/proxy-tests" element={<ProxyTestsPage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
