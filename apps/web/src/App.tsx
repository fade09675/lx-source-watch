import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { AboutPage } from './pages/About';
import { AdminPage } from './pages/Admin';
import { CandidatesPage } from './pages/Candidates';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { SourceDetailPage } from './pages/SourceDetail';

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="boot">
        <span className="spinner" /> 正在验证登录状态…
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
            <Route path="/" element={<OverviewPage />} />
            <Route path="/s/:id" element={<SourceDetailPage />} />
            <Route path="/candidates" element={<CandidatesPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/about" element={<AboutPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
