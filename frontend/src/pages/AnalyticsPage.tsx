import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { X } from 'lucide-react';
import clsx from 'clsx';
import {
  ANALYTICS_FEEDERS,
  DAY_NAMES,
  DAY_SHORT_NAMES,
  computeEnergyLossTodayKwh,
  energyLossSeries,
  estimateEnergyLossKwh,
  faultHeatmap,
  faultsByType,
  feederComparison,
  filterAlertsByRangeAndFeeder,
  formatIstTimestamp,
  getAlertDayAndHour,
  type AnalyticsRangeKey,
  type EnergyLossPoint,
  type FaultTypeBreakdownItem,
  type FeederComparisonItem,
  type FeederFilterKey,
  type HeatmapCellData,
} from '../analytics/aggregate';
import { SeverityBadge, StatusBadge } from '../components/Badges';
import { LiveValue } from '../components/LiveValue';
import { useTelemetry } from '../context/TelemetryContext';
import { TOKENS } from '../design/tokens';
import type { Alert } from '../types';
import { formatFaultLabel } from '../utils/format';

const RANGE_OPTIONS: readonly { value: AnalyticsRangeKey; label: string }[] = [
  { value: '7d', label: '7D' },
  { value: '14d', label: '14D' },
  { value: '30d', label: '30D' },
];

const FEEDER_OPTIONS: readonly { value: FeederFilterKey; label: string }[] = [
  { value: 'all', label: 'All Feeders' },
  { value: '01', label: 'Feeder 01 (FDR-01)' },
  { value: '02', label: 'Feeder 02 (FDR-02)' },
  { value: '03', label: 'Feeder 03 (FDR-03)' },
];

function parseRangeParam(raw: string | null): AnalyticsRangeKey {
  if (raw === '14d' || raw === '30d' || raw === '7d') return raw;
  return '7d';
}

function parseFeederParam(raw: string | null): FeederFilterKey {
  const normalized = (raw || '').trim().toUpperCase();
  if (normalized === '01' || normalized === 'FDR-01') return '01';
  if (normalized === '02' || normalized === 'FDR-02') return '02';
  if (normalized === '03' || normalized === 'FDR-03') return '03';
  return 'all';
}

interface DailyEnergyLossChartProps {
  series: EnergyLossPoint[];
  range: AnalyticsRangeKey;
  feeder: FeederFilterKey;
}

