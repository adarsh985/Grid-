import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { TOKENS } from '../design/tokens';
import { SUBSTATION_FEEDERS, getFeederForMeterIndex } from '../mock/mockData';
import type { MeterSummary } from '../types';
import {
  MAX_PARTICLES,
  computeFeederFlowStats,
  computeFeederParticles,
  usePrefersReducedMotion,
  type OneShotAnimationItem,
} from '../utils/animationQueue';
import {
  computeLoadKw,
  formatFaultLabel,
  formatTimeShort,
  getMeterStatus,
  getReadingTimestamp,
} from '../utils/format';

export interface GridMapProps {
  meters: MeterSummary[];
  activeRipples?: OneShotAnimationItem[];
}

interface PositionedNode {
  meter: MeterSummary;
  x: number;
  y: number;
  feederIdx: number;
  status: 'critical' | 'warning' | 'normal';
}

const VIEWBOX_W = 940;
const VIEWBOX_H = 540;
const BUSBAR_X = 148;
const BUSBAR_Y1 = 80;
const BUSBAR_Y2 = 480;
const FEEDER_X1 = 148;
const FEEDER_X2 = 905;

export const GridMap: React.FC<GridMapProps> = ({ meters, activeRipples = [] }) => {
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);

  const particleCircleRefs = useRef<(SVGCircleElement | null)[]>([]);
  const particleOffsetsRef = useRef<number[]>([]);

  const nodes = useMemo<PositionedNode[]>(() => {
    return meters.map((meter, idx) => {
      const feeder = getFeederForMeterIndex(idx);
      const feederIdx = idx < 7 ? 0 : idx < 14 ? 1 : 2;
      const posInFeeder = idx < 7 ? idx : idx < 14 ? idx - 7 : idx - 14;
      const x = 235 + posInFeeder * 105;
      const yOffset = posInFeeder % 2 === 0 ? -42 : 42;
      return {
        meter,
        x,
        y: feeder.yCenter + yOffset,
        feederIdx,
        status: getMeterStatus(meter),
      };
    });
  }, [meters]);

  const feederStats = useMemo(() => computeFeederFlowStats(meters), [meters]);
  const particles = useMemo(
    () => computeFeederParticles(meters, reducedMotion, MAX_PARTICLES),
    [meters, reducedMotion],
  );
  const particlesRef = useRef(particles);
  particlesRef.current = particles;

  // Initialize particle offset array whenever particle count changes
  useEffect(() => {
    particleOffsetsRef.current = particles.map((p, idx) =>
      particleOffsetsRef.current[idx] !== undefined ? particleOffsetsRef.current[idx] : p.offsetRatio,
    );
  }, [particles]);

  // Single rAF loop animating SVG particle transforms without React re-renders; pauses when document.hidden
  useEffect(() => {
    if (reducedMotion || particles.length === 0) return;

    let rafId: number | null = null;
    let lastMs = performance.now();

    const step = (now: number) => {
      if (typeof document !== 'undefined' && document.hidden) {
        lastMs = now;
        rafId = requestAnimationFrame(step);
        return;
      }

      const dtSec = Math.min(0.05, Math.max(0, (now - lastMs) / 1000));
      lastMs = now;

      const list = particlesRef.current;
      for (let i = 0; i < list.length; i += 1) {
        const p = list[i];
        const el = particleCircleRefs.current[i];
        if (!el) continue;

        const trackLength = p.track === 'busbar' ? BUSBAR_Y2 - BUSBAR_Y1 : FEEDER_X2 - FEEDER_X1;
        const nextOffset =
          ((particleOffsetsRef.current[i] ?? p.offsetRatio) + (p.speedPxPerSec * dtSec) / trackLength) %
          1;
        particleOffsetsRef.current[i] = nextOffset;

        if (p.track === 'busbar') {
          const py = BUSBAR_Y1 + nextOffset * (BUSBAR_Y2 - BUSBAR_Y1);
          el.setAttribute('transform', `translate(${BUSBAR_X}, ${py.toFixed(1)})`);
        } else {
          const fy = SUBSTATION_FEEDERS[p.feederIdx]?.yCenter ?? 130;
          const px = FEEDER_X1 + nextOffset * (FEEDER_X2 - FEEDER_X1);
          el.setAttribute('transform', `translate(${px.toFixed(1)}, ${fy})`);
        }
      }

      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [reducedMotion, particles.length]);

  const hoveredNode = useMemo(
    () => (hoveredId ? nodes.find((n) => n.meter.id === hoveredId) ?? null : null),
    [nodes, hoveredId],
  );

  const dockedNode = useMemo(
    () =>
      hoveredNode ??
      (inspectedId ? nodes.find((n) => n.meter.id === inspectedId) : null) ??
      nodes.find((n) => n.status === 'critical') ??
      nodes[0],
    [hoveredNode, inspectedId, nodes],
  );

  const flickeringFeeders = useMemo(() => {
    const map = new Set<number>();
    activeRipples.forEach((r) => map.add(r.feederIdx));
    return map;
  }, [activeRipples]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-meter-node]')) return;
    setDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  };

  const handlePointerUp = () => setDragging(false);

  return (
    <div
      role="region"
      aria-label="Substation single-line schematic diagram"
      className="flex flex-col h-full bg-[#F2F3EE] dark:bg-[#07090D]"
    >
      {/* Schematic Toolbar */}
      <div className="px-3.5 py-2 border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-mono font-semibold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
            SLD // 33/11kV PRIMARY SUBSTATION TOPOLOGY
          </span>
          <span className="hidden xl:inline-block text-[10px] font-mono text-[#7D899C]">
            [HOVER NODE FOR MAGNETIC READOUT · CLICK TO EXPAND OSCILLOSCOPE]
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Non-color-only Status Legend + Dominant Phase Flow Key */}
          <div className="flex items-center gap-3 text-[10px] font-mono">
            <span className="inline-flex items-center gap-1 text-[#F59E0B]">
              <span>●</span> NOMINAL
            </span>
            <span className="inline-flex items-center gap-1 text-[#F59E0B]">
              <span>◆</span> ACK/WARN
            </span>
            <span className="inline-flex items-center gap-1 text-[#FF4D2D]">
              <span>▲</span> FAULT/THEFT
            </span>
          </div>

          <div className="hidden md:flex items-center border border-[#C8CDD6] dark:border-[#1E2633] divide-x divide-[#C8CDD6] dark:divide-[#1E2633] text-xs font-mono">
            <button
              type="button"
              aria-label="Zoom out schematic"
              onClick={() => setZoom((z) => Math.max(0.7, +(z - 0.15).toFixed(2)))}
              className="px-2 py-0.5 hover:bg-[#F59E0B]/15"
            >
              -
            </button>
            <span className="px-2 py-0.5 text-[10px] text-[#7D899C]">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              aria-label="Zoom in schematic"
              onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.15).toFixed(2)))}
              className="px-2 py-0.5 hover:bg-[#F59E0B]/15"
            >
              +
            </button>
            <button
              type="button"
              aria-label="Reset schematic view"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              className="px-2 py-0.5 text-[10px] hover:bg-[#F59E0B]/15"
            >
              1:1
            </button>
          </div>
        </div>
      </div>

      {/* Desktop / Tablet Interactive Single-Line Diagram Canvas */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        className={clsx(
          'hidden md:flex relative flex-1 min-h-[450px] items-center justify-center overflow-hidden select-none p-2',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
      >
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
          }}
          className="relative w-full max-w-[940px] aspect-[940/540]"
        >
          {/* Underlying SVG Busbars, Feeders, Tap Lines, Power Flow Particles, and Fault Ripples */}
          <svg
            viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
            role="img"
            aria-label="Interactive electrical grid single-line schematic showing 3 feeders, power flow, and 20 smart meters"
            className="w-full h-full block"
          >
            {/* Substation HV Busbar Trunk on Left */}
            <rect
              x={28}
              y={65}
              width={92}
              height={425}
              fill="none"
              stroke={TOKENS.colors.neutral}
              strokeWidth={1}
              strokeDasharray="4 3"
            />
            <text
              x={36}
              y={84}
              fill={TOKENS.colors.neutral}
              fontSize="10"
              fontFamily={TOKENS.typography.fontMono}
            >
              SUB-01 33kV
            </text>

            {/* Vertical 11kV Main Busbar */}
            <line
              x1={BUSBAR_X}
              y1={BUSBAR_Y1}
              x2={BUSBAR_X}
              y2={BUSBAR_Y2}
              stroke={TOKENS.colors.signal}
              strokeWidth={3}
            />
            <text
              x={136}
              y={68}
              fill={TOKENS.colors.signal}
              fontSize="10"
              fontFamily={TOKENS.typography.fontMono}
              fontWeight="600"
            >
              11kV BUSBAR
            </text>

            {/* Step-Down Transformer Symbol (33/11kV) */}
            <circle cx={66} cy={278} r={16} fill="none" stroke={TOKENS.colors.signal} strokeWidth={1.8} />
            <circle cx={84} cy={278} r={16} fill="none" stroke={TOKENS.colors.signal} strokeWidth={1.8} />
            <line x1={100} y1={278} x2={BUSBAR_X} y2={278} stroke={TOKENS.colors.signal} strokeWidth={2} />

            {/* Three Distribution Feeders */}
            {SUBSTATION_FEEDERS.map((feeder, fIdx) => {
              const y = feeder.yCenter;
              const stat = feederStats[fIdx];
              const isFlickering = flickeringFeeders.has(fIdx);

              return (
                <g key={feeder.id}>
                  {/* Breaker Box on Feeder Head */}
                  <rect
                    x={162}
                    y={y - 7}
                    width={14}
                    height={14}
                    fill={TOKENS.colors.dark.panel}
                    stroke={stat?.color ?? TOKENS.colors.signal}
                    strokeWidth={1.5}
                  />
                  {/* Feeder Horizontal Base Line */}
                  <motion.line
                    x1={FEEDER_X1}
                    y1={y}
                    x2={FEEDER_X2}
                    y2={y}
                    stroke={isFlickering ? TOKENS.colors.alert : TOKENS.colors.neutral}
                    strokeWidth={isFlickering ? 2.2 : 1.5}
                    initial={{ opacity: 0.7 }}
                    animate={
                      isFlickering && !reducedMotion
                        ? { opacity: [1, 0.4, 1] }
                        : { opacity: 0.7 }
                    }
                    transition={
                      isFlickering && !reducedMotion
                        ? { duration: 0.3, ease: 'easeInOut' }
                        : { duration: 0.2 }
                    }
                  />

                  {/* Reduced-motion fallback: static dashed power flow line */}
                  {reducedMotion && (
                    <line
                      data-testid="static-power-flow-line"
                      x1={FEEDER_X1 + 28}
                      y1={y}
                      x2={FEEDER_X2}
                      y2={y}
                      stroke={stat?.color ?? TOKENS.colors.signal}
                      strokeWidth={1.5}
                      strokeDasharray="6 4"
                      strokeOpacity={0.6}
                    />
                  )}

                  <text
                    x={162}
                    y={y + 18}
                    fill={TOKENS.colors.neutral}
                    fontSize="9.5"
                    fontFamily={TOKENS.typography.fontMono}
                    fontWeight="600"
                  >
                    {feeder.code} · {stat ? `${stat.totalKw.toFixed(0)}kW Ø${stat.dominantPhase}` : ''}
                  </text>
                </g>
              );
            })}

            {/* Tap Lines from Feeders + Fault Ripples */}
            {nodes.map(({ meter, x, y, feederIdx, status }) => {
              const feederY = SUBSTATION_FEEDERS[feederIdx].yCenter;
              const isCrit = status === 'critical';
              const isWarn = status === 'warning';
              const strokeColor = isCrit ? TOKENS.colors.alert : TOKENS.colors.signal;
              const isNeighborDimmed =
                hoveredNode !== null &&
                hoveredNode.feederIdx === feederIdx &&
                hoveredNode.meter.id !== meter.id;

              const nodeRipples = activeRipples.filter((r) => r.meterId === meter.id);

              return (
                <g
                  key={`svg-${meter.id}`}
                  style={{ opacity: isNeighborDimmed ? 0.6 : 1, transition: 'opacity 180ms ease' }}
                >
                  <line
                    x1={x}
                    y1={feederY}
                    x2={x}
                    y2={y}
                    stroke={strokeColor}
                    strokeWidth={isCrit ? 1.8 : 1.1}
                    strokeDasharray={isWarn ? '3 2' : undefined}
                  />
                  <circle cx={x} cy={feederY} r={3} fill={strokeColor} />

                  {/* One-shot queued Fault Ripple (2 concentric expanding rings over 900ms) */}
                  {nodeRipples.map((ripple) =>
                    reducedMotion ? (
                      <circle
                        key={ripple.id}
                        data-testid="fault-ripple-static"
                        cx={x}
                        cy={y}
                        r={28}
                        fill="none"
                        stroke={TOKENS.colors.alert}
                        strokeWidth={1.8}
                      />
                    ) : (
                      <g key={ripple.id}>
                        <motion.circle
                          data-testid="fault-ripple-ring"
                          cx={x}
                          cy={y}
                          r={20}
                          fill="none"
                          stroke={TOKENS.colors.alert}
                          strokeWidth={2}
                          style={{ transformOrigin: `${x}px ${y}px` }}
                          initial={{ scale: 0.8, opacity: 0.9 }}
                          animate={{ scale: 2.3, opacity: 0 }}
                          transition={{ duration: 0.9, ease: 'easeOut' }}
                        />
                        <motion.circle
                          data-testid="fault-ripple-ring"
                          cx={x}
                          cy={y}
                          r={20}
                          fill="none"
                          stroke={TOKENS.colors.signal}
                          strokeWidth={1.4}
                          style={{ transformOrigin: `${x}px ${y}px` }}
                          initial={{ scale: 0.6, opacity: 0.85 }}
                          animate={{ scale: 1.9, opacity: 0 }}
                          transition={{ duration: 0.9, delay: 0.08, ease: 'easeOut' }}
                        />
                      </g>
                    ),
                  )}
                </g>
              );
            })}

            {/* Power Flow Particles (rAF animated SVG circles, strictly <= 120) */}
            {!reducedMotion &&
              particles.map((p, idx) => {
                const initX =
                  p.track === 'busbar'
                    ? BUSBAR_X
                    : FEEDER_X1 + p.offsetRatio * (FEEDER_X2 - FEEDER_X1);
                const initY =
                  p.track === 'busbar'
                    ? BUSBAR_Y1 + p.offsetRatio * (BUSBAR_Y2 - BUSBAR_Y1)
                    : SUBSTATION_FEEDERS[p.feederIdx]?.yCenter ?? 130;

                return (
                  <circle
                    key={p.id}
                    ref={(el) => {
                      particleCircleRefs.current[idx] = el;
                    }}
                    data-testid="power-flow-particle"
                    cx={0}
                    cy={0}
                    r={p.radius}
                    fill={p.color}
                    fillOpacity={0.88}
                    transform={`translate(${initX.toFixed(1)}, ${initY.toFixed(1)})`}
                  />
                );
              })}
          </svg>

          {/* HTML Node Layer for Sharp Typography, Spring Magnetism, & Shared-Element layoutId */}
          {nodes.map(({ meter, x, y, feederIdx, status }) => {
            const isCrit = status === 'critical';
            const isWarn = status === 'warning';
            const strokeColor = isCrit ? TOKENS.colors.alert : TOKENS.colors.signal;
            const loadKw = computeLoadKw(meter.latest_reading);
            const isHovered = hoveredId === meter.id;
            const isNeighborDimmed =
              hoveredNode !== null &&
              hoveredNode.feederIdx === feederIdx &&
              hoveredNode.meter.id !== meter.id;

            const leftPct = (x / VIEWBOX_W) * 100;
            const topPct = (y / VIEWBOX_H) * 100;

            return (
              <motion.button
                key={meter.id}
                type="button"
                data-meter-node={meter.id}
                data-dimmed={isNeighborDimmed ? 'true' : 'false'}
                aria-label={`Meter ${meter.id}, status ${status}, load ${loadKw.toFixed(1)} kW`}
                onMouseEnter={() => {
                  setHoveredId(meter.id);
                  setInspectedId(meter.id);
                }}
                onMouseLeave={() => setHoveredId((prev) => (prev === meter.id ? null : prev))}
                onFocus={() => {
                  setHoveredId(meter.id);
                  setInspectedId(meter.id);
                }}
                onBlur={() => setHoveredId((prev) => (prev === meter.id ? null : prev))}
                onClick={() => navigate(`/meters/${encodeURIComponent(meter.id)}`)}
                style={{
                  left: `${leftPct}%`,
                  top: `${topPct}%`,
                  transform: 'translate(-50%, -50%)',
                  borderColor: strokeColor,
                }}
                animate={{
                  scale: isHovered && !reducedMotion ? 1.15 : 1,
                  opacity: isNeighborDimmed ? 0.6 : 1,
                }}
                transition={{
                  scale: { type: 'spring', stiffness: 400, damping: 25 },
                  opacity: { duration: 0.16 },
                }}
                className={clsx(
                  'absolute -translate-x-1/2 -translate-y-1/2 w-[82px] px-1.5 py-1 text-left border font-mono leading-tight focus:outline-none focus:ring-1 focus:ring-[#F59E0B] z-10',
                  isCrit
                    ? 'bg-[#250D0B] text-[#E6E9EF]'
                    : 'bg-[#FFFFFF] dark:bg-[#0C1017] text-[#11141C] dark:text-[#E6E9EF]',
                  isHovered && 'z-20 border-2',
                )}
              >
                <div className="flex items-center justify-between gap-1 text-[10px] font-bold">
                  <motion.span
                    layoutId={`meter-status-${meter.id}`}
                    transition={{ duration: 0.32 }}
                    style={{ color: isCrit ? TOKENS.colors.alert : TOKENS.colors.signal }}
                  >
                    {isCrit ? '▲' : isWarn ? '◆' : '●'}
                  </motion.span>
                  <motion.span
                    layoutId={`meter-header-${meter.id}`}
                    transition={{ duration: 0.32 }}
                    className="truncate"
                  >
                    {meter.id.replace('MTR-', 'M')}
                  </motion.span>
                </div>
                <div
                  className="text-[9.5px] tabular-nums"
                  style={{ color: isCrit ? TOKENS.colors.alert : TOKENS.colors.signal }}
                >
                  {loadKw.toFixed(1)}kW
                </div>
              </motion.button>
            );
          })}

          {/* Clip-Path Reveal Magnetic Readout Card on Hover */}
          {hoveredNode && hoveredNode.meter.latest_reading && (
            <motion.div
              key={`readout-${hoveredNode.meter.id}`}
              data-testid="magnetic-node-readout"
              initial={
                reducedMotion
                  ? { opacity: 1, clipPath: 'inset(0% 0% 0% 0%)' }
                  : { opacity: 0, clipPath: 'inset(45% 45% 45% 45%)' }
              }
              animate={{ opacity: 1, clipPath: 'inset(0% 0% 0% 0%)' }}
              transition={{ duration: reducedMotion ? 0 : 0.22, ease: 'easeOut' }}
              style={{
                left: `${Math.min(72, Math.max(18, (hoveredNode.x / VIEWBOX_W) * 100))}%`,
                top: `${hoveredNode.y > 290 ? ((hoveredNode.y - 68) / VIEWBOX_H) * 100 : ((hoveredNode.y + 56) / VIEWBOX_H) * 100}%`,
              }}
              className="pointer-events-none absolute -translate-x-1/2 z-30 w-60 border border-[#F59E0B] bg-[#0C1017]/95 text-[#E6E9EF] px-2.5 py-2 font-mono text-[10px]"
            >
              <div className="flex items-center justify-between border-b border-[#1E2633] pb-1 mb-1">
                <span className="font-bold text-[#F59E0B]">{hoveredNode.meter.id}</span>
                <span
                  className={
                    hoveredNode.status === 'critical' ? 'text-[#FF4D2D] font-bold' : 'text-[#F59E0B]'
                  }
                >
                  {hoveredNode.status === 'critical'
                    ? '▲ FAULT'
                    : hoveredNode.status === 'warning'
                      ? '◆ WARN'
                      : '● NOMINAL'}
                </span>
              </div>
              <div className="text-[9.5px] text-[#7D899C] truncate mb-1">
                {hoveredNode.meter.location}
              </div>
              <div className="grid grid-cols-3 gap-1 tabular-nums text-[9.5px]">
                <span style={{ color: TOKENS.colors.phases.A.color }}>
                  ØA {hoveredNode.meter.latest_reading.current_a.toFixed(1)}A
                </span>
                <span style={{ color: TOKENS.colors.phases.B.color }}>
                  ØB {hoveredNode.meter.latest_reading.current_b.toFixed(1)}A
                </span>
                <span style={{ color: TOKENS.colors.phases.C.color }}>
                  ØC {hoveredNode.meter.latest_reading.current_c.toFixed(1)}A
                </span>
              </div>
            </motion.div>
          )}
        </div>
      </div>

      {/* Bottom Docked Node Telemetry Readout Bar */}
      {dockedNode && (
        <div
          aria-live="polite"
          className="hidden md:flex border-t border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF]/95 dark:bg-[#0C1017]/95 px-4 py-2 flex-wrap items-center justify-between gap-4 text-xs font-mono"
        >
          <div className="flex items-center gap-3">
            <span
              className={clsx(
                'px-1.5 py-0.5 text-[10px] font-bold uppercase border',
                dockedNode.status === 'critical'
                  ? 'border-[#FF4D2D] text-[#FF4D2D] bg-[#FF4D2D]/10'
                  : 'border-[#F59E0B] text-[#F59E0B] bg-[#F59E0B]/10',
              )}
            >
              {dockedNode.status === 'critical'
                ? '▲ FAULT'
                : dockedNode.status === 'warning'
                  ? '◆ WARN'
                  : '● NOMINAL'}
            </span>
            <span className="font-bold text-sm">{dockedNode.meter.id}</span>
            <span className="text-[#7D899C]">{dockedNode.meter.location}</span>
          </div>

          {dockedNode.meter.latest_reading && (
            <div className="flex flex-wrap items-center gap-4 tabular-nums">
              <span>
                <strong style={{ color: TOKENS.colors.phases.A.color }}>ØA:</strong>{' '}
                {dockedNode.meter.latest_reading.voltage_a.toFixed(1)}V /{' '}
                {dockedNode.meter.latest_reading.current_a.toFixed(1)}A
              </span>
              <span>
                <strong style={{ color: TOKENS.colors.phases.B.color }}>ØB:</strong>{' '}
                {dockedNode.meter.latest_reading.voltage_b.toFixed(1)}V /{' '}
                {dockedNode.meter.latest_reading.current_b.toFixed(1)}A
              </span>
              <span>
                <strong style={{ color: TOKENS.colors.phases.C.color }}>ØC:</strong>{' '}
                {dockedNode.meter.latest_reading.voltage_c.toFixed(1)}V /{' '}
                {dockedNode.meter.latest_reading.current_c.toFixed(1)}A
              </span>
              <span className="text-[#7D899C]">
                TS: {formatTimeShort(getReadingTimestamp(dockedNode.meter.latest_reading))}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Mobile / Narrow Viewport Collapsed Feeder List */}
      <div className="md:hidden divide-y divide-[#C8CDD6] dark:divide-[#1E2633]">
        {nodes.map(({ meter, status }) => {
          const loadKw = computeLoadKw(meter.latest_reading);
          const primaryAlert = meter.open_alerts[0];
          return (
            <button
              key={meter.id}
              type="button"
              onClick={() => navigate(`/meters/${encodeURIComponent(meter.id)}`)}
              className="w-full px-3.5 py-2.5 text-left flex items-center justify-between font-mono text-xs hover:bg-[#F59E0B]/10"
            >
              <div className="min-w-0 pr-2">
                <div className="font-bold">
                  {status === 'critical' ? '▲ ' : status === 'warning' ? '◆ ' : '● '}
                  {meter.id}
                </div>
                <div className="text-[11px] text-[#7D899C] truncate">{meter.location}</div>
              </div>
              <div className="text-right tabular-nums shrink-0">
                <div className="font-bold text-[#F59E0B]">{loadKw.toFixed(2)} kW</div>
                <div className={primaryAlert ? 'text-[#FF4D2D]' : 'text-[#7D899C]'}>
                  {primaryAlert ? formatFaultLabel(primaryAlert.type) : 'NOMINAL'}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
