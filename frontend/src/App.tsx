import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { SocketProvider } from './context/SocketContext';
import { TelemetryProvider } from './context/TelemetryContext';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { ControlRoomPage } from './pages/ControlRoomPage';
import { MeterDetailPage } from './pages/MeterDetailPage';
import { AlertsPage } from './pages/AlertsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { ModelHealthPage } from './pages/ModelHealthPage';
import type { Alert, User } from './types';

const RequireConsoleAccess: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token, offlineDemoMode } = useAuth();
  if (!token && !offlineDemoMode) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
};

export const AppRoutes: React.FC = () => (
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route
      path="/"
      element={
        <RequireConsoleAccess>
          <AppShell />
        </RequireConsoleAccess>
      }
    >
      <Route index element={<ControlRoomPage />} />
      <Route path="meters/:meterId" element={<MeterDetailPage />} />
      <Route path="alerts" element={<AlertsPage />} />
      <Route path="analytics" element={<AnalyticsPage />} />
      <Route path="model-health" element={<ModelHealthPage />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
);

export const AppProviders: React.FC<{
  children: React.ReactNode;
  initialAlerts?: Alert[];
  initialOfflineDemo?: boolean;
  initialUser?: User | null;
  initialToken?: string | null;
}> = ({
  children,
  initialAlerts,
  initialOfflineDemo = false,
  initialUser = null,
  initialToken = null,
}) => (
  <ThemeProvider>
    <AuthProvider
      initialOfflineDemo={initialOfflineDemo}
      initialUser={initialUser}
      initialToken={initialToken}
    >
      <SocketProvider>
        <TelemetryProvider initialAlerts={initialAlerts}>{children}</TelemetryProvider>
      </SocketProvider>
    </AuthProvider>
  </ThemeProvider>
);

export function App() {
  return (
    <AppProviders>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProviders>
  );
}

export default App;
