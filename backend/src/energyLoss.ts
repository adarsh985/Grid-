/**
 * Shared IST (Asia/Kolkata) energy-loss calculation matching frontend/src/analytics/aggregate.ts.
 *
 * Per-alert rule (power_theft alerts only):
 * 1. Primary (interval metering delta if present): max(0, expected_kwh - measured_kwh)
 * 2. Fallback A (baseline delta x duration if present): max(0, baseline_kw - measured_kw) * max(0, duration_hours)
 * 3. Fallback B (DB stored streaming integration): energy_loss_kwh > 0 ? energy_loss_kwh :
 *    max(0, loss_kw * max(0.25, (last_detected_at - detected_at) / 3_600_000))
 */

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface LossAlertLike {
  type: string;
  detected_at: string | Date;
  last_detected_at?: string | Date | null;
  loss_kw?: number | null;
  energy_loss_kwh?: number | null;
  expected_kwh?: number | null;
  measured_kwh?: number | null;
  baseline_kw?: number | null;
  measured_kw?: number | null;
  duration_hours?: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function getIstDateKey(tsOrMs: string | number | Date): string {
  const ms =
    tsOrMs instanceof Date
      ? tsOrMs.getTime()
      : typeof tsOrMs === 'number'
        ? tsOrMs
        : Date.parse(String(tsOrMs));
  if (!Number.isFinite(ms)) return '';
  const ist = new Date(ms + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getIstDayStartUtcIso(referenceNowMs: number = Date.now()): string {
  const ist = new Date(referenceNowMs + IST_OFFSET_MS);
  const istMidnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return new Date(istMidnight - IST_OFFSET_MS).toISOString();
}

export function getIstDayEndUtcIso(referenceNowMs: number = Date.now()): string {
  const startMs = Date.parse(getIstDayStartUtcIso(referenceNowMs));
  return new Date(startMs + DAY_MS - 1).toISOString();
}

export function estimateAlertLossKwh(alert: LossAlertLike): number {
  if (!alert || alert.type !== 'power_theft') return 0;

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

  const stored = Number(alert.energy_loss_kwh);
  if (Number.isFinite(stored) && stored > 0) {
    return round2(stored);
  }

  const lossKw = Number(alert.loss_kw);
  if (Number.isFinite(lossKw) && lossKw > 0) {
    const startMs =
      alert.detected_at instanceof Date
        ? alert.detected_at.getTime()
        : Date.parse(String(alert.detected_at));
    const endMs = alert.last_detected_at
      ? alert.last_detected_at instanceof Date
        ? alert.last_detected_at.getTime()
        : Date.parse(String(alert.last_detected_at))
      : startMs;
    const spanHours =
      Number.isFinite(startMs) && Number.isFinite(endMs)
        ? Math.max(0.25, (endMs - startMs) / 3_600_000)
        : 1;
    return round2(Math.max(0, lossKw * spanHours));
  }

  return 0;
}

export function computeBackendEnergyLossTodayKwh(
  alerts: LossAlertLike[],
  referenceNowMs: number = Date.now(),
): number {
  const todayKey = getIstDateKey(referenceNowMs);
  if (!todayKey || !alerts.length) return 0;
  let total = 0;
  for (const a of alerts) {
    if (getIstDateKey(a.detected_at) !== todayKey) continue;
    total += estimateAlertLossKwh(a);
  }
  return round2(total);
}
