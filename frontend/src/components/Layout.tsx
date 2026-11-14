import React, { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Cpu,
  LogOut,
  Menu,
  Moon,
  Radio,
  Sun,
  X,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useSocket } from '../context/SocketContext';
import { RoleBadge } from './Badges';

const NAV_ITEMS = [
  { to: '/', label: 'Live Overview', icon: Activity, end: true },
  { to: '/alerts', label: 'Alerts', icon: AlertTriangle, end: false },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, end: false },
  { to: '/model-health', label: 'Model Health', icon: Cpu, end: false },
];

export const Layout: React.FC = () => {
  const { user, logout, canMutate } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { connected } = useSocket();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 scada-grid-bg">
      <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          {/* Brand + Nav */}
          <div className="flex items-center gap-6">
            <NavLink to="/" className="flex items-center gap-2.5 group">
              <div className="h-9 w-9 rounded-lg bg-cyan-500/15 border border-cyan-500/40 flex items-center justify-center text-cyan-500">
                <Zap className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <div className="font-semibold tracking-tight text-base leading-none">GridSense</div>
                <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 tracking-wider uppercase mt-0.5">
                  SCADA Telemetry
                </div>
              </div>
            </NavLink>

            <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-1">
              {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    clsx(
                      'inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70',
                    )
                  }
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>

          {/* Status + Role + Controls */}
          <div className="flex items-center gap-3">
            <div
              className={clsx(
                'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border',
                connected
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                  : 'bg-slate-500/10 text-slate-500 dark:text-slate-400 border-slate-500/30',
              )}
              title={connected ? 'Real-time Socket.IO stream active' : 'Stream disconnected'}
            >
              <Radio className={clsx('h-3.5 w-3.5', connected && 'animate-pulse')} aria-hidden="true" />
              {connected ? 'LIVE' : 'OFFLINE'}
            </div>

            {user && (
              <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700">
                <span className="text-xs text-slate-700 dark:text-slate-200 font-medium truncate max-w-[140px]">
                  {user.email}
                </span>
                <RoleBadge role={user.role} />
                {!canMutate && (
                  <span className="text-[10px] font-mono uppercase text-slate-500 dark:text-slate-400">
                    (Read-Only)
                  </span>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle dark mode"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500"
            >
              {theme === 'dark' ? (
                <Sun className="h-4 w-4 text-amber-400" aria-hidden="true" />
              ) : (
                <Moon className="h-4 w-4 text-slate-700" aria-hidden="true" />
              )}
            </button>

            <button
              type="button"
              onClick={logout}
              aria-label="Sign out"
              className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-500/30 transition-colors"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              Sign out
            </button>

            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label="Toggle navigation menu"
              aria-expanded={mobileMenuOpen}
              className="md:hidden p-2 rounded-lg border border-slate-200 dark:border-slate-700"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile navigation drawer */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-slate-200 dark:border-slate-800 px-4 py-3 space-y-1 bg-white dark:bg-slate-900">
            {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => setMobileMenuOpen(false)}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium',
                    isActive
                      ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300'
                      : 'text-slate-600 dark:text-slate-300',
                  )
                }
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
              </NavLink>
            ))}
            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
              {user && (
                <div className="flex items-center gap-2 text-xs">
                  <span>{user.email}</span>
                  <RoleBadge role={user.role} />
                </div>
              )}
              <button
                type="button"
                onClick={logout}
                className="text-xs text-rose-500 font-medium px-2 py-1"
              >
                Sign out
              </button>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
};
