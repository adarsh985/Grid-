import React, { useEffect, useId, useMemo, useState } from 'react';
import { LiveValue } from './LiveValue';
import { useTelemetry } from '../context/TelemetryContext';
import { TOKENS } from '../design/tokens';
import { usePrefersReducedMotion } from '../utils/animationQueue';
import { computeAvgVoltage, computeLoadKw } from '../utils/format';

export const MAX_KPI_SPARKLINE_POINTS = 40;

interface KpiSparklineProps {
  points: number[];
  color: string;
  label: string;
  reducedMotion: boolean;
  testId: string;
}

const KpiSparkline: React.FC<KpiSparklineProps> = ({
  points,
  color,
  label,
  reducedMotion,
  testId,
}) => {
  const gradId = useId().replace(/:/g, '');
  const safePoints = points.length > 1 ? points : [points[0] ?? 0, points[0] ?? 0];

  const { linePath, areaPath, lastX, lastY } = useMemo(() => {
    const w = 140;
    const h = 22;
    const padY = 2.5;
    const min = Math.min(...safePoints);
    const max = Math.max(...safePoints);
    const span = max - min || 1;

    const coords = safePoints.map((val, idx) => {
      const x = (idx / Math.max(1, safePoints.length - 1)) * w;
      const y = h - padY - ((val - min) / span) * (h - padY * 2);
      return { x: +x.toFixed(1), y: +y.toFixed(1) };
    });

    const line = coords
      .map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${pt.x},${pt.y}`)
      .join(' ');
    const area = `${line} L${w},${h} L0,${h} Z`;
    const last = coords[coords.length - 1];

    return { linePath: line, areaPath: area, lastX: last.x, lastY: last.y };
  }, [safePoints]);

  return (
    <svg
      data-testid={testId}
      role="img"
      aria-label={`${label} 40-sample sparkline`}
      viewBox="0 0 140 22"
      preserveAspectRatio="none"
      className="w-full h-[22px] mt-1.5 overflow-visible"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.3} strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={2.1} fill={color} />
      {!reducedMotion && (
        <circle
          cx={lastX}
          cy={lastY}
          r={4.2}
          fill={color}
          fillOpacity={0.28}
          className="animate-pulse"
        />
      )}
    </svg>
  );
};

interface SparkHistoryState {
  totalKw: number[];
  avgF: number[];
  avgV: number[];
  maxImbalancePct: number[];
  faultedNodes: number[];
}

function seedSeries(base: number, jitter: number, decimals = 2): number[] {
  return Array.from({ length: MAX_KPI_SPARKLINE_POINTS }, (_, idx) => {
    const wave = Math.sin(idx * 0.35) * jitter * 0.65 + Math.cos(idx * 0.17) * jitter * 0.35;
    return Number((base + wave).toFixed(decimals));
  });
}

function appendSeries(prev: number[], nextVal: number): number[] {
  const updated = [...prev, nextVal];
  return updated.length > MAX_KPI_SPARKLINE_POINTS
    ? updated.slice(updated.length - MAX_KPI_SPARKLINE_POINTS)
    : updated;
}

export const KpiStrip: React.FC = () => {
  const { meters, alerts, triggerSimulatedFault } = useTelemetry();
  const reducedMotion = usePrefersReducedMotion();

  const metrics = useMemo(() => {
    let totalKw = 0;
    let vSum = 0;
    let fSum = 0;
    let pfSum = 0;
    let count = 0;
    let maxImbalancePct = 0;
    let faultedNodes = 0;

    for (const m of meters) {
      if (m.open_alerts.length > 0) faultedNodes += 1;
      const r = m.latest_reading;
      if (!r) continue;
      count += 1;
      totalKw += computeLoadKw(r);
      vSum += computeAvgVoltage(r);
      fSum += r.frequency;
      pfSum += r.power_factor;

      const iMean = (r.current_a + r.current_b + r.current_c) / 3;
      if (iMean > 0) {
        const maxDev = Math.max(
          Math.abs(r.current_a - iMean),
          Math.abs(r.current_b - iMean),
          Math.abs(r.current_c - iMean),
        );
        const imb = (maxDev / iMean) * 100;
        if (imb > maxImbalancePct) maxImbalancePct = imb;
      }
    }

    const avgV = count > 0 ? vSum / count : TOKENS.limits.nominalVoltage;
    const avgF = count > 0 ? fSum / count : TOKENS.limits.nominalFrequency;
    const avgPf = count > 0 ? pfSum / count : TOKENS.limits.nominalPowerFactor;
    const openCrits = alerts.filter(
      (a) => a.status === 'open' && (a.severity === 'critical' || a.severity === 'high'),
    ).length;

    return {
      totalKw,
      avgV,
      avgF,
      avgPf,
      maxImbalancePct,
      faultedNodes,
      totalNodes: meters.length,
      openCrits,
    };
  }, [meters, alerts]);

  const [history, setHistory] = useState<SparkHistoryState>(() => ({
    totalKw: seedSeries(metrics.totalKw || 230, 4.5, 1),
    avgF: seedSeries(metrics.avgF || 50.0, 0.025, 3),
    avgV: seedSeries(metrics.avgV || 229.0, 1.1, 1),
    maxImbalancePct: seedSeries(metrics.maxImbalancePct || 18, 2.2, 1),
    faultedNodes: Array.from(
      { length: MAX_KPI_SPARKLINE_POINTS },
      (_, idx) => (idx < 30 ? Math.max(0, metrics.faultedNodes - 1) : metrics.faultedNodes),
    ),
  }));

  useEffect(() => {
    setHistory((prev) => ({
      totalKw: appendSeries(prev.totalKw, Number(metrics.totalKw.toFixed(1))),
      avgF: appendSeries(prev.avgF, Number(metrics.avgF.toFixed(3))),
      avgV: appendSeries(prev.avgV, Number(metrics.avgV.toFixed(1))),
      maxImbalancePct: appendSeries(prev.maxImbalancePct, Number(metrics.maxImbalancePct.toFixed(1))),
      faultedNodes: appendSeries(prev.faultedNodes, metrics.faultedNodes),
    }));
  }, [
    metrics.totalKw,
    metrics.avgF,
    metrics.avgV,
    metrics.maxImbalancePct,
    metrics.faultedNodes,
  ]);

  return (
    <section
      aria-label="Substation real-time KPI strip"
      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] divide-y md:divide-y-0 divide-x divide-[#C8CDD6] dark:divide-[#1E2633]"
    >
      {/* 1. Aggregate Bus Load */}
      <div className="px-3.5 py-2 flex flex-col justify-between">
        <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-[#7D899C]">
          <span>BUSBAR ACTIVE LOAD</span>
          <span className="text-[#F59E0B]">3Ø ΣP</span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between">
          <LiveValue
            value={metrics.totalKw}
            decimals={1}
            unit="kW"
            flashOnChange
            className="text-xl font-bold text-[#11141C] dark:text-[#E6E9EF]"
          />
          <span className="text-[11px] font-mono text-[#7D899C]">
            PF {metrics.avgPf.toFixed(3)}
          </span>
        </div>
        <KpiSparkline
          testId="kpi-sparkline-load"
          points={history.totalKw}
          color={TOKENS.colors.signal}
          label="Busbar active load"
          reducedMotion={reducedMotion}
        />
      </div>

      {/* 2. System Frequency */}
      <div className="px-3.5 py-2 flex flex-col justify-between">
        <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-[#7D899C]">
          <span>SYNC FREQUENCY</span>
          <span>NOM 50.00Hz</span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between">
          <LiveValue
            value={metrics.avgF}
            decimals={3}
            unit="Hz"
            flashOnChange
            className="text-xl font-bold text-[#F59E0B]"
          />
          <span className="text-[11px] font-mono text-[#7D899C]">
            {((metrics.avgF - 50) * 1000 >= 0 ? '+' : '') +
              ((metrics.avgF - 50) * 1000).toFixed(0)}{' '}
            mHz
          </span>
        </div>
        <KpiSparkline
          testId="kpi-sparkline-freq"
          points={history.avgF}
          color={TOKENS.colors.signal}
          label="System frequency"
          reducedMotion={reducedMotion}
        />
      </div>

      {/* 3. Mean Bus Voltage */}
      <div className="px-3.5 py-2 flex flex-col justify-between">
        <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-[#7D899C]">
          <span>MEAN PHASE VOLTAGE</span>
          <span>207–253V</span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between">
          <LiveValue
            value={metrics.avgV}
            decimals={1}
            unit="V"
            flashOnChange
            className="text-xl font-bold text-[#11141C] dark:text-[#E6E9EF]"
          />
          <span className="text-[11px] font-mono text-[#7D899C]">EN-50160</span>
        </div>
        <KpiSparkline
          testId="kpi-sparkline-voltage"
          points={history.avgV}
          color={TOKENS.colors.phases.B.color}
          label="Mean phase voltage"
          reducedMotion={reducedMotion}
        />
      </div>

      {/* 4. Peak NEMA Phase Imbalance */}
      <div className="px-3.5 py-2 flex flex-col justify-between">
        <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-[#7D899C]">
          <span>PEAK NEMA IMBALANCE</span>
          <span>LIM 10.0%</span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between">
          <LiveValue
            value={metrics.maxImbalancePct}
            decimals={1}
            unit="%"
            flashOnChange
            className={
              metrics.maxImbalancePct >= 10
                ? 'text-xl font-bold text-[#FF4D2D]'
                : 'text-xl font-bold text-[#F59E0B]'
            }
          />
          <span className="text-[11px] font-mono uppercase text-[#7D899C]">
            {metrics.maxImbalancePct >= 10 ? '▲ BREACH' : '● BALANCED'}
          </span>
        </div>
        <KpiSparkline
          testId="kpi-sparkline-imbalance"
          points={history.maxImbalancePct}
          color={metrics.maxImbalancePct >= 10 ? TOKENS.colors.alert : TOKENS.colors.signal}
          label="Peak NEMA phase imbalance"
          reducedMotion={reducedMotion}
        />
      </div>

      {/* 5. Faulted Nodes */}
      <div className="px-3.5 py-2 flex flex-col justify-between">
        <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-[#7D899C]">
          <span>FAULTED TERMINALS</span>
          <span>FLEET {metrics.totalNodes}</span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between font-mono tabular-nums">
          <span
            className={
              metrics.faultedNodes > 0
                ? 'text-xl font-bold text-[#FF4D2D]'
                : 'text-xl font-bold text-[#F59E0B]'
            }
          >
            {metrics.faultedNodes}{' '}
            <span className="text-xs font-normal text-[#7D899C]">/ {metrics.totalNodes}</span>
          </span>
          <span className="text-[11px] text-[#FF4D2D] font-semibold">
            {metrics.openCrits} CRIT/HIGH
          </span>
        </div>
        <KpiSparkline
          testId="kpi-sparkline-faulted"
          points={history.faultedNodes}
          color={metrics.faultedNodes > 0 ? TOKENS.colors.alert : TOKENS.colors.signal}
          label="Faulted terminals"
          reducedMotion={reducedMotion}
        />
      </div>

      {/* 6. Simulator Controls (Demo Only) */}
      <div
        aria-label="Simulator controls (demo only)"
        className="min-w-0 px-2.5 sm:px-3.5 py-2 flex flex-col justify-between bg-[#F2F3EE]/60 dark:bg-[#07090D]/60"
      >
        <div className="flex items-center justify-between gap-1 text-[9.5px] sm:text-[10px] font-mono uppercase tracking-wider text-[#7D899C]">
          <span className="truncate">SIMULATOR CONTROLS</span>
          <span className="px-1 py-0.5 text-[9px] border border-[#F59E0B]/40 text-[#F59E0B] bg-[#F59E0B]/10 shrink-0">
            DEMO ONLY
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => triggerSimulatedFault('MTR-0104', 'power_theft')}
            className="w-full sm:w-auto sm:flex-1 px-2 py-1 text-[10px] font-mono font-semibold uppercase tracking-wider border border-[#FF4D2D]/60 bg-[#FF4D2D]/15 text-[#FF4D2D] hover:bg-[#FF4D2D]/25 focus:outline-none focus:ring-1 focus:ring-[#FF4D2D]"
          >
            SIM: + INJECT THEFT
          </button>
          <button
            type="button"
            onClick={() => triggerSimulatedFault('MTR-0109', 'phase_imbalance')}
            className="w-full sm:w-auto px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-[#F59E0B]/50 bg-[#F59E0B]/10 text-[#F59E0B] hover:bg-[#F59E0B]/20 focus:outline-none focus:ring-1 focus:ring-[#F59E0B]"
            title="Simulate Phase B imbalance on MTR-0109 (demo)"
          >
            SIM: + ØB IMB
          </button>
        </div>
      </div>
    </section>
  );
};
