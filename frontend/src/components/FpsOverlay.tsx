import React, { useEffect, useState } from 'react';
import { useTelemetry } from '../context/TelemetryContext';
import { TOKENS } from '../design/tokens';
import { MAX_PARTICLES } from '../utils/animationQueue';

export const FpsOverlay: React.FC = () => {
  const { meters, activeRipples, queuedRipplesCount } = useTelemetry();

  const [visible, setVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.location.search.includes('fps=1');
  });

  const [stats, setStats] = useState<{ fps: number; frameMs: number }>({
    fps: 60,
    frameMs: 16.7,
  });

  // Toggle on Shift+F
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Rolling 30-frame FPS measurement paused when document.hidden
  useEffect(() => {
    if (!visible) return;

    let rafId: number | null = null;
    const frameDeltas: number[] = [];
    let lastNow = performance.now();
    let lastReport = lastNow;

    const tick = (now: number) => {
      if (typeof document !== 'undefined' && document.hidden) {
        lastNow = now;
        rafId = requestAnimationFrame(tick);
        return;
      }

      const dt = now - lastNow;
      lastNow = now;
      if (dt > 0 && dt < 500) {
        frameDeltas.push(dt);
        if (frameDeltas.length > 30) frameDeltas.shift();
      }

      if (now - lastReport >= 250 && frameDeltas.length > 0) {
        lastReport = now;
        const avgMs = frameDeltas.reduce((s, x) => s + x, 0) / frameDeltas.length;
        const fps = Math.min(60, Math.round(1000 / Math.max(1, avgMs)));
        setStats({ fps, frameMs: Number(avgMs.toFixed(1)) });
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <aside
      data-testid="fps-overlay"
      aria-label="Performance telemetry overlay"
      style={{
        borderColor: TOKENS.colors.signal,
        backgroundColor: TOKENS.colors.dark.panel,
        color: TOKENS.colors.dark.textPrimary,
      }}
      className="fixed bottom-3 right-3 z-40 border px-3 py-2 font-mono text-[11px] tabular-nums select-none"
    >
      <div className="flex items-center justify-between gap-4 border-b border-[#1E2633] pb-1 mb-1">
        <span className="text-[#F59E0B] font-bold">HMI PERF MONITOR</span>
        <span className="text-[10px] text-[#7D899C]">SHIFT+F</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        <span className="text-[#7D899C]">RENDER FPS</span>
        <span className="font-bold text-right text-[#F59E0B]">{stats.fps} fps</span>
        <span className="text-[#7D899C]">FRAME TIME</span>
        <span className="text-right">{stats.frameMs.toFixed(1)} ms</span>
        <span className="text-[#7D899C]">ACTIVE METERS</span>
        <span className="text-right">{meters.length} @ 1Hz</span>
        <span className="text-[#7D899C]">PARTICLE CAP</span>
        <span className="text-right">&le; {MAX_PARTICLES}</span>
        <span className="text-[#7D899C]">RIPPLES (ACT/Q)</span>
        <span className="text-right">
          {activeRipples.length}/3 ({queuedRipplesCount}q)
        </span>
      </div>
    </aside>
  );
};
