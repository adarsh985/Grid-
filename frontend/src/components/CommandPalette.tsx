import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command, CornerDownLeft, Search, X } from 'lucide-react';
import clsx from 'clsx';
import { useTelemetry } from '../context/TelemetryContext';
import { useTheme } from '../context/ThemeContext';
import { formatFaultLabel } from '../utils/format';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

interface CommandItem {
  id: string;
  group: 'ACTIONS' | 'NAVIGATION' | 'METERS' | 'ALERTS';
  label: string;
  sublabel: string;
  badge?: string;
  isAlert?: boolean;
  action: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ open, onClose }) => {
  const navigate = useNavigate();
  const { toggleTheme, theme } = useTheme();
  const {
    meters,
    alerts,
    selectedAlertId,
    acknowledgeAlert,
    closeAlert,
    triggerSimulatedFault,
  } = useTelemetry();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const items = useMemo<CommandItem[]>(() => {
    const selectedAlert =
      alerts.find((a) => a.id === selectedAlertId) ??
      alerts.find((a) => a.status === 'open') ??
      alerts[0];

    const list: CommandItem[] = [
      {
        id: 'nav-control-room',
        group: 'NAVIGATION',
        label: 'Go to Control Room',
        sublabel: 'Single-line schematic grid map + live alert feed',
        badge: 'PAGE',
        action: () => navigate('/'),
      },
      {
        id: 'nav-alerts',
        group: 'NAVIGATION',
        label: 'Go to Alerts Console',
        sublabel: 'Incident triage table with keyboard shortcuts (J/K/A/C)',
        badge: 'PAGE',
        action: () => navigate('/alerts'),
      },
      {
        id: 'nav-analytics',
        group: 'NAVIGATION',
        label: 'Go to Grid Analytics',
        sublabel: '24x7 fault heatmap, weekly kWh loss & fault breakdown',
        badge: 'PAGE',
        action: () => navigate('/analytics'),
      },
      {
        id: 'nav-model-health',
        group: 'NAVIGATION',
        label: 'Go to Model Health & Drift',
        sublabel: 'Segmented PSI drift gauge & precision/recall matrix',
        badge: 'PAGE',
        action: () => navigate('/model-health'),
      },
      {
        id: 'act-ack-selected',
        group: 'ACTIONS',
        label: selectedAlert
          ? `Acknowledge Alert #${selectedAlert.id} (${selectedAlert.meter_id})`
          : 'Acknowledge Selected Alert',
        sublabel: 'Mark active incident as acknowledged by operator',
        badge: 'ACTION',
        action: () => {
          if (selectedAlert) void acknowledgeAlert(selectedAlert.id);
        },
      },
      {
        id: 'act-close-selected',
        group: 'ACTIONS',
        label: selectedAlert
          ? `Close Alert #${selectedAlert.id} (${selectedAlert.meter_id})`
          : 'Close Selected Alert',
        sublabel: 'Resolve and archive selected incident',
        badge: 'ACTION',
        action: () => {
          if (selectedAlert) void closeAlert(selectedAlert.id);
        },
      },
      {
        id: 'act-sim-theft',
        group: 'ACTIONS',
        label: 'Inject Simulated Power Theft on MTR-0104',
        sublabel: 'Drop 3-phase current 50% at nominal bus voltage',
        badge: 'SIM',
        isAlert: true,
        action: () => triggerSimulatedFault('MTR-0104', 'power_theft'),
      },
      {
        id: 'act-theme',
        group: 'ACTIONS',
        label: `Switch to ${theme === 'dark' ? 'Light' : 'Dark'} HMI Theme`,
        sublabel: 'Toggle high-contrast control room appearance',
        badge: 'UI',
        action: () => toggleTheme(),
      },
    ];

    for (const m of meters) {
      const hasAlert = m.open_alerts.length > 0;
      list.push({
        id: `meter-${m.id}`,
        group: 'METERS',
        label: `Inspect Meter ${m.id}`,
        sublabel: m.location || '3-Phase Distribution Node',
        badge: hasAlert ? m.open_alerts[0].type.toUpperCase() : 'NOMINAL',
        isAlert: hasAlert,
        action: () => navigate(`/meters/${encodeURIComponent(m.id)}`),
      });
    }

    for (const a of alerts.slice(0, 8)) {
      list.push({
        id: `alert-${a.id}`,
        group: 'ALERTS',
        label: `Alert #${a.id} · ${a.meter_id} · ${formatFaultLabel(a.type)}`,
        sublabel: `Status: ${a.status.toUpperCase()} · Score: ${a.score.toFixed(2)}`,
        badge: a.severity.toUpperCase(),
        isAlert: a.status !== 'closed',
        action: () => navigate(`/meters/${encodeURIComponent(a.meter_id)}`),
      });
    }

    return list;
  }, [
    alerts,
    meters,
    selectedAlertId,
    theme,
    navigate,
    acknowledgeAlert,
    closeAlert,
    triggerSimulatedFault,
    toggleTheme,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.sublabel.toLowerCase().includes(q) ||
        item.group.toLowerCase().includes(q),
    );
  }, [items, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  const executeItem = (item: CommandItem | undefined) => {
    if (!item) return;
    item.action();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (filtered.length > 0 ? (prev + 1) % filtered.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) =>
        filtered.length > 0 ? (prev - 1 + filtered.length) % filtered.length : 0,
      );
    } else if (e.key === 'Enter' && filtered[activeIndex]) {
      e.preventDefault();
      executeItem(filtered[activeIndex]);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4 bg-black/75 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE] dark:bg-[#0C1017] text-[#11141C] dark:text-[#E6E9EF] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header Input */}
        <div className="flex items-center gap-3 px-3.5 py-3 border-b border-[#C8CDD6] dark:border-[#1E2633]">
          <Command className="h-4 w-4 text-[#F59E0B] shrink-0" aria-hidden="true" />
          <Search className="h-4 w-4 text-[#7D899C] shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            aria-label="Search commands, meters, or alerts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a meter ID (MTR-0104), page, or action (Acknowledge, Close)..."
            className="w-full bg-transparent text-sm font-mono focus:outline-none placeholder:text-[#7D899C]"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close command palette"
            className="p-1 text-[#7D899C] hover:text-[#F59E0B]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Results List */}
        <div
          role="listbox"
          aria-label="Command results"
          className="max-h-96 overflow-y-auto divide-y divide-[#C8CDD6]/50 dark:divide-[#1E2633]"
        >
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs font-mono text-[#7D899C]">
              NO MATCHING TELEMETRY NODE OR COMMAND FOR &ldquo;{query}&rdquo;
            </div>
          ) : (
            filtered.map((item, idx) => {
              const isSelected = idx === activeIndex;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => executeItem(item)}
                  className={clsx(
                    'w-full px-4 py-2.5 text-left flex items-center justify-between gap-4 transition-colors',
                    isSelected
                      ? 'bg-[#F59E0B]/15 border-l-2 border-l-[#F59E0B]'
                      : 'hover:bg-[#121822]/40',
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono uppercase tracking-wider text-[#7D899C]">
                        [{item.group}]
                      </span>
                      <span className="text-sm font-medium truncate">{item.label}</span>
                    </div>
                    <div className="text-xs font-mono text-[#7D899C] truncate mt-0.5">
                      {item.sublabel}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {item.badge && (
                      <span
                        className={clsx(
                          'px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase border',
                          item.isAlert
                            ? 'border-[#FF4D2D]/50 text-[#FF4D2D] bg-[#FF4D2D]/10'
                            : 'border-[#7D899C]/40 text-[#7D899C]',
                        )}
                      >
                        {item.badge}
                      </span>
                    )}
                    <CornerDownLeft className="h-3.5 w-3.5 text-[#7D899C]" aria-hidden="true" />
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Footer Hints */}
        <div className="px-4 py-2 border-t border-[#C8CDD6] dark:border-[#1E2633] bg-[#E7E9E2] dark:bg-[#07090D] flex items-center justify-between text-[11px] font-mono text-[#7D899C]">
          <span>↑↓ NAVIGATE · ENTER EXECUTE · ESC DISMISS</span>
          <span>{filtered.length} COMMANDS READY</span>
        </div>
      </div>
    </div>
  );
};
