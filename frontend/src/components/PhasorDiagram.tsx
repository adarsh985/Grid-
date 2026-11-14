import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TOKENS } from '../design/tokens';
import type { Reading } from '../types';
import { usePrefersReducedMotion } from '../utils/animationQueue';

/**
 * 50 Hz grid vector rotation slowed by 200x so 1 full revolution takes 4.0 seconds (0.25 Hz).
 */
export const PHASOR_SLOWDOWN_FACTOR = 200;
export const PHASOR_REV_PERIOD_MS = (1000 / TOKENS.limits.nominalFrequency) * PHASOR_SLOWDOWN_FACTOR; // 4000 ms
export const MAX_PHASOR_TRAIL_LENGTH = 24;
export const PHASOR_TRAIL_SAMPLE_MS = 1000 / 12; // ~83.3ms (12 Hz sampling)

export interface PhasorTrailSample {
  rotationDeg: number;
  vRadiusA: number;
  vRadiusB: number;
  vRadiusC: number;
  iRadiusA: number;
  iRadiusB: number;
  iRadiusC: number;
}

/**
 * Pure helper generating trailing angles for unit tests & initialization.
 * Returns [] when prefers-reduced-motion is active.
 */
export function buildPhasorTrailAngles(
  currentDeg: number,
  count: number = MAX_PHASOR_TRAIL_LENGTH,
  reducedMotion: boolean = false,
): number[] {
  if (reducedMotion || count <= 0) return [];
  const stepDeg = (360 / PHASOR_REV_PERIOD_MS) * PHASOR_TRAIL_SAMPLE_MS;
  return Array.from({ length: count }, (_, idx) => {
    const stepsBack = count - idx; // oldest first, newest last
    return (currentDeg - stepsBack * stepDeg + 360) % 360;
  });
}

export interface PhasorDiagramProps {
  reading: Reading | null;
  meterId: string;
}

interface PhaseVector {
  key: 'A' | 'B' | 'C';
  label: string;
  color: string;
  voltage: number;
  current: number;
  vAngleDeg: number;
  iAngleDeg: number;
  vRadius: number;
  iRadius: number;
}

function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

