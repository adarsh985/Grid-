import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { formatIstTimestamp } from '../analytics/aggregate';
import {
  classifyPsi,
  formatPsiAriaText,
  psiToMeterPercent,
} from '../analytics/driftStatus';
import { fetchModelInfo, type ModelInfoResult } from '../api/modelInfo';
import { LiveValue } from '../components/LiveValue';
import { TOKENS } from '../design/tokens';
import type { FaultMetric, ModelEvaluationHistoryEntry, ModelInfo } from '../types';
import { formatFaultLabel } from '../utils/format';

const REFRESH_INTERVAL_MS = 60_000;

const PREFERRED_FAULT_ORDER = [
  'phase_imbalance',
  'power_theft',
  'overcurrent',
  'overcurrent_spike',
  'voltage_sag',
  'voltage_swell',
  'harmonic_distortion',
] as const;

function formatEvalDateShort(iso?: string): string {
  if (!iso) return 'unknown date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return iso.slice(0, 10);
}

interface ModelIdentityPanelProps {
  data: ModelInfo;
  sourceLabel: string;
}

const ModelIdentityPanel: React.FC<ModelIdentityPanelProps> = React.memo(
  ({ data, sourceLabel }) => {
    const ifWeightPct = Math.round((data.ensemble_weights?.isolation_forest_weight ?? 0) * 100);
    const lstmWeightPct = Math.round((data.ensemble_weights?.lstm_autoencoder_weight ?? 0) * 100);
    const anomalyThreshold = data.ensemble_weights?.anomaly_threshold ?? 0.65;
    const ifVersion = data.component_versions?.isolation_forest ?? data.version;
    const lstmVersion = data.component_versions?.lstm_autoencoder ?? data.version;

    const vMin = data.hard_rules?.voltage_min_v ?? TOKENS.limits.voltageMin;
    const vMax = data.hard_rules?.voltage_max_v ?? TOKENS.limits.voltageMax;
    const voltageRuleSource =
      data.hard_rules?.voltage_min_v !== undefined ? 'API YAML config' : 'EN-50160 safety config';

    const overall = data.metrics?.overall;

    return (
      <section
        aria-label="Model identity and configuration"
        className="min-w-0 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-3 sm:p-4 flex flex-col gap-3"
      >
        <div className="border-b border-[#C8CDD6] dark:border-[#1E2633] pb-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
              1 // MODEL IDENTITY &amp; ENSEMBLE CONFIG
            </h2>
            <div className="flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase border border-[#00E5FF]/50 text-[#00E5FF] bg-[#00E5FF]/10">
                HELD-OUT TEST SPLIT
              </span>
              <span className="px-1.5 py-0.5 font-mono text-[10px] font-bold border border-[#F59E0B]/50 text-[#F59E0B] bg-[#F59E0B]/10">
                {data.version}
              </span>
            </div>
          </div>
          <p className="font-mono text-[10px] text-[#576070] dark:text-[#7D899C] mt-1">
            {sourceLabel}
          </p>
        </div>

        {/* Two Ensemble Models + Hard Rule Layer */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 font-mono text-xs">
          <div className="border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE]/60 dark:bg-[#121822]/70 p-2.5">
            <div className="flex items-center justify-between text-[10px] uppercase text-[#576070] dark:text-[#7D899C]">
              <span>ISOLATION FOREST</span>
              <span className="text-[#00E5FF] font-bold">{ifVersion}</span>
            </div>
            <div className="mt-1 text-lg font-bold tabular-nums text-[#11141C] dark:text-[#E6E9EF]">
              {ifWeightPct}% <span className="text-[11px] font-normal text-[#7D899C]">WEIGHT</span>
            </div>
            <div className="mt-1 text-[11px] text-[#576070] dark:text-[#7D899C]">
              Point anomalies · {data.feature_count ?? '—'} features
            </div>
          </div>

          <div className="border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE]/60 dark:bg-[#121822]/70 p-2.5">
            <div className="flex items-center justify-between text-[10px] uppercase text-[#576070] dark:text-[#7D899C]">
              <span>LSTM AUTOENCODER</span>
              <span className="text-[#F59E0B] font-bold">{lstmVersion}</span>
            </div>
            <div className="mt-1 text-lg font-bold tabular-nums text-[#11141C] dark:text-[#E6E9EF]">
              {lstmWeightPct}% <span className="text-[11px] font-normal text-[#7D899C]">WEIGHT</span>
            </div>
            <div className="mt-1 text-[11px] text-[#576070] dark:text-[#7D899C] tabular-nums">
              Seq {data.sequence_length ?? '—'} steps · Thresh{' '}
              {typeof data.lstm_threshold === 'number' ? data.lstm_threshold.toFixed(2) : '—'}
            </div>
          </div>
        </div>

        {/* Hard Rule Limits & Overall Holdout Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[#C8CDD6] dark:bg-[#1E2633] border border-[#C8CDD6] dark:border-[#1E2633] font-mono">
          <div className="bg-[#FFFFFF] dark:bg-[#0C1017] p-2">
            <div className="text-[10px] uppercase text-[#576070] dark:text-[#7D899C]">
              ANOMALY GATE
            </div>
            <div className="text-sm font-bold tabular-nums mt-0.5">
              ≥ {anomalyThreshold.toFixed(2)}
            </div>
          </div>
          <div className="bg-[#FFFFFF] dark:bg-[#0C1017] p-2">
            <div className="text-[10px] uppercase text-[#576070] dark:text-[#7D899C]">
              VOLTAGE LIMITS
            </div>
            <div className="text-sm font-bold tabular-nums mt-0.5 text-[#F59E0B]">
              {vMin}–{vMax} V
            </div>
            <div className="text-[9.5px] text-[#7D899C]">{voltageRuleSource}</div>
          </div>
          <div className="bg-[#FFFFFF] dark:bg-[#0C1017] p-2">
            <div className="text-[10px] uppercase text-[#576070] dark:text-[#7D899C]">
              OVERALL F1
            </div>
            <div className="text-sm font-bold tabular-nums mt-0.5 text-[#00E5FF]">
              {overall ? overall.f1.toFixed(4) : '—'}
            </div>
            <div className="text-[9.5px] text-[#7D899C] tabular-nums">
              {overall ? `P ${overall.precision.toFixed(3)} / R ${overall.recall.toFixed(3)}` : ''}
            </div>
          </div>
          <div className="bg-[#FFFFFF] dark:bg-[#0C1017] p-2">
            <div className="text-[10px] uppercase text-[#576070] dark:text-[#7D899C]">
              OVERALL FPR
            </div>
            <div className="text-sm font-bold tabular-nums mt-0.5 text-[#FF4D2D]">
              {overall ? `${(overall.fpr * 100).toFixed(2)}%` : '—'}
            </div>
            <div className="text-[9.5px] text-[#7D899C] tabular-nums flex flex-wrap gap-x-1">
              {overall ? (
                <>
                  <span className="whitespace-nowrap">TP {overall.tp}</span>
                  <span>·</span>
                  <span className="whitespace-nowrap">FP {overall.fp}</span>
                  <span>·</span>
                  <span className="whitespace-nowrap">FN {overall.fn}</span>
                </>
              ) : (
                ''
              )}
            </div>
          </div>
        </div>
      </section>
    );
  },
);

ModelIdentityPanel.displayName = 'ModelIdentityPanel';

interface DriftGaugePanelProps {
  psiValue: number | null;
  psiThreshold: number;
  sampleCount: number;
  sourceLabel: string;
  psiOriginNote: string;
}

const DriftGaugePanel: React.FC<DriftGaugePanelProps> = React.memo(
  ({ psiValue, psiThreshold, sampleCount, sourceLabel, psiOriginNote }) => {
    const status = useMemo(() => classifyPsi(psiValue), [psiValue]);
    const meterPct = useMemo(() => psiToMeterPercent(psiValue), [psiValue]);
    const ariaValueText = useMemo(() => formatPsiAriaText(psiValue), [psiValue]);

    // SVG gauge coordinates: track spans x=20..580 (width 560)
    const trackX = 20;
    const trackW = 560;
    const segW = trackW / 3;
    const needleOffsetPx = (meterPct / 100) * trackW;

    const statusBadgeClass =
      status.zone === 'drift'
        ? 'border-[#FF4D2D] bg-[#FF4D2D]/15 text-[#FF4D2D]'
        : status.zone === 'watch'
          ? 'border-[#F59E0B] bg-[#F59E0B]/15 text-[#F59E0B]'
          : status.zone === 'stable'
            ? 'border-[#00E5FF] bg-[#00E5FF]/15 text-[#00E5FF]'
            : 'border-[#7D899C] bg-[#7D899C]/15 text-[#7D899C]';

    return (
      <section
        aria-label="Distribution drift gauge"
        className="min-w-0 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-3 sm:p-4 flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[#C8CDD6] dark:border-[#1E2633] pb-2">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
              2 // FEATURE DRIFT MONITOR (PSI)
            </h2>
            <p className="text-xs text-[#576070] dark:text-[#7D899C] mt-0.5">
              {status.description} ({psiOriginNote})
            </p>
            <p className="font-mono text-[10px] text-[#576070] dark:text-[#7D899C] mt-0.5">
              {sourceLabel}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase border border-[#FF4D2D]/50 text-[#F59E0B] bg-[#F59E0B]/10">
              LIVE WINDOW ({sampleCount})
            </span>
            <span
              data-testid="drift-status-badge"
              className={clsx(
                'px-2 py-0.5 font-mono text-xs font-bold uppercase border',
                statusBadgeClass,
              )}
            >
              {status.icon} {status.label}
            </span>
          </div>
        </div>

        {/* Numeric PSI Readout + Segmented Meter */}
        <div className="flex flex-wrap items-baseline justify-between gap-3 font-mono">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] uppercase text-[#576070] dark:text-[#7D899C]">
              CURRENT MAX PSI:
            </span>
            {status.value !== null ? (
              <LiveValue
                value={status.value}
                decimals={4}
                ariaLabel={`Current maximum PSI: ${status.value.toFixed(4)}`}
                className={clsx(
                  'text-2xl font-bold',
                  status.zone === 'drift'
                    ? 'text-[#FF4D2D]'
                    : status.zone === 'watch'
                      ? 'text-[#F59E0B]'
                      : 'text-[#00E5FF]',
                )}
              />
            ) : (
              <span className="text-2xl font-bold text-[#7D899C]">—</span>
            )}
          </div>
          <div className="text-[11px] text-[#576070] dark:text-[#7D899C] tabular-nums">
            LIMIT: {psiThreshold.toFixed(2)} · WINDOW: {sampleCount} SAMPLES
          </div>
        </div>

        {/* Accessible ARIA Meter wrapping segmented SVG (needle moves via transform only) */}
        <div
          data-testid="psi-drift-meter"
          role="meter"
          aria-label="Population Stability Index drift gauge"
          aria-valuenow={status.value ?? 0}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuetext={ariaValueText}
          className="w-full"
        >
          <svg
            viewBox="0 0 600 94"
            className="w-full h-[88px] sm:h-[94px] select-none block"
            aria-hidden="true"
          >
            {/* Segment Labels placed cleanly above needle track */}
            <text
              x={trackX + segW / 2}
              y={14}
              textAnchor="middle"
              dominantBaseline="central"
              fill={TOKENS.colors.phases.B.color}
              className="font-mono text-[10.5px] font-bold"
            >
              ● STABLE (&lt; 0.10)
            </text>
            <text
              x={trackX + segW * 1.5}
              y={14}
              textAnchor="middle"
              dominantBaseline="central"
              fill={TOKENS.colors.signal}
              className="font-mono text-[10.5px] font-bold"
            >
              ▲ WATCH (0.10–0.20)
            </text>
            <text
              x={trackX + segW * 2.5}
              y={14}
              textAnchor="middle"
              dominantBaseline="central"
              fill={TOKENS.colors.alert}
              className="font-mono text-[10.5px] font-bold"
            >
              ◆ DRIFT (&gt; 0.20)
            </text>

            {/* Segment 1: STABLE (< 0.10) */}
            <rect
              x={trackX}
              y={36}
              width={segW - 2}
              height={16}
              fill={TOKENS.colors.phases.B.color}
              fillOpacity={status.zone === 'stable' ? 0.34 : 0.14}
              stroke={TOKENS.colors.phases.B.color}
              strokeWidth={status.zone === 'stable' ? 1.5 : 0.75}
            />

            {/* Segment 2: WATCH (0.10 - 0.20) */}
            <rect
              x={trackX + segW + 1}
              y={36}
              width={segW - 2}
              height={16}
              fill={TOKENS.colors.signal}
              fillOpacity={status.zone === 'watch' ? 0.36 : 0.14}
              stroke={TOKENS.colors.signal}
              strokeWidth={status.zone === 'watch' ? 1.5 : 0.75}
            />

            {/* Segment 3: DRIFT (> 0.20) */}
            <rect
              x={trackX + segW * 2 + 2}
              y={36}
              width={segW - 2}
              height={16}
              fill={TOKENS.colors.alert}
              fillOpacity={status.zone === 'drift' ? 0.38 : 0.14}
              stroke={TOKENS.colors.alert}
              strokeWidth={status.zone === 'drift' ? 1.5 : 0.75}
            />

            {/* Scale Boundaries */}
            <text
              x={trackX}
              y={72}
              textAnchor="start"
              className="fill-[#576070] dark:fill-[#7D899C] font-mono text-[10px]"
            >
              0.00
            </text>
            <text
              x={trackX + segW}
              y={72}
              textAnchor="middle"
              className="fill-[#576070] dark:fill-[#7D899C] font-mono text-[10px]"
            >
              0.10
            </text>
            <text
              x={trackX + segW * 2}
              y={72}
              textAnchor="middle"
              className="fill-[#576070] dark:fill-[#7D899C] font-mono text-[10px]"
            >
              0.20
            </text>
            <text
              x={trackX + trackW}
              y={72}
              textAnchor="end"
              className="fill-[#576070] dark:fill-[#7D899C] font-mono text-[10px]"
            >
              1.00+
            </text>

            {/* Transform-only animated Needle */}
            {status.value !== null && (
              <g
                data-testid="psi-gauge-needle"
                style={{
                  transform: `translateX(${needleOffsetPx.toFixed(1)}px)`,
                  transition: 'transform 300ms ease-out',
                }}
              >
                <polygon
                  points={`${trackX - 5},25 ${trackX + 5},25 ${trackX},34`}
                  fill="#E6E9EF"
                  stroke={TOKENS.colors.signal}
                  strokeWidth={1.25}
                />
                <line
                  x1={trackX}
                  y1={34}
                  x2={trackX}
                  y2={56}
                  stroke="#E6E9EF"
                  strokeWidth={2.5}
                />
              </g>
            )}
          </svg>
        </div>

        <table className="sr-only">
          <caption>PSI drift classification thresholds and current reading</caption>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Value</th>
              <th>Status Zone</th>
              <th>Sample Window</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Max Feature PSI</td>
              <td>{status.value !== null ? status.value.toFixed(4) : 'Unknown'}</td>
              <td>{status.label}</td>
              <td>{sampleCount}</td>
            </tr>
          </tbody>
        </table>
      </section>
    );
  },
);

DriftGaugePanel.displayName = 'DriftGaugePanel';

interface FaultMatrixPanelProps {
  perFault: Record<string, FaultMetric>;
  overall?: ModelInfo['metrics']['overall'];
  sourceLabel: string;
  onSelectFaultType: (faultType: string) => void;
}

const FaultMatrixPanel: React.FC<FaultMatrixPanelProps> = React.memo(
  ({ perFault, overall, sourceLabel, onSelectFaultType }) => {
    const [hoveredFault, setHoveredFault] = useState<string | null>(null);

    const rows = useMemo(() => {
      const entries = Object.entries(perFault);
      const orderMap = new Map<string, number>(
        PREFERRED_FAULT_ORDER.map((ft, idx) => [ft, idx]),
      );
      return entries.sort((a, b) => {
        const ra = orderMap.get(a[0]) ?? 99;
        const rb = orderMap.get(b[0]) ?? 99;
        if (ra !== rb) return ra - rb;
        return a[0].localeCompare(b[0]);
      });
    }, [perFault]);

    const activeRow = hoveredFault ? perFault[hoveredFault] : null;
    const summaryText = `Per-fault holdout precision, recall, F1, and FPR across ${rows.length} fault classes. Click any row to triage matching alerts.`;

    const getCellBgStyle = (value: number, isFpr = false): React.CSSProperties => {
      if (isFpr) {
        return value > 0.01
          ? { backgroundColor: 'rgba(255, 77, 45, 0.16)' }
          : { backgroundColor: 'rgba(0, 229, 255, 0.06)' };
      }
      if (value >= 0.98) return { backgroundColor: 'rgba(0, 229, 255, 0.14)' };
      if (value >= 0.9) return { backgroundColor: 'rgba(245, 158, 11, 0.12)' };
      return { backgroundColor: 'rgba(255, 77, 45, 0.16)' };
    };

    return (
      <section
        aria-label="Per-fault evaluation matrix"
        className="min-w-0 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-3 sm:p-4 flex flex-col gap-3"
      >
        <div className="border-b border-[#C8CDD6] dark:border-[#1E2633] pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
              3 // PER-FAULT CONFUSION MATRIX METRICS
            </h2>
            <span className="font-mono text-[10px] uppercase text-[#576070] dark:text-[#7D899C]">
              CLICK ROW TO OPEN /ALERTS?TYPE=...
            </span>
          </div>
          <p className="text-xs text-[#576070] dark:text-[#7D899C] mt-0.5">{summaryText}</p>
          <p className="font-mono text-[10px] text-[#576070] dark:text-[#7D899C] mt-0.5">
            {sourceLabel}
          </p>
        </div>

        {/* Hover / Focus Raw Count Strip */}
        <div
          data-testid="matrix-hover-counts"
          className="px-2.5 py-1.5 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE] dark:bg-[#121822] font-mono text-[11px] tabular-nums flex flex-wrap items-center justify-between gap-2"
        >
          {hoveredFault && activeRow ? (
            <>
              <span className="font-bold text-[#F59E0B]">
                {formatFaultLabel(hoveredFault)} (n={activeRow.support})
              </span>
              {activeRow.tp !== undefined &&
              activeRow.fp !== undefined &&
              activeRow.fn !== undefined ? (
                <span>
                  TP: <strong className="text-[#00E5FF]">{activeRow.tp}</strong> · FP:{' '}
                  <strong className="text-[#FF4D2D]">{activeRow.fp}</strong> · FN:{' '}
                  <strong className="text-[#F59E0B]">{activeRow.fn}</strong>
                </span>
              ) : (
                <span className="text-[#576070] dark:text-[#7D899C]">
                  Support: {activeRow.support} faults (per-class TP/FP/FN not included in /model/info)
                </span>
              )}
            </>
          ) : overall ? (
            <>
              <span className="text-[#576070] dark:text-[#7D899C]">
                OVERALL BINARY CONFUSION MATRIX (HOVER ROW FOR CLASS DETAILS):
              </span>
              <span>
                TP <strong>{overall.tp}</strong> · FP{' '}
                <strong className="text-[#FF4D2D]">{overall.fp}</strong> · FN{' '}
                <strong className="text-[#F59E0B]">{overall.fn}</strong> · TN{' '}
                <strong>{overall.tn}</strong>
              </span>
            </>
          ) : (
            <span className="text-[#576070] dark:text-[#7D899C]">
              Hover a fault type row to inspect raw evaluation counts.
            </span>
          )}
        </div>

        {/* Horizontal scroll contained inside wrapper below 768px */}
        <div data-testid="matrix-scroll-wrapper" className="w-full overflow-x-auto">
          <table className="w-full min-w-[540px] text-left border-collapse font-mono text-xs tabular-nums">
            <thead>
              <tr className="border-b border-[#C8CDD6] dark:border-[#1E2633] text-[10px] uppercase text-[#576070] dark:text-[#7D899C]">
                <th className="py-2 px-2">Fault Type</th>
                <th className="py-2 px-2 text-right">Support</th>
                <th className="py-2 px-2 text-right">Precision</th>
                <th className="py-2 px-2 text-right">Recall</th>
                <th className="py-2 px-2 text-right">F1</th>
                <th className="py-2 px-2 text-right">FPR</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#C8CDD6]/70 dark:divide-[#1E2633]">
              {rows.map(([ft, m]) => (
                <tr
                  key={ft}
                  data-testid={`matrix-row-${ft}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`Filter alerts to ${formatFaultLabel(ft)}`}
                  onMouseEnter={() => setHoveredFault(ft)}
                  onFocus={() => setHoveredFault(ft)}
                  onMouseLeave={() => setHoveredFault((prev) => (prev === ft ? null : prev))}
                  onClick={() => onSelectFaultType(ft)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectFaultType(ft);
                    }
                  }}
                  className="cursor-pointer hover:bg-[#F59E0B]/10 focus:outline-none focus:bg-[#F59E0B]/15 transition-colors"
                >
                  <td className="py-2 px-2 font-semibold text-[#F59E0B] whitespace-nowrap">
                    {formatFaultLabel(ft)}
                  </td>
                  <td className="py-2 px-2 text-right text-[#576070] dark:text-[#7D899C]">
                    {m.support}
                  </td>
                  <td
                    style={getCellBgStyle(m.precision)}
                    className="py-2 px-2 text-right font-semibold text-[#11141C] dark:text-[#E6E9EF]"
                  >
                    {m.precision.toFixed(4)}
                  </td>
                  <td
                    style={getCellBgStyle(m.recall)}
                    className="py-2 px-2 text-right font-semibold text-[#11141C] dark:text-[#E6E9EF]"
                  >
                    {m.recall.toFixed(4)}
                  </td>
                  <td
                    style={getCellBgStyle(m.f1)}
                    className="py-2 px-2 text-right font-bold text-[#00E5FF]"
                  >
                    {m.f1.toFixed(4)}
                  </td>
                  <td
                    style={getCellBgStyle(m.fpr, true)}
                    className={clsx(
                      'py-2 px-2 text-right font-semibold',
                      m.fpr > 0.01
                        ? 'text-[#FF4D2D]'
                        : 'text-[#11141C] dark:text-[#E6E9EF]',
                    )}
                  >
                    {m.fpr.toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  },
);

FaultMatrixPanel.displayName = 'FaultMatrixPanel';

interface RankedFeatureRow {
  feature: string;
  value: number;
  metricType: 'PSI' | 'IMPORTANCE';
}

interface TopFeaturesPanelProps {
  features: RankedFeatureRow[];
  psiThreshold: number;
  sourceLabel: string;
}

const TopFeaturesPanel: React.FC<TopFeaturesPanelProps> = React.memo(
  ({ features, psiThreshold, sourceLabel }) => {
    const maxVal = useMemo(
      () => Math.max(psiThreshold, ...features.map((f) => f.value), 0.01),
      [features, psiThreshold],
    );

    const top = features[0] ?? null;
    const summaryText =
      features.length === 0
        ? 'No per-feature metrics reported by /model/info.'
        : `${top?.feature ?? ''} shows the highest ${top?.metricType ?? 'PSI'} value (${top ? top.value.toFixed(4) : '0'}) among ${features.length} API-reported features.`;

    return (
      <section
        aria-label="Per-feature explanation and drift summary"
        className="min-w-0 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-3 sm:p-4 flex flex-col gap-3"
      >
        <div className="border-b border-[#C8CDD6] dark:border-[#1E2633] pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
              4 // MONITORED FEATURE SIGNALS
            </h2>
            <span className="px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase border border-[#F59E0B]/50 text-[#F59E0B] bg-[#F59E0B]/10">
              LIVE INFERENCE WINDOW
            </span>
          </div>
          <p className="text-xs text-[#576070] dark:text-[#7D899C] mt-0.5">{summaryText}</p>
          <p className="font-mono text-[10px] text-[#576070] dark:text-[#7D899C] mt-0.5">
            {sourceLabel}
          </p>
        </div>

        {features.length === 0 ? (
          <div className="py-8 text-center font-mono text-xs text-[#7D899C]">
            NO PER-FEATURE SCORES RETURNED BY API
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {features.map((item, idx) => {
              const widthPct = Math.max(3, Math.min(100, (item.value / maxVal) * 100));
              const cls = item.metricType === 'PSI' ? classifyPsi(item.value) : null;
              const barColor =
                cls?.zone === 'drift'
                  ? TOKENS.colors.alert
                  : cls?.zone === 'watch'
                    ? TOKENS.colors.signal
                    : TOKENS.colors.phases.B.color;

              return (
                <div key={item.feature} className="flex flex-col gap-1 font-mono text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold text-[#11141C] dark:text-[#E6E9EF]">
                      {idx + 1}. {item.feature}
                    </span>
                    <span className="tabular-nums shrink-0 flex items-center gap-1.5">
                      {cls && (
                        <span
                          style={{ color: barColor }}
                          className="text-[10px] font-bold"
                        >
                          {cls.icon} {cls.label}
                        </span>
                      )}
                      <strong className="text-[#11141C] dark:text-[#E6E9EF]">
                        {item.value.toFixed(4)}
                      </strong>
                    </span>
                  </div>
                  <div className="h-2 w-full bg-[#E7E9E2] dark:bg-[#121822] border border-[#C8CDD6]/70 dark:border-[#1E2633] overflow-hidden">
                    <div
                      style={{
                        width: '100%',
                        transform: `scaleX(${(widthPct / 100).toFixed(3)})`,
                        transformOrigin: 'left center',
                        backgroundColor: barColor,
                      }}
                      className="h-full"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <table className="sr-only">
          <caption>Monitored feature values table</caption>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Feature</th>
              <th>Metric</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {features.map((item, idx) => (
              <tr key={item.feature}>
                <td>{idx + 1}</td>
                <td>{item.feature}</td>
                <td>{item.metricType}</td>
                <td>{item.value.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    );
  },
);

TopFeaturesPanel.displayName = 'TopFeaturesPanel';

interface EvaluationHistoryPanelProps {
  history: ModelEvaluationHistoryEntry[];
  sourceLabel: string;
}

const EvaluationHistoryPanel: React.FC<EvaluationHistoryPanelProps> = React.memo(
  ({ history, sourceLabel }) => {
    const isSingle = history.length <= 1;
    const latest = history[history.length - 1];
    const summaryText =
      history.length === 0
        ? 'No evaluation history entries returned.'
        : isSingle
          ? `Single evaluated version (${latest.version}) with F1 ${latest.f1.toFixed(4)}, Precision ${latest.precision.toFixed(4)}, Recall ${latest.recall.toFixed(4)} — no multi-version trend until a second version is evaluated.`
          : `Tracked ${history.length} evaluated versions; latest ${latest.version} achieved F1 ${latest.f1.toFixed(4)}.`;

    const svgW = 680;
    const svgH = 150;
    const padL = 46;
    const padR = 24;
    const padT = 18;
    const padB = 28;
    const plotW = svgW - padL - padR;
    const plotH = svgH - padT - padB;

    const coords = useMemo(() => {
      return history.map((entry, idx) => {
        const x =
          history.length <= 1
            ? padL + plotW / 2
            : padL + (idx / (history.length - 1)) * plotW;
        const yF1 = padT + plotH - Math.max(0, Math.min(1, entry.f1)) * plotH;
        const yRec = padT + plotH - Math.max(0, Math.min(1, entry.recall)) * plotH;
        const yPrec = padT + plotH - Math.max(0, Math.min(1, entry.precision)) * plotH;
        return { ...entry, x, yF1, yRec, yPrec };
      });
    }, [history, plotH, plotW]);

    const f1Path = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.yF1}`).join(' ');
    const precPath = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.yPrec}`).join(' ');
    const recPath = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.yRec}`).join(' ');

    return (
      <section
        aria-label="Evaluation history across model versions"
        className="min-w-0 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-3 sm:p-4 flex flex-col gap-2.5"
      >
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[#C8CDD6] dark:border-[#1E2633] pb-2">
          <div>
            <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
              5 // EVALUATION HISTORY
            </h2>
            <p className="text-xs text-[#576070] dark:text-[#7D899C] mt-0.5">{summaryText}</p>
            <p className="font-mono text-[10px] text-[#576070] dark:text-[#7D899C] mt-0.5">
              {sourceLabel}
            </p>
          </div>
          <div className="flex items-center gap-3 font-mono text-[10px]">
            <span className="inline-flex items-center gap-1 text-[#00E5FF]">● F1</span>
            <span className="inline-flex items-center gap-1 text-[#F59E0B]">▲ RECALL</span>
            <span className="inline-flex items-center gap-1 text-[#FF3EA5]">◆ PRECISION</span>
          </div>
        </div>

        <svg
          data-testid="evaluation-history-svg"
          role="img"
          aria-label={summaryText}
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="w-full h-[140px] sm:h-[150px] select-none block"
        >
          {[0, 0.5, 1].map((v) => {
            const y = padT + plotH - v * plotH;
            return (
              <g key={v}>
                <line
                  x1={padL}
                  y1={y}
                  x2={svgW - padR}
                  y2={y}
                  stroke="currentColor"
                  className="text-[#C8CDD6] dark:text-[#1E2633]"
                  strokeDasharray="3 3"
                />
                <text
                  x={padL - 8}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="central"
                  className="fill-[#576070] dark:fill-[#7D899C] font-mono text-[10px]"
                >
                  {v.toFixed(1)}
                </text>
              </g>
            );
          })}

          {!isSingle && (
            <>
              <path d={recPath} fill="none" stroke={TOKENS.colors.signal} strokeWidth={1.5} />
              <path d={f1Path} fill="none" stroke={TOKENS.colors.phases.B.color} strokeWidth={2} />
              <path d={precPath} fill="none" stroke={TOKENS.colors.phases.C.color} strokeWidth={1.5} />
            </>
          )}

          {coords.map((pt) => (
            <g key={pt.version}>
              <circle cx={pt.x} cy={pt.yRec} r={3.5} fill={TOKENS.colors.signal} />
              <circle cx={pt.x} cy={pt.yF1} r={4.5} fill={TOKENS.colors.phases.B.color} />
              <circle cx={pt.x} cy={pt.yPrec} r={3.5} fill={TOKENS.colors.phases.C.color} />
              <text
                x={pt.x}
                y={svgH - 8}
                textAnchor="middle"
                className="fill-[#F59E0B] font-mono text-[10.5px] font-bold"
              >
                {pt.version} ({formatEvalDateShort(pt.evaluated_at)})
              </text>
              {isSingle && (
                <text
                  x={pt.x + 12}
                  y={pt.yF1}
                  dominantBaseline="central"
                  className="fill-[#00E5FF] font-mono text-[10px] font-semibold"
                >
                  F1 {pt.f1.toFixed(4)}
                </text>
              )}
            </g>
          ))}
        </svg>

        <table className="sr-only">
          <caption>Model version evaluation history</caption>
          <thead>
            <tr>
              <th>Version</th>
              <th>Evaluated At</th>
              <th>Precision</th>
              <th>Recall</th>
              <th>F1</th>
              <th>FPR</th>
            </tr>
          </thead>
          <tbody>
            {history.map((entry) => (
              <tr key={entry.version}>
                <td>{entry.version}</td>
                <td>{entry.evaluated_at}</td>
                <td>{entry.precision.toFixed(4)}</td>
                <td>{entry.recall.toFixed(4)}</td>
                <td>{entry.f1.toFixed(4)}</td>
                <td>{entry.fpr.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    );
  },
);

EvaluationHistoryPanel.displayName = 'EvaluationHistoryPanel';

export const ModelHealthPage: React.FC = () => {
  const navigate = useNavigate();
  const [result, setResult] = useState<ModelInfoResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadModelHealth = useCallback(async (isManualRefresh = false, signal?: AbortSignal) => {
    if (isManualRefresh) setRefreshing(true);
    const res = await fetchModelInfo({ signal });
    if (signal?.aborted) return;
    setResult(res);
    setLoading(false);
    setRefreshing(false);
  }, []);

  // Fetch once on mount + every 60s; never triggered on 1Hz telemetry ticks
  useEffect(() => {
    const controller = new AbortController();
    void loadModelHealth(false, controller.signal);
    const intervalId = window.setInterval(() => {
      void loadModelHealth(false, controller.signal);
    }, REFRESH_INTERVAL_MS);

    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, [loadModelHealth]);

  const data = result?.status === 'ok' ? result.data : undefined;

  const derived = useMemo(() => {
    if (!data) {
      return {
        sourceLine: '',
        psiOriginNote: '',
        rankedFeatures: [] as RankedFeatureRow[],
        history: [] as ModelEvaluationHistoryEntry[],
      };
    }

    const evalDate = formatEvalDateShort(data.metrics?.evaluated_at || data.trained_at);
    const splitSamples = data.metrics?.test_samples;
    const splitPart = splitSamples
      ? `${splitSamples.toLocaleString()} test samples`
      : 'held-out test split';
    const sourceLine = `Source: ${result?.source ?? '/model/info'} · evaluated ${evalDate} · ${splitPart}`;

    const sampleCount = data.drift?.sample_count ?? 0;
    const psiOriginNote =
      sampleCount > 0
        ? `live inference window (${sampleCount} readings)`
        : 'at training time';

    let rankedFeatures: RankedFeatureRow[] = [];
    if (data.top_features && data.top_features.length > 0) {
      rankedFeatures = [...data.top_features]
        .map((item) => ({
          feature: item.feature,
          value: Number(item.psi ?? item.importance ?? item.contribution ?? 0),
          metricType: (item.psi !== undefined ? 'PSI' : 'IMPORTANCE') as 'PSI' | 'IMPORTANCE',
        }))
        .sort((a, b) => b.value - a.value);
    } else if (data.drift?.feature_psi) {
      rankedFeatures = Object.entries(data.drift.feature_psi)
        .map(([feature, val]) => ({
          feature,
          value: Number(val),
          metricType: 'PSI' as const,
        }))
        .sort((a, b) => b.value - a.value);
    }

    const overall = data.metrics?.overall;
    const history: ModelEvaluationHistoryEntry[] =
      data.evaluation_history && data.evaluation_history.length > 0
        ? data.evaluation_history
        : overall
          ? [
              {
                version: data.version,
                evaluated_at: data.metrics?.evaluated_at || data.trained_at,
                precision: overall.precision,
                recall: overall.recall,
                f1: overall.f1,
                fpr: overall.fpr,
                test_samples: data.metrics?.test_samples,
              },
            ]
          : [];

    return {
      sourceLine,
      psiOriginNote,
      rankedFeatures,
      history,
    };
  }, [data, result?.source]);

  const handleSelectFaultType = useCallback(
    (faultType: string) => {
      navigate(`/alerts?type=${encodeURIComponent(faultType)}`);
    },
    [navigate],
  );

  if (loading) {
    return (
      <div className="flex-1 flex flex-col bg-[#F2F3EE] dark:bg-[#07090D] p-4">
        <div
          role="status"
          aria-label="Loading model health"
          className="border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] p-6 font-mono text-xs uppercase text-[#7D899C]"
        >
          CHECKING ML SERVICE (/model/info)…
        </div>
      </div>
    );
  }

  // Honest NOT EVALUATED / UNAVAILABLE state with zero placeholder metric numbers
  if (!result || result.status !== 'ok' || !data) {
    return (
      <div className="flex-1 flex flex-col bg-[#F2F3EE] dark:bg-[#07090D] text-[#11141C] dark:text-[#E6E9EF] overflow-x-hidden">
        <header className="px-4 py-3 border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="font-['Space_Grotesk',sans-serif] text-base font-bold tracking-wider uppercase">
              MODEL HEALTH
            </h1>
            <span className="px-2 py-0.5 font-mono text-[11px] font-bold uppercase border border-[#FF4D2D] bg-[#FF4D2D]/15 text-[#FF4D2D]">
              ○ NOT EVALUATED
            </span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px] text-[#576070] dark:text-[#7D899C]">
            <span>Last checked: {formatIstTimestamp(result?.checkedAt || '')}</span>
            <button
              type="button"
              onClick={() => void loadModelHealth(true)}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-[#F59E0B]/60 text-[#F59E0B] hover:bg-[#F59E0B]/15 uppercase focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
            >
              <RefreshCw className={clsx('h-3 w-3', refreshing && 'animate-spin')} aria-hidden="true" />
              <span>Retry</span>
            </button>
          </div>
        </header>

        <div className="p-4">
          <section
            data-testid="model-not-evaluated"
            role="status"
            aria-label="Model not evaluated"
            className="border border-[#FF4D2D]/70 bg-[#FFFFFF] dark:bg-[#0C1017] p-5 flex flex-col gap-3 max-w-3xl"
          >
            <div className="flex items-center gap-2 font-mono text-sm font-bold uppercase text-[#FF4D2D]">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>NOT EVALUATED — REAL METRICS UNAVAILABLE</span>
            </div>
            <p className="text-sm text-[#11141C] dark:text-[#E6E9EF]">
              {result?.status === 'unavailable'
                ? 'Could not retrieve evaluated model metrics from GET /model/info. No placeholder metrics are shown.'
                : 'The ML service responded, but holdout evaluation metrics have not been generated yet.'}
            </p>
            {result?.error && (
              <p className="font-mono text-xs text-[#576070] dark:text-[#7D899C]">
                Detail: {result.error}
              </p>
            )}
            <div className="border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE] dark:bg-[#07090D] p-3 font-mono text-xs">
              <div className="text-[10px] uppercase text-[#576070] dark:text-[#7D899C] mb-1">
                Generate evaluation metrics and markdown report:
              </div>
              <code className="block text-[#F59E0B] break-all">
                python ml-service/evaluate.py --artifacts ml-service/artifacts --report docs/model-evaluation.md
              </code>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-[#F2F3EE] dark:bg-[#07090D] text-[#11141C] dark:text-[#E6E9EF] overflow-x-hidden">
      {/* Header */}
      <header className="px-4 py-3 border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="font-['Space_Grotesk',sans-serif] text-base font-bold tracking-wider uppercase">
            MODEL HEALTH
          </h1>
          <span
            data-testid="model-version-pill"
            className="px-2 py-0.5 font-mono text-[11px] font-bold uppercase border border-[#F59E0B]/60 bg-[#F59E0B]/15 text-[#F59E0B]"
          >
            {data.version}
          </span>
          <span className="font-mono text-[11px] text-[#576070] dark:text-[#7D899C]">
            Trained: {formatIstTimestamp(data.trained_at)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-[#576070] dark:text-[#7D899C]">
          <span data-testid="model-last-checked">
            Last checked: {formatIstTimestamp(result.checkedAt)}
          </span>
          <button
            type="button"
            onClick={() => void loadModelHealth(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-[#F59E0B]/60 text-[#F59E0B] hover:bg-[#F59E0B]/15 uppercase focus:outline-none focus:ring-2 focus:ring-[#F59E0B]"
          >
            <RefreshCw className={clsx('h-3 w-3', refreshing && 'animate-spin')} aria-hidden="true" />
            <span>{refreshing ? 'Refreshing' : 'Refresh'}</span>
          </button>
        </div>
      </header>

      {/* Main Content: <768px stacks strictly Panel 1 -> Panel 2 -> Panel 3 -> Panel 4 -> Panel 5 -> Footer */}
      <div className="p-3 sm:p-4 flex flex-col lg:grid lg:grid-cols-12 gap-3 sm:gap-4 min-w-0">
        {/* Panel 1: Model Identity */}
        <div className="order-1 lg:col-span-5 min-w-0">
          <ModelIdentityPanel data={data} sourceLabel={derived.sourceLine} />
        </div>

        {/* Panel 2: Drift Gauge */}
        <div className="order-2 lg:col-span-7 min-w-0">
          <DriftGaugePanel
            psiValue={data.drift?.max_psi ?? null}
            psiThreshold={data.drift?.psi_threshold ?? TOKENS.limits.psiWarningThreshold}
            sampleCount={data.drift?.sample_count ?? 0}
            sourceLabel={derived.sourceLine}
            psiOriginNote={derived.psiOriginNote}
          />
        </div>

        {/* Panel 3: Confusion-Style Per-Fault Matrix */}
        <div className="order-3 lg:col-span-7 min-w-0">
          <FaultMatrixPanel
            perFault={data.metrics.per_fault ?? {}}
            overall={data.metrics.overall}
            sourceLabel={derived.sourceLine}
            onSelectFaultType={handleSelectFaultType}
          />
        </div>

        {/* Panel 4: Per-Feature Signals */}
        <div className="order-4 lg:col-span-5 min-w-0">
          <TopFeaturesPanel
            features={derived.rankedFeatures}
            psiThreshold={data.drift?.psi_threshold ?? TOKENS.limits.psiWarningThreshold}
            sourceLabel={derived.sourceLine}
          />
        </div>

        {/* Panel 5: Evaluation History */}
        <div className="order-5 lg:col-span-12 min-w-0">
          <EvaluationHistoryPanel
            history={derived.history}
            sourceLabel={derived.sourceLine}
          />
        </div>

        {/* Honest Split & Simulation Footer */}
        <footer className="order-6 lg:col-span-12 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-[#576070] dark:text-[#7D899C]">
          <span>{derived.sourceLine}</span>
          <span>
            Metrics are from the held-out test split. They are measured on simulated data and have
            not been validated on real meter hardware.
          </span>
        </footer>
      </div>
    </div>
  );
};
