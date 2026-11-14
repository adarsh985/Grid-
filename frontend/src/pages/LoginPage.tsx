import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Lock, Mail, Moon, Radio, Sun } from 'lucide-react';
import { ApiError } from '../api';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

const DEMO_ACCOUNTS = [
  { label: 'Operator', email: 'operator@gridsense.local', password: 'ChangeMe123!', role: 'operator' },
  { label: 'Admin', email: 'admin@gridsense.local', password: 'ChangeMe123!', role: 'admin' },
  { label: 'Viewer', email: 'viewer@gridsense.local', password: 'ChangeMe123!', role: 'viewer' },
];

export const LoginPage: React.FC = () => {
  const { login, enterOfflineDemo } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const [email, setEmail] = useState('operator@gridsense.local');
  const [password, setPassword] = useState('ChangeMe123!');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) {
        setError(err.message);
      } else {
        setError(
          'Backend unreachable. Start the backend service (docker compose up) or click "Offline Mock Fallback (No Backend)" below.',
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const handleOfflineDemo = () => {
    enterOfflineDemo();
    navigate('/', { replace: true });
  };

  return (
    <div className="min-h-screen flex flex-col justify-center items-center px-4 py-10 hmi-grid-bg text-[#11141C] dark:text-[#E6E9EF] relative">
      <button
        type="button"
        onClick={toggleTheme}
        aria-label="Toggle dark mode"
        className="absolute top-5 right-5 p-2.5 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] hover:border-[#F59E0B]"
      >
        {theme === 'dark' ? (
          <Sun className="h-4 w-4 text-[#F59E0B]" aria-hidden="true" />
        ) : (
          <Moon className="h-4 w-4 text-[#11141C]" aria-hidden="true" />
        )}
      </button>

      <div className="w-full max-w-md border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-6 sm:p-7">
        <div className="flex items-center gap-3 pb-4 mb-5 border-b border-[#C8CDD6] dark:border-[#1E2633]">
          <span
            aria-hidden="true"
            className="inline-block h-4 w-4 bg-[#F59E0B] border border-[#F59E0B] shadow-[0_0_10px_rgba(245,158,11,0.55)]"
          />
          <div>
            <h1 className="font-display font-bold tracking-wider text-base uppercase">
              GRIDSENSE // OPERATOR AUTH
            </h1>
            <p className="font-mono text-[10px] uppercase tracking-widest text-[#576070] dark:text-[#7D899C]">
              Substation Fault &amp; Power-Theft HMI
            </p>
          </div>
        </div>

        <div className="mb-4 px-3 py-2 border border-[#00E5FF]/40 bg-[#00E5FF]/10 font-mono text-[11px] text-[#00E5FF]">
          JWT session token is held in memory only (never stored in localStorage).
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 flex items-center gap-2 border border-[#FF4D2D] bg-[#FF4D2D]/10 px-3 py-2 text-xs font-mono text-[#FF4D2D]"
          >
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block font-mono text-[10px] font-bold uppercase tracking-wider text-[#576070] dark:text-[#7D899C] mb-1"
            >
              Operator Email
            </label>
            <div className="relative">
              <Mail
                className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#7D899C]"
                aria-hidden="true"
              />
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="operator@gridsense.local"
                className="w-full pl-9 pr-3 py-2 font-mono text-xs border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE] dark:bg-[#07090D] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="password"
              className="block font-mono text-[10px] font-bold uppercase tracking-wider text-[#576070] dark:text-[#7D899C] mb-1"
            >
              Password
            </label>
            <div className="relative">
              <Lock
                className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#7D899C]"
                aria-hidden="true"
              />
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full pl-9 pr-3 py-2 font-mono text-xs border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE] dark:bg-[#07090D] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 font-mono text-xs font-bold uppercase tracking-wider border border-[#F59E0B] bg-[#F59E0B]/20 hover:bg-[#F59E0B]/30 text-[#F59E0B] disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
          >
            {loading ? 'AUTHENTICATING...' : 'SIGN IN TO LIVE CONSOLE'}
          </button>
        </form>

        <div className="mt-5 pt-4 border-t border-[#C8CDD6] dark:border-[#1E2633]">
          <p className="font-mono text-[10px] uppercase tracking-wider text-[#576070] dark:text-[#7D899C] mb-2">
            Seeded Demo Accounts (ChangeMe123!)
          </p>
          <div className="grid grid-cols-3 gap-2">
            {DEMO_ACCOUNTS.map((acc) => (
              <button
                key={acc.label}
                type="button"
                onClick={() => {
                  setEmail(acc.email);
                  setPassword(acc.password);
                }}
                className="px-2 py-1.5 font-mono text-[11px] uppercase border border-[#C8CDD6] dark:border-[#1E2633] hover:border-[#F59E0B] hover:text-[#F59E0B] transition-colors"
              >
                {acc.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-[#C8CDD6] dark:border-[#1E2633]">
          <button
            type="button"
            onClick={handleOfflineDemo}
            className="w-full py-2 px-3 font-mono text-[11px] uppercase border border-[#C8CDD6] dark:border-[#1E2633] text-[#576070] dark:text-[#7D899C] hover:border-[#00E5FF] hover:text-[#00E5FF] inline-flex items-center justify-center gap-2 transition-colors"
          >
            <Radio className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Offline Mock Fallback (No Backend)</span>
          </button>
        </div>
      </div>
    </div>
  );
};
