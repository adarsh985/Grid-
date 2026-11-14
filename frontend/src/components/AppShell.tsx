import React, { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LayoutGroup } from 'framer-motion';
import { Command, LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import clsx from 'clsx';
import { BootSequence } from './BootSequence';
import { CommandPalette } from './CommandPalette';
import { FpsOverlay } from './FpsOverlay';
import { LiveValue } from './LiveValue';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useTelemetry } from '../context/TelemetryContext';
import { useTheme } from '../context/ThemeContext';
import { TOKENS } from '../design/tokens';

const NAV_LINKS = [
  { to: '/', label: '01 // CONTROL ROOM', end: true },
  { to: '/alerts', label: '02 // ALERTS', end: false },
  { to: '/analytics', label: '03 // ANALYTICS', end: false },
  { to: '/model-health', label: '04 // MODEL HEALTH', end: false },
];

export const AppShell: React.FC = () => {
  const { user, token, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { connected } = useSocket();
  const {
    openAlertsCount,
    energyLossTodayKwh,
    isMockMode,
    setIsMockMode,
    lastHeartbeat,
  } = useTelemetry();

  const isLiveStream = Boolean(token && connected && !isMockMode);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Global Cmd/Ctrl+K keyboard shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="relative min-h-screen w-full overflow-x-hidden flex flex-col hmi-grid-bg text-[#11141C] dark:text-[#E6E9EF]">
      {/* Subtle CRT Edge Vignette */}
      <div
        aria-hidden="true"
        style={{
          background: `radial-gradient(ellipse at center, transparent 58%, ${TOKENS.colors.dark.bg} 100%)`,
        }}
        className="pointer-events-none fixed inset-0 z-10 opacity-75 dark:block hidden hmi-vignette"
      />

      {/* Film Grain Overlay (SVG fractalNoise, opacity 0.04, stays below z-20 Oscilloscope canvas) */}
      <svg
        data-testid="hmi-grain-overlay"
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-10 w-full h-full opacity-[0.04]"
      >
        <filter id="hmi-noise-filter">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.82"
            numOctaves="3"
            stitchTiles="stitch"
          />
        </filter>
        <rect width="100%" height="100%" filter="url(#hmi-noise-filter)" />
      </svg>

      {/* Once-per-session 1.8s HMI Power-Up Boot Sequence */}
      <BootSequence />

      {/* Top Industrial HMI Header Bar */}
      <header className="sticky top-0 z-30 border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF]/95 dark:bg-[#0C1017]/95 backdrop-blur-sm">
        <div className="flex items-stretch justify-between min-h-[48px] divide-x divide-[#C8CDD6] dark:divide-[#1E2633]">
          {/* Brand Station ID */}
          <div className="px-3.5 py-2 flex items-center gap-3 shrink-0">
            <NavLink to="/" className="flex items-center gap-2.5 focus:outline-none">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 bg-[#F59E0B] border border-[#F59E0B] shadow-[0_0_8px_rgba(245,158,11,0.65)]"
              />
              <div>
                <div className="font-display font-bold tracking-wider text-sm leading-none uppercase">
                  GRIDSENSE
                </div>
                <div className="font-mono text-[10px] text-[#7D899C] tracking-widest mt-0.5">
                  SUB-HMI // 50Hz
                </div>
              </div>
            </NavLink>
          </div>

          {/* Primary Console Navigation */}
          <nav
            aria-label="Primary console navigation"
            className="hidden lg:flex items-stretch divide-x divide-[#C8CDD6] dark:divide-[#1E2633]"
          >
            {NAV_LINKS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  clsx(
                    'px-3.5 flex items-center text-xs font-mono tracking-wider uppercase transition-colors focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[#F59E0B]',
                    isActive
                      ? 'bg-[#F59E0B]/15 text-[#F59E0B] font-semibold border-b-2 border-b-[#F59E0B]'
                      : 'text-[#576070] dark:text-[#7D899C] hover:text-[#11141C] dark:hover:text-[#E6E9EF] hover:bg-[#121822]/40',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* Spacer */}
          <div className="flex-1 hidden xl:block" />

          {/* Live Header Counters: Open Alerts, Energy Loss Today, Stream Heartbeat */}
          <div className="hidden sm:flex items-stretch divide-x divide-[#C8CDD6] dark:divide-[#1E2633] font-mono text-xs">
            {/* 1. Open Alerts Counter */}
            <NavLink
              to="/alerts"
              aria-label={`Open alerts: ${openAlertsCount}`}
              className="px-3 flex items-center gap-2 hover:bg-[#FF4D2D]/10 transition-colors"
            >
              <span className="text-[10px] uppercase text-[#7D899C]">OPEN ALERTS</span>
              <span
                className={clsx(
                  'px-1.5 py-0.5 text-xs font-bold tabular-nums border',
                  openAlertsCount > 0
                    ? 'border-[#FF4D2D] text-[#FF4D2D] bg-[#FF4D2D]/15'
                    : 'border-[#7D899C]/40 text-[#7D899C]',
                )}
              >
                ▲ {openAlertsCount}
              </span>
            </NavLink>

            {/* 2. Estimated Energy Loss Today (Animated Number Roll) */}
            <div className="px-3 flex items-center gap-2">
              <span className="text-[10px] uppercase text-[#7D899C]">LOSS TODAY</span>
              <LiveValue
                value={energyLossTodayKwh}
                decimals={2}
                unit="kWh"
                flashOnChange
                ariaLabel={`Estimated energy loss today: ${energyLossTodayKwh.toFixed(2)} kWh`}
                className="font-bold text-[#FF4D2D]"
              />
            </div>

            {/* 3. Connection & Heartbeat Indicator: explicitly LIVE or MOCK */}
            <button
              type="button"
              data-testid="stream-status-badge"
              onClick={() => {
                if (token && connected) setIsMockMode(!isMockMode);
              }}
              aria-label={`Telemetry stream status: ${isLiveStream ? 'LIVE' : 'MOCK'}`}
              title={
                isLiveStream
                  ? 'Connected to Backend Socket.IO live telemetry stream (click to preview mock stream)'
                  : 'Running simulated fallback stream (backend/Socket.IO offline)'
              }
              className="px-3 flex items-center gap-2 hover:bg-[#F59E0B]/10 transition-colors"
            >
              <span
                key={lastHeartbeat}
                aria-hidden="true"
                className={clsx(
                  'h-2 w-2 rounded-full animate-ping',
                  isLiveStream ? 'bg-[#00E5FF]' : 'bg-[#F59E0B]',
                )}
              />
              <span
                className={clsx(
                  'text-[11px] font-bold tracking-wider uppercase',
                  isLiveStream ? 'text-[#00E5FF]' : 'text-[#F59E0B]',
                )}
              >
                {isLiveStream ? 'LIVE' : 'MOCK'}
              </span>
            </button>
          </div>

          {/* Command Palette Trigger + Mobile Stream Pill + Theme + User */}
          <div className="flex items-stretch divide-x divide-[#C8CDD6] dark:divide-[#1E2633]">
            <div className="sm:hidden px-2 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase">
              <span
                aria-hidden="true"
                className={clsx(
                  'h-1.5 w-1.5 rounded-full',
                  isLiveStream ? 'bg-[#00E5FF]' : 'bg-[#F59E0B]',
                )}
              />
              <span className={isLiveStream ? 'text-[#00E5FF]' : 'text-[#F59E0B]'}>
                {isLiveStream ? 'LIVE' : 'MOCK'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              className="px-3 flex items-center gap-2 text-xs font-mono text-[#7D899C] hover:text-[#F59E0B] hover:bg-[#F59E0B]/10 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[#F59E0B]"
            >
              <Command className="h-3.5 w-3.5 text-[#F59E0B]" aria-hidden="true" />
              <span className="hidden md:inline">CMD+K</span>
            </button>

            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle dark mode"
              className="px-3 flex items-center justify-center hover:bg-[#F59E0B]/10 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[#F59E0B]"
            >
              {theme === 'dark' ? (
                <Sun className="h-4 w-4 text-[#F59E0B]" aria-hidden="true" />
              ) : (
                <Moon className="h-4 w-4 text-[#11141C]" aria-hidden="true" />
              )}
            </button>

            {user && (
              <div className="hidden md:flex items-center gap-2 px-3 text-[11px] font-mono">
                <span className="uppercase font-semibold text-[#F59E0B]">
                  [{user.role}]
                </span>
                <button
                  type="button"
                  onClick={logout}
                  aria-label="Sign out"
                  className="text-[#7D899C] hover:text-[#FF4D2D] inline-flex items-center gap-1"
                >
                  <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => setMobileNavOpen((v) => !v)}
              aria-label="Toggle navigation menu"
              className="lg:hidden px-3 flex items-center"
            >
              {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Mobile Drawer */}
        {mobileNavOpen && (
          <div className="lg:hidden border-t border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] divide-y divide-[#C8CDD6] dark:divide-[#1E2633] font-mono text-xs">
            {NAV_LINKS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setMobileNavOpen(false)}
                className="block px-4 py-2.5 uppercase hover:bg-[#F59E0B]/15"
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        )}
      </header>

      {/* Main Console Workspace wrapped in LayoutGroup for Shared-Element Navigation */}
      <main className="flex-1 flex flex-col">
        <LayoutGroup>
          <Outlet />
        </LayoutGroup>
      </main>

      {/* Dev / Demo FPS & Queue Telemetry Overlay (Shift+F or ?fps=1) */}
      <FpsOverlay />

      {/* Keyboard-First Command Palette Modal */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
};
