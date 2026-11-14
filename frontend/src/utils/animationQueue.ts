import { useEffect, useState } from 'react';
import { TOKENS, type PhaseKey } from '../design/tokens';
import { SUBSTATION_FEEDERS } from '../mock/mockData';
import type { MeterSummary } from '../types';
import { computeLoadKw } from './format';

export const MAX_PARTICLES = 120;
export const MAX_CONCURRENT_ONESHOTS = 3;

export interface FeederFlowParticle {
  id: string;
  track: 'busbar' | 'feeder';
  feederIdx: number;
  offsetRatio: number; // 0..1 along track
  speedPxPerSec: number;
  color: string;
  radius: number;
}

export interface FeederSummaryStats {
  feederIdx: number;
  totalKw: number;
  speedPxPerSec: number;
  dominantPhase: PhaseKey;
  color: string;
}

/**
 * Reactive hook reading `(prefers-reduced-motion: reduce)` safely in SSR, browser, and jsdom.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);

  return reduced;
}

/**
 * Computes feeder load, flow speed, and dominant phase color across the 3 feeders.
 */
export function computeFeederFlowStats(meters: MeterSummary[]): FeederSummaryStats[] {
  const acc = SUBSTATION_FEEDERS.map((_, feederIdx) => ({
    feederIdx,
    totalKw: 0,
    ia: 0,
    ib: 0,
    ic: 0,
  }));

  meters.forEach((m, idx) => {
    const fIdx = idx < 7 ? 0 : idx < 14 ? 1 : 2;
    const r = m.latest_reading;
    if (!r) return;
    acc[fIdx].totalKw += computeLoadKw(r);
    acc[fIdx].ia += r.current_a;
    acc[fIdx].ib += r.current_b;
    acc[fIdx].ic += r.current_c;
  });

  return acc.map((item) => {
    let dominantPhase: PhaseKey = 'A';
    if (item.ib >= item.ia && item.ib >= item.ic) dominantPhase = 'B';
    else if (item.ic >= item.ia && item.ic >= item.ib) dominantPhase = 'C';

    // Scale linearly from 36 px/s (idle) up to 165 px/s (heavy feeder load >= 140 kW)
    const normalized = Math.min(1, Math.max(0, item.totalKw / 140));
    const speedPxPerSec = Math.round(36 + normalized * 129);

    return {
      feederIdx: item.feederIdx,
      totalKw: item.totalKw,
      speedPxPerSec,
      dominantPhase,
      color: TOKENS.colors.phases[dominantPhase].color,
    };
  });
}

/**
 * Generates power-flow particles along the 11kV vertical busbar and 3 horizontal feeders.
 * Returns [] under prefers-reduced-motion and strictly enforces `<= maxParticles` (default 120).
 */
export function computeFeederParticles(
  meters: MeterSummary[],
  reducedMotion: boolean,
  maxParticles: number = MAX_PARTICLES,
): FeederFlowParticle[] {
  if (reducedMotion || maxParticles <= 0) return [];

  const cap = Math.min(maxParticles, MAX_PARTICLES);
  const stats = computeFeederFlowStats(meters);
  const totalBusKw = stats.reduce((s, f) => s + f.totalKw, 0);
  const busAvgSpeed =
    stats.length > 0
      ? Math.round(stats.reduce((s, f) => s + f.speedPxPerSec, 0) / stats.length)
      : 60;

  const particles: FeederFlowParticle[] = [];

  // 1. 11kV Busbar trunk particles (proportional up to 18 particles)
  const busCount = Math.min(18, Math.max(6, Math.round(totalBusKw / 22)));
  for (let i = 0; i < busCount && particles.length < cap; i += 1) {
    particles.push({
      id: `bus-${i}`,
      track: 'busbar',
      feederIdx: -1,
      offsetRatio: i / busCount,
      speedPxPerSec: busAvgSpeed,
      color: TOKENS.colors.signal,
      radius: 2.2,
    });
  }

  // 2. Feeder horizontal particles (density & speed scale with feeder total load)
  const perFeederBudget = Math.floor((cap - particles.length) / Math.max(1, stats.length));
  stats.forEach((f) => {
    const desired = Math.max(8, Math.round(8 + (f.totalKw / 120) * 24));
    const count = Math.min(perFeederBudget, desired);
    for (let i = 0; i < count && particles.length < cap; i += 1) {
      particles.push({
        id: `f-${f.feederIdx}-${i}`,
        track: 'feeder',
        feederIdx: f.feederIdx,
        offsetRatio: i / count,
        speedPxPerSec: f.speedPxPerSec,
        color: f.color,
        radius: 2.1,
      });
    }
  });

  return particles.slice(0, cap);
}

export interface OneShotAnimationItem {
  id: string;
  alertId: number;
  meterId: string;
  feederIdx: number;
  severity: string;
  createdAt: number;
  durationMs: number;
}

/**
 * Concurrency-bounded queue ensuring at most MAX_CONCURRENT_ONESHOTS (3) fault ripples
 * / feeder flickers run simultaneously, ignoring acknowledged/closed or duplicate alerts.
 */
export class OneShotAnimationQueue {
  private readonly maxConcurrent: number;
  private active: OneShotAnimationItem[] = [];
  private queued: OneShotAnimationItem[] = [];
  private seenAlertIds = new Set<number>();

  constructor(maxConcurrent: number = MAX_CONCURRENT_ONESHOTS) {
    this.maxConcurrent = maxConcurrent;
  }

  enqueue(
    item: OneShotAnimationItem,
    alertStatus: string = 'open',
  ): { accepted: boolean; activeNow: boolean } {
    if (alertStatus === 'acknowledged' || alertStatus === 'closed') {
      return { accepted: false, activeNow: false };
    }
    if (this.seenAlertIds.has(item.alertId)) {
      return { accepted: false, activeNow: false };
    }

    this.seenAlertIds.add(item.alertId);
    if (this.active.length < this.maxConcurrent) {
      this.active.push(item);
      return { accepted: true, activeNow: true };
    }

    this.queued.push(item);
    return { accepted: true, activeNow: false };
  }

  complete(id: string): OneShotAnimationItem[] {
    const before = this.active.length;
    this.active = this.active.filter((x) => x.id !== id);
    const promoted: OneShotAnimationItem[] = [];

    if (this.active.length !== before) {
      while (this.active.length < this.maxConcurrent && this.queued.length > 0) {
        const next = this.queued.shift();
        if (next) {
          this.active.push(next);
          promoted.push(next);
        }
      }
    }

    return promoted;
  }

  hasSeen(alertId: number): boolean {
    return this.seenAlertIds.has(alertId);
  }

  getState(): { active: OneShotAnimationItem[]; queued: OneShotAnimationItem[] } {
    return {
      active: [...this.active],
      queued: [...this.queued],
    };
  }
}