export const PhasorDiagram: React.FC<PhasorDiagramProps> = ({ reading, meterId }) => {
  const reducedMotion = usePrefersReducedMotion();
  const [rotationDeg, setRotationDeg] = useState(0);
  const [trailHistory, setTrailHistory] = useState<number[]>(() =>
    buildPhasorTrailAngles(0, MAX_PHASOR_TRAIL_LENGTH, false),
  );

  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const lastTrailSampleRef = useRef<number>(0);

  useEffect(() => {
    if (reducedMotion) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      setTrailHistory([]);
      return;
    }

    setTrailHistory((prev) =>
      prev.length > 0 ? prev : buildPhasorTrailAngles(rotationDeg, MAX_PHASOR_TRAIL_LENGTH, false),
    );

    const step = (now: number) => {
      if (typeof document !== 'undefined' && document.hidden) {
        lastFrameRef.current = now;
        rafRef.current = requestAnimationFrame(step);
        return;
      }

      if (lastFrameRef.current !== null) {
        const dt = now - lastFrameRef.current;
        const deltaDeg = (dt / PHASOR_REV_PERIOD_MS) * 360;
        setRotationDeg((prev) => {
          const next = (prev + deltaDeg) % 360;
          if (now - lastTrailSampleRef.current >= PHASOR_TRAIL_SAMPLE_MS) {
            lastTrailSampleRef.current = now;
            setTrailHistory((hist) => {
              const updated = [...hist, prev];
              return updated.length > MAX_PHASOR_TRAIL_LENGTH
                ? updated.slice(updated.length - MAX_PHASOR_TRAIL_LENGTH)
                : updated;
            });
          }
          return next;
        });
      }
      lastFrameRef.current = now;
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastFrameRef.current = null;
    };
  }, [reducedMotion]); // eslint-disable-line react-hooks/exhaustive-deps

  const { vectors, imbalancePct, pfAngleDeg } = useMemo(() => {
    const va = reading?.voltage_a ?? TOKENS.limits.nominalVoltage;
    const vb = reading?.voltage_b ?? TOKENS.limits.nominalVoltage;
    const vc = reading?.voltage_c ?? TOKENS.limits.nominalVoltage;
    const ia = reading?.current_a ?? 14.0;
    const ib = reading?.current_b ?? 14.0;
    const ic = reading?.current_c ?? 14.0;
    const pf = Math.min(1, Math.max(0.4, reading?.power_factor ?? TOKENS.limits.nominalPowerFactor));

    const iMean = Math.max(0.5, (ia + ib + ic) / 3);
    const maxIDev = Math.max(Math.abs(ia - iMean), Math.abs(ib - iMean), Math.abs(ic - iMean));
    const nemaImb = (maxIDev / iMean) * 100;

    const baseLagDeg = (Math.acos(pf) * 180) / Math.PI;
    const vMean = (va + vb + vc) / 3;
    const angleShiftA = ((va - vMean) / TOKENS.limits.nominalVoltage) * 45;
    const angleShiftB =
      ((ib - iMean) / iMean) * 28 - ((vb - vMean) / TOKENS.limits.nominalVoltage) * 55;
    const angleShiftC =
      ((ic - iMean) / iMean) * -22 + ((vc - vMean) / TOKENS.limits.nominalVoltage) * 45;

    const maxVRadius = 96;
    const maxIRadius = 78;
    const refI = Math.max(22, iMean * 1.45);
    const clamp = (val: number, min: number, max: number) => Math.min(max, Math.max(min, val));

    const list: PhaseVector[] = [
      {
        key: 'A',
        label: TOKENS.colors.phases.A.short,
        color: TOKENS.colors.phases.A.color,
        voltage: va,
        current: ia,
        vAngleDeg: (0 + angleShiftA + 360) % 360,
        iAngleDeg: (0 + angleShiftA + baseLagDeg + 360) % 360,
        vRadius: clamp((va / 260) * maxVRadius, 28, maxVRadius + 8),
        iRadius: clamp((ia / refI) * maxIRadius, 18, maxIRadius + 14),
      },
      {
        key: 'B',
        label: TOKENS.colors.phases.B.short,
        color: TOKENS.colors.phases.B.color,
        voltage: vb,
        current: ib,
        vAngleDeg: (120 + angleShiftB + 360) % 360,
        iAngleDeg: (120 + angleShiftB + baseLagDeg + (ib > iMean * 1.15 ? 9 : 0) + 360) % 360,
        vRadius: clamp((vb / 260) * maxVRadius, 28, maxVRadius + 8),
        iRadius: clamp((ib / refI) * maxIRadius, 18, maxIRadius + 14),
      },
      {
        key: 'C',
        label: TOKENS.colors.phases.C.short,
        color: TOKENS.colors.phases.C.color,
        voltage: vc,
        current: ic,
        vAngleDeg: (240 + angleShiftC + 360) % 360,
        iAngleDeg: (240 + angleShiftC + baseLagDeg + 360) % 360,
        vRadius: clamp((vc / 260) * maxVRadius, 28, maxVRadius + 8),
        iRadius: clamp((ic / refI) * maxIRadius, 18, maxIRadius + 14),
      },
    ];

    return {
      vectors: list,
      imbalancePct: nemaImb,
      pfAngleDeg: baseLagDeg,
    };
  }, [reading]);

  const ariaSummary = useMemo(() => {
    const parts = vectors.map(
      (v) =>
        `Phase ${v.key}: ${v.voltage.toFixed(1)} volts at ${Math.round(v.vAngleDeg)} degrees, ${v.current.toFixed(1)} amps at ${Math.round(v.iAngleDeg)} degrees`,
    );
    return `Three-phase voltage and current phasor diagram for ${meterId}. ${parts.join('; ')}. NEMA current imbalance ${imbalancePct.toFixed(1)} percent.`;
  }, [vectors, meterId, imbalancePct]);

  const cx = 140;
  const cy = 140;

  return (
    <section
      aria-label="Three-phase phasor diagram panel"
      className="border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] flex flex-col"
    >
      {/* Panel Header */}
      <div className="px-3.5 py-2 border-b border-[#C8CDD6] dark:border-[#1E2633] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="h-2 w-2 bg-[#F59E0B] inline-block" />
          <h2 className="text-[11px] font-mono font-semibold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
            3Ø PHASOR VECTORS // V (SOLID) &amp; I (DASHED)
          </h2>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono text-[#7D899C]">
          <span>ω = 50Hz / {PHASOR_SLOWDOWN_FACTOR}x</span>
          <span
            className={
              imbalancePct >= 10
                ? 'px-1.5 py-0.5 border border-[#FF4D2D]/60 bg-[#FF4D2D]/15 text-[#FF4D2D] font-semibold'
                : 'px-1.5 py-0.5 border border-[#1E2633] text-[#F59E0B]'
            }
          >
            IMB {imbalancePct.toFixed(1)}%
          </span>
        </div>
      </div>

      {/* SVG Polar Phasor Scope */}
      <div className="p-2.5 flex flex-col items-center justify-center bg-[#F2F3EE]/50 dark:bg-[#07090D]">
        <svg
          role="img"
          aria-label={ariaSummary}
          viewBox="0 0 280 280"
          className="w-full max-w-[232px] aspect-square select-none"
        >
          <defs>
            {(['A', 'B', 'C'] as const).map((phaseKey) => (
              <marker
                key={phaseKey}
                id={`phasor-arrow-${phaseKey}`}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill={TOKENS.colors.phases[phaseKey].color} />
              </marker>
            ))}
          </defs>

          {/* Concentric Reference Rings */}
          <circle
            cx={cx}
            cy={cy}
            r={38}
            fill="none"
            stroke={TOKENS.colors.neutral}
            strokeOpacity={0.22}
            strokeDasharray="2 3"
          />
          <circle
            cx={cx}
            cy={cy}
            r={68}
            fill="none"
            stroke={TOKENS.colors.neutral}
            strokeOpacity={0.25}
            strokeDasharray="2 3"
          />
          <circle
            cx={cx}
            cy={cy}
            r={85}
            fill="none"
            stroke={TOKENS.colors.signal}
            strokeOpacity={0.28}
            strokeWidth={1}
          />
          <circle
            cx={cx}
            cy={cy}
            r={104}
            fill="none"
            stroke={TOKENS.colors.neutral}
            strokeOpacity={0.2}
          />

          {/* 120-Degree Reference Axes */}
          {[0, 120, 240].map((deg) => {
            const outer = polarToCartesian(cx, cy, 108, deg);
            const labelPos = polarToCartesian(cx, cy, 120, deg);
            return (
              <g key={deg}>
                <line
                  x1={cx}
                  y1={cy}
                  x2={outer.x}
                  y2={outer.y}
                  stroke={TOKENS.colors.neutral}
                  strokeOpacity={0.25}
                  strokeWidth={1}
                />
                <text
                  x={labelPos.x}
                  y={labelPos.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={TOKENS.colors.neutral}
                  fontSize="9"
                  fontFamily={TOKENS.typography.fontMono}
                >
                  {deg}°
                </text>
              </g>
            );
          })}

          {/* 24-Sample Fading Ghost Trails (disabled under prefers-reduced-motion) */}
          {!reducedMotion &&
            trailHistory.map((histRotDeg, idx) => {
              const progress = (idx + 1) / trailHistory.length; // 0..1 oldest -> newest
              const opacity = Number((progress * 0.5).toFixed(3));
              return (
                <g key={`trail-${idx}`}>
                  {vectors.map((v) => {
                    const tipV = polarToCartesian(cx, cy, v.vRadius, (v.vAngleDeg + histRotDeg) % 360);
                    return (
                      <line
                        key={`trail-${v.key}-${idx}`}
                        data-testid={`phasor-trail-${v.key}`}
                        x1={cx}
                        y1={cy}
                        x2={tipV.x}
                        y2={tipV.y}
                        stroke={v.color}
                        strokeOpacity={opacity}
                        strokeWidth={Number((0.4 + progress * 0.8).toFixed(2))}
                      />
                    );
                  })}
                </g>
              );
            })}

          {/* Primary Active Rotating Vectors + Live Readouts */}
          {vectors.map((v) => {
            const vRotAngle = (v.vAngleDeg + rotationDeg) % 360;
            const iRotAngle = (v.iAngleDeg + rotationDeg) % 360;

            const vTip = polarToCartesian(cx, cy, v.vRadius, vRotAngle);
            const iTip = polarToCartesian(cx, cy, v.iRadius, iRotAngle);
            const vLabelPos = polarToCartesian(cx, cy, v.vRadius + 15, vRotAngle);
            const iLabelPos = polarToCartesian(cx, cy, Math.max(26, v.iRadius - 12), iRotAngle);

            return (
              <g key={v.key} data-testid={`phasor-vector-${v.key}`}>
                <line
                  data-testid={`phasor-voltage-${v.key}`}
                  x1={cx}
                  y1={cy}
                  x2={vTip.x}
                  y2={vTip.y}
                  stroke={v.color}
                  strokeWidth={2.4}
                  markerEnd={`url(#phasor-arrow-${v.key})`}
                />
                <line
                  data-testid={`phasor-current-${v.key}`}
                  x1={cx}
                  y1={cy}
                  x2={iTip.x}
                  y2={iTip.y}
                  stroke={v.color}
                  strokeWidth={1.8}
                  strokeDasharray="4 3"
                  strokeOpacity={0.9}
                  markerEnd={`url(#phasor-arrow-${v.key})`}
                />
                <circle cx={vTip.x} cy={vTip.y} r={2.5} fill={v.color} />

                <text
                  x={vLabelPos.x}
                  y={vLabelPos.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={v.color}
                  fontSize="9.5"
                  fontWeight="600"
                  fontFamily={TOKENS.typography.fontMono}
                >
                  Ø{v.key} {v.voltage.toFixed(0)}V
                </text>

                <text
                  x={iLabelPos.x}
                  y={iLabelPos.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={v.color}
                  fontSize="8.5"
                  fontFamily={TOKENS.typography.fontMono}
                  opacity={0.92}
                >
                  {v.current.toFixed(1)}A
                </text>
              </g>
            );
          })}

          <circle
            cx={cx}
            cy={cy}
            r={3.5}
            fill={TOKENS.colors.dark.bg}
            stroke={TOKENS.colors.signal}
            strokeWidth={1.5}
          />
        </svg>

        {/* Compact Vector Readout Strip */}
        <div className="w-full mt-2 pt-2 border-t border-[#C8CDD6] dark:border-[#1E2633] grid grid-cols-1 sm:grid-cols-3 gap-1.5 text-[11px] font-mono tabular-nums">
          {vectors.map((v) => (
            <div
              key={v.key}
              className="px-2 py-1 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017]"
            >
              <div className="flex items-center justify-between text-[10px]">
                <span style={{ color: v.color }} className="font-bold">
                  {v.label}
                </span>
                <span className="text-[#7D899C]">∠{Math.round(v.vAngleDeg)}°</span>
              </div>
              <div className="mt-0.5 font-semibold text-[#11141C] dark:text-[#E6E9EF]">
                {v.voltage.toFixed(1)}V · {v.current.toFixed(1)}A
              </div>
            </div>
          ))}
        </div>

        {/* Legend Footer */}
        <div className="w-full mt-2 flex items-center justify-between text-[10px] font-mono text-[#7D899C]">
          <span>─── V (RMS) - - - I (A)</span>
          <span>PF LAG φ = {pfAngleDeg.toFixed(1)}°</span>
          <span>{reducedMotion ? 'STATIC (REDUCED MOTION)' : '24-STEP TRAIL @ 12Hz'}</span>
        </div>
      </div>
    </section>
  );
};
