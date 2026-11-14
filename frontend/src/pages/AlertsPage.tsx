import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  HelpCircle,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { SeverityBadge, StatusBadge } from '../components/Badges';
import { DeviationBars } from '../components/DeviationBars';
import { LiveValue } from '../components/LiveValue';
import { useAuth } from '../context/AuthContext';
import { useTelemetry } from '../context/TelemetryContext';
import { TOKENS } from '../design/tokens';
import { getFeederForMeterId, SUBSTATION_FEEDERS } from '../mock/mockData';
import type { Alert, Reading } from '../types';
import { usePrefersReducedMotion } from '../utils/animationQueue';
import {
  formatDateTime,
  formatFaultLabel,
  formatTimeShort,
  getReadingTimestamp,
  parseExplanation,
} from '../utils/format';

export type AlertSortField = 'severity' | 'time' | 'score';
export type AlertSortDir = 'asc' | 'desc';

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const TYPE_OPTIONS = [
  { value: 'phase_imbalance', label: 'Phase Imbalance' },
  { value: 'power_theft', label: 'Power Theft' },
  { value: 'overcurrent', label: 'Overcurrent' },
  { value: 'voltage_sag', label: 'Voltage Sag' },
  { value: 'voltage_swell', label: 'Voltage Swell' },
  { value: 'harmonic_distortion', label: 'Harmonic Distortion' },
];

// Lightweight shared 1Hz clock so 200 live elapsed cells tick with 1 timer and zero table re-renders
const clockListeners = new Set<() => void>();
let clockInterval: number | null = null;
let clockSnapshot = Date.now();

function subscribeSharedClock(cb: () => void): () => void {
  clockListeners.add(cb);
  if (clockInterval === null && typeof window !== 'undefined') {
    clockSnapshot = Date.now();
    clockInterval = window.setInterval(() => {
      clockSnapshot = Date.now();
      clockListeners.forEach((fn) => fn());
    }, 1000);
  }
  return () => {
    clockListeners.delete(cb);
    if (clockListeners.size === 0 && clockInterval !== null) {
      window.clearInterval(clockInterval);
      clockInterval = null;
    }
  };
}

function getSharedClockSnapshot(): number {
  return clockSnapshot;
}

