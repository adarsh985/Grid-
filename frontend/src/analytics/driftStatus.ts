export type DriftZone = 'stable' | 'watch' | 'drift' | 'unknown';

export interface DriftClassification {
  zone: DriftZone;
  label: string;
  zoneText: string;
  icon: string;
  description: string;
  value: number | null;
}

export const PSI_WATCH_THRESHOLD = 0.1;
export const PSI_DRIFT_THRESHOLD = 0.2;

/**
 * Classify a Population Stability Index (PSI) value into an operational drift zone.
 *
 * Rules:
 * - Negative, NaN, null, undefined, or non-finite -> 'unknown'
 * - [0, 0.1) -> 'stable'
 * - [0.1, 0.2] -> 'watch'
 * - (0.2, Infinity) -> 'drift'
 */
export function classifyPsi(psi: number | null | undefined): DriftClassification {
  if (typeof psi !== 'number' || !Number.isFinite(psi) || psi < 0) {
    return {
      zone: 'unknown',
      label: 'UNKNOWN',
      zoneText: 'unknown',
      icon: '?',
      description: 'No valid PSI measurement available.',
      value: null,
    };
  }

  if (psi < PSI_WATCH_THRESHOLD) {
    return {
      zone: 'stable',
      label: 'STABLE',
      zoneText: 'stable',
      icon: '●',
      description: 'Incoming telemetry matches training distribution (< 0.10).',
      value: psi,
    };
  }

  if (psi <= PSI_DRIFT_THRESHOLD) {
    return {
      zone: 'watch',
      label: 'WATCH',
      zoneText: 'watch',
      icon: '▲',
      description: 'Moderate distribution shift detected (0.10–0.20).',
      value: psi,
    };
  }

  return {
    zone: 'drift',
    label: 'DRIFT',
    zoneText: 'drift',
    icon: '◆',
    description: 'Significant distribution drift detected (> 0.20). Retraining advised.',
    value: psi,
  };
}

/**
 * Map a PSI value onto the 3 equal-width gauge zones:
 * - [0.00, 0.10) -> 0% .. 33.33% (STABLE)
 * - [0.10, 0.20] -> 33.33% .. 66.67% (WATCH)
 * - (0.20, 1.00+] -> 66.67% .. 100% (DRIFT)
 */
export function psiToMeterPercent(psi: number | null | undefined): number {
  const status = classifyPsi(psi);
  if (status.zone === 'unknown' || status.value === null) return 0;

  const v = status.value;
  if (v < PSI_WATCH_THRESHOLD) {
    return Math.max(0, Math.min(33.33, (v / PSI_WATCH_THRESHOLD) * 33.33));
  }
  if (v <= PSI_DRIFT_THRESHOLD) {
    return 33.33 + ((v - PSI_WATCH_THRESHOLD) / (PSI_DRIFT_THRESHOLD - PSI_WATCH_THRESHOLD)) * 33.34;
  }
  const capped = Math.min(1.0, v);
  return 66.67 + ((capped - PSI_DRIFT_THRESHOLD) / (1.0 - PSI_DRIFT_THRESHOLD)) * 33.33;
}

export function formatPsiAriaText(psi: number | null | undefined): string {
  const status = classifyPsi(psi);
  if (status.zone === 'unknown' || status.value === null) {
    return 'PSI unavailable, unknown zone';
  }
  return `PSI ${status.value.toFixed(2)}, ${status.zoneText} zone`;
}
