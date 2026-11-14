import type { Alert, ExplanationItem } from '../types';

export const GRIDSENSE_ANALYTICS_SEED = 20261114;

export type AnalyticsRangeKey = '7d' | '14d' | '30d';
export type FeederFilterKey = 'all' | '01' | '02' | '03';
export type FeederShortId = '01' | '02' | '03';

export const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export const DAY_SHORT_NAMES = [
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
] as const;

export interface FeederSpec {
  shortId: FeederShortId;
  id: 'FDR-01' | 'FDR-02' | 'FDR-03';
  name: string;
  label: string;
  meterCount: number;
  meters: readonly string[];
}

export const ANALYTICS_FEEDERS: readonly FeederSpec[] = [
  {
    shortId: '01',
    id: 'FDR-01',
    name: 'FDR-01 · Sector Alpha',
    label: 'Feeder 01',
    meterCount: 4,
    meters: ['MTR-0101', 'MTR-0102', 'MTR-0103', 'MTR-0104'],
  },
  {
    shortId: '02',
    id: 'FDR-02',
    name: 'FDR-02 · Sector Beta',
    label: 'Feeder 02',
    meterCount: 4,
    meters: ['MTR-0105', 'MTR-0106', 'MTR-0107', 'MTR-0108'],
  },
  {
    shortId: '03',
    id: 'FDR-03',
    name: 'FDR-03 · Sector Gamma',
    label: 'Feeder 03',
    meterCount: 4,
    meters: ['MTR-0109', 'MTR-0110', 'MTR-0111', 'MTR-0112'],
  },
] as const;

export interface HeatmapCellData {
  dayIndex: number;
  hour: number;
  count: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  energyLossKwh: number;
}

