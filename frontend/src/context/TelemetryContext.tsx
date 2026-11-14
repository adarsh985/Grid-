import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  acknowledgeAlert as apiAckAlert,
  assignAlert as apiAssignAlert,
  closeAlert as apiCloseAlert,
  getAlerts,
  getMeterReadings,
  getMeters,
  injectSimulatorFaultApi,
} from '../api';
import {
  buildInitialMockAlerts,
  buildInitialMockMeters,
  buildRollingReadingsForMeter,
  createSyntheticFaultExplanation,
} from '../mock/mockData';
import type { Alert, MeterSummary, Reading } from '../types';
import { computeEnergyLossTodayKwh } from '../analytics/aggregate';
import {
  OneShotAnimationQueue,
  type OneShotAnimationItem,
  MAX_CONCURRENT_ONESHOTS,
} from '../utils/animationQueue';
import { useAuth } from './AuthContext';
import { useSocket } from './SocketContext';

/** Rolling 15-minute window at 1 Hz = at most 900 samples per meter */
export const MAX_RING_BUFFER_SAMPLES = 900;
export const ROLLING_WINDOW_MS = 15 * 60 * 1000;
export const RIPPLE_DURATION_MS = 900;
export const ALERT_HIGHLIGHT_DURATION_MS = 1500;

/**
 * Appends a reading (or batch) to a meter's ring buffer, pruning samples
 * older than 15 minutes relative to the newest sample and capping capacity
 * strictly at MAX_RING_BUFFER_SAMPLES (900).
 */
export function appendToRingBuffer(
  existing: Reading[],
  incoming: Reading | Reading[],
  maxSamples = MAX_RING_BUFFER_SAMPLES,
): Reading[] {
  const additions = Array.isArray(incoming) ? incoming : [incoming];
  if (additions.length === 0) return existing.slice(-maxSamples);

  const combined = [...existing, ...additions];
  const lastSample = combined[combined.length - 1];
  const latestMs = Date.parse(lastSample?.ts ?? lastSample?.timestamp ?? '');

  const filtered = !Number.isNaN(latestMs)
    ? combined.filter((item) => {
        const t = Date.parse(item.ts ?? item.timestamp ?? '');
        return Number.isNaN(t) || t >= latestMs - ROLLING_WINDOW_MS;
      })
    : combined;

  if (filtered.length > maxSamples) {
    return filtered.slice(filtered.length - maxSamples);
  }
  return filtered;
}

/**
 * Resolves a meter ID across both MTR-0101..MTR-0120 and MTR-001..MTR-020 conventions.
 */
export function findMeterById(meters: MeterSummary[], rawId: string): MeterSummary | null {
  const trimmed = rawId.trim().toUpperCase();
  const exact = meters.find((m) => m.id.toUpperCase() === trimmed);
  if (exact) return exact;

  const m = /^MTR-0*(\d+)$/i.exec(trimmed);
  if (!m) return null;
  const num = Number(m[1]);
  const altId =
    num >= 1 && num <= 20
      ? `MTR-${String(100 + num).padStart(4, '0')}`
      : num >= 101 && num <= 120
        ? `MTR-${String(num - 100).padStart(3, '0')}`
        : null;
  if (!altId) return null;
  return meters.find((item) => item.id.toUpperCase() === altId) ?? null;
}

function getFeederIndexForMeterId(meters: MeterSummary[], meterId: string): number {
  const idx = meters.findIndex((m) => m.id === meterId);
  if (idx >= 0) return idx < 7 ? 0 : idx < 14 ? 1 : 2;
  const m = /(\d+)$/.exec(meterId);
  const num = m ? Number(m[1]) : 1;
  const normalized = num >= 101 ? num - 101 : num - 1;
  if (normalized < 7) return 0;
  if (normalized < 14) return 1;
  return 2;
}

