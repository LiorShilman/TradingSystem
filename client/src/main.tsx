import '@fontsource-variable/heebo';
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ActiveAccountProvider } from './lib/activeAccount';
import { AuthProvider, useAuth } from './lib/auth';
import { AccountPage } from './pages/AccountPage';
import { AccountsPage } from './pages/AccountsPage';
import { AlertsPage } from './pages/AlertsPage';
import { AssetPage } from './pages/AssetPage';
import { AssetsPage } from './pages/AssetsPage';
import { IdeaPage } from './pages/IdeaPage';
import { IdeasPage } from './pages/IdeasPage';
import { LoginPage } from './pages/LoginPage';
import { NewPlanPage } from './pages/NewPlanPage';
import { PlanPage } from './pages/PlanPage';
import { PlansPage } from './pages/PlansPage';
import { SettingsPage } from './pages/SettingsPage';
import { TradePage } from './pages/TradePage';
import { TradesPage } from './pages/TradesPage';

function App() {
  const { loggedIn } = useAuth();
  if (!loggedIn) return <LoginPage />;
  return (
    <ActiveAccountProvider>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/plans" replace />} />
        <Route path="plans" element={<PlansPage />} />
        <Route path="plans/new" element={<NewPlanPage />} />
        <Route path="plans/:id" element={<PlanPage />} />
        <Route path="trades" element={<TradesPage />} />
        <Route path="trades/:id" element={<TradePage />} />
        <Route path="ideas" element={<IdeasPage />} />
        <Route path="ideas/:id" element={<IdeaPage />} />
        <Route path="assets" element={<AssetsPage />} />
        <Route path="assets/:symbol" element={<AssetPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="accounts/:id" element={<AccountPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/plans" replace />} />
      </Route>
    </Routes>
    </ActiveAccountProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