export interface FaultTypeBreakdownItem {
  type: string;
  label: string;
  count: number;
  sharePct: number;
  severities: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

export interface EnergyLossPoint {
  dateKey: string;
  label: string;
  shortLabel: string;
  lossKwh: number;
  theftAlertsCount: number;
  totalAlertsCount: number;
  isToday: boolean;
}

export interface FeederComparisonItem {
  feederShortId: FeederShortId;
  feederId: 'FDR-01' | 'FDR-02' | 'FDR-03';
  feederName: string;
  meterCount: number;
  totalFaults: number;
  openFaults: number;
  criticalFaults: number;
  lossKwh: number;
  healthScore: number;
  faultsPerMeter: number;
  isWorst: boolean;
}

const FAULT_LABELS: Record<string, string> = {
  power_theft: 'Power Theft',
  phase_imbalance: 'Phase Imbalance',
  overcurrent: 'Overcurrent',
  voltage_sag: 'Voltage Sag',
  voltage_swell: 'Voltage Swell',
  harmonic_distortion: 'Harmonic Distortion',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

function formatFaultTypeLabel(type: string): string {
  if (FAULT_LABELS[type]) return FAULT_LABELS[type];
  return type
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function getFeederShortIdForMeter(meterId: string): FeederShortId {
  const normalized = (meterId || '').trim().toUpperCase();
  if (
    normalized === 'MTR-0101' ||
    normalized === 'MTR-0102' ||
    normalized === 'MTR-0103' ||
    normalized === 'MTR-0104' ||
    normalized === 'FDR-01' ||
    normalized === '01'
  ) {
    return '01';
  }
  if (
    normalized === 'MTR-0105' ||
    normalized === 'MTR-0106' ||
    normalized === 'MTR-0107' ||
    normalized === 'MTR-0108' ||
    normalized === 'FDR-02' ||
    normalized === '02'
  ) {
    return '02';
  }
  if (
    normalized === 'MTR-0109' ||
    normalized === 'MTR-0110' ||
    normalized === 'MTR-0111' ||
    normalized === 'MTR-0112' ||
    normalized === 'FDR-03' ||
    normalized === '03'
  ) {
    return '03';
  }

  const match = /(\d+)$/.exec(normalized);
  if (match) {
    const num = Number(match[1]);
    if (num >= 101 && num <= 112) {
      const idx = Math.floor((num - 101) / 4);
      if (idx === 0) return '01';
      if (idx === 1) return '02';
      return '03';
    }
    const mod = ((num % 3) + 3) % 3;
    if (mod === 0) return '01';
    if (mod === 1) return '02';
    return '03';
  }
  return '01';
}

export function parseRangeDays(range: AnalyticsRangeKey): number {
  if (range === '14d') return 14;
  if (range === '30d') return 30;
  return 7;
}

export const IST_TIMEZONE = 'Asia/Kolkata';
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toIstWallClockDate(ms: number): Date {
  return new Date(ms + IST_OFFSET_MS);
}

/**
 * Midnight (00:00:00.000) in Asia/Kolkata (IST, UTC+05:30) as UTC epoch ms.
 * Keeping timezone conversion in one pure helper ensures heatmap cells,
 * daily energy-loss buckets, KPIs, and drill-down labels stay aligned for Thāne operators.
 */
export function getIstDayStartMs(ms: number): number {
  const ist = toIstWallClockDate(ms);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS;
}

export function getIstDateKey(msOrIso: number | string): string | null {
  const ms = typeof msOrIso === 'number' ? msOrIso : Date.parse(msOrIso);
  if (!Number.isFinite(ms)) return null;
  const d = toIstWallClockDate(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function getAlertDayAndHour(
  timestampIso: string,
): { dayIndex: number; hour: number } | null {
  const ms = Date.parse(timestampIso);
  if (!Number.isFinite(ms)) return null;
  const d = toIstWallClockDate(ms);
  const dayIndex = (d.getUTCDay() + 6) % 7; // Monday = 0 ... Sunday = 6 (IST)
  const hour = d.getUTCHours(); // 0 ... 23 (IST)
  return { dayIndex, hour };
}

export function formatIstTimestamp(timestampIso: string): string {
  const ms = Date.parse(timestampIso);
  if (!Number.isFinite(ms)) return '—';
  const d = toIstWallClockDate(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = months[d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${dd} ${mon}, ${hh}:${mm}:${ss} IST`;
}

export const getUtcDayStartMs = getIstDayStartMs;
export const getUtcDateKey = getIstDateKey;

/**
 * Estimate unbilled / lost energy (in kWh) attributable to a fault or theft alert.
 *
 * Formula:
 * 1. Primary (interval metering delta):
 *    max(0, expected_kwh - measured_kwh) when both interval totals are present.
 * 2. Fallback A (baseline power delta x duration):
 *    max(0, baseline_kw - measured_kw) * max(0, duration_hours) when baseline_kw,
 *    measured_kw, and duration_hours are present.
 * 3. Fallback B (stored streaming / interval loss):
 *    alert.energy_loss_kwh when > 0, otherwise max(0, alert.loss_kw * durationHours)
 *    with durationHours = max(0.25, (last_detected_at - detected_at) / 3_600_000).
 *
 * Estimate only -- derived from feeder telemetry models, not calibrated billing data.
 */
export function estimateEnergyLossKwh(alert: Alert): number {
  if (!alert) return 0;

  if (
    typeof alert.expected_kwh === 'number' &&
    Number.isFinite(alert.expected_kwh) &&
    typeof alert.measured_kwh === 'number' &&
    Number.isFinite(alert.measured_kwh)
  ) {
    return round2(Math.max(0, alert.expected_kwh - alert.measured_kwh));
  }

  if (
    typeof alert.baseline_kw === 'number' &&
    Number.isFinite(alert.baseline_kw) &&
    typeof alert.measured_kw === 'number' &&
    Number.isFinite(alert.measured_kw) &&
    typeof alert.duration_hours === 'number' &&
    Number.isFinite(alert.duration_hours)
  ) {
    return round2(
      Math.max(0, alert.baseline_kw - alert.measured_kw) * Math.max(0, alert.duration_hours),
    );
  }

  if (typeof alert.energy_loss_kwh === 'number' && Number.isFinite(alert.energy_loss_kwh) && alert.energy_loss_kwh > 0) {
    return round2(alert.energy_loss_kwh);
  }

  if (typeof alert.loss_kw === 'number' && Number.isFinite(alert.loss_kw) && alert.loss_kw > 0) {
    const startMs = Date.parse(alert.detected_at);
    const endMs = Date.parse(alert.last_detected_at);
    const spanHours =
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.max(0.25, (endMs - startMs) / 3_600_000)
        : typeof alert.duration_hours === 'number' && Number.isFinite(alert.duration_hours)
          ? Math.max(0, alert.duration_hours)
          : 1;
    return round2(Math.max(0, alert.loss_kw * spanHours));
  }

  return 0;
}

function alertTheftLossKwh(alert: Alert): number {
  return alert.type === 'power_theft' ? estimateEnergyLossKwh(alert) : 0;
}

/**
 * Shared Control Room + Analytics KPI calculation for LOSS TODAY (kWh).
 * Ensures Control Room KPI strip and Analytics today's loss bucket always match identically.
 */
export function computeEnergyLossTodayKwh(
  alerts: Alert[],
  referenceNowMs: number = Date.now(),
): number {
  const todayKey = getUtcDateKey(referenceNowMs);
  if (!todayKey || !alerts.length) return 0;

  let total = 0;
  for (const alert of alerts) {
    const dateKey = getUtcDateKey(alert.detected_at);
    if (dateKey !== todayKey) continue;
    total += alertTheftLossKwh(alert);
  }
  return round2(total);
}

export function filterAlertsByRangeAndFeeder(
  alerts: Alert[],
  range: AnalyticsRangeKey = '7d',
  feeder: FeederFilterKey = 'all',
  referenceNowMs: number = Date.now(),
): Alert[] {
  if (!alerts.length) return [];
  const days = parseRangeDays(range);
  const todayStart = getUtcDayStartMs(referenceNowMs);
  const windowStart = todayStart - (days - 1) * DAY_MS;

  return alerts.filter((alert) => {
    const ms = Date.parse(alert.detected_at);
    if (!Number.isFinite(ms) || ms < windowStart) return false;
    if (feeder !== 'all' && getFeederShortIdForMeter(alert.meter_id) !== feeder) {
      return false;
    }
    return true;
  });
}

export function faultHeatmap(alerts: Alert[]): HeatmapCellData[][] {
  const matrix: HeatmapCellData[][] = Array.from({ length: 7 }, (_, dayIndex) =>
    Array.from({ length: 24 }, (_, hour) => ({
      dayIndex,
      hour,
      count: 0,
      criticalCount: 0,
      highCount: 0,
      mediumCount: 0,
      lowCount: 0,
      energyLossKwh: 0,
    })),
  );

  for (const alert of alerts) {
    const coords = getAlertDayAndHour(alert.detected_at);
    if (!coords) continue;
    const cell = matrix[coords.dayIndex][coords.hour];
    cell.count += 1;
    if (alert.severity === 'critical') cell.criticalCount += 1;
    else if (alert.severity === 'high') cell.highCount += 1;
    else if (alert.severity === 'medium') cell.mediumCount += 1;
    else cell.lowCount += 1;
    cell.energyLossKwh = round2(cell.energyLossKwh + alertTheftLossKwh(alert));
  }

  return matrix;
}

export function faultsByType(alerts: Alert[]): FaultTypeBreakdownItem[] {
  if (!alerts.length) return [];

  const map = new Map<
    string,
    {
      count: number;
      critical: number;
      high: number;
      medium: number;
      low: number;
    }
  >();

  for (const alert of alerts) {
    const type = alert.type || 'unknown';
    const current = map.get(type) ?? {
      count: 0,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    current.count += 1;
    if (alert.severity === 'critical') current.critical += 1;
    else if (alert.severity === 'high') current.high += 1;
    else if (alert.severity === 'medium') current.medium += 1;
    else current.low += 1;
    map.set(type, current);
  }

  const total = alerts.length;
  return Array.from(map.entries())
    .sort((a, b) => {
      if (b[1].count !== a[1].count) return b[1].count - a[1].count;
      return a[0].localeCompare(b[0]);
    })
    .map(([type, stats]) => ({
      type,
      label: formatFaultTypeLabel(type),
      count: stats.count,
      sharePct: total > 0 ? round1((stats.count / total) * 100) : 0,
      severities: {
        critical: stats.critical,
        high: stats.high,
        medium: stats.medium,
        low: stats.low,
      },
    }));
}

export function energyLossSeries(
  alerts: Alert[],
  range: AnalyticsRangeKey = '7d',
  _bucket: 'day' = 'day',
  referenceNowMs: number = Date.now(),
): EnergyLossPoint[] {
  const days = parseRangeDays(range);
  const todayStart = getUtcDayStartMs(referenceNowMs);
  const todayKey = getUtcDateKey(todayStart)!;

  const bucketMap = new Map<
    string,
    { lossKwh: number; theftAlertsCount: number; totalAlertsCount: number }
  >();

  for (const alert of alerts) {
    const key = getUtcDateKey(alert.detected_at);
    if (!key) continue;
    const entry = bucketMap.get(key) ?? {
      lossKwh: 0,
      theftAlertsCount: 0,
      totalAlertsCount: 0,
    };
    const theftLoss = alertTheftLossKwh(alert);
    entry.lossKwh = round2(entry.lossKwh + theftLoss);
    if (alert.type === 'power_theft') entry.theftAlertsCount += 1;
    entry.totalAlertsCount += 1;
    bucketMap.set(key, entry);
  }

  const series: EnergyLossPoint[] = [];
  const monthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const dayStart = todayStart - offset * DAY_MS;
    const dateKey = getIstDateKey(dayStart)!;
    const d = toIstWallClockDate(dayStart);
    const label = `${monthNames[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
    const shortLabel = `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    const agg = bucketMap.get(dateKey);

    series.push({
      dateKey,
      label,
      shortLabel,
      lossKwh: agg ? agg.lossKwh : 0,
      theftAlertsCount: agg ? agg.theftAlertsCount : 0,
      totalAlertsCount: agg ? agg.totalAlertsCount : 0,
      isToday: dateKey === todayKey,
    });
  }

  return series;
}

export function feederComparison(alerts: Alert[]): FeederComparisonItem[] {
  const buckets = new Map<
    FeederShortId,
    {
      totalFaults: number;
      openFaults: number;
      criticalFaults: number;
      severityPoints: number;
      lossKwh: number;
    }
  >();

  for (const spec of ANALYTICS_FEEDERS) {
    buckets.set(spec.shortId, {
      totalFaults: 0,
      openFaults: 0,
      criticalFaults: 0,
      severityPoints: 0,
      lossKwh: 0,
    });
  }

  for (const alert of alerts) {
    const feederId = getFeederShortIdForMeter(alert.meter_id);
    const entry = buckets.get(feederId)!;
    entry.totalFaults += 1;
    if (alert.status !== 'closed') entry.openFaults += 1;
    if (alert.severity === 'critical') entry.criticalFaults += 1;

    const sevWeight =
      alert.severity === 'critical'
        ? 4.2
        : alert.severity === 'high'
          ? 2.4
          : alert.severity === 'medium'
            ? 1.2
            : 0.5;
    entry.severityPoints += sevWeight + (alert.status === 'open' ? 1.5 : 0);
    entry.lossKwh = round2(entry.lossKwh + alertTheftLossKwh(alert));
  }

  const rows: FeederComparisonItem[] = ANALYTICS_FEEDERS.map((spec) => {
    const stats = buckets.get(spec.shortId)!;
    const faultsPerMeter = stats.totalFaults / spec.meterCount;
    const lossPerMeter = stats.lossKwh / spec.meterCount;
    const criticalShare =
      stats.totalFaults > 0 ? (stats.criticalFaults / stats.totalFaults) * 18 : 0;
    const penalty =
      stats.openFaults * 4 +
      criticalShare +
      Math.min(32, faultsPerMeter * 2.2) +
      Math.min(35, lossPerMeter * 0.95);
    const healthScore =
      stats.totalFaults === 0 ? 100 : Math.max(5, Math.min(99, Math.round(100 - penalty)));
    return {
      feederShortId: spec.shortId,
      feederId: spec.id,
      feederName: spec.name,
      meterCount: spec.meterCount,
      totalFaults: stats.totalFaults,
      openFaults: stats.openFaults,
      criticalFaults: stats.criticalFaults,
      lossKwh: stats.lossKwh,
      healthScore,
      faultsPerMeter: round2(faultsPerMeter),
      isWorst: false,
    };
  });

  const hasAnyFault = rows.some((r) => r.totalFaults > 0 || r.lossKwh > 0);
  if (hasAnyFault) {
    let worstIdx = 0;
    for (let i = 1; i < rows.length; i += 1) {
      const a = rows[i];
      const b = rows[worstIdx];
      if (
        a.lossKwh > b.lossKwh ||
        (a.lossKwh === b.lossKwh && a.healthScore < b.healthScore) ||
        (a.lossKwh === b.lossKwh && a.healthScore === b.healthScore && a.totalFaults > b.totalFaults)
      ) {
        worstIdx = i;
      }
    }
    rows[worstIdx] = { ...rows[worstIdx], isWorst: true };
  }

  return rows;
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T>(rng: () => number, items: readonly { value: T; weight: number }[]): T {
  let totalWeight = 0;
  for (const item of items) totalWeight += item.weight;
  let roll = rng() * totalWeight;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item.value;
  }
  return items[items.length - 1].value;
}

/**
 * Deterministically synthesize closed historical alerts spread across daysAgo = 1..(days-1)
 * using Mulberry32 PRNG so analytics charts, heatmaps, and tests remain reproducible
 * with zero render-time Math.random() calls.
 */
export function generateDeterministicAlertHistory(
  referenceNowMs: number,
  options?: {
    seed?: number;
    days?: number;
    count?: number;
    startId?: number;
  },
): Alert[] {
  const seed = options?.seed ?? GRIDSENSE_ANALYTICS_SEED;
  const days = Math.max(2, options?.days ?? 30);
  const count = Math.max(0, options?.count ?? 96);
  const startId = options?.startId ?? 8801;

  if (count === 0) return [];

  const rng = createMulberry32(seed);
  const istTodayStart = getIstDayStartMs(referenceNowMs);

  const feederWeights: readonly { value: FeederShortId; weight: number }[] = [
    { value: '02', weight: 0.44 },
    { value: '01', weight: 0.32 },
    { value: '03', weight: 0.24 },
  ];

  const metersByFeeder: Record<FeederShortId, readonly string[]> = {
    '01': ['MTR-0101', 'MTR-0102', 'MTR-0103', 'MTR-0104'],
    '02': ['MTR-0105', 'MTR-0106', 'MTR-0107', 'MTR-0108'],
    '03': ['MTR-0109', 'MTR-0110', 'MTR-0111', 'MTR-0112'],
  };

  const faultWeights: readonly { value: string; weight: number }[] = [
    { value: 'power_theft', weight: 0.28 },
    { value: 'phase_imbalance', weight: 0.24 },
    { value: 'voltage_sag', weight: 0.18 },
    { value: 'overcurrent', weight: 0.14 },
    { value: 'harmonic_distortion', weight: 0.1 },
    { value: 'voltage_swell', weight: 0.06 },
  ];

  // Realistic evening substation peak + morning industrial ramp hours (IST Asia/Kolkata)
  const hourWeights: readonly { value: number; weight: number }[] = [
    { value: 18, weight: 0.14 },
    { value: 19, weight: 0.14 },
    { value: 20, weight: 0.11 },
    { value: 17, weight: 0.09 },
    { value: 21, weight: 0.08 },
    { value: 9, weight: 0.07 },
    { value: 10, weight: 0.06 },
    { value: 14, weight: 0.06 },
    { value: 15, weight: 0.06 },
    { value: 8, weight: 0.05 },
    { value: 11, weight: 0.04 },
    { value: 22, weight: 0.04 },
    { value: 13, weight: 0.03 },
    { value: 6, weight: 0.02 },
    { value: 2, weight: 0.01 },
  ];

  const result: Alert[] = [];

  for (let i = 0; i < count; i += 1) {
    // Spread strictly across daysAgo 1..(days - 1) so Day 0 (Today) remains strictly under live mock control
    const daysAgo = 1 + (i % (days - 1));
    const hour = pickWeighted(rng, hourWeights);
    const minute = Math.floor(rng() * 56) + 2;
    const dayStartMs = istTodayStart - daysAgo * DAY_MS;
    const detectedMs = dayStartMs + hour * 3_600_000 + minute * 60_000;
    const durationMin = Math.round(25 + rng() * 145);
    const lastDetectedMs = detectedMs + durationMin * 60_000;

    const feederId = pickWeighted(rng, feederWeights);
    const meterList = metersByFeeder[feederId];
    const meterId = meterList[Math.floor(rng() * meterList.length)];
    const type = pickWeighted(rng, faultWeights);

    const severityRoll = rng();
    const severity =
      type === 'power_theft'
        ? severityRoll < 0.58
          ? 'critical'
          : 'high'
        : type === 'voltage_swell'
          ? severityRoll < 0.4
            ? 'medium'
            : 'low'
          : severityRoll < 0.25
            ? 'critical'
            : severityRoll < 0.62
              ? 'high'
              : severityRoll < 0.88
                ? 'medium'
                : 'low';

    const score =
      severity === 'critical'
        ? round2(0.86 + rng() * 0.12)
        : severity === 'high'
          ? round2(0.71 + rng() * 0.14)
          : severity === 'medium'
            ? round2(0.55 + rng() * 0.14)
            : round2(0.41 + rng() * 0.12);

    let lossKw = 0;
    let energyLossKwh = 0;
    let expectedKwh: number | undefined;
    let measuredKwh: number | undefined;
    let baselineKw: number | undefined;
    let measuredKw: number | undefined;
    let durationHours: number | undefined;

    if (type === 'power_theft') {
      const feederScale = feederId === '02' ? 1.25 : feederId === '01' ? 1.0 : 0.72;
      const durHrs = round2(Math.max(0.75, durationMin / 60));
      const deltaKw = round2((2.8 + rng() * 3.8) * feederScale);
      lossKw = deltaKw;

      if (i % 2 === 0) {
        measuredKwh = round2(12 + rng() * 18);
        energyLossKwh = round2(deltaKw * durHrs);
        expectedKwh = round2(measuredKwh + energyLossKwh);
      } else {
        measuredKw = round2(4.2 + rng() * 5.0);
        baselineKw = round2(measuredKw + deltaKw);
        durationHours = durHrs;
        energyLossKwh = round2(deltaKw * durHrs);
      }
    }

    const explanation: ExplanationItem[] = [
      {
        feature: type === 'power_theft' ? 'power_discrepancy_ratio' : `${type}_index`,
        deviation_pct:
          type === 'voltage_sag'
            ? -round1(12 + rng() * 14)
            : round1(18 + rng() * 28),
        z_score: round2(severity === 'critical' ? 3.1 + rng() * 1.4 : 1.9 + rng() * 1.1),
        description:
          type === 'power_theft'
            ? `Unmetered load divergence of ${energyLossKwh.toFixed(2)} kWh detected on Feeder ${feederId}`
            : `${formatFaultTypeLabel(type)} excursion recorded on ${meterId}`,
      },
    ];

    result.push({
      id: startId + i,
      meter_id: meterId,
      type,
      severity,
      score,
      status: 'closed',
      assigned_to: feederId === '02' ? 'ops-shift-a' : 'field-crew-2',
      detected_at: new Date(detectedMs).toISOString(),
      last_detected_at: new Date(lastDetectedMs).toISOString(),
      loss_kw: lossKw,
      energy_loss_kwh: energyLossKwh,
      expected_kwh: expectedKwh,
      measured_kwh: measuredKwh,
      baseline_kw: baselineKw,
      measured_kw: measuredKw,
      duration_hours: durationHours,
      explanation,
    });
  }

  return result;
}