const DailyEnergyLossChart: React.FC<DailyEnergyLossChartProps> = React.memo(
  ({ series, range, feeder }) => {
    const gradientId = useId().replace(/:/g, '');
    const [activeIdx, setActiveIdx] = useState<number | null>(null);

    const chart = useMemo(() => {
      const width = 720;
      const height = 220;
      const padL = 48;
      const padR = 16;
      const padT = 18;
      const padB = 30;
      const plotW = width - padL - padR;
      const plotH = height - padT - padB;

      const rawMax = Math.max(0, ...series.map((p) => p.lossKwh));
      const yMax = rawMax > 0 ? Math.ceil(rawMax * 1.18 * 10) / 10 : 10;

      const points = series.map((pt, idx) => {
        const x =
          series.length <= 1
            ? padL + plotW / 2
            : padL + (idx / (series.length - 1)) * plotW;
        const y = padT + plotH - (pt.lossKwh / yMax) * plotH;
        return {
          ...pt,
          x: Math.round(x * 10) / 10,
          y: Math.round(y * 10) / 10,
        };
      });

      const linePath = points
        .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${p.x},${p.y}`)
        .join(' ');
      const firstX = points[0]?.x ?? padL;
      const lastX = points[points.length - 1]?.x ?? padL + plotW;
      const baselineY = padT + plotH;
      const areaPath =
        points.length > 0
          ? `${linePath} L${lastX},${baselineY} L${firstX},${baselineY} Z`
          : '';

      const tickStep = range === '7d' ? 1 : range === '14d' ? 2 : 5;
      const xTicks = points.filter(
        (_, idx) => idx === 0 || idx === points.length - 1 || idx % tickStep === 0,
      );

      const yTicks = [0, 0.5, 1].map((frac) => ({
        value: Math.round(yMax * frac * 10) / 10,
        y: Math.round((padT + plotH - frac * plotH) * 10) / 10,
      }));

      let peakPoint: EnergyLossPoint | null = null;
      let totalLoss = 0;
      for (const p of series) {
        totalLoss += p.lossKwh;
        if (!peakPoint || p.lossKwh > peakPoint.lossKwh) peakPoint = p;
      }

      return {
        width,
        height,
        padL,
        padR,
        padT,
        baselineY,
        points,
        linePath,
        areaPath,
        xTicks,
        yTicks,
        peakPoint,
        totalLoss: Math.round(totalLoss * 100) / 100,
      };
    }, [series, range]);

    const hovered =
      activeIdx !== null && chart.points[activeIdx]
        ? chart.points[activeIdx]
        : chart.points[chart.points.length - 1] ?? null;

    const summaryText =
      chart.totalLoss === 0
        ? `No estimated power-theft energy loss recorded across the selected ${range} window${feeder === 'all' ? '' : ` on Feeder ${feeder}`}.`
        : `Estimated unbilled loss totals ${chart.totalLoss.toFixed(2)} kWh over ${range}${feeder === 'all' ? '' : ` on Feeder ${feeder}`}, peaking at ${(chart.peakPoint?.lossKwh ?? 0).toFixed(2)} kWh on ${chart.peakPoint?.label ?? '—'}.`;

    return (
      <section
        aria-label="Daily estimated energy loss chart"
        className="min-w-0 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-3 sm:p-4 flex flex-col gap-2.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#C8CDD6] dark:border-[#1E2633] pb-2">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
              DAILY ESTIMATED ENERGY LOSS
            </h2>
            <p className="text-xs text-[#576070] dark:text-[#7D899C] mt-0.5">{summaryText}</p>
          </div>
          {hovered && (
            <div
              data-testid="loss-chart-readout"
              className="px-2 py-1 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE] dark:bg-[#121822] font-mono text-[11px] tabular-nums flex items-center gap-2 shrink-0"
            >
              <span className="text-[#576070] dark:text-[#7D899C]">
                {hovered.isToday ? `${hovered.label} (TODAY)` : hovered.label}
              </span>
              <span className="font-bold text-[#FF4D2D]">{hovered.lossKwh.toFixed(2)} kWh</span>
              <span className="text-[#576070] dark:text-[#7D899C]">
                {hovered.theftAlertsCount} theft
              </span>
            </div>
          )}
        </div>

        <div className="relative w-full overflow-hidden">
          <svg
            data-testid="energy-loss-svg"
            role="img"
            aria-label={`Daily estimated energy loss area chart over ${range}. ${summaryText}`}
            viewBox={`0 0 ${chart.width} ${chart.height}`}
            className="w-full h-[200px] sm:h-[220px] select-none"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={TOKENS.colors.alert} stopOpacity="0.34" />
                <stop offset="100%" stopColor={TOKENS.colors.alert} stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {chart.yTicks.map((tick) => (
              <g key={tick.value}>
                <line
                  x1={chart.padL}
                  y1={tick.y}
                  x2={chart.width - chart.padR}
                  y2={tick.y}
                  stroke="currentColor"
                  className="text-[#C8CDD6] dark:text-[#1E2633]"
                  strokeDasharray="3 3"
                  strokeWidth={1}
                />
                <text
                  x={chart.padL - 8}
                  y={tick.y}
                  textAnchor="end"
                  dominantBaseline="central"
                  className="fill-[#576070] dark:fill-[#7D899C] font-mono text-[10px]"
                >
                  {tick.value.toFixed(1)}
                </text>
              </g>
            ))}

            {chart.areaPath && <path d={chart.areaPath} fill={`url(#${gradientId})`} />}

            {chart.linePath && (
              <path
                d={chart.linePath}
                fill="none"
                stroke={TOKENS.colors.alert}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            )}

            {hovered && (
              <line
                x1={hovered.x}
                y1={chart.padT}
                x2={hovered.x}
                y2={chart.baselineY}
                stroke={TOKENS.colors.signal}
                strokeWidth={1}
                strokeDasharray="3 2"
              />
            )}

            {chart.points.map((pt, idx) => {
              const isActive =
                activeIdx === idx || (activeIdx === null && idx === chart.points.length - 1);
              return (
                <g
                  key={pt.dateKey}
                  tabIndex={0}
                  role="button"
                  aria-label={`${pt.label}: ${pt.lossKwh.toFixed(2)} kWh across ${pt.theftAlertsCount} theft alerts`}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onFocus={() => setActiveIdx(idx)}
                  onMouseLeave={() => setActiveIdx(null)}
                  className="cursor-pointer focus:outline-none"
                >
                  <rect
                    x={pt.x - 10}
                    y={chart.padT}
                    width={20}
                    height={chart.baselineY - chart.padT}
                    fill="transparent"
                  />
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={isActive ? 4.5 : pt.lossKwh > 0 ? 3 : 2}
                    fill={isActive ? TOKENS.colors.signal : TOKENS.colors.alert}
                    stroke={TOKENS.colors.dark.bg}
                    strokeWidth={1}
                  />
                </g>
              );
            })}

            {chart.xTicks.map((tick) => (
              <text
                key={tick.dateKey}
                x={tick.x}
                y={chart.height - 8}
                textAnchor="middle"
                className={clsx(
                  'font-mono text-[10px]',
                  tick.isToday
                    ? 'fill-[#F59E0B] font-bold'
                    : 'fill-[#576070] dark:fill-[#7D899C]',
                )}
              >
                {tick.isToday ? 'TODAY' : tick.shortLabel}
              </text>
            ))}
          </svg>
        </div>

        <table className="sr-only">
          <caption>Daily estimated energy loss table</caption>
          <thead>
            <tr>
              <th>Date</th>
              <th>Estimated Loss (kWh)</th>
              <th>Power Theft Alerts</th>
              <th>Total Alerts</th>
            </tr>
          </thead>
          <tbody>
            {series.map((pt) => (
              <tr key={pt.dateKey}>
                <td>{pt.dateKey}</td>
                <td>{pt.lossKwh.toFixed(2)}</td>
                <td>{pt.theftAlertsCount}</td>
                <td>{pt.totalAlertsCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    );
  },
);

DailyEnergyLossChart.displayName = 'DailyEnergyLossChart';

interface FaultBreakdownPanelProps {
  breakdown: FaultTypeBreakdownItem[];
  totalAlerts: number;
}

const FaultBreakdownPanel: React.FC<FaultBreakdownPanelProps> = React.memo(
  ({ breakdown, totalAlerts }) => {
    const topItem = breakdown[0] ?? null;
    const summaryText =
      totalAlerts === 0
        ? 'No fault events in this filter window.'
        : `${topItem?.label ?? 'Faults'} leads at ${topItem?.sharePct.toFixed(1) ?? '0.0'}% (${topItem?.count ?? 0} of ${totalAlerts} incidents).`;

    return (
      <section
        aria-label="Fault breakdown by type"
        className="min-w-0 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-3 sm:p-4 flex flex-col gap-3"
      >
        <div className="border-b border-[#C8CDD6] dark:border-[#1E2633] pb-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
              FAULTS BY TYPE
            </h2>
            <span className="font-mono text-[10px] text-[#576070] dark:text-[#7D899C] tabular-nums">
              {totalAlerts} TOTAL
            </span>
          </div>
          <p className="text-xs text-[#576070] dark:text-[#7D899C] mt-0.5">{summaryText}</p>
        </div>

        {breakdown.length === 0 ? (
          <div className="py-8 text-center font-mono text-xs text-[#7D899C]">
            NO FAULTS RECORDED IN WINDOW
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {breakdown.map((item) => {
              const critPct = totalAlerts > 0 ? (item.severities.critical / item.count) * 100 : 0;
              const highPct = totalAlerts > 0 ? (item.severities.high / item.count) * 100 : 0;
              const medPct = totalAlerts > 0 ? (item.severities.medium / item.count) * 100 : 0;
              const lowPct = totalAlerts > 0 ? (item.severities.low / item.count) * 100 : 0;
              const barScale = topItem && topItem.count > 0 ? (item.count / topItem.count) * 100 : 0;

              return (
                <div key={item.type} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-2 font-mono text-xs">
                    <span className="font-semibold text-[#11141C] dark:text-[#E6E9EF] truncate">
                      {item.label}
                    </span>
                    <span className="tabular-nums text-[#576070] dark:text-[#7D899C] shrink-0">
                      <strong className="text-[#11141C] dark:text-[#E6E9EF]">{item.count}</strong> (
                      {item.sharePct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="h-2.5 w-full bg-[#E7E9E2] dark:bg-[#121822] border border-[#C8CDD6]/70 dark:border-[#1E2633] overflow-hidden">
                    <div
                      style={{ width: `${Math.max(4, barScale)}%` }}
                      className="h-full flex"
                      aria-hidden="true"
                    >
                      {critPct > 0 && (
                        <span
                          style={{ width: `${critPct}%`, backgroundColor: TOKENS.colors.alert }}
                          className="h-full"
                        />
                      )}
                      {highPct > 0 && (
                        <span
                          style={{ width: `${highPct}%`, backgroundColor: TOKENS.colors.signal }}
                          className="h-full"
                        />
                      )}
                      {medPct > 0 && (
                        <span
                          style={{
                            width: `${medPct}%`,
                            backgroundColor: TOKENS.colors.phases.B.color,
                          }}
                          className="h-full"
                        />
                      )}
                      {lowPct > 0 && (
                        <span
                          style={{
                            width: `${lowPct}%`,
                            backgroundColor: TOKENS.colors.neutral,
                          }}
                          className="h-full"
                        />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="pt-2 border-t border-[#C8CDD6] dark:border-[#1E2633] flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-[#576070] dark:text-[#7D899C]">
              <span className="inline-flex items-center gap-1">
                <span style={{ color: TOKENS.colors.alert }} aria-hidden="true">
                  ◆
                </span>{' '}
                CRITICAL
              </span>
              <span className="inline-flex items-center gap-1">
                <span style={{ color: TOKENS.colors.signal }} aria-hidden="true">
                  ▲
                </span>{' '}
                HIGH
              </span>
              <span className="inline-flex items-center gap-1">
                <span style={{ color: TOKENS.colors.phases.B.color }} aria-hidden="true">
                  ●
                </span>{' '}
                MEDIUM
              </span>
              <span className="inline-flex items-center gap-1">
                <span style={{ color: TOKENS.colors.neutral }} aria-hidden="true">
                  ○
                </span>{' '}
                LOW
              </span>
            </div>
          </div>
        )}

        <table className="sr-only">
          <caption>Fault breakdown by type table</caption>
          <thead>
            <tr>
              <th>Fault Type</th>
              <th>Count</th>
              <th>Share (%)</th>
              <th>Critical</th>
              <th>High</th>
              <th>Medium</th>
              <th>Low</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((item) => (
              <tr key={item.type}>
                <td>{item.label}</td>
                <td>{item.count}</td>
                <td>{item.sharePct.toFixed(1)}%</td>
                <td>{item.severities.critical}</td>
                <td>{item.severities.high}</td>
                <td>{item.severities.medium}</td>
                <td>{item.severities.low}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    );
  },
);

FaultBreakdownPanel.displayName = 'FaultBreakdownPanel';

interface HeatmapSelection {
  dayIndex: number;
  hour: number;
}

interface FaultHeatmapPanelProps {
  matrix: HeatmapCellData[][];
  selectedCell: HeatmapSelection | null;
  onSelectCell: (cell: HeatmapSelection | null) => void;
}

const FaultHeatmapPanel: React.FC<FaultHeatmapPanelProps> = React.memo(
  ({ matrix, selectedCell, onSelectCell }) => {
    const [focusPos, setFocusPos] = useState<HeatmapSelection>({ dayIndex: 0, hour: 0 });
    const cellRefs = useRef<Record<string, SVGGElement | null>>({});

    const { maxCount, peakCell, totalInGrid } = useMemo(() => {
      let max = 0;
      let total = 0;
      let peak: HeatmapCellData | null = null;
      for (const row of matrix) {
        for (const cell of row) {
          total += cell.count;
          if (cell.count > max) {
            max = cell.count;
            peak = cell;
          }
        }
      }
      return { maxCount: max, peakCell: peak, totalInGrid: total };
    }, [matrix]);

    const moveFocus = useCallback((nextDay: number, nextHour: number) => {
      const clampedDay = ((nextDay % 7) + 7) % 7;
      const clampedHour = ((nextHour % 24) + 24) % 24;
      setFocusPos({ dayIndex: clampedDay, hour: clampedHour });
      const node = cellRefs.current[`${clampedDay}-${clampedHour}`];
      if (node && typeof node.focus === 'function') {
        node.focus();
      }
    }, []);

    const summaryText =
      totalInGrid === 0 || !peakCell
        ? 'No faults recorded across any day or hour in this window.'
        : `Peak activity occurs ${DAY_NAMES[peakCell.dayIndex]} ${String(peakCell.hour).padStart(2, '0')}:00 IST (${peakCell.count} ${peakCell.count === 1 ? 'fault' : 'faults'}).`;

    const svgWidth = 792;
    const svgHeight = 224;
    const topPad = 24;
    const cellW = 31;
    const cellH = 24;
    const gap = 2;

    const getCellAppearance = (count: number) => {
      if (count <= 0 || maxCount <= 0) {
        return {
          fill: 'transparent',
          textColor: TOKENS.colors.neutral,
          tier: 'none',
        };
      }
      const ratio = count / maxCount;
      if (ratio > 0.66) {
        return {
          fill: TOKENS.colors.alert,
          fillOpacity: 0.78,
          textColor: '#FFFFFF',
          tier: 'high',
        };
      }
      if (ratio > 0.33) {
        return {
          fill: TOKENS.colors.signal,
          fillOpacity: 0.52,
          textColor: '#11141C',
          tier: 'med',
        };
      }
      return {
        fill: TOKENS.colors.signal,
        fillOpacity: 0.22,
        textColor: '#F59E0B',
        tier: 'low',
      };
    };

    return (
      <section
        aria-label="Day by hour fault heatmap"
        className="min-w-0 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-3 sm:p-4 flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#C8CDD6] dark:border-[#1E2633] pb-2">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
              DAY × HOUR FAULT HEATMAP (IST · ASIA/KOLKATA)
            </h2>
            <p className="text-xs text-[#576070] dark:text-[#7D899C] mt-0.5">{summaryText}</p>
          </div>
          <span className="font-mono text-[10px] text-[#576070] dark:text-[#7D899C] uppercase">
            SELECT CELL OR ENTER TO FILTER · ESC CLEAR
          </span>
        </div>

        {/* Horizontally scrollable below md while pinning MON-SUN day labels on the left */}
        <div
          data-testid="heatmap-scroll-wrapper"
          className="w-full overflow-x-auto pb-1"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && selectedCell) {
              e.preventDefault();
              onSelectCell(null);
            }
          }}
        >
          <div className="flex w-max min-w-full items-start">
            {/* Pinned sticky day labels */}
            <svg
              data-testid="heatmap-day-labels"
              aria-hidden="true"
              viewBox={`0 0 42 ${svgHeight}`}
              className="sticky left-0 z-10 w-[42px] h-[224px] shrink-0 bg-[#FFFFFF] dark:bg-[#0C1017] border-r border-[#C8CDD6]/40 dark:border-[#1E2633] select-none"
            >
              {DAY_SHORT_NAMES.map((dayShort, dayIndex) => {
                const y = topPad + dayIndex * (cellH + gap);
                return (
                  <text
                    key={dayShort}
                    x={36}
                    y={y + cellH / 2}
                    textAnchor="end"
                    dominantBaseline="central"
                    className="fill-[#576070] dark:fill-[#7D899C] font-mono text-[10.5px] font-semibold uppercase"
                  >
                    {dayShort}
                  </text>
                );
              })}
            </svg>

            <svg
              data-testid="fault-heatmap-svg"
              role="grid"
              aria-label={`Weekly fault density matrix, 7 days by 24 IST hours. ${summaryText}`}
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="w-[792px] h-[224px] shrink-0 block select-none"
            >
              {/* Hour Column Labels */}
              {Array.from({ length: 24 }, (_, hour) => (
                <text
                  key={`hdr-${hour}`}
                  x={4 + hour * (cellW + gap) + cellW / 2}
                  y={14}
                  textAnchor="middle"
                  className="fill-[#576070] dark:fill-[#7D899C] font-mono text-[9.5px]"
                >
                  {String(hour).padStart(2, '0')}
                </text>
              ))}

              {/* 7 Day Rows x 24 Hour Cells = 168 Cells */}
              {matrix.map((row, dayIndex) => {
                const y = topPad + dayIndex * (cellH + gap);
                return (
                  <g key={DAY_SHORT_NAMES[dayIndex]}>
                    {row.map((cell) => {
                      const x = 4 + cell.hour * (cellW + gap);
                    const isSelected =
                      selectedCell?.dayIndex === cell.dayIndex &&
                      selectedCell?.hour === cell.hour;
                    const isRovingFocus =
                      focusPos.dayIndex === cell.dayIndex && focusPos.hour === cell.hour;
                    const appearance = getCellAppearance(cell.count);

                    return (
                      <g
                        key={`${cell.dayIndex}-${cell.hour}`}
                        ref={(el) => {
                          cellRefs.current[`${cell.dayIndex}-${cell.hour}`] = el;
                        }}
                        data-testid={`heatmap-cell-${cell.dayIndex}-${cell.hour}`}
                        role="button"
                        tabIndex={isRovingFocus ? 0 : -1}
                        aria-pressed={isSelected}
                        aria-label={`${DAY_NAMES[cell.dayIndex]} ${String(cell.hour).padStart(2, '0')}:00, ${cell.count} ${cell.count === 1 ? 'fault' : 'faults'}`}
                        onClick={() =>
                          onSelectCell(
                            isSelected
                              ? null
                              : { dayIndex: cell.dayIndex, hour: cell.hour },
                          )
                        }
                        onFocus={() =>
                          setFocusPos({ dayIndex: cell.dayIndex, hour: cell.hour })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'ArrowRight') {
                            e.preventDefault();
                            moveFocus(cell.dayIndex, cell.hour + 1);
                          } else if (e.key === 'ArrowLeft') {
                            e.preventDefault();
                            moveFocus(cell.dayIndex, cell.hour - 1);
                          } else if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            moveFocus(cell.dayIndex + 1, cell.hour);
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            moveFocus(cell.dayIndex - 1, cell.hour);
                          } else if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelectCell(
                              isSelected
                                ? null
                                : { dayIndex: cell.dayIndex, hour: cell.hour },
                            );
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            onSelectCell(null);
                          }
                        }}
                        className="cursor-pointer focus:outline-none"
                      >
                        <rect
                          x={x}
                          y={y}
                          width={cellW}
                          height={cellH}
                          rx={2}
                          fill={appearance.fill}
                          fillOpacity={appearance.fillOpacity ?? 1}
                          stroke={
                            isSelected
                              ? TOKENS.colors.phases.B.color
                              : isRovingFocus
                                ? TOKENS.colors.signal
                                : 'currentColor'
                          }
                          strokeWidth={isSelected || isRovingFocus ? 1.75 : 0.75}
                          className={
                            isSelected || isRovingFocus
                              ? ''
                              : 'text-[#C8CDD6] dark:text-[#1E2633]'
                          }
                        />
                        {cell.count > 0 && (
                          <text
                            x={x + cellW / 2}
                            y={y + cellH / 2}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill={appearance.textColor}
                            className="font-mono text-[10px] font-bold pointer-events-none"
                          >
                            {cell.count}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}
            </svg>
          </div>
        </div>

        {/* Accessible tabular mirror for screen readers */}
        <table className="sr-only">
          <caption>Fault counts by IST day and hour</caption>
          <thead>
            <tr>
              <th>Day</th>
              <th>Hour (IST)</th>
              <th>Fault Count</th>
            </tr>
          </thead>
          <tbody>
            {matrix.flatMap((row) =>
              row
                .filter((c) => c.count > 0)
                .map((c) => (
                  <tr key={`${c.dayIndex}-${c.hour}`}>
                    <td>{DAY_NAMES[c.dayIndex]}</td>
                    <td>{`${String(c.hour).padStart(2, '0')}:00`}</td>
                    <td>{c.count}</td>
                  </tr>
                )),
            )}
          </tbody>
        </table>
      </section>
    );
  },
);

FaultHeatmapPanel.displayName = 'FaultHeatmapPanel';

interface FeederComparisonPanelProps {
  rows: FeederComparisonItem[];
  activeFeeder: FeederFilterKey;
  onSelectFeeder: (feeder: FeederFilterKey) => void;
}

const FeederComparisonPanel: React.FC<FeederComparisonPanelProps> = React.memo(
  ({ rows, activeFeeder, onSelectFeeder }) => {
    const worst = rows.find((r) => r.isWorst) ?? null;
    const summaryText = worst
      ? `${worst.feederId} shows the highest fault impact with ${worst.lossKwh.toFixed(2)} kWh lost and ${worst.healthScore}% health.`
      : 'All feeders operating cleanly in the selected window.';

    return (
      <section
        aria-label="Feeder comparison"
        className="min-w-0 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-3 sm:p-4 flex flex-col gap-3"
      >
        <div className="border-b border-[#C8CDD6] dark:border-[#1E2633] pb-2">
          <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
            FEEDER COMPARISON
          </h2>
          <p className="text-xs text-[#576070] dark:text-[#7D899C] mt-0.5">{summaryText}</p>
        </div>

        <div className="flex flex-col gap-2.5">
          {rows.map((row) => {
            const isActiveFilter = activeFeeder === row.feederShortId;
            return (
              <button
                key={row.feederId}
                type="button"
                data-testid={`feeder-row-${row.feederShortId}`}
                onClick={() =>
                  onSelectFeeder(isActiveFilter ? 'all' : row.feederShortId)
                }
                aria-pressed={isActiveFilter}
                className={clsx(
                  'w-full text-left p-2.5 border transition-colors focus:outline-none focus:ring-2 focus:ring-[#F59E0B]',
                  row.isWorst
                    ? 'border-[#FF4D2D] bg-[#FF4D2D]/[0.08]'
                    : isActiveFilter
                      ? 'border-[#F59E0B] bg-[#F59E0B]/10'
                      : 'border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE]/60 dark:bg-[#121822]/60 hover:border-[#F59E0B]/60',
                )}
              >
                <div className="flex items-center justify-between gap-2 font-mono text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-bold text-[#11141C] dark:text-[#E6E9EF] truncate">
                      {row.feederName}
                    </span>
                    {row.isWorst && (
                      <span
                        data-testid={`worst-feeder-badge-${row.feederShortId}`}
                        className="px-1.5 py-0.5 text-[10px] font-bold uppercase border border-[#FF4D2D] text-[#FF4D2D] bg-[#FF4D2D]/15 shrink-0"
                      >
                        ▲ WORST FEEDER
                      </span>
                    )}
                  </div>
                  <span
                    className={clsx(
                      'font-bold tabular-nums shrink-0',
                      row.healthScore < 65
                        ? 'text-[#FF4D2D]'
                        : row.healthScore < 85
                          ? 'text-[#F59E0B]'
                          : 'text-[#11141C] dark:text-[#E6E9EF]',
                    )}
                  >
                    {row.healthScore}% HEALTH
                  </span>
                </div>

                {/* Health Bar */}
                <div className="mt-2 h-1.5 w-full bg-[#C8CDD6]/50 dark:bg-[#1E2633] overflow-hidden">
                  <div
                    style={{
                      width: `${row.healthScore}%`,
                      backgroundColor:
                        row.healthScore < 65
                          ? TOKENS.colors.alert
                          : TOKENS.colors.signal,
                    }}
                    className="h-full transition-all duration-300"
                  />
                </div>

                <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px] tabular-nums text-[#576070] dark:text-[#7D899C]">
                  <div>
                    FAULTS:{' '}
                    <strong className="text-[#11141C] dark:text-[#E6E9EF]">
                      {row.totalFaults}
                    </strong>{' '}
                    ({row.openFaults} open)
                  </div>
                  <div>
                    /METER:{' '}
                    <strong className="text-[#11141C] dark:text-[#E6E9EF]">
                      {row.faultsPerMeter.toFixed(1)}
                    </strong>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    LOSS:{' '}
                    <strong className="text-[#FF4D2D]">
                      {row.lossKwh.toFixed(2)} kWh
                    </strong>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <table className="sr-only">
          <caption>Feeder health comparison table</caption>
          <thead>
            <tr>
              <th>Feeder</th>
              <th>Total Faults</th>
              <th>Open Faults</th>
              <th>Faults per Meter</th>
              <th>Estimated Loss (kWh)</th>
              <th>Health Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.feederId}>
                <td>{row.feederName}</td>
                <td>{row.totalFaults}</td>
                <td>{row.openFaults}</td>
                <td>{row.faultsPerMeter.toFixed(2)}</td>
                <td>{row.lossKwh.toFixed(2)}</td>
                <td>{row.healthScore}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    );
  },
);

FeederComparisonPanel.displayName = 'FeederComparisonPanel';

export const AnalyticsPage: React.FC = () => {
  const { alerts } = useTelemetry();
  const [searchParams, setSearchParams] = useSearchParams();

  const range = parseRangeParam(searchParams.get('range'));
  const feeder = parseFeederParam(searchParams.get('feeder'));
  const [selectedCell, setSelectedCell] = useState<HeatmapSelection | null>(null);

  // Stabilize reference timestamp when alerts array updates so 1 Hz reading ticks do not recompute charts
  const referenceNowMs = useMemo(() => Date.now(), [alerts]);

  const setFilters = useCallback(
    (nextRange: AnalyticsRangeKey, nextFeeder: FeederFilterKey) => {
      setSearchParams(
        {
          range: nextRange,
          feeder: nextFeeder,
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Global Escape clears active heatmap drill-down filter
  useEffect(() => {
    if (!selectedCell) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedCell(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedCell]);

  // Memoize all heavy analytics computations solely on [alerts, range, feeder]
  const aggregated = useMemo(() => {
    const filteredAlerts = filterAlertsByRangeAndFeeder(alerts, range, feeder, referenceNowMs);
    const heatmapMatrix = faultHeatmap(filteredAlerts);
    const breakdown = faultsByType(filteredAlerts);
    const lossSeries = energyLossSeries(filteredAlerts, range, 'day', referenceNowMs);
    const rangeWindowOnly = filterAlertsByRangeAndFeeder(alerts, range, 'all', referenceNowMs);
    const feeders = feederComparison(rangeWindowOnly);
    const todayLossKwh = computeEnergyLossTodayKwh(alerts, referenceNowMs);

    const rangeLossKwh =
      Math.round(lossSeries.reduce((sum, pt) => sum + pt.lossKwh, 0) * 100) / 100;
    const openCount = filteredAlerts.filter((a) => a.status !== 'closed').length;

    let peakCell: HeatmapCellData | null = null;
    for (const row of heatmapMatrix) {
      for (const cell of row) {
        if (!peakCell || cell.count > peakCell.count) {
          peakCell = cell;
        }
      }
    }

    return {
      filteredAlerts,
      heatmapMatrix,
      breakdown,
      lossSeries,
      feeders,
      todayLossKwh,
      rangeLossKwh,
      openCount,
      peakCell,
    };
  }, [alerts, range, feeder, referenceNowMs]);

  const cellDrilldownAlerts: Alert[] = useMemo(() => {
    if (!selectedCell) return [];
    return aggregated.filteredAlerts
      .filter((alert) => {
        const coords = getAlertDayAndHour(alert.detected_at);
        return (
          coords !== null &&
          coords.dayIndex === selectedCell.dayIndex &&
          coords.hour === selectedCell.hour
        );
      })
      .sort((a, b) => Date.parse(b.detected_at) - Date.parse(a.detected_at));
  }, [aggregated.filteredAlerts, selectedCell]);

  return (
    <div className="flex-1 flex flex-col bg-[#F2F3EE] dark:bg-[#07090D] text-[#11141C] dark:text-[#E6E9EF] overflow-x-hidden">
      {/* Header & Filter Bar */}
      <header className="px-4 py-3 border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="font-['Space_Grotesk',sans-serif] text-base font-bold tracking-wider uppercase">
            ANALYTICS
          </h1>
          <span className="px-2 py-0.5 font-mono text-[11px] font-bold uppercase border border-[#F59E0B]/50 bg-[#F59E0B]/10 text-[#F59E0B] tabular-nums">
            {aggregated.filteredAlerts.length} FAULTS · {range.toUpperCase()}
          </span>
          {feeder !== 'all' && (
            <span className="px-2 py-0.5 font-mono text-[11px] uppercase border border-[#00E5FF]/50 bg-[#00E5FF]/10 text-[#00E5FF]">
              FDR-{feeder}
            </span>
          )}
          <span
            data-testid="analytics-simulated-badge"
            className="px-2 py-0.5 font-mono text-[10px] uppercase border border-[#C8CDD6] dark:border-[#1E2633] text-[#576070] dark:text-[#7D899C]"
          >
            SIMULATED DEMO HISTORY · IST
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Range Toggle Buttons */}
          <div
            role="group"
            aria-label="Time range"
            className="inline-flex border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE] dark:bg-[#07090D]"
          >
            {RANGE_OPTIONS.map((opt) => {
              const active = range === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilters(opt.value, feeder)}
                  className={clsx(
                    'px-3 py-1 font-mono text-xs font-semibold uppercase transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[#F59E0B]',
                    active
                      ? 'bg-[#F59E0B] text-[#11141C]'
                      : 'text-[#576070] dark:text-[#7D899C] hover:text-[#F59E0B]',
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          {/* Feeder Filter Select */}
          <div className="flex items-center gap-2">
            <label
              htmlFor="analytics-feeder-select"
              className="font-mono text-[10px] uppercase tracking-wider text-[#576070] dark:text-[#7D899C]"
            >
              Feeder
            </label>
            <select
              id="analytics-feeder-select"
              value={feeder}
              onChange={(e) => setFilters(range, parseFeederParam(e.target.value))}
              className="px-2.5 py-1 font-mono text-xs border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#121822] text-[#11141C] dark:text-[#E6E9EF] focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
            >
              {FEEDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </header>

      {/* Main Workspace: Responsive CSS Order ensures mobile stacks KPIs -> Energy Loss -> Breakdown -> Heatmap -> Feeders */}
      <div className="p-3 sm:p-4 flex flex-col lg:grid lg:grid-cols-12 gap-3 sm:gap-4 min-w-0">
        {/* 1. KPI Summary Strip */}
        <section
          aria-label="Analytics summary metrics"
          className="order-1 lg:col-span-12 grid grid-cols-2 lg:grid-cols-4 gap-px border border-[#C8CDD6] dark:border-[#1E2633] bg-[#C8CDD6] dark:bg-[#1E2633]"
        >
          {/* Matches Control Room LOSS TODAY identically */}
          <div className="p-3 flex flex-col justify-between bg-[#FFFFFF] dark:bg-[#0C1017]">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[#576070] dark:text-[#7D899C]">
              LOSS TODAY (GRID)
            </span>
            <LiveValue
              value={aggregated.todayLossKwh}
              decimals={2}
              unit="kWh"
              ariaLabel={`Analytics loss today: ${aggregated.todayLossKwh.toFixed(2)} kWh`}
              className="mt-1 text-xl font-bold text-[#FF4D2D]"
            />
            <span className="font-mono text-[10px] text-[#576070] dark:text-[#7D899C]">
              Matches Control Room KPI
            </span>
          </div>

          <div className="p-3 flex flex-col justify-between bg-[#FFFFFF] dark:bg-[#0C1017]">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[#576070] dark:text-[#7D899C]">
              EST. LOSS ({range.toUpperCase()})
            </span>
            <LiveValue
              value={aggregated.rangeLossKwh}
              decimals={2}
              unit="kWh"
              ariaLabel={`Estimated loss over ${range}: ${aggregated.rangeLossKwh.toFixed(2)} kWh`}
              className="mt-1 text-xl font-bold text-[#F59E0B]"
            />
            <span className="font-mono text-[10px] text-[#576070] dark:text-[#7D899C]">
              {feeder === 'all' ? 'All 3 substation feeders' : `Filtered to FDR-${feeder}`}
            </span>
          </div>

          <div className="p-3 flex flex-col justify-between bg-[#FFFFFF] dark:bg-[#0C1017]">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[#576070] dark:text-[#7D899C]">
              FAULTS IN WINDOW
            </span>
            <div
              data-testid="analytics-fault-count"
              className="mt-1 font-mono text-xl font-bold tabular-nums text-[#11141C] dark:text-[#E6E9EF]"
            >
              {aggregated.filteredAlerts.length}
            </div>
            <span className="font-mono text-[10px] text-[#576070] dark:text-[#7D899C] tabular-nums">
              {aggregated.openCount} active ·{' '}
              {aggregated.filteredAlerts.length - aggregated.openCount} closed
            </span>
          </div>

          <div className="p-3 flex flex-col justify-between bg-[#FFFFFF] dark:bg-[#0C1017]">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[#576070] dark:text-[#7D899C]">
              PEAK HOUR (IST)
            </span>
            <div className="mt-1 font-mono text-xl font-bold tabular-nums text-[#F59E0B]">
              {aggregated.peakCell && aggregated.peakCell.count > 0
                ? `${DAY_SHORT_NAMES[aggregated.peakCell.dayIndex].toUpperCase()} ${String(
                    aggregated.peakCell.hour,
                  ).padStart(2, '0')}:00`
                : '—'}
            </div>
            <span className="font-mono text-[10px] text-[#576070] dark:text-[#7D899C] tabular-nums">
              {aggregated.peakCell && aggregated.peakCell.count > 0
                ? `${aggregated.peakCell.count} faults at peak slot`
                : 'No faults in range'}
            </span>
          </div>
        </section>

        {/* 2. Daily Energy Loss Area Chart */}
        <div className="order-2 lg:col-span-8 min-w-0">
          <DailyEnergyLossChart
            series={aggregated.lossSeries}
            range={range}
            feeder={feeder}
          />
        </div>

        {/* 3. Faults by Type Breakdown */}
        <div className="order-3 lg:col-span-4 min-w-0">
          <FaultBreakdownPanel
            breakdown={aggregated.breakdown}
            totalAlerts={aggregated.filteredAlerts.length}
          />
        </div>

        {/* 4. 7x24 Day x Hour Fault Heatmap + Drill-Down Chip & Table */}
        <div className="order-4 lg:col-span-8 min-w-0 flex flex-col gap-3">
          <FaultHeatmapPanel
            matrix={aggregated.heatmapMatrix}
            selectedCell={selectedCell}
            onSelectCell={setSelectedCell}
          />

          {selectedCell && (
            <section
              aria-label="Selected heatmap slot alerts"
              className="border border-[#00E5FF]/60 bg-[#FFFFFF] dark:bg-[#0C1017] p-3 flex flex-col gap-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-mono text-xs">
                  <span className="text-[#576070] dark:text-[#7D899C] uppercase">
                    SLOT FILTER:
                  </span>
                  <button
                    type="button"
                    data-testid="heatmap-filter-chip"
                    onClick={() => setSelectedCell(null)}
                    aria-label={`Remove filter ${DAY_NAMES[selectedCell.dayIndex]} ${String(selectedCell.hour).padStart(2, '0')}:00`}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 border border-[#00E5FF] bg-[#00E5FF]/10 text-[#00E5FF] font-semibold hover:bg-[#00E5FF]/20 focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
                  >
                    <span>
                      {DAY_NAMES[selectedCell.dayIndex]}{' '}
                      {String(selectedCell.hour).padStart(2, '0')}:00 ({cellDrilldownAlerts.length})
                    </span>
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedCell(null)}
                  className="font-mono text-[11px] uppercase text-[#576070] dark:text-[#7D899C] hover:text-[#F59E0B]"
                >
                  Clear Slot (ESC)
                </button>
              </div>

              {cellDrilldownAlerts.length === 0 ? (
                <p className="font-mono text-xs text-[#7D899C]">
                  No incidents recorded for {DAY_NAMES[selectedCell.dayIndex]}{' '}
                  {String(selectedCell.hour).padStart(2, '0')}:00 IST.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse font-mono text-xs">
                    <thead>
                      <tr className="border-b border-[#C8CDD6] dark:border-[#1E2633] text-[10px] uppercase text-[#576070] dark:text-[#7D899C]">
                        <th className="py-1.5 pr-3">Severity</th>
                        <th className="py-1.5 pr-3">Meter</th>
                        <th className="py-1.5 pr-3">Type</th>
                        <th className="py-1.5 pr-3">Detected (IST)</th>
                        <th className="py-1.5 pr-3">Est. Loss</th>
                        <th className="py-1.5">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#C8CDD6]/60 dark:divide-[#1E2633]/60">
                      {cellDrilldownAlerts.map((alert) => {
                        const loss =
                          alert.type === 'power_theft' ? estimateEnergyLossKwh(alert) : 0;
                        return (
                          <tr key={alert.id}>
                            <td className="py-1.5 pr-3 whitespace-nowrap">
                              <SeverityBadge severity={alert.severity} />
                            </td>
                            <td className="py-1.5 pr-3 whitespace-nowrap">
                              <Link
                                to={`/meters/${encodeURIComponent(alert.meter_id)}`}
                                className="font-bold text-[#F59E0B] hover:underline"
                              >
                                {alert.meter_id}
                              </Link>
                            </td>
                            <td className="py-1.5 pr-3 whitespace-nowrap">
                              {formatFaultLabel(alert.type)}
                            </td>
                            <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums text-[#576070] dark:text-[#7D899C]">
                              {formatIstTimestamp(alert.detected_at)}
                            </td>
                            <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums text-[#FF4D2D]">
                              {loss > 0 ? `${loss.toFixed(2)} kWh` : '—'}
                            </td>
                            <td className="py-1.5 whitespace-nowrap">
                              <StatusBadge status={alert.status} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>

        {/* 5. Feeder Comparison Panel */}
        <div className="order-5 lg:col-span-4 min-w-0">
          <FeederComparisonPanel
            rows={aggregated.feeders}
            activeFeeder={feeder}
            onSelectFeeder={(nextFeeder) => setFilters(range, nextFeeder)}
          />
        </div>

        {/* 6. Formula Documentation Footer */}
        <footer className="order-6 lg:col-span-12 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[#576070] dark:text-[#7D899C]">
          <span>
            LOSS FORMULA: max(0, expected_kWh − measured_kWh); fallback max(0, baseline_kW −
            measured_kW) × duration_h or feeder theft kW × window duration across{' '}
            {ANALYTICS_FEEDERS.length} substation feeders (IST · Asia/Kolkata).
          </span>
          <span className="font-semibold text-[#F59E0B] uppercase">
            Simulated 30-day history (seeded generator) · Estimate, not billing data.
          </span>
        </footer>
      </div>
    </div>
  );
};