function formatElapsedDuration(detectedIso: string, nowMs: number): string {
  const detectedMs = Date.parse(detectedIso);
  if (Number.isNaN(detectedMs)) return '—';
  const diffSec = Math.max(0, Math.floor((nowMs - detectedMs) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return `${hrs}h ${String(remMins).padStart(2, '0')}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

const LiveElapsedTime: React.FC<{ detectedAt: string }> = React.memo(({ detectedAt }) => {
  const nowMs = useSyncExternalStore(
    subscribeSharedClock,
    getSharedClockSnapshot,
    getSharedClockSnapshot,
  );
  return (
    <time
      dateTime={detectedAt}
      title={formatDateTime(detectedAt)}
      className="font-mono text-xs tabular-nums text-[#576070] dark:text-[#7D899C]"
    >
      {formatElapsedDuration(detectedAt, nowMs)}
    </time>
  );
});

LiveElapsedTime.displayName = 'LiveElapsedTime';

function normalizeTypeParam(raw: string | null): string {
  const value = (raw || '').trim();
  if (!value) return '';
  if (value === 'overcurrent_spike') return 'overcurrent';
  return value;
}

function matchesTypeFilter(alertType: string, filterType: string): boolean {
  if (!filterType) return true;
  if (filterType === 'overcurrent' || filterType === 'overcurrent_spike') {
    return alertType === 'overcurrent' || alertType === 'overcurrent_spike';
  }
  return alertType === filterType;
}

function compareAlerts(
  a: Alert,
  b: Alert,
  sortField: AlertSortField,
  sortDir: AlertSortDir,
  liveTopOrder: Map<number, number>,
): number {
  const aLivePos = liveTopOrder.get(a.id);
  const bLivePos = liveTopOrder.get(b.id);
  if (aLivePos !== undefined || bLivePos !== undefined) {
    if (aLivePos !== undefined && bLivePos !== undefined) return aLivePos - bLivePos;
    return aLivePos !== undefined ? -1 : 1;
  }

  const mul = sortDir === 'asc' ? 1 : -1;
  if (sortField === 'severity') {
    const rA = SEVERITY_RANK[a.severity.toLowerCase()] ?? 0;
    const rB = SEVERITY_RANK[b.severity.toLowerCase()] ?? 0;
    if (rA !== rB) return (rA - rB) * mul;
    return Date.parse(b.detected_at) - Date.parse(a.detected_at);
  }
  if (sortField === 'score') {
    if (a.score !== b.score) return (a.score - b.score) * mul;
    return Date.parse(b.detected_at) - Date.parse(a.detected_at);
  }
  return (Date.parse(a.detected_at) - Date.parse(b.detected_at)) * mul;
}

interface AlertTableRowProps {
  alert: Alert;
  isSelected: boolean;
  isExpanded: boolean;
  hasHighlight: boolean;
  canUndoClose: boolean;
  confirmationText?: string;
  canMutate: boolean;
  reducedMotion: boolean;
  onSelect: (id: number, openDrawer?: boolean) => void;
  onToggleExpand: (id: number) => void;
  onAcknowledge: (id: number) => void;
  onAssignToMe: (id: number) => void;
  onCloseAlert: (id: number) => void;
  onUndoClose: (id: number) => void;
}

const AlertTableRow: React.FC<AlertTableRowProps> = React.memo(
  ({
    alert,
    isSelected,
    isExpanded,
    hasHighlight,
    canUndoClose,
    confirmationText,
    canMutate,
    reducedMotion,
    onSelect,
    onToggleExpand,
    onAcknowledge,
    onAssignToMe,
    onCloseAlert,
    onUndoClose,
  }) => {
    const feeder = getFeederForMeterId(alert.meter_id);
    const explanations = useMemo(() => parseExplanation(alert.explanation), [alert.explanation]);
    const isOpen = alert.status === 'open';
    const isClosed = alert.status === 'closed';

    return (
      <>
        <tr
          role="row"
          data-testid={`alert-row-${alert.id}`}
          aria-selected={isSelected}
          tabIndex={0}
          onClick={() => onSelect(alert.id, true)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              onSelect(alert.id, true);
            } else if (e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onSelect(alert.id, false);
            }
          }}
          className={clsx(
            'relative block md:table-row border-b border-[#C8CDD6] dark:border-[#1E2633] transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#F59E0B]',
            'border-l-2',
            isOpen
              ? 'border-l-[#FF4D2D]'
              : alert.status === 'acknowledged'
                ? 'border-l-[#F59E0B]'
                : 'border-l-[#7D899C]/50 opacity-75',
            isSelected
              ? 'bg-[#F59E0B]/[0.11] dark:bg-[#F59E0B]/[0.12]'
              : 'hover:bg-[#E7E9E2]/60 dark:hover:bg-[#121822]/80',
          )}
        >
          {/* 1. Severity */}
          <td role="cell" className="flex items-center justify-between md:table-cell px-2.5 py-1 md:py-2 align-middle whitespace-nowrap">
            <span className="md:hidden font-mono text-[10px] uppercase text-[#7D899C]">
              Severity
            </span>
            <div className="relative flex items-center gap-1.5">
              {hasHighlight && (
                <motion.span
                  data-testid={`alert-highlight-${alert.id}`}
                  aria-hidden="true"
                  initial={{ opacity: reducedMotion ? 0.3 : 0.55 }}
                  animate={{ opacity: 0 }}
                  transition={{ duration: 1.5, ease: 'easeOut' }}
                  style={{
                    background: `linear-gradient(90deg, ${TOKENS.colors.alert} 0%, transparent 100%)`,
                  }}
                  className="pointer-events-none absolute -inset-y-2 -left-2.5 w-20"
                />
              )}
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-label={`Toggle explanation for alert ${alert.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleExpand(alert.id);
                }}
                className="relative z-10 p-0.5 text-[#7D899C] hover:text-[#F59E0B] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                )}
              </button>
              <SeverityBadge severity={alert.severity} />
            </div>
          </td>

          {/* 2. Meter ID */}
          <td role="cell" className="flex items-center justify-between md:table-cell px-2.5 py-1 md:py-2 align-middle font-mono whitespace-nowrap">
            <span className="md:hidden font-mono text-[10px] uppercase text-[#7D899C]">
              Meter ID
            </span>
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <Link
                to={`/meters/${encodeURIComponent(alert.meter_id)}`}
                onClick={(e) => e.stopPropagation()}
                className="text-xs font-bold text-[#F59E0B] hover:underline focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
              >
                {alert.meter_id}
              </Link>
              <span className="text-[10px] text-[#7D899C] uppercase">{feeder.id}</span>
            </div>
          </td>

          {/* 3. Type */}
          <td role="cell" className="flex items-center justify-between md:table-cell px-2.5 py-1 md:py-2 align-middle text-xs font-medium whitespace-nowrap">
            <span className="md:hidden font-mono text-[10px] uppercase text-[#7D899C]">
              Type
            </span>
            <span>{formatFaultLabel(alert.type)}</span>
          </td>

          {/* 4. Score */}
          <td role="cell" className="flex items-center justify-between md:table-cell px-2.5 py-1 md:py-2 align-middle font-mono text-xs tabular-nums whitespace-nowrap">
            <span className="md:hidden font-mono text-[10px] uppercase text-[#7D899C]">
              Score
            </span>
            <span
              className={clsx(
                'font-semibold',
                alert.score >= 0.9
                  ? 'text-[#FF4D2D]'
                  : alert.score >= 0.75
                    ? 'text-[#F59E0B]'
                    : 'text-[#576070] dark:text-[#7D899C]',
              )}
            >
              {alert.score.toFixed(2)}
            </span>
          </td>

          {/* 5. Time Since First Seen */}
          <td role="cell" className="flex items-center justify-between md:table-cell px-2.5 py-1 md:py-2 align-middle whitespace-nowrap">
            <span className="md:hidden font-mono text-[10px] uppercase text-[#7D899C]">
              First Seen
            </span>
            <LiveElapsedTime detectedAt={alert.detected_at} />
          </td>

          {/* 6. Status */}
          <td role="cell" className="flex items-center justify-between md:table-cell px-2.5 py-1 md:py-2 align-middle whitespace-nowrap">
            <span className="md:hidden font-mono text-[10px] uppercase text-[#7D899C]">
              Status
            </span>
            <StatusBadge status={alert.status} />
          </td>

          {/* 7. Assigned To */}
          <td role="cell" className="flex items-center justify-between md:table-cell px-2.5 py-1 md:py-2 align-middle font-mono text-xs whitespace-nowrap">
            <span className="md:hidden font-mono text-[10px] uppercase text-[#7D899C]">
              Assigned To
            </span>
            <span className={alert.assigned_to ? 'text-[#11141C] dark:text-[#E6E9EF]' : 'text-[#7D899C]'}>
              {alert.assigned_to || 'Unassigned'}
            </span>
          </td>

          {/* 8. Actions + Inline Row Confirmation */}
          <td
            role="cell"
            className="flex items-center justify-between md:table-cell px-2.5 py-1.5 md:py-2 align-middle md:text-right whitespace-nowrap"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="md:hidden font-mono text-[10px] uppercase text-[#7D899C]">
              Actions
            </span>
            <div className="inline-flex flex-nowrap items-center justify-end gap-1 font-mono text-[10px]">
              {confirmationText && (
                <span
                  role="status"
                  data-testid={`row-confirmation-${alert.id}`}
                  className="px-1.5 py-0.5 text-[10px] font-bold uppercase border border-[#F59E0B] bg-[#F59E0B]/15 text-[#F59E0B]"
                >
                  {confirmationText}
                </span>
              )}
              {(canUndoClose || (isClosed && confirmationText === '✓ CLOSED')) && canMutate && (
                <button
                  type="button"
                  data-testid={`undo-close-${alert.id}`}
                  aria-label={`Undo closing alert ${alert.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onUndoClose(alert.id);
                  }}
                  className="px-1.5 py-0.5 border border-[#00E5FF] text-[#00E5FF] hover:bg-[#00E5FF]/15 uppercase font-semibold cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
                >
                  Undo
                </button>
              )}
              {canMutate && !isClosed && (
                <>
                  {isOpen && (
                    <button
                      type="button"
                      onClick={() => onAcknowledge(alert.id)}
                      className="px-1.5 py-0.5 uppercase border border-[#F59E0B]/60 text-[#F59E0B] hover:bg-[#F59E0B]/15 focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
                    >
                      Ack
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onAssignToMe(alert.id)}
                    className="px-1.5 py-0.5 uppercase border border-[#00E5FF]/50 text-[#00E5FF] hover:bg-[#00E5FF]/10 focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
                  >
                    Assign
                  </button>
                  <button
                    type="button"
                    onClick={() => onCloseAlert(alert.id)}
                    className="px-1.5 py-0.5 uppercase border border-[#7D899C]/50 text-[#576070] dark:text-[#7D899C] hover:text-[#11141C] dark:hover:text-[#E6E9EF] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
                  >
                    Close
                  </button>
                </>
              )}
              {isClosed && !confirmationText && (
                <span className="text-[10px] uppercase text-[#7D899C]">Closed</span>
              )}
            </div>
          </td>
        </tr>

        {/* Inline Expandable Explanation Row (at most one expanded at a time) */}
        {isExpanded && (
          <tr
            role="row"
            data-testid={`expanded-row-${alert.id}`}
            className="block md:table-row bg-[#E7E9E2]/70 dark:bg-[#07090D]/90 border-b border-[#C8CDD6] dark:border-[#1E2633]"
          >
            <td role="cell" colSpan={8} className="block md:table-cell px-4 py-3">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center justify-between mb-2 font-mono text-[10px] uppercase tracking-wider text-[#7D899C]">
                    <span>FULL ANOMALY EXPLANATION // ALERT #{alert.id}</span>
                    {alert.energy_loss_kwh > 0 && (
                      <span className="text-[#FF4D2D] font-semibold">
                        EST. LOSS {alert.energy_loss_kwh.toFixed(2)} kWh ({alert.loss_kw.toFixed(2)} kW)
                      </span>
                    )}
                  </div>
                  <ul className="space-y-1.5">
                    {explanations.map((item, idx) => (
                      <li
                        key={`${item.feature}-${idx}`}
                        className="border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-2 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                          <span className="font-semibold text-[#F59E0B]">{item.feature}</span>
                          <span className="text-[#7D899C] tabular-nums">
                            Z={Number(item.z_score || 0).toFixed(2)}σ ·{' '}
                            {item.deviation_pct > 0 ? `+${item.deviation_pct}%` : `${item.deviation_pct}%`}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-[#11141C] dark:text-[#E6E9EF]">
                          {item.description}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <div className="font-mono text-[10px] uppercase tracking-wider text-[#7D899C] mb-2">
                    TOP FEATURE DEVIATION VECTORS
                  </div>
                  <DeviationBars explanations={explanations} />
                </div>
              </div>
            </td>
          </tr>
        )}
      </>
    );
  },
);

AlertTableRow.displayName = 'AlertTableRow';

interface AlertsTableProps {
  alerts: Alert[];
  selectedRowId: number | null;
  expandedRowId: number | null;
  recentHighlightAlertIds: Record<number, number>;
  rowConfirmations: Record<number, string>;
  canMutate: boolean;
  reducedMotion: boolean;
  sortField: AlertSortField;
  sortDir: AlertSortDir;
  onSortChange: (field: AlertSortField) => void;
  onSelect: (id: number, openDrawer?: boolean) => void;
  onToggleExpand: (id: number) => void;
  onAcknowledge: (id: number) => void;
  onAssignToMe: (id: number) => void;
  onCloseAlert: (id: number) => void;
  recentlyClosedIds: Record<number, boolean>;
  onUndoClose: (id: number) => void;
}

const AlertsTable: React.FC<AlertsTableProps> = React.memo(
  ({
    alerts,
    selectedRowId,
    expandedRowId,
    recentHighlightAlertIds,
    rowConfirmations,
    canMutate,
    reducedMotion,
    sortField,
    sortDir,
    onSortChange,
    onSelect,
    onToggleExpand,
    onAcknowledge,
    onAssignToMe,
    onCloseAlert,
    recentlyClosedIds,
    onUndoClose,
  }) => {
    const getSortIcon = (field: AlertSortField) => {
      if (sortField !== field) {
        return <ArrowUpDown className="h-3 w-3 text-[#7D899C]" aria-hidden="true" />;
      }
      return sortDir === 'desc' ? (
        <ArrowDown className="h-3 w-3 text-[#F59E0B]" aria-hidden="true" />
      ) : (
        <ArrowUp className="h-3 w-3 text-[#F59E0B]" aria-hidden="true" />
      );
    };

    const getAriaSort = (field: AlertSortField): 'ascending' | 'descending' | 'none' => {
      if (sortField !== field) return 'none';
      return sortDir === 'asc' ? 'ascending' : 'descending';
    };

    return (
      <table role="table" className="block md:table w-full text-left border-collapse">
        <caption className="sr-only">GridSense operator alert triage table</caption>
        <thead
          role="rowgroup"
          className="sr-only md:not-sr-only md:table-header-group md:sticky md:top-0 z-20 bg-[#F2F3EE] dark:bg-[#121822] border-b border-[#C8CDD6] dark:border-[#1E2633] font-mono text-[10px] uppercase tracking-wider text-[#576070] dark:text-[#7D899C]"
        >
          <tr role="row">
            <th role="columnheader" scope="col" aria-sort={getAriaSort('severity')} className="px-3 py-2.5">
              <button
                type="button"
                onClick={() => onSortChange('severity')}
                className="inline-flex items-center gap-1 uppercase hover:text-[#F59E0B] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
              >
                <span>Severity</span>
                {getSortIcon('severity')}
              </button>
            </th>
            <th role="columnheader" scope="col" className="px-3 py-2.5">
              Meter ID
            </th>
            <th role="columnheader" scope="col" className="px-3 py-2.5">
              Type
            </th>
            <th role="columnheader" scope="col" aria-sort={getAriaSort('score')} className="px-3 py-2.5">
              <button
                type="button"
                onClick={() => onSortChange('score')}
                className="inline-flex items-center gap-1 uppercase hover:text-[#F59E0B] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
              >
                <span>Score</span>
                {getSortIcon('score')}
              </button>
            </th>
            <th role="columnheader" scope="col" aria-sort={getAriaSort('time')} className="px-3 py-2.5">
              <button
                type="button"
                onClick={() => onSortChange('time')}
                className="inline-flex items-center gap-1 uppercase hover:text-[#F59E0B] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
              >
                <span>First Seen</span>
                {getSortIcon('time')}
              </button>
            </th>
            <th role="columnheader" scope="col" className="px-3 py-2.5">
              Status
            </th>
            <th role="columnheader" scope="col" className="px-3 py-2.5">
              Assigned To
            </th>
            <th role="columnheader" scope="col" className="px-3 py-2.5 text-right">
              Actions
            </th>
          </tr>
        </thead>
        <tbody
          role="rowgroup"
          className="block md:table-row-group divide-y md:divide-y-0 divide-[#C8CDD6] dark:divide-[#1E2633]"
        >
          {alerts.length === 0 ? (
            <tr role="row" className="block md:table-row">
              <td
                role="cell"
                colSpan={8}
                className="block md:table-cell px-4 py-10 text-center font-mono text-xs text-[#7D899C]"
              >
                NO ALERTS MATCH ACTIVE FILTER CRITERIA
              </td>
            </tr>
          ) : (
            alerts.map((alert) => (
              <AlertTableRow
                key={alert.id}
                alert={alert}
                isSelected={selectedRowId === alert.id}
                isExpanded={expandedRowId === alert.id}
                hasHighlight={Boolean(recentHighlightAlertIds[alert.id]) && alert.status === 'open'}
                canUndoClose={Boolean(recentlyClosedIds[alert.id])}
                confirmationText={rowConfirmations[alert.id]}
                canMutate={canMutate}
                reducedMotion={reducedMotion}
                onSelect={onSelect}
                onToggleExpand={onToggleExpand}
                onAcknowledge={onAcknowledge}
                onAssignToMe={onAssignToMe}
                onCloseAlert={onCloseAlert}
                onUndoClose={onUndoClose}
              />
            ))
          )}
        </tbody>
      </table>
    );
  },
);

AlertsTable.displayName = 'AlertsTable';

interface AlertDetailDrawerProps {
  alert: Alert;
  readings: Reading[];
  canMutate: boolean;
  confirmationText?: string;
  reducedMotion: boolean;
  onCloseDrawer: () => void;
  onAcknowledge: (id: number) => void;
  onAssignToMe: (id: number) => void;
  onCloseAlert: (id: number) => void;
}

const AlertDetailDrawer: React.FC<AlertDetailDrawerProps> = ({
  alert,
  readings,
  canMutate,
  confirmationText,
  reducedMotion,
  onCloseDrawer,
  onAcknowledge,
  onAssignToMe,
  onCloseAlert,
}) => {
  const feeder = getFeederForMeterId(alert.meter_id);
  const explanations = parseExplanation(alert.explanation);
  const lastTenReadings = readings.slice(-10).reverse();
  const auditEvents = alert.events ?? [];

  return (
    <motion.aside
      role="complementary"
      aria-label="Alert detail drawer"
      initial={reducedMotion ? { opacity: 1 } : { opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.16 }}
      className="fixed inset-0 z-40 md:static md:inset-auto md:z-auto w-full md:w-[430px] xl:w-[470px] shrink-0 bg-[#FFFFFF] dark:bg-[#0C1017] md:border-l border-[#C8CDD6] dark:border-[#1E2633] flex flex-col overflow-y-auto"
    >
      {/* Drawer Header */}
      <div className="sticky top-0 z-10 px-4 py-3 border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE] dark:bg-[#121822] flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-bold uppercase tracking-wider text-[#F59E0B]">
              ALERT #{alert.id}
            </span>
            <SeverityBadge severity={alert.severity} />
            <StatusBadge status={alert.status} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs font-mono">
            <Link
              to={`/meters/${encodeURIComponent(alert.meter_id)}`}
              className="font-bold text-[#F59E0B] hover:underline focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
            >
              {alert.meter_id}
            </Link>
            <span className="text-[#7D899C]">// {feeder.name}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={onCloseDrawer}
          aria-label="Close detail drawer"
          className="p-1.5 border border-[#C8CDD6] dark:border-[#1E2633] hover:border-[#F59E0B] text-[#7D899C] hover:text-[#F59E0B] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Quick Metadata & Operator Triage Actions */}
      <div className="px-4 py-3 border-b border-[#C8CDD6] dark:border-[#1E2633] space-y-2.5">
        <div className="grid grid-cols-3 gap-2 font-mono text-xs">
          <div className="border border-[#C8CDD6] dark:border-[#1E2633] p-2 bg-[#F2F3EE]/50 dark:bg-[#07090D]">
            <div className="text-[10px] uppercase text-[#7D899C]">FAULT TYPE</div>
            <div className="mt-0.5 font-sans font-semibold truncate">
              {formatFaultLabel(alert.type)}
            </div>
          </div>
          <div className="border border-[#C8CDD6] dark:border-[#1E2633] p-2 bg-[#F2F3EE]/50 dark:bg-[#07090D]">
            <div className="text-[10px] uppercase text-[#7D899C]">ANOMALY SCORE</div>
            <div className="mt-0.5 font-bold tabular-nums text-[#FF4D2D]">
              {alert.score.toFixed(2)}
            </div>
          </div>
          <div className="border border-[#C8CDD6] dark:border-[#1E2633] p-2 bg-[#F2F3EE]/50 dark:bg-[#07090D]">
            <div className="text-[10px] uppercase text-[#7D899C]">ASSIGNED</div>
            <div className="mt-0.5 truncate text-[#11141C] dark:text-[#E6E9EF]">
              {alert.assigned_to || 'Unassigned'}
            </div>
          </div>
        </div>

        {canMutate && alert.status !== 'closed' && (
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
            {alert.status === 'open' && (
              <button
                type="button"
                onClick={() => onAcknowledge(alert.id)}
                className="px-2.5 py-1 uppercase border border-[#F59E0B]/60 bg-[#F59E0B]/15 text-[#F59E0B] hover:bg-[#F59E0B]/25 focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
              >
                Acknowledge (A)
              </button>
            )}
            <button
              type="button"
              onClick={() => onAssignToMe(alert.id)}
              className="px-2.5 py-1 uppercase border border-[#00E5FF]/50 bg-[#00E5FF]/10 text-[#00E5FF] hover:bg-[#00E5FF]/20 focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
            >
              Assign To Me (Shift+A)
            </button>
            <button
              type="button"
              onClick={() => onCloseAlert(alert.id)}
              className="px-2.5 py-1 uppercase border border-[#FF4D2D]/50 bg-[#FF4D2D]/10 text-[#FF4D2D] hover:bg-[#FF4D2D]/20 focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
            >
              Close (C)
            </button>
            {confirmationText && (
              <span role="status" className="text-[11px] font-bold text-[#F59E0B]">
                {confirmationText}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Body Sections */}
      <div className="p-4 space-y-5">
        {/* 1. DeviationBars */}
        <section aria-label="Feature deviation vectors">
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[#7D899C] mb-2">
            CONTRIBUTING FEATURE DEVIATIONS
          </h2>
          <DeviationBars explanations={explanations} />
        </section>

        {/* 2. Full Explanation */}
        <section aria-label="Full root-cause explanation">
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[#7D899C] mb-2">
            FULL EXPLANATION &amp; THRESHOLDS
          </h2>
          <ul className="space-y-2">
            {explanations.map((item, idx) => (
              <li
                key={`${item.feature}-${idx}`}
                className="border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE]/60 dark:bg-[#07090D] p-2.5 text-xs"
              >
                <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                  <span className="font-semibold text-[#F59E0B]">{item.feature}</span>
                  <span className="tabular-nums text-[#7D899C]">
                    Z={Number(item.z_score || 0).toFixed(2)}σ ·{' '}
                    {item.deviation_pct > 0 ? `+${item.deviation_pct}%` : `${item.deviation_pct}%`}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-snug">{item.description}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* 3. Meter Last 10 Readings Table */}
        <section aria-label="Meter last 10 readings">
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[#7D899C] mb-2">
            METER LAST 10 READINGS // {alert.meter_id}
          </h2>
          <div className="border border-[#C8CDD6] dark:border-[#1E2633] overflow-x-auto">
            <table className="w-full text-[11px] font-mono tabular-nums text-left">
              <caption className="sr-only">Last 10 readings for {alert.meter_id}</caption>
              <thead className="bg-[#F2F3EE] dark:bg-[#121822] text-[10px] uppercase text-[#7D899C] border-b border-[#C8CDD6] dark:border-[#1E2633]">
                <tr>
                  <th scope="col" className="px-2 py-1.5">
                    Time
                  </th>
                  <th scope="col" className="px-2 py-1.5" style={{ color: TOKENS.colors.phases.A.color }}>
                    ØA V/A
                  </th>
                  <th scope="col" className="px-2 py-1.5" style={{ color: TOKENS.colors.phases.B.color }}>
                    ØB V/A
                  </th>
                  <th scope="col" className="px-2 py-1.5" style={{ color: TOKENS.colors.phases.C.color }}>
                    ØC V/A
                  </th>
                  <th scope="col" className="px-2 py-1.5">
                    PF / Hz
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#C8CDD6] dark:divide-[#1E2633]">
                {lastTenReadings.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-2 py-3 text-center text-[#7D899C]">
                      No recent samples buffered
                    </td>
                  </tr>
                ) : (
                  lastTenReadings.map((r, idx) => {
                    const ts = getReadingTimestamp(r);
                    return (
                      <tr key={`${ts ?? idx}-${idx}`}>
                        <td className="px-2 py-1 whitespace-nowrap text-[#7D899C]">
                          {formatTimeShort(ts)}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          {r.voltage_a.toFixed(1)}/{r.current_a.toFixed(1)}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          {r.voltage_b.toFixed(1)}/{r.current_b.toFixed(1)}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          {r.voltage_c.toFixed(1)}/{r.current_c.toFixed(1)}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          {r.power_factor.toFixed(2)}/{r.frequency.toFixed(1)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* 4. Alert Audit Log */}
        <section aria-label="Alert audit log">
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[#7D899C] mb-2">
            ALERT AUDIT LOG
          </h2>
          {auditEvents.length === 0 ? (
            <p className="font-mono text-xs text-[#7D899C]">
              Created at {formatDateTime(alert.detected_at)} (last seen{' '}
              {formatDateTime(alert.last_detected_at)}).
            </p>
          ) : (
            <ul className="space-y-1.5 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE]/50 dark:bg-[#07090D] p-2.5">
              {auditEvents.map((ev) => (
                <li
                  key={ev.id}
                  className="font-mono text-xs flex flex-col gap-0.5 pb-1.5 last:pb-0 border-b last:border-b-0 border-[#C8CDD6]/60 dark:border-[#1E2633]/60"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold uppercase text-[#F59E0B]">{ev.action}</span>
                    <span className="text-[10px] text-[#7D899C] tabular-nums">
                      {formatDateTime(ev.created_at)}
                    </span>
                  </div>
                  <div className="text-[11px] text-[#11141C] dark:text-[#E6E9EF]">
                    Actor: <span className="font-semibold">{ev.actor}</span>
                    {ev.details ? ` — ${ev.details}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </motion.aside>
  );
};

export const AlertsPage: React.FC = () => {
  const { canMutate, user } = useAuth();
  const reducedMotion = usePrefersReducedMotion();
  const {
    alerts,
    openAlertsCount,
    recentHighlightAlertIds,
    acknowledgeAlert,
    assignAlert,
    closeAlert,
    reopenAlert,
    triggerSimulatedFault,
    getMeterHistory,
  } = useTelemetry();

  const currentUserEmail = user?.email || 'operator@gridsense.local';

  // Filters
  const [searchParams, setSearchParams] = useSearchParams();
  const [severityFilter, setSeverityFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState(() => normalizeTypeParam(searchParams.get('type')));
  const [statusFilter, setStatusFilter] = useState('');
  const [feederFilter, setFeederFilter] = useState('');
  const [meterSearch, setMeterSearch] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  const urlTypeParam = normalizeTypeParam(searchParams.get('type'));
  useEffect(() => {
    setTypeFilter(urlTypeParam);
  }, [urlTypeParam]);

  // Sorting (Default: severity desc, then newest detected_at first)
  const [sortField, setSortField] = useState<AlertSortField>('severity');
  const [sortDir, setSortDir] = useState<AlertSortDir>('desc');

  // Triage Interaction State
  const [selectedRowId, setSelectedRowId] = useState<number | null>(null);
  const [expandedRowId, setExpandedRowId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [rowConfirmations, setRowConfirmations] = useState<Record<number, string>>({});
  const [recentlyClosedIds, setRecentlyClosedIds] = useState<Record<number, boolean>>({});

  // Live Arrival Freeze & "N new alerts" Pill State
  const knownAlertIdsRef = useRef<Set<number>>(new Set(alerts.map((a) => a.id)));
  const [liveTopIds, setLiveTopIds] = useState<number[]>([]);
  const [pendingNewAlertIds, setPendingNewAlertIds] = useState<number[]>([]);
  const [frozenOrderIds, setFrozenOrderIds] = useState<number[] | null>(null);

  const tableScrollRef = useRef<HTMLDivElement>(null);
  const confirmTimersRef = useRef<Record<number, number>>({});
  const closeTimersRef = useRef<Record<number, number>>({});

  useEffect(() => {
    const cTimers = confirmTimersRef.current;
    const xTimers = closeTimersRef.current;
    return () => {
      Object.values(cTimers).forEach((t) => window.clearTimeout(t));
      Object.values(xTimers).forEach((t) => window.clearTimeout(t));
    };
  }, []);

  const flashRowConfirmation = useCallback((id: number, message: string) => {
    setRowConfirmations((prev) => ({ ...prev, [id]: message }));
    if (confirmTimersRef.current[id]) {
      window.clearTimeout(confirmTimersRef.current[id]);
    }
    confirmTimersRef.current[id] = window.setTimeout(() => {
      setRowConfirmations((prev) => {
        if (!(id in prev)) return prev;
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
    }, 2500);
  }, []);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (severityFilter) count += 1;
    if (typeFilter) count += 1;
    if (statusFilter) count += 1;
    if (feederFilter) count += 1;
    if (meterSearch.trim()) count += 1;
    if (showClosed && statusFilter !== 'closed') count += 1;
    return count;
  }, [severityFilter, typeFilter, statusFilter, feederFilter, meterSearch, showClosed]);

  const handleClearFilters = useCallback(() => {
    setSeverityFilter('');
    setTypeFilter('');
    setStatusFilter('');
    setFeederFilter('');
    setMeterSearch('');
    setShowClosed(false);
    setRecentlyClosedIds({});
    if (searchParams.has('type')) {
      const next = new URLSearchParams(searchParams);
      next.delete('type');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const handleSortChange = useCallback(
    (field: AlertSortField) => {
      setLiveTopIds([]);
      setSortField((prevField) => {
        if (prevField === field) {
          setSortDir((prevDir) => (prevDir === 'desc' ? 'asc' : 'desc'));
          return prevField;
        }
        setSortDir('desc');
        return field;
      });
    },
    [],
  );

  // Detect new alerts arriving while mounted without triggering re-render loops
  useEffect(() => {
    const incomingIds: number[] = [];
    for (const a of alerts) {
      if (!knownAlertIdsRef.current.has(a.id)) {
        incomingIds.push(a.id);
      }
    }

    if (selectedRowId !== null) {
      setPendingNewAlertIds((prev) => {
        if (
          prev.length === incomingIds.length &&
          prev.every((val, idx) => val === incomingIds[idx])
        ) {
          return prev;
        }
        return incomingIds;
      });
      return;
    }

    // No row selected: immediately promote any pending + incoming alerts to top
    if (incomingIds.length > 0) {
      incomingIds.forEach((id) => knownAlertIdsRef.current.add(id));
      setLiveTopIds((prev) => [...incomingIds, ...prev.filter((id) => !incomingIds.includes(id))]);
    }
    setPendingNewAlertIds((prev) => (prev.length === 0 ? prev : []));
  }, [alerts, selectedRowId]);

  const liveTopOrderMap = useMemo(() => {
    const map = new Map<number, number>();
    liveTopIds.forEach((id, idx) => map.set(id, idx));
    return map;
  }, [liveTopIds]);

  // Base filtered & sorted alerts (re-runs only when alerts, filters, or sort criteria change — NOT on 1Hz reading ticks)
  const filteredAndSortedAlerts = useMemo(() => {
    const searchLower = meterSearch.trim().toLowerCase();

    const matching = alerts.filter((alert) => {
      if (selectedRowId !== null && !knownAlertIdsRef.current.has(alert.id)) {
        return false;
      }
      if (statusFilter) {
        if (alert.status !== statusFilter) return false;
      } else if (!showClosed && alert.status === 'closed' && !recentlyClosedIds[alert.id]) {
        return false;
      }
      if (severityFilter && alert.severity.toLowerCase() !== severityFilter.toLowerCase()) {
        return false;
      }
      if (!matchesTypeFilter(alert.type, typeFilter)) return false;
      if (feederFilter && getFeederForMeterId(alert.meter_id).id !== feederFilter) {
        return false;
      }
      if (searchLower && !alert.meter_id.toLowerCase().includes(searchLower)) {
        return false;
      }
      return true;
    });

    if (selectedRowId !== null && frozenOrderIds !== null) {
      const byId = new Map(matching.map((a) => [a.id, a]));
      const ordered: Alert[] = [];
      const seen = new Set<number>();
      for (const id of frozenOrderIds) {
        const item = byId.get(id);
        if (item) {
          ordered.push(item);
          seen.add(id);
        }
      }
      const extras = matching
        .filter((a) => !seen.has(a.id))
        .sort((a, b) => compareAlerts(a, b, sortField, sortDir, liveTopOrderMap));
      return [...ordered, ...extras];
    }

    return [...matching].sort((a, b) => compareAlerts(a, b, sortField, sortDir, liveTopOrderMap));
  }, [
    alerts,
    severityFilter,
    typeFilter,
    statusFilter,
    feederFilter,
    meterSearch,
    showClosed,
    sortField,
    sortDir,
    selectedRowId,
    frozenOrderIds,
    liveTopOrderMap,
    recentlyClosedIds,
  ]);

  // Snapshot row order as soon as a row is selected so new live alerts never shift rows under cursor
  useEffect(() => {
    if (selectedRowId === null) {
      setFrozenOrderIds(null);
      return;
    }
    setFrozenOrderIds((prev) => {
      if (prev === null) {
        return filteredAndSortedAlerts.map((a) => a.id);
      }
      return prev;
    });
  }, [selectedRowId, filteredAndSortedAlerts]);

  useEffect(() => {
    if (selectedRowId !== null) {
      setFrozenOrderIds(null);
    }
    // Reset snapshot when explicit filter/sort criteria change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severityFilter, typeFilter, statusFilter, feederFilter, meterSearch, showClosed, sortField, sortDir]);

  const handleSelectRow = useCallback((id: number, openDrawer = false) => {
    setSelectedRowId(id);
    if (openDrawer) {
      setDrawerOpen(true);
    }
  }, []);

  const handleToggleExpand = useCallback((id: number) => {
    setExpandedRowId((prev) => (prev === id ? null : id));
  }, []);

  const handleAcknowledge = useCallback(
    (id: number) => {
      if (!canMutate) return;
      void acknowledgeAlert(id);
      flashRowConfirmation(id, '✓ ACKNOWLEDGED');
    },
    [acknowledgeAlert, canMutate, flashRowConfirmation],
  );

  const handleAssignToMe = useCallback(
    (id: number) => {
      if (!canMutate) return;
      void assignAlert(id, currentUserEmail);
      flashRowConfirmation(id, `✓ ASSIGNED → ${currentUserEmail}`);
    },
    [assignAlert, canMutate, currentUserEmail, flashRowConfirmation],
  );

  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  const recentlyClosedPrevStatusRef = useRef<Record<number, 'open' | 'acknowledged'>>({});

  const handleCloseAlert = useCallback(
    (id: number) => {
      if (!canMutate) return;
      const current = alertsRef.current.find((a) => a.id === id);
      recentlyClosedPrevStatusRef.current[id] =
        current?.status === 'acknowledged' ? 'acknowledged' : 'open';
      setRecentlyClosedIds((prev) => ({ ...prev, [id]: true }));
      if (closeTimersRef.current[id]) {
        window.clearTimeout(closeTimersRef.current[id]);
      }
      closeTimersRef.current[id] = window.setTimeout(() => {
        delete recentlyClosedPrevStatusRef.current[id];
        setRecentlyClosedIds((prev) => {
          if (!(id in prev)) return prev;
          const copy = { ...prev };
          delete copy[id];
          return copy;
        });
      }, 2500);
      void closeAlert(id);
      flashRowConfirmation(id, '✓ CLOSED');
    },
    [canMutate, closeAlert, flashRowConfirmation],
  );

  const handleUndoClose = useCallback(
    (id: number) => {
      if (!canMutate) return;
      if (closeTimersRef.current[id]) {
        window.clearTimeout(closeTimersRef.current[id]);
        delete closeTimersRef.current[id];
      }
      const prevStatus = recentlyClosedPrevStatusRef.current[id] ?? 'open';
      delete recentlyClosedPrevStatusRef.current[id];
      setRecentlyClosedIds((prev) => {
        if (!(id in prev)) return prev;
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      void reopenAlert(id, prevStatus);
      flashRowConfirmation(id, '↺ RESTORED');
    },
    [canMutate, flashRowConfirmation, reopenAlert],
  );

  const handleRevealNewAlerts = useCallback(() => {
    if (pendingNewAlertIds.length === 0) return;
    const toRelease = [...pendingNewAlertIds];
    toRelease.forEach((id) => knownAlertIdsRef.current.add(id));
    setPendingNewAlertIds([]);
    setLiveTopIds((prev) => [...toRelease, ...prev.filter((id) => !toRelease.includes(id))]);
    setFrozenOrderIds((prev) => (prev ? [...toRelease, ...prev] : null));
    tableScrollRef.current?.scrollTo?.({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [pendingNewAlertIds, reducedMotion]);

  // Global keyboard-first triage bindings: J / K / Enter / Escape / A / Shift+A / C / ?
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"][aria-label*="Command palette"]')) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable) {
        return;
      }

      const key = e.key;
      const lower = key.toLowerCase();

      if (key === '?') {
        e.preventDefault();
        setLegendOpen((prev) => !prev);
        return;
      }

      if (key === 'Escape') {
        if (drawerOpen) {
          e.preventDefault();
          setDrawerOpen(false);
        } else if (legendOpen) {
          e.preventDefault();
          setLegendOpen(false);
        }
        return;
      }

      if (lower === 'j' || lower === 'k') {
        if (filteredAndSortedAlerts.length === 0) return;
        e.preventDefault();
        const curIdx =
          selectedRowId === null
            ? -1
            : filteredAndSortedAlerts.findIndex((a) => a.id === selectedRowId);

        let nextIdx: number;
        if (curIdx === -1) {
          nextIdx = lower === 'j' ? 0 : filteredAndSortedAlerts.length - 1;
        } else if (lower === 'j') {
          nextIdx = Math.min(filteredAndSortedAlerts.length - 1, curIdx + 1);
        } else {
          nextIdx = Math.max(0, curIdx - 1);
        }

        const nextAlert = filteredAndSortedAlerts[nextIdx];
        if (nextAlert) {
          setSelectedRowId(nextAlert.id);
        }
        return;
      }

      if (key === 'Enter' && selectedRowId !== null) {
        e.preventDefault();
        setDrawerOpen(true);
        return;
      }

      if (selectedRowId !== null && lower === 'a' && e.shiftKey) {
        e.preventDefault();
        handleAssignToMe(selectedRowId);
        return;
      }

      if (selectedRowId !== null && lower === 'a' && !e.shiftKey) {
        e.preventDefault();
        handleAcknowledge(selectedRowId);
        return;
      }

      if (selectedRowId !== null && lower === 'c') {
        e.preventDefault();
        handleCloseAlert(selectedRowId);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    drawerOpen,
    legendOpen,
    filteredAndSortedAlerts,
    selectedRowId,
    handleAcknowledge,
    handleAssignToMe,
    handleCloseAlert,
  ]);

  const selectedAlert = useMemo(
    () => (selectedRowId !== null ? alerts.find((a) => a.id === selectedRowId) ?? null : null),
    [alerts, selectedRowId],
  );

  const selectedMeterReadings = selectedAlert ? getMeterHistory(selectedAlert.meter_id) : [];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header Row */}
      <header className="px-4 py-3 border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-display font-bold text-lg tracking-wider uppercase">ALERTS</h1>
          <span
            data-testid="alerts-page-open-count"
            className={clsx(
              'px-2 py-0.5 font-mono text-xs font-bold uppercase tabular-nums border',
              openAlertsCount > 0
                ? 'border-[#FF4D2D]/60 text-[#FF4D2D] bg-[#FF4D2D]/15'
                : 'border-[#7D899C]/50 text-[#7D899C]',
            )}
          >
            <LiveValue
              value={openAlertsCount}
              decimals={0}
              durationMs={0}
              ariaLabel={`Open alerts count: ${openAlertsCount}`}
            />{' '}
            OPEN
          </span>
          <span className="hidden sm:inline font-mono text-[11px] text-[#7D899C] tabular-nums">
            VISIBLE: {filteredAndSortedAlerts.length}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
          <button
            type="button"
            aria-pressed={showClosed}
            onClick={() => setShowClosed((prev) => !prev)}
            className={clsx(
              'px-2.5 py-1 border uppercase transition-colors focus:outline-none focus:ring-2 focus:ring-[#F59E0B]',
              showClosed
                ? 'border-[#F59E0B] bg-[#F59E0B]/15 text-[#F59E0B] font-semibold'
                : 'border-[#C8CDD6] dark:border-[#1E2633] text-[#576070] dark:text-[#7D899C] hover:border-[#F59E0B]',
            )}
          >
            Show closed
          </button>

          <button
            type="button"
            aria-label="Toggle keyboard shortcuts legend"
            aria-expanded={legendOpen}
            onClick={() => setLegendOpen((prev) => !prev)}
            className={clsx(
              'inline-flex items-center gap-1.5 px-2.5 py-1 border uppercase focus:outline-none focus:ring-2 focus:ring-[#F59E0B]',
              legendOpen
                ? 'border-[#F59E0B] bg-[#F59E0B]/15 text-[#F59E0B]'
                : 'border-[#C8CDD6] dark:border-[#1E2633] text-[#576070] dark:text-[#7D899C] hover:border-[#F59E0B]',
            )}
          >
            <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
            <span>? Shortcuts</span>
          </button>

          <button
            type="button"
            onClick={() => triggerSimulatedFault('MTR-0104', 'power_theft')}
            title="Simulator control (demo only)"
            className="px-2.5 py-1 border border-[#FF4D2D]/60 bg-[#FF4D2D]/10 text-[#FF4D2D] hover:bg-[#FF4D2D]/20 uppercase font-semibold focus:outline-none focus:ring-2 focus:ring-[#FF4D2D]"
          >
            SIM: + INJECT ALERT
          </button>
        </div>
      </header>

      {/* Filter Bar */}
      <section
        aria-label="Alert filters"
        className="px-4 py-2.5 border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE]/80 dark:bg-[#07090D] flex flex-wrap items-end gap-3"
      >
        <div className="flex flex-col gap-1 min-w-[130px] flex-1 sm:flex-initial">
          <label
            htmlFor="alert-filter-severity"
            className="font-mono text-[10px] uppercase tracking-wider text-[#576070] dark:text-[#7D899C]"
          >
            Severity
          </label>
          <select
            id="alert-filter-severity"
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="px-2.5 py-1.5 font-mono text-xs border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
          >
            <option value="">All Severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        <div className="flex flex-col gap-1 min-w-[155px] flex-1 sm:flex-initial">
          <label
            htmlFor="alert-filter-type"
            className="font-mono text-[10px] uppercase tracking-wider text-[#576070] dark:text-[#7D899C]"
          >
            Type
          </label>
          <select
            id="alert-filter-type"
            value={typeFilter}
            onChange={(e) => {
              const nextVal = e.target.value;
              setTypeFilter(nextVal);
              const next = new URLSearchParams(searchParams);
              if (nextVal) next.set('type', nextVal);
              else next.delete('type');
              setSearchParams(next, { replace: true });
            }}
            className="px-2.5 py-1.5 font-mono text-xs border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
          >
            <option value="">All Types</option>
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 min-w-[135px] flex-1 sm:flex-initial">
          <label
            htmlFor="alert-filter-status"
            className="font-mono text-[10px] uppercase tracking-wider text-[#576070] dark:text-[#7D899C]"
          >
            Status
          </label>
          <select
            id="alert-filter-status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-2.5 py-1.5 font-mono text-xs border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
          >
            <option value="">All Open / Ack</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="closed">Closed</option>
          </select>
        </div>

        <div className="flex flex-col gap-1 min-w-[160px] flex-1 sm:flex-initial">
          <label
            htmlFor="alert-filter-feeder"
            className="font-mono text-[10px] uppercase tracking-wider text-[#576070] dark:text-[#7D899C]"
          >
            Feeder
          </label>
          <select
            id="alert-filter-feeder"
            value={feederFilter}
            onChange={(e) => setFeederFilter(e.target.value)}
            className="px-2.5 py-1.5 font-mono text-xs border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
          >
            <option value="">All Feeders</option>
            {SUBSTATION_FEEDERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.id} ({f.code})
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 min-w-[180px] flex-1">
          <label
            htmlFor="alert-filter-meter"
            className="font-mono text-[10px] uppercase tracking-wider text-[#576070] dark:text-[#7D899C]"
          >
            Meter ID
          </label>
          <input
            id="alert-filter-meter"
            type="search"
            value={meterSearch}
            onChange={(e) => setMeterSearch(e.target.value)}
            placeholder="Search meter (e.g. MTR-0104)"
            className="px-2.5 py-1.5 font-mono text-xs border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
          />
        </div>

        <div className="flex items-center gap-2 ml-auto font-mono text-xs pb-0.5">
          <span
            data-testid="active-filter-count"
            className="px-2 py-1 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] text-[#576070] dark:text-[#7D899C] tabular-nums uppercase"
          >
            Filters: {activeFilterCount}
          </span>
          <button
            type="button"
            onClick={handleClearFilters}
            className="px-2.5 py-1 border border-[#F59E0B]/60 text-[#F59E0B] hover:bg-[#F59E0B]/15 uppercase focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
          >
            Clear
          </button>
        </div>
      </section>

      {/* Keyboard Shortcuts Legend (Toggled with '?') */}
      {legendOpen && (
        <aside
          aria-label="Keyboard shortcuts legend"
          className="px-4 py-2 border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#121822] flex flex-wrap items-center justify-between gap-3 font-mono text-[11px]"
        >
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <span>
              <kbd className="px-1.5 py-0.5 border border-[#F59E0B]/50 text-[#F59E0B]">J / K</kbd>{' '}
              Next / Prev row
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 border border-[#F59E0B]/50 text-[#F59E0B]">ENTER</kbd>{' '}
              Open detail drawer
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 border border-[#F59E0B]/50 text-[#F59E0B]">ESC</kbd>{' '}
              Close drawer
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 border border-[#F59E0B]/50 text-[#F59E0B]">A</kbd>{' '}
              Acknowledge
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 border border-[#F59E0B]/50 text-[#F59E0B]">
                SHIFT+A
              </kbd>{' '}
              Assign to me
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 border border-[#F59E0B]/50 text-[#F59E0B]">C</kbd>{' '}
              Close alert
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 border border-[#F59E0B]/50 text-[#F59E0B]">?</kbd>{' '}
              Toggle legend
            </span>
          </div>
          <button
            type="button"
            aria-label="Close keyboard shortcuts"
            onClick={() => setLegendOpen(false)}
            className="text-[#7D899C] hover:text-[#F59E0B] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </aside>
      )}

      {/* Main Split Workspace: Dense Triage Table + Right-Side Detail Drawer */}
      <div className="flex-1 flex flex-col md:flex-row min-h-0 bg-[#FFFFFF] dark:bg-[#0C1017]">
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Frozen New Arrivals Notification Pill */}
          {pendingNewAlertIds.length > 0 && (
            <div className="px-4 py-2 border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#F59E0B]/10 flex items-center justify-center">
              <button
                type="button"
                data-testid="new-alerts-pill"
                onClick={handleRevealNewAlerts}
                className="px-3 py-1 font-mono text-xs font-bold uppercase border border-[#F59E0B] bg-[#F59E0B]/20 text-[#F59E0B] hover:bg-[#F59E0B]/30 focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
              >
                {pendingNewAlertIds.length}{' '}
                {pendingNewAlertIds.length === 1 ? 'new alert' : 'new alerts'} ↑
              </button>
            </div>
          )}

          {/* Dense Triage Table Container */}
          <div ref={tableScrollRef} className="flex-1 overflow-y-auto overflow-x-auto">
            <AlertsTable
              alerts={filteredAndSortedAlerts}
              selectedRowId={selectedRowId}
              expandedRowId={expandedRowId}
              recentHighlightAlertIds={recentHighlightAlertIds}
              rowConfirmations={rowConfirmations}
              recentlyClosedIds={recentlyClosedIds}
              canMutate={canMutate}
              reducedMotion={reducedMotion}
              sortField={sortField}
              sortDir={sortDir}
              onSortChange={handleSortChange}
              onSelect={handleSelectRow}
              onToggleExpand={handleToggleExpand}
              onAcknowledge={handleAcknowledge}
              onAssignToMe={handleAssignToMe}
              onCloseAlert={handleCloseAlert}
              onUndoClose={handleUndoClose}
            />
          </div>
        </div>

        {/* Right-Side Detail Drawer (Full-Screen Sheet < 768px) */}
        {drawerOpen && selectedAlert && (
          <AlertDetailDrawer
            alert={selectedAlert}
            readings={selectedMeterReadings}
            canMutate={canMutate}
            confirmationText={rowConfirmations[selectedAlert.id]}
            reducedMotion={reducedMotion}
            onCloseDrawer={() => setDrawerOpen(false)}
            onAcknowledge={handleAcknowledge}
            onAssignToMe={handleAssignToMe}
            onCloseAlert={handleCloseAlert}
          />
        )}
      </div>
    </div>
  );
};
