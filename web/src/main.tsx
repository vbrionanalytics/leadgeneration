import { StrictMode, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { AuthProvider, useAuth } from './lib/auth';
import Layout from './components/Layout';
import { Loading } from './components/ui';
import { LoginPage, RegisterPage } from './pages/Auth';
import Dashboard from './pages/Dashboard';
import SearchPage from './pages/Search';
import LeadsPage from './pages/Leads';
import LeadDetail from './pages/LeadDetail';
import Outreach from './pages/Outreach';
import Campaigns from './pages/Campaigns';
import Marketplace from './pages/Marketplace';
import Billing from './pages/Billing';
import SettingsPage from './pages/Settings';
import Admin from './pages/Admin';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 } } });

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  return user ? <>{children}</> : <Navigate to="/login" replace />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route element={<Protected><Layout /></Protected>}>
              <Route index element={<Dashboard />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="leads" element={<LeadsPage />} />
              <Route path="leads/:id" element={<LeadDetail />} />
              <Route path="outreach" element={<Outreach />} />
              <Route path="campaigns" element={<Campaigns />} />
              <Route path="marketplace" element={<Marketplace />} />
              <Route path="billing" element={<Billing />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="admin" element={<Admin />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>
);
