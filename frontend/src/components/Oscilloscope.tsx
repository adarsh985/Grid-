import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { TOKENS, type PhaseKey } from '../design/tokens';
import { useTheme } from '../context/ThemeContext';
import type { Reading } from '../types';
import { formatTimeShort, getReadingTimestamp } from '../utils/format';

export const OSCILLOSCOPE_MAX_FPS = 60;
export const OSCILLOSCOPE_FRAME_INTERVAL_MS = 1000 / OSCILLOSCOPE_MAX_FPS;
export const SWEEP_PERIOD_MS = 12_000;

export function mapScrubRatioToSampleIndex(sampleCount: number, ratio: number): number {
  if (sampleCount <= 0) return -1;
  if (sampleCount === 1) return 0;
  const clamped = Math.min(1, Math.max(0, ratio));
  return Math.round(clamped * (sampleCount - 1));
}

export function getSampleAtScrubRatio(samples: Reading[], ratio: number): Reading | null {
  const idx = mapScrubRatioToSampleIndex(samples.length, ratio);
  return idx >= 0 ? samples[idx] : null;
}

export function mapTimestampToScrubRatio(samples: Reading[], isoTimestamp: string): number {
  if (samples.length <= 1) return 0;
  const targetMs = Date.parse(isoTimestamp);
  if (Number.isNaN(targetMs)) return 1;

  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    const tMs = Date.parse(getReadingTimestamp(samples[i]) ?? '');
    if (Number.isNaN(tMs)) continue;
    const diff = Math.abs(tMs - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx / (samples.length - 1);
}

export interface OscilloscopeProps {
  meterId: string;
  samples: Reading[];
  externalScrubTimestamp: string | null;
  onScrubChange: (sample: Reading | null, timestamp: string | null) => void;
  onReturnToLive: () => void;
}

export const Oscilloscope: React.FC<OscilloscopeProps> = ({
  meterId,
  samples,
  externalScrubTimestamp,
  onScrubChange,
  onReturnToLive,
}) => {
  const { theme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastDrawMsRef = useRef<number>(0);
  const isDraggingRef = useRef<boolean>(false);
  const lastEmittedTsRef = useRef<string | null>(null);

  const [visiblePhases, setVisiblePhases] = useState<Record<PhaseKey, boolean>>({
    A: true,
    B: true,
    C: true,
  });

  // When scrubRatio !== null, live telemetry stream is paused on screen via a frozen snapshot
  const [scrubRatio, setScrubRatio] = useState<number | null>(null);
  const [frozenSamples, setFrozenSamples] = useState<Reading[] | null>(null);
  const [sweepRatio, setSweepRatio] = useState<number>(0.85);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({
    width: 960,
    height: 300,
  });

  const isScrubbing = scrubRatio !== null || externalScrubTimestamp !== null;
  const activeSamples = useMemo(
    () => (isScrubbing && frozenSamples ? frozenSamples : samples),
    [isScrubbing, frozenSamples, samples],
  );

  // Sync external scrub trigger (from AlertTimeline tick click)
  useEffect(() => {
    if (externalScrubTimestamp === null) {
      lastEmittedTsRef.current = null;
      setScrubRatio(null);
      setFrozenSamples(null);
      return;
    }
    if (externalScrubTimestamp === lastEmittedTsRef.current) {
      return;
    }
    const base = frozenSamples ?? samples;
    if (!frozenSamples) {
      setFrozenSamples(samples);
    }
    const ratio = mapTimestampToScrubRatio(base, externalScrubTimestamp);
    setScrubRatio(ratio);
  }, [externalScrubTimestamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeSample = useMemo(() => {
    if (activeSamples.length === 0) return null;
    if (scrubRatio !== null) {
      return getSampleAtScrubRatio(activeSamples, scrubRatio);
    }
    return activeSamples[activeSamples.length - 1];
  }, [activeSamples, scrubRatio]);

  // Responsive ResizeObserver for crisp HiDPI canvas sizing
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) {
        setCanvasSize({
          width: Math.max(320, Math.floor(rect.width)),
          height: 300,
        });
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const togglePhase = (phase: PhaseKey) => {
    setVisiblePhases((prev) => ({
      ...prev,
      [phase]: !prev[phase],
    }));
  };

  const applyScrubFromClientX = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const width = rect.width > 0 ? rect.width : canvasSize.width;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / width));

      const snapshot = frozenSamples ?? samples;
      if (!frozenSamples) {
        setFrozenSamples(samples);
      }
      setScrubRatio(ratio);
      const sample = getSampleAtScrubRatio(snapshot, ratio);
      const ts = sample ? getReadingTimestamp(sample) ?? null : null;
      lastEmittedTsRef.current = ts;
      onScrubChange(sample, ts);
    },
    [canvasSize.width, frozenSamples, onScrubChange, samples],
  );

  const handleReturnToLive = useCallback(() => {
    isDraggingRef.current = false;
    setScrubRatio(null);
    setFrozenSamples(null);
    onScrubChange(null, null);
    onReturnToLive();
  }, [onReturnToLive, onScrubChange]);

  // Draw phosphor oscilloscope canvas (capped at 60 fps and paused when tab is hidden)
  const drawOscilloscope = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvasSize;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    const palette = theme === 'dark' ? TOKENS.colors.dark : TOKENS.colors.light;
    const padLeft = 48;
    const padRight = 14;
    const padTop = 18;
    const padBottom = 20;
    const plotW = Math.max(40, width - padLeft - padRight);
    const totalPlotH = Math.max(80, height - padTop - padBottom);
    const bandGap = 16;
    const vBandTop = padTop;
    const vBandH = Math.floor((totalPlotH - bandGap) * 0.5);
    const iBandTop = vBandTop + vBandH + bandGap;
    const iBandH = totalPlotH - vBandH - bandGap;

    // 1. Background fill
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, width, height);

    // 2. Graticule matching index.css (24px minor, 120px major)
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme === 'dark' ? TOKENS.colors.signalDim : palette.border;
    ctx.globalAlpha = theme === 'dark' ? 0.3 : 0.4;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 24) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
    }
    for (let y = 0; y <= height; y += 24) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
    }
    ctx.stroke();

    ctx.strokeStyle = TOKENS.colors.neutral;
    ctx.globalAlpha = theme === 'dark' ? 0.2 : 0.25;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 120) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height);
    }
    for (let y = 0; y <= height; y += 120) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(width, y + 0.5);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Band frames & statutory reference lines
    const vMin = 180;
    const vMax = 260;
    const vToY = (v: number) => {
      const norm = (v - vMin) / (vMax - vMin);
      return vBandTop + vBandH - Math.min(1, Math.max(0, norm)) * vBandH;
    };

    const iValues = activeSamples.flatMap((s) => [s.current_a, s.current_b, s.current_c]);
    const maxCurrent = Math.max(30, ...(iValues.length > 0 ? iValues : [30])) * 1.15;
    const iToY = (c: number) => {
      const norm = c / maxCurrent;
      return iBandTop + iBandH - Math.min(1, Math.max(0, norm)) * iBandH;
    };

    // EN 50160 statutory bounds (207V - 253V)
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = TOKENS.colors.alert;
    ctx.globalAlpha = 0.65;
    [TOKENS.limits.voltageMin, TOKENS.limits.voltageMax].forEach((limitV) => {
      const ly = vToY(limitV);
      ctx.beginPath();
      ctx.moveTo(padLeft, ly);
      ctx.lineTo(padLeft + plotW, ly);
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Axis labels
    ctx.font = `10px ${TOKENS.typography.fontMono}`;
    ctx.fillStyle = palette.textMuted;
    ctx.textAlign = 'right';
    ctx.fillText('260V', padLeft - 6, vBandTop + 8);
    ctx.fillText('230V', padLeft - 6, vToY(230) + 3);
    ctx.fillText('180V', padLeft - 6, vBandTop + vBandH);
    ctx.fillText(`${Math.round(maxCurrent)}A`, padLeft - 6, iBandTop + 8);
    ctx.fillText('0A', padLeft - 6, iBandTop + iBandH);

    ctx.textAlign = 'left';
    ctx.fillStyle = TOKENS.colors.signal;
    ctx.fillText('CH1–CH3 // VOLTAGE (RMS V)', padLeft, vBandTop - 5);
    ctx.fillText('CH4–CH6 // PHASE CURRENT (A)', padLeft, iBandTop - 5);

    // 3. Draw Phosphor Phase Traces
    if (activeSamples.length > 0) {
      const phases: {
        key: PhaseKey;
        vField: 'voltage_a' | 'voltage_b' | 'voltage_c';
        iField: 'current_a' | 'current_b' | 'current_c';
      }[] = [
        { key: 'A', vField: 'voltage_a', iField: 'current_a' },
        { key: 'B', vField: 'voltage_b', iField: 'current_b' },
        { key: 'C', vField: 'voltage_c', iField: 'current_c' },
      ];

      phases.forEach(({ key, vField, iField }) => {
        if (!visiblePhases[key]) return;
        const phaseColor = TOKENS.colors.phases[key].color;

        // Voltage trace (solid with phosphor glow)
        ctx.save();
        ctx.strokeStyle = phaseColor;
        ctx.lineWidth = 1.9;
        ctx.shadowColor = phaseColor;
        ctx.shadowBlur = theme === 'dark' ? 6 : 0;
        ctx.beginPath();
        activeSamples.forEach((sample, idx) => {
          const x =
            activeSamples.length === 1
              ? padLeft + plotW
              : padLeft + (idx / (activeSamples.length - 1)) * plotW;
          const y = vToY(sample[vField]);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.restore();

        // Current trace (bright solid trace in bottom band)
        ctx.save();
        ctx.strokeStyle = phaseColor;
        ctx.lineWidth = 1.8;
        ctx.shadowColor = phaseColor;
        ctx.shadowBlur = theme === 'dark' ? 5 : 0;
        ctx.beginPath();
        activeSamples.forEach((sample, idx) => {
          const x =
            activeSamples.length === 1
              ? padLeft + plotW
              : padLeft + (idx / (activeSamples.length - 1)) * plotW;
          const y = iToY(sample[iField]);
          if (idx === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.restore();
      });
    }

    // 4. Vertical Sweep / Scrub Cursor
    const cursorRatio = scrubRatio !== null ? scrubRatio : sweepRatio;
    const cursorX = padLeft + Math.min(1, Math.max(0, cursorRatio)) * plotW;
    ctx.save();
    ctx.strokeStyle = isScrubbing ? TOKENS.colors.alert : TOKENS.colors.signal;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(isScrubbing ? [] : [3, 3]);
    ctx.beginPath();
    ctx.moveTo(cursorX, padTop - 4);
    ctx.lineTo(cursorX, height - padBottom + 4);
    ctx.stroke();

    // Cursor head marker triangle
    ctx.fillStyle = isScrubbing ? TOKENS.colors.alert : TOKENS.colors.signal;
    ctx.beginPath();
    ctx.moveTo(cursorX - 4, padTop - 6);
    ctx.lineTo(cursorX + 4, padTop - 6);
    ctx.lineTo(cursorX, padTop);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }, [activeSamples, canvasSize, isScrubbing, scrubRatio, sweepRatio, theme, visiblePhases]);

  // Throttled 60fps animation loop for CRT sweep cursor & hidden-tab skip
  useEffect(() => {
    let rafId: number | null = null;
    let cancelled = false;

    const tick = (now: number) => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.hidden) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      if (now - lastDrawMsRef.current >= OSCILLOSCOPE_FRAME_INTERVAL_MS) {
        lastDrawMsRef.current = now;
        if (!isScrubbing) {
          setSweepRatio((now % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS);
        }
        drawOscilloscope();
      }
      rafId = requestAnimationFrame(tick);
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        lastDrawMsRef.current = 0;
        drawOscilloscope();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    drawOscilloscope();
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [drawOscilloscope, isScrubbing]);

  const canvasAriaLabel = useMemo(() => {
    if (!activeSample) {
      return `Three-phase voltage and current oscilloscope for ${meterId}. Waiting for telemetry samples.`;
    }
    const activeNames = (['A', 'B', 'C'] as PhaseKey[])
      .filter((k) => visiblePhases[k])
      .join(', ');
    return `Three-phase oscilloscope for ${meterId} (${isScrubbing ? 'paused at scrub cursor' : 'live rolling 15-minute window'}). Visible phases: ${activeNames || 'none'}. Phase A ${activeSample.voltage_a.toFixed(1)} V / ${activeSample.current_a.toFixed(1)} A, Phase B ${activeSample.voltage_b.toFixed(1)} V / ${activeSample.current_b.toFixed(1)} A, Phase C ${activeSample.voltage_c.toFixed(1)} V / ${activeSample.current_c.toFixed(1)} A.`;
  }, [activeSample, isScrubbing, meterId, visiblePhases]);

  const srTableSamples = useMemo(() => activeSamples.slice(-10).reverse(), [activeSamples]);

  const activeTimestampLabel = externalScrubTimestamp
    ? formatTimeShort(externalScrubTimestamp)
    : activeSample
      ? formatTimeShort(getReadingTimestamp(activeSample))
      : '--:--:--';

  return (
    <section
      aria-label="Three-phase phosphor oscilloscope panel"
      className="relative z-20 isolate border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] flex flex-col"
    >
      {/* Top Toolbar: Title, Phase Legend Toggles, Live/Scrub Controls */}
      <div className="px-3.5 py-2 border-b border-[#C8CDD6] dark:border-[#1E2633] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className={clsx(
              'h-2 w-2 inline-block',
              isScrubbing ? 'bg-[#FF4D2D]' : 'bg-[#F59E0B]',
            )}
          />
          <h2 className="text-[11px] font-mono font-semibold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
            PHOSPHOR OSCILLOSCOPE // 15M WINDOW ({activeSamples.length}/900 SAMPLES)
          </h2>
          <span
            data-testid="osc-mode-badge"
            className={clsx(
              'px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase border',
              isScrubbing
                ? 'border-[#FF4D2D]/60 bg-[#FF4D2D]/15 text-[#FF4D2D]'
                : 'border-[#F59E0B]/50 bg-[#F59E0B]/10 text-[#F59E0B]',
            )}
          >
            {isScrubbing ? `PAUSED @ ${activeTimestampLabel}` : 'LIVE SWEEP'}
          </span>
        </div>

        {/* Phase Toggle Buttons (local state, aria-pressed) */}
        <div
          role="group"
          aria-label="Toggle oscilloscope phase traces"
          className="flex flex-wrap items-center gap-1.5"
        >
          {(['A', 'B', 'C'] as PhaseKey[]).map((phaseKey) => {
            const meta = TOKENS.colors.phases[phaseKey];
            const pressed = visiblePhases[phaseKey];
            return (
              <button
                key={phaseKey}
                type="button"
                aria-pressed={pressed}
                data-testid={`phase-toggle-${phaseKey}`}
                onClick={() => togglePhase(phaseKey)}
                className={clsx(
                  'px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider border inline-flex items-center gap-1.5 transition-colors focus:outline-none focus:ring-1 focus:ring-[#F59E0B]',
                  pressed
                    ? 'border-[#C8CDD6] dark:border-[#1E2633] bg-[#E7E9E2] dark:bg-[#121822] text-[#11141C] dark:text-[#E6E9EF]'
                    : 'border-[#C8CDD6]/50 dark:border-[#1E2633]/60 bg-transparent text-[#7D899C] opacity-55 line-through',
                )}
              >
                <span
                  aria-hidden="true"
                  className="h-2 w-2 inline-block"
                  style={{ backgroundColor: pressed ? meta.color : TOKENS.colors.neutral }}
                />
                Phase {phaseKey}
              </button>
            );
          })}

          {isScrubbing && (
            <button
              type="button"
              onClick={handleReturnToLive}
              className="ml-1 px-2.5 py-1 text-[11px] font-mono font-semibold uppercase tracking-wider border border-[#F59E0B] bg-[#F59E0B]/20 text-[#F59E0B] hover:bg-[#F59E0B]/30 focus:outline-none focus:ring-1 focus:ring-[#F59E0B]"
            >
              Return to live
            </button>
          )}
        </div>
      </div>

      {/* Scrub Readout Strip */}
      <div
        data-testid="osc-readout"
        className="px-3.5 py-1.5 border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE] dark:bg-[#07090D] flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono tabular-nums"
      >
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-[#7D899C]">
            CURSOR TS: <strong className="text-[#11141C] dark:text-[#E6E9EF]">{activeTimestampLabel}</strong>
          </span>
          {visiblePhases.A && (
            <span style={{ color: TOKENS.colors.phases.A.color }}>
              ØA: {activeSample ? `${activeSample.voltage_a.toFixed(1)}V / ${activeSample.current_a.toFixed(1)}A` : '—'}
            </span>
          )}
          {visiblePhases.B && (
            <span style={{ color: TOKENS.colors.phases.B.color }}>
              ØB: {activeSample ? `${activeSample.voltage_b.toFixed(1)}V / ${activeSample.current_b.toFixed(1)}A` : '—'}
            </span>
          )}
          {visiblePhases.C && (
            <span style={{ color: TOKENS.colors.phases.C.color }}>
              ØC: {activeSample ? `${activeSample.voltage_c.toFixed(1)}V / ${activeSample.current_c.toFixed(1)}A` : '—'}
            </span>
          )}
        </div>
        <span className="text-[10px] text-[#7D899C]">
          DRAG CANVAS OR PRESS ←/→ TO SCRUB TIMELINE
        </span>
      </div>

      {/* Canvas Plot Area */}
      <div ref={containerRef} className="relative w-full">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={canvasAriaLabel}
          tabIndex={0}
          style={{ width: '100%', height: '300px', display: 'block' }}
          className="cursor-crosshair focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[#F59E0B]"
          onMouseDown={(e) => {
            isDraggingRef.current = true;
            applyScrubFromClientX(e.clientX);
          }}
          onMouseMove={(e) => {
            if (isDraggingRef.current) {
              applyScrubFromClientX(e.clientX);
            }
          }}
          onMouseUp={() => {
            isDraggingRef.current = false;
          }}
          onMouseLeave={() => {
            isDraggingRef.current = false;
          }}
          onPointerDown={(e) => {
            isDraggingRef.current = true;
            applyScrubFromClientX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (isDraggingRef.current) {
              applyScrubFromClientX(e.clientX);
            }
          }}
          onPointerUp={() => {
            isDraggingRef.current = false;
          }}
          onKeyDown={(e) => {
            if (activeSamples.length <= 1) return;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              const snapshot = frozenSamples ?? samples;
              if (!frozenSamples) setFrozenSamples(samples);
              const currentRatio = scrubRatio ?? 1;
              const delta = e.key === 'ArrowLeft' ? -0.05 : 0.05;
              const nextRatio = Math.min(1, Math.max(0, currentRatio + delta));
              setScrubRatio(nextRatio);
              const sample = getSampleAtScrubRatio(snapshot, nextRatio);
              const ts = sample ? getReadingTimestamp(sample) ?? null : null;
              lastEmittedTsRef.current = ts;
              onScrubChange(sample, ts);
            }
          }}
        />
      </div>

      {/* Visually Hidden Accessible Data Table of Last 10 Samples */}
      <div className="sr-only">
        <table>
          <caption>Last 10 three-phase oscilloscope samples for {meterId}</caption>
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">Voltage A (V)</th>
              <th scope="col">Voltage B (V)</th>
              <th scope="col">Voltage C (V)</th>
              <th scope="col">Current A (A)</th>
              <th scope="col">Current B (A)</th>
              <th scope="col">Current C (A)</th>
              <th scope="col">Power Factor</th>
              <th scope="col">Frequency (Hz)</th>
            </tr>
          </thead>
          <tbody>
            {srTableSamples.map((r, idx) => (
              <tr key={`${getReadingTimestamp(r) ?? idx}`}>
                <td>{getReadingTimestamp(r) ?? 'unknown'}</td>
                <td>{r.voltage_a.toFixed(2)}</td>
                <td>{r.voltage_b.toFixed(2)}</td>
                <td>{r.voltage_c.toFixed(2)}</td>
                <td>{r.current_a.toFixed(2)}</td>
                <td>{r.current_b.toFixed(2)}</td>
                <td>{r.current_c.toFixed(2)}</td>
                <td>{r.power_factor.toFixed(3)}</td>
                <td>{r.frequency.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
