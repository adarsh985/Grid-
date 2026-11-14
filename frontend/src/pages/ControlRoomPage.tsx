import React, { useEffect, useRef } from 'react';
import { KpiStrip } from '../components/KpiStrip';
import { GridMap } from '../components/GridMap';
import { AlertFeed } from '../components/AlertFeed';
import { useTelemetry } from '../context/TelemetryContext';
import { TOKENS } from '../design/tokens';
import { usePrefersReducedMotion } from '../utils/animationQueue';

export const ControlRoomPage: React.FC = () => {
  const { meters, activeRipples } = useTelemetry();
  const reducedMotion = usePrefersReducedMotion();

  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const latestPosRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (reducedMotion || e.pointerType === 'touch') return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const el = containerRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    latestPosRef.current = {
      x: Math.round(e.clientX - rect.left),
      y: Math.round(e.clientY - rect.top),
    };

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (containerRef.current && latestPosRef.current) {
          containerRef.current.style.setProperty('--spotlight-x', `${latestPosRef.current.x}px`);
          containerRef.current.style.setProperty('--spotlight-y', `${latestPosRef.current.y}px`);
          containerRef.current.style.setProperty('--spotlight-opacity', '1');
        }
      });
    }
  };

  const handlePointerLeave = () => {
    if (containerRef.current) {
      containerRef.current.style.setProperty('--spotlight-opacity', '0');
    }
  };

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      style={
        {
          '--spotlight-x': '50%',
          '--spotlight-y': '40%',
          '--spotlight-opacity': '0',
        } as React.CSSProperties
      }
      className="relative flex-1 flex flex-col overflow-hidden"
    >
      {/* 320px Pointer Spotlight (CSS custom props updated in rAF; disabled on touch / reduced motion) */}
      {!reducedMotion && (
        <div
          data-testid="pointer-spotlight"
          aria-hidden="true"
          style={{
            opacity: 'var(--spotlight-opacity)',
            background: `radial-gradient(160px circle at var(--spotlight-x) var(--spotlight-y), ${TOKENS.colors.signalDim}, transparent 75%)`,
          }}
          className="pointer-events-none absolute inset-0 z-0 transition-opacity duration-300"
        />
      )}

      {/* Top Substation KPI Strip */}
      <div className="relative z-10">
        <KpiStrip />
      </div>

      {/* Main Split Console: Schematic Grid Map (Left) + Live Alert Feed (Right) */}
      <div className="relative z-10 flex-1 grid grid-cols-1 lg:grid-cols-12">
        <div className="lg:col-span-8 flex flex-col">
          <GridMap meters={meters} activeRipples={activeRipples} />
        </div>
        <div className="lg:col-span-4 flex flex-col">
          <AlertFeed />
        </div>
      </div>
    </div>
  );
};