interface TelemetryContextValue {
  meters: MeterSummary[];
  alerts: Alert[];
  readingsByMeter: Record<string, Reading[]>;
  getMeterHistory: (meterId: string) => Reading[];
  loadMeterHistory: (meterId: string) => Promise<void>;
  selectedAlertId: number | null;
  setSelectedAlertId: (id: number | null) => void;
  isMockMode: boolean;
  setIsMockMode: (v: boolean) => void;
  lastHeartbeat: number;
  energyLossTodayKwh: number;
  openAlertsCount: number;
  activeRipples: OneShotAnimationItem[];
  queuedRipplesCount: number;
  recentHighlightAlertIds: Record<number, number>;
  acknowledgeAlert: (id: number) => Promise<void>;
  assignAlert: (id: number, assignee: string) => Promise<void>;
  closeAlert: (id: number) => Promise<void>;
  reopenAlert: (id: number, previousStatus?: 'open' | 'acknowledged') => Promise<void>;
  triggerSimulatedFault: (
    meterId?: string,
    faultType?: 'power_theft' | 'phase_imbalance' | 'voltage_sag',
  ) => void;
}

const TelemetryContext = createContext<TelemetryContextValue | null>(null);

export const TelemetryProvider: React.FC<{
  children: React.ReactNode;
  initialAlerts?: Alert[];
}> = ({ children, initialAlerts }) => {
  const { token, user } = useAuth();
  const { connected, onReading, onAlert, onAlertUpdate } = useSocket();
  const actorName = user?.email || 'operator@gridsense.local';

  const [meters, setMeters] = useState<MeterSummary[]>(() => buildInitialMockMeters());
  const [alerts, setAlerts] = useState<Alert[]>(() => initialAlerts ?? buildInitialMockAlerts());
  const [readingsByMeter, setReadingsByMeter] = useState<Record<string, Reading[]>>(() => {
    const initialMeters = buildInitialMockMeters();
    const map: Record<string, Reading[]> = {};
    for (const m of initialMeters) {
      map[m.id] = buildRollingReadingsForMeter(m, 180);
    }
    return map;
  });
  const [selectedAlertId, setSelectedAlertId] = useState<number | null>(
    () => (initialAlerts ?? buildInitialMockAlerts())[0]?.id ?? 9041,
  );
  const [isMockMode, setIsMockMode] = useState<boolean>(true);
  const [lastHeartbeat, setLastHeartbeat] = useState<number>(() => Date.now());
  const [activeRipples, setActiveRipples] = useState<OneShotAnimationItem[]>([]);
  const [queuedRipplesCount, setQueuedRipplesCount] = useState<number>(0);
  const [recentHighlightAlertIds, setRecentHighlightAlertIds] = useState<Record<number, number>>(
    {},
  );

  const nextAlertId = useRef(9050);
  const nextEventId = useRef(1000);
  const rippleQueueRef = useRef<OneShotAnimationQueue>(
    new OneShotAnimationQueue(MAX_CONCURRENT_ONESHOTS),
  );
  const highlightQueueRef = useRef<OneShotAnimationQueue>(
    new OneShotAnimationQueue(MAX_CONCURRENT_ONESHOTS),
  );
  const timersRef = useRef<number[]>([]);
  const metersRef = useRef<MeterSummary[]>(meters);
  metersRef.current = meters;
  const alertsRef = useRef<Alert[]>(alerts);
  alertsRef.current = alerts;

  const syncHighlightState = useCallback(() => {
    const active = highlightQueueRef.current.getState().active;
    const nextMap: Record<number, number> = {};
    for (const item of active) {
      nextMap[item.alertId] = item.createdAt;
    }
    setRecentHighlightAlertIds(nextMap);
  }, []);

  const scheduleRippleCompletion = useCallback((item: OneShotAnimationItem) => {
    const timer = window.setTimeout(() => {
      const promoted = rippleQueueRef.current.complete(item.id);
      const state = rippleQueueRef.current.getState();
      setActiveRipples(state.active);
      setQueuedRipplesCount(state.queued.length);
      promoted.forEach((nextItem) => scheduleRippleCompletion(nextItem));
    }, item.durationMs);
    timersRef.current.push(timer);
  }, []);

  const scheduleHighlightCompletion = useCallback(
    (item: OneShotAnimationItem) => {
      const timer = window.setTimeout(() => {
        const promoted = highlightQueueRef.current.complete(item.id);
        syncHighlightState();
        promoted.forEach((nextItem) => scheduleHighlightCompletion(nextItem));
      }, item.durationMs);
      timersRef.current.push(timer);
    },
    [syncHighlightState],
  );

  const triggerAlertAnimations = useCallback(
    (alert: Alert) => {
      if (alert.status === 'acknowledged' || alert.status === 'closed') return;

      const feederIdx = getFeederIndexForMeterId(metersRef.current, alert.meter_id);
      const now = Date.now();

      // One-shot row highlight for newly arriving open alerts (capped at 3 concurrent)
      const hlItem: OneShotAnimationItem = {
        id: `hl-${alert.id}-${now}`,
        alertId: alert.id,
        meterId: alert.meter_id,
        feederIdx,
        severity: alert.severity,
        createdAt: now,
        durationMs: ALERT_HIGHLIGHT_DURATION_MS,
      };
      const hlRes = highlightQueueRef.current.enqueue(hlItem, alert.status);
      if (hlRes.accepted) {
        syncHighlightState();
        if (hlRes.activeNow) {
          scheduleHighlightCompletion(hlItem);
        }
      }

      // Grid fault ripple applies to critical & high severity open alerts (capped at 3 concurrent)
      if (alert.severity !== 'critical' && alert.severity !== 'high') return;
      const item: OneShotAnimationItem = {
        id: `ripple-${alert.id}-${now}`,
        alertId: alert.id,
        meterId: alert.meter_id,
        feederIdx,
        severity: alert.severity,
        createdAt: now,
        durationMs: RIPPLE_DURATION_MS,
      };

      const { accepted, activeNow } = rippleQueueRef.current.enqueue(item, alert.status);
      if (!accepted) return;

      const state = rippleQueueRef.current.getState();
      setActiveRipples(state.active);
      setQueuedRipplesCount(state.queued.length);

      if (activeNow) {
        scheduleRippleCompletion(item);
      }
    },
    [scheduleHighlightCompletion, scheduleRippleCompletion, syncHighlightState],
  );

  // Trigger initial open alerts once on mount and clean up all timers on unmount
  useEffect(() => {
    alerts.forEach((a) => {
      if (a.status === 'open') {
        triggerAlertAnimations(a);
      }
    });
    return () => {
      timersRef.current.forEach((id) => window.clearTimeout(id));
      timersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hydrate exclusively from live backend when authenticated; stay/fall back to explicit MOCK mode if unreachable
  useEffect(() => {
    if (!token) {
      setIsMockMode(true);
      return;
    }
    let active = true;
    Promise.all([getMeters(), getAlerts({ limit: 500 })])
      .then(([mRes, aRes]) => {
        if (!active) return;
        setMeters(mRes.meters);
        setAlerts(aRes.alerts);
        setReadingsByMeter(() => {
          const next: Record<string, Reading[]> = {};
          for (const m of mRes.meters) {
            next[m.id] = m.latest_reading ? [{ ...m.latest_reading, ts: m.latest_reading.ts ?? m.latest_reading.timestamp }] : [];
          }
          return next;
        });
        if (aRes.alerts[0]) setSelectedAlertId(aRes.alerts[0].id);
        aRes.alerts.forEach((a) => triggerAlertAnimations(a));
        setLastHeartbeat(Date.now());
        setIsMockMode(false);
      })
      .catch(() => {
        if (!active) return;
        // Backend unreachable -> stay in explicit MOCK fallback stream
        setIsMockMode(true);
      });
    return () => {
      active = false;
    };
  }, [token, triggerAlertAnimations]);

  // If Socket.IO disconnects cleanly while in live mode without any active connection, surface MOCK fallback indicator
  useEffect(() => {
    if (token && connected) {
      setIsMockMode(false);
    }
  }, [token, connected]);

  // Subscribe to live Socket.IO events when available
  useEffect(() => {
    const unsubR = onReading((reading: Reading) => {
      setLastHeartbeat(Date.now());
      const ts = reading.ts ?? reading.timestamp ?? new Date().toISOString();
      const normalized: Reading = { ...reading, ts };
      setMeters((prev) =>
        prev.map((m) =>
          m.id === reading.meter_id
            ? { ...m, last_seen: ts, latest_reading: normalized }
            : m,
        ),
      );
      setReadingsByMeter((prev) => ({
        ...prev,
        [reading.meter_id]: appendToRingBuffer(prev[reading.meter_id] ?? [], normalized),
      }));
    });
    const unsubA = onAlert((alert: Alert) => {
      setLastHeartbeat(Date.now());
      setAlerts((prev) => [alert, ...prev.filter((a) => a.id !== alert.id)]);
      setMeters((prev) =>
        prev.map((m) =>
          m.id === alert.meter_id
            ? {
                ...m,
                open_alerts: [
                  { severity: alert.severity, type: alert.type },
                  ...m.open_alerts.filter((x) => x.type !== alert.type),
                ],
              }
            : m,
        ),
      );
      triggerAlertAnimations(alert);
    });
    const unsubU = onAlertUpdate((updated: Alert) => {
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === updated.id
            ? { ...updated, events: updated.events ?? a.events }
            : a,
        ),
      );
      if (updated.status !== 'open') {
        setMeters((prev) =>
          prev.map((m) =>
            m.id === updated.meter_id
              ? { ...m, open_alerts: m.open_alerts.filter((x) => x.type !== updated.type) }
              : m,
          ),
        );
      }
    });
    return () => {
      unsubR();
      unsubA();
      unsubU();
    };
  }, [onReading, onAlert, onAlertUpdate, triggerAlertAnimations]);

  // 1 Hz Mock Telemetry Generator (active whenever in Mock Mode or when Socket.IO is disconnected)
  useEffect(() => {
    if (!isMockMode && connected) return;

    const timer = window.setInterval(() => {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      setLastHeartbeat(nowMs);

      const newReadingsBatch: Record<string, Reading> = {};

      setMeters((prev) =>
        prev.map((m, idx) => {
          const r = m.latest_reading;
          if (!r) return m;

          const hasTheft = m.open_alerts.some((a) => a.type === 'power_theft');
          const hasImbalance =
            m.id === 'MTR-0109' || m.open_alerts.some((a) => a.type === 'phase_imbalance');
          const hasSag = m.open_alerts.some((a) => a.type === 'voltage_sag');

          const jitter = () => (Math.random() - 0.5) * 0.7;
          const baseI = 11.5 + (idx % 7) * 2.4;

          const va = hasSag ? 196.2 + jitter() : 230.1 + jitter();
          const vb = hasSag ? 197.8 + jitter() : hasImbalance ? 219.4 + jitter() : 229.9 + jitter();
          const vc = hasSag ? 196.9 + jitter() : 230.3 + jitter();

          const ia = hasTheft
            ? baseI * 0.51 + jitter() * 0.2
            : baseI + Math.sin(nowMs / 6000 + idx) * 0.6;
          const ib = hasTheft
            ? baseI * 0.5 + jitter() * 0.2
            : hasImbalance
              ? baseI * 1.35 + jitter() * 0.3
              : baseI * 0.99 + Math.cos(nowMs / 6000 + idx) * 0.6;
          const ic = hasTheft
            ? baseI * 0.52 + jitter() * 0.2
            : baseI * 1.01 + Math.sin(nowMs / 5000 - idx) * 0.6;

          const pf = +(0.952 + (Math.random() - 0.5) * 0.008).toFixed(3);
          const freq = +(50.0 + (Math.random() - 0.5) * 0.03).toFixed(3);
          const kw = ((va * ia + vb * ib + vc * ic) * pf) / 1000;

          const nextReading: Reading = {
            ...r,
            ts: nowIso,
            voltage_a: +va.toFixed(2),
            voltage_b: +vb.toFixed(2),
            voltage_c: +vc.toFixed(2),
            current_a: +Math.max(0.5, ia).toFixed(2),
            current_b: +Math.max(0.5, ib).toFixed(2),
            current_c: +Math.max(0.5, ic).toFixed(2),
            power_factor: pf,
            frequency: freq,
            active_energy_kwh: +(r.active_energy_kwh + kw / 3600).toFixed(3),
            fault_label: hasTheft
              ? 'power_theft'
              : hasImbalance
                ? 'phase_imbalance'
                : hasSag
                  ? 'voltage_sag'
                  : 'normal',
          };

          newReadingsBatch[m.id] = nextReading;

          return {
            ...m,
            last_seen: nowIso,
            latest_reading: nextReading,
          };
        }),
      );

      setReadingsByMeter((prev) => {
        const next: Record<string, Reading[]> = { ...prev };
        for (const [mId, sample] of Object.entries(newReadingsBatch)) {
          next[mId] = appendToRingBuffer(prev[mId] ?? [], sample);
        }
        return next;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isMockMode, connected]);

  const getMeterHistory = useCallback(
    (meterId: string): Reading[] => {
      if (readingsByMeter[meterId]) return readingsByMeter[meterId];
      const resolved = findMeterById(meters, meterId);
      if (resolved && readingsByMeter[resolved.id]) {
        return readingsByMeter[resolved.id];
      }
      return [];
    },
    [readingsByMeter, meters],
  );

  const loadMeterHistory = useCallback(
    async (meterId: string) => {
      if (isMockMode || !token || !meterId) return;
      const resolved = findMeterById(metersRef.current, meterId)?.id ?? meterId;
      try {
        const res = await getMeterReadings(resolved, { limit: 900 });
        if (res.readings.length > 0) {
          setReadingsByMeter((prev) => ({
            ...prev,
            [resolved]: appendToRingBuffer([], res.readings),
          }));
        }
      } catch {
        // Ignore transient history fetch error cleanly
      }
    },
    [isMockMode, token],
  );

  const triggerSimulatedFault = useCallback(
    (
      meterId?: string,
      faultType: 'power_theft' | 'phase_imbalance' | 'voltage_sag' = 'power_theft',
    ) => {
      const currentMeters = metersRef.current;
      const resolvedMeter = meterId ? findMeterById(currentMeters, meterId) : null;
      const targetId = resolvedMeter?.id || currentMeters[3]?.id || 'MTR-004';
      const targetMeter = currentMeters.find((m) => m.id === targetId);

      // In live mode with JWT, route through real Backend -> ML Service -> Postgres -> Socket.IO pipeline
      if (!isMockMode && token) {
        void injectSimulatorFaultApi(targetId, faultType)
          .then(async () => {
            const refreshed = await getAlerts({ limit: 500 });
            setAlerts(refreshed.alerts);
          })
          .catch(() => {
            setIsMockMode(true);
          });
        return;
      }

      if (!targetMeter || !targetMeter.latest_reading) return;

      const nowIso = new Date().toISOString();
      const id = nextAlertId.current++;
      const r: Reading = { ...targetMeter.latest_reading, ts: nowIso, fault_label: faultType };
      if (faultType === 'power_theft') {
        r.current_a = +(r.current_a * 0.48).toFixed(2);
        r.current_b = +(r.current_b * 0.49).toFixed(2);
        r.current_c = +(r.current_c * 0.47).toFixed(2);
      } else if (faultType === 'phase_imbalance') {
        r.current_b = +(r.current_a * 1.38).toFixed(2);
        r.voltage_b = 218.4;
      } else {
        r.voltage_a = 194.2;
        r.voltage_b = 195.8;
        r.voltage_c = 195.1;
      }

      const newAlert: Alert = {
        id,
        meter_id: targetId,
        type: faultType,
        severity: faultType === 'phase_imbalance' ? 'high' : 'critical',
        score: faultType === 'power_theft' ? 0.94 : 0.89,
        status: 'open',
        assigned_to: null,
        detected_at: nowIso,
        last_detected_at: nowIso,
        loss_kw: faultType === 'power_theft' ? 5.85 : 0,
        energy_loss_kwh: faultType === 'power_theft' ? 4.25 : 0,
        ...(faultType === 'power_theft'
          ? { expected_kwh: 11.45, measured_kwh: 7.2 }
          : {}),
        explanation: createSyntheticFaultExplanation(targetId, faultType, r),
        events: [
          {
            id: Date.now(),
            alert_id: id,
            actor: 'ensemble-v1.0.0',
            action: 'created',
            details: 'Injected fault trigger',
            created_at: nowIso,
          },
        ],
      };

      setMeters((prev) =>
        prev.map((m) =>
          m.id === targetId
            ? {
                ...m,
                last_seen: nowIso,
                latest_reading: r,
                open_alerts: [
                  { severity: newAlert.severity, type: faultType },
                  ...m.open_alerts.filter((x) => x.type !== faultType),
                ],
              }
            : m,
        ),
      );
      setAlerts((aPrev) => [newAlert, ...aPrev]);
      setSelectedAlertId(id);
      setReadingsByMeter((rPrev) => ({
        ...rPrev,
        [targetId]: appendToRingBuffer(rPrev[targetId] ?? [], r),
      }));
      triggerAlertAnimations(newAlert);
    },
    [triggerAlertAnimations],
  );

  const syncMeterOpenAlertsFromList = useCallback((nextAlerts: Alert[], targetMeterId: string) => {
    if (!targetMeterId) return;
    const remainingOpen = nextAlerts
      .filter((a) => a.meter_id === targetMeterId && a.status === 'open')
      .map((a) => ({ severity: a.severity, type: a.type }));

    setMeters((prev) =>
      prev.map((m) => (m.id === targetMeterId ? { ...m, open_alerts: remainingOpen } : m)),
    );
  }, []);

  const createAuditEvent = useCallback(
    (alertId: number, action: string, details: string) => ({
      id: nextEventId.current++,
      alert_id: alertId,
      actor: actorName,
      action,
      details,
      created_at: new Date().toISOString(),
    }),
    [actorName],
  );

  const acknowledgeAlert = useCallback(
    async (id: number) => {
      const target = alertsRef.current.find((a) => a.id === id);
      if (!target || target.status !== 'open') return;

      const auditEntry = createAuditEvent(id, 'acknowledged', 'Alert acknowledged by operator');
      const nextAlerts = alertsRef.current.map((a) =>
        a.id === id
          ? {
              ...a,
              status: 'acknowledged' as const,
              events: [auditEntry, ...(a.events ?? [])],
            }
          : a,
      );
      setAlerts(nextAlerts);
      syncMeterOpenAlertsFromList(nextAlerts, target.meter_id);

      setRecentHighlightAlertIds((prev) => {
        if (!(id in prev)) return prev;
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      if (!isMockMode) {
        try {
          const updated = await apiAckAlert(id);
          setAlerts((prev) =>
            prev.map((a) => (a.id === id ? { ...updated, events: updated.events ?? a.events } : a)),
          );
        } catch {
          // keep optimistic state if backend unreachable
        }
      }
    },
    [createAuditEvent, isMockMode, syncMeterOpenAlertsFromList],
  );

  const assignAlert = useCallback(
    async (id: number, assignee: string) => {
      const cleanAssignee = assignee.trim();
      if (!cleanAssignee) return;
      const auditEntry = createAuditEvent(id, 'assigned', `Assigned to ${cleanAssignee}`);
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === id
            ? {
                ...a,
                assigned_to: cleanAssignee,
                events: [auditEntry, ...(a.events ?? [])],
              }
            : a,
        ),
      );
      if (!isMockMode) {
        try {
          const updated = await apiAssignAlert(id, cleanAssignee);
          setAlerts((prev) =>
            prev.map((a) => (a.id === id ? { ...updated, events: updated.events ?? a.events } : a)),
          );
        } catch {
          // keep optimistic state
        }
      }
    },
    [createAuditEvent, isMockMode],
  );

  const closeAlert = useCallback(
    async (id: number) => {
      const target = alertsRef.current.find((a) => a.id === id);
      if (!target || target.status === 'closed') return;

      const auditEntry = createAuditEvent(id, 'closed', 'Alert closed by operator');
      const nextAlerts = alertsRef.current.map((a) =>
        a.id === id
          ? {
              ...a,
              status: 'closed' as const,
              events: [auditEntry, ...(a.events ?? [])],
            }
          : a,
      );
      setAlerts(nextAlerts);
      syncMeterOpenAlertsFromList(nextAlerts, target.meter_id);

      setRecentHighlightAlertIds((prev) => {
        if (!(id in prev)) return prev;
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      if (!isMockMode) {
        try {
          const updated = await apiCloseAlert(id);
          setAlerts((prev) =>
            prev.map((a) => (a.id === id ? { ...updated, events: updated.events ?? a.events } : a)),
          );
        } catch {
          // keep optimistic state
        }
      }
    },
    [createAuditEvent, isMockMode, syncMeterOpenAlertsFromList],
  );

  const openAlertsCount = useMemo(
    () => alerts.filter((a) => a.status === 'open').length,
    [alerts],
  );

  const reopenAlert = useCallback(
    async (id: number, previousStatus: 'open' | 'acknowledged' = 'open') => {
      const target = alertsRef.current.find((a) => a.id === id);
      if (!target) return;
      const targetStatus: 'open' | 'acknowledged' =
        previousStatus === 'acknowledged' ? 'acknowledged' : 'open';
      const auditEntry = createAuditEvent(
        id,
        'reopened',
        `Undo close — restored to ${targetStatus}`,
      );
      const nextAlerts = alertsRef.current.map((a) =>
        a.id === id
          ? {
              ...a,
              status: targetStatus,
              events: [auditEntry, ...(a.events ?? [])],
            }
          : a,
      );
      setAlerts(nextAlerts);
      syncMeterOpenAlertsFromList(nextAlerts, target.meter_id);
    },
    [createAuditEvent, syncMeterOpenAlertsFromList],
  );

  const energyLossTodayKwh = useMemo(
    () => computeEnergyLossTodayKwh(alerts),
    [alerts],
  );

  const value = useMemo<TelemetryContextValue>(
    () => ({
      meters,
      alerts,
      readingsByMeter,
      getMeterHistory,
      loadMeterHistory,
      selectedAlertId,
      setSelectedAlertId,
      isMockMode,
      setIsMockMode,
      lastHeartbeat,
      energyLossTodayKwh,
      openAlertsCount,
      activeRipples,
      queuedRipplesCount,
      recentHighlightAlertIds,
      acknowledgeAlert,
      assignAlert,
      closeAlert,
      reopenAlert,
      triggerSimulatedFault,
    }),
    [
      meters,
      alerts,
      readingsByMeter,
      getMeterHistory,
      loadMeterHistory,
      selectedAlertId,
      isMockMode,
      lastHeartbeat,
      energyLossTodayKwh,
      openAlertsCount,
      activeRipples,
      queuedRipplesCount,
      recentHighlightAlertIds,
      acknowledgeAlert,
      assignAlert,
      closeAlert,
      reopenAlert,
      triggerSimulatedFault,
    ],
  );

  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>;
};

export function useTelemetry(): TelemetryContextValue {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error('useTelemetry must be used inside TelemetryProvider');
  return ctx;
}
