import React, { useMemo, useState } from 'react';
import clsx from 'clsx';
import { TOKENS } from '../design/tokens';
import type { Alert } from '../types';
import { formatFaultLabel, formatTimeShort, parseExplanation } from '../utils/format';

export interface AlertTimelineProps {
  alerts: Alert[];
  selectedTimestamp: string | null;
  onSelectTimestamp: (isoTimestamp: string, alert: Alert) => void;
  nowMs?: number;
}

const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

export const AlertTimeline: React.FC<AlertTimelineProps> = ({
  alerts,
  selectedTimestamp,
  onSelectTimestamp,
  nowMs,
}) => {
  const [hoveredAlertId, setHoveredAlertId] = useState<number | null>(null);
  const referenceNow = nowMs ?? Date.now();
  const windowStart = referenceNow - WINDOW_24H_MS;

  // Generate 9 hour ticks every 3 hours (-24h, -21h, -18h, ..., 0h)
  const hourTicks = useMemo(() => {
    return Array.from({ length: 9 }, (_, i) => {
      const hoursAgo = 24 - i * 3;
      const tickMs = referenceNow - hoursAgo * 3600_000;
      const pct = (i / 8) * 100;
      const d = new Date(tickMs);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return {
        hoursAgo,
        pct,
        label: hoursAgo === 0 ? 'NOW' : `-${hoursAgo}h (${hh}:${mm})`,
        shortLabel: hoursAgo === 0 ? 'NOW' : `-${hoursAgo}h`,
      };
    });
  }, [referenceNow]);

  const timelineEvents = useMemo(() => {
    return alerts
      .map((alert) => {
        const tsMs = Date.parse(alert.detected_at);
        if (Number.isNaN(tsMs)) return null;
        const clampedMs = Math.max(windowStart, Math.min(referenceNow, tsMs));
        const pct = ((clampedMs - windowStart) / WINDOW_24H_MS) * 100;
        const explanations = parseExplanation(alert.explanation);
        const topReason =
          explanations[0]?.description ??
          `${formatFaultLabel(alert.type)} (${(alert.score * 100).toFixed(0)}% confidence)`;

        const isCritOrHigh = alert.severity === 'critical' || alert.severity === 'high';
        return {
          alert,
          pct: Math.min(98.5, Math.max(1.5, pct)),
          topReason,
          explanations,
          isCritOrHigh,
          glyph:
            alert.severity === 'critical'
              ? '◆'
              : alert.severity === 'high'
                ? '▲'
                : '●',
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.pct - b.pct);
  }, [alerts, windowStart, referenceNow]);

  const activeTooltipItem = useMemo(
    () => timelineEvents.find((e) => e.alert.id === hoveredAlertId) ?? null,
    [timelineEvents, hoveredAlertId],
  );

  return (
    <section
      aria-label="24-hour alert event timeline"
      className="border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-3"
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2 w-2 bg-[#FF4D2D] inline-block"
          />
          <h2 className="text-[11px] font-mono font-semibold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
            24-HOUR INCIDENT TIMELINE // CLICK TICK TO SCRUB OSCILLOSCOPE
          </h2>
        </div>

        <div className="flex items-center gap-3 text-[10px] font-mono text-[#7D899C]">
          <span className="inline-flex items-center gap-1 text-[#FF4D2D]">
            <span>◆</span> CRITICAL
          </span>
          <span className="inline-flex items-center gap-1 text-[#FF4D2D]">
            <span>▲</span> HIGH
          </span>
          <span className="inline-flex items-center gap-1 text-[#F59E0B]">
            <span>●</span> MED/LOW
          </span>
          <span className="text-[#11141C] dark:text-[#E6E9EF] font-semibold">
            {timelineEvents.length} EVENTS
          </span>
        </div>
      </div>

      {/* Horizontal 24h Strip */}
      <div className="relative h-14 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE] dark:bg-[#07090D] px-2 select-none">
        {/* Horizontal Center Rail */}
        <div
          aria-hidden="true"
          className="absolute left-2 right-2 top-6 h-[1px] bg-[#C8CDD6] dark:bg-[#1E2633]"
        />

        {/* 3-Hour Division Ticks and Labels */}
        {hourTicks.map((tick) => (
          <div
            key={tick.hoursAgo}
            style={{ left: `${tick.pct}%` }}
            className="absolute top-0 bottom-0 -translate-x-1/2 flex flex-col justify-between pointer-events-none"
          >
            <div className="h-2.5 w-[1px] bg-[#7D899C]/40 mx-auto" />
            <span
              data-testid={`timeline-hour-${tick.hoursAgo}`}
              className="text-[9px] font-mono text-[#7D899C] pb-1 whitespace-nowrap"
            >
              {tick.shortLabel}
            </span>
          </div>
        ))}

        {/* Alert Event Ticks */}
        {timelineEvents.map(({ alert, pct, topReason, isCritOrHigh, glyph }) => {
          const isSelected = selectedTimestamp === alert.detected_at;
          const color = isCritOrHigh ? TOKENS.colors.alert : TOKENS.colors.signal;

          return (
            <button
              key={alert.id}
              type="button"
              data-testid={`alert-tick-${alert.id}`}
              aria-label={`${alert.severity.toUpperCase()} alert: ${formatFaultLabel(alert.type)} at ${formatTimeShort(alert.detected_at)}. ${topReason}`}
              style={{ left: `${pct}%` }}
              onMouseEnter={() => setHoveredAlertId(alert.id)}
              onMouseLeave={() => setHoveredAlertId((prev) => (prev === alert.id ? null : prev))}
              onFocus={() => setHoveredAlertId(alert.id)}
              onBlur={() => setHoveredAlertId((prev) => (prev === alert.id ? null : prev))}
              onClick={() => onSelectTimestamp(alert.detected_at, alert)}
              className={clsx(
                'absolute top-1.5 -translate-x-1/2 z-10 flex flex-col items-center group focus:outline-none',
              )}
            >
              <span
                style={{
                  borderColor: color,
                  color,
                  backgroundColor: isSelected
                    ? color
                    : isCritOrHigh
                      ? TOKENS.colors.alertDim
                      : TOKENS.colors.signalDim,
                }}
                className={clsx(
                  'px-1.5 py-0.5 text-[10px] font-mono font-bold border transition-transform group-hover:scale-110 group-focus:ring-1 group-focus:ring-[#F59E0B]',
                  isSelected && 'text-[#07090D] scale-110',
                )}
              >
                {glyph}
              </span>
              <span
                style={{ backgroundColor: color }}
                className="w-[2px] h-3.5"
              />
            </button>
          );
        })}
      </div>

      {/* Hover / Focus Explanation Readout Bar */}
      <div
        role="status"
        aria-live="polite"
        className="mt-2 min-h-[26px] px-2.5 py-1 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#E7E9E2]/60 dark:bg-[#121822]/70 flex items-center justify-between gap-3 text-xs font-mono"
      >
        {activeTooltipItem ? (
          <>
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={clsx(
                  'px-1.5 py-0.5 text-[10px] font-bold uppercase border shrink-0',
                  activeTooltipItem.isCritOrHigh
                    ? 'border-[#FF4D2D] text-[#FF4D2D] bg-[#FF4D2D]/15'
                    : 'border-[#F59E0B] text-[#F59E0B] bg-[#F59E0B]/15',
                )}
              >
                {activeTooltipItem.glyph} {activeTooltipItem.alert.severity} ·{' '}
                {formatFaultLabel(activeTooltipItem.alert.type)}
              </span>
              <span className="truncate text-[#11141C] dark:text-[#E6E9EF]">
                {activeTooltipItem.topReason}
              </span>
            </div>
            <span className="text-[11px] text-[#7D899C] shrink-0">
              {formatTimeShort(activeTooltipItem.alert.detected_at)} · CLICK TO JUMP
            </span>
          </>
        ) : (
          <span className="text-[11px] text-[#7D899C]">
            HOVER AN INCIDENT TICK FOR ROOT-CAUSE EXPLANATION · CLICK TO LOCK OSCILLOSCOPE SWEEP CURSOR
          </span>
        )}
      </div>
    </section>
  );
};
