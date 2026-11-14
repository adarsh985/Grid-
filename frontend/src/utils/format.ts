import type { Alert, ExplanationItem, MeterSummary, Reading } from '../types';

export function computeLoadKw(r: Reading | null | undefined): number {
  if (!r) return 0;
  const va = r.voltage_a ?? 0;
  const vb = r.voltage_b ?? 0;
  const vc = r.voltage_c ?? 0;
  const ia = r.current_a ?? 0;
  const ib = r.current_b ?? 0;
  const ic = r.current_c ?? 0;
  const pf = r.power_factor ?? 0.95;
  return ((va * ia + vb * ib + vc * ic) * pf) / 1000;
}

export function computeAvgVoltage(r: Reading | null | undefined): number {
  if (!r) return 0;
  return (r.voltage_a + r.voltage_b + r.voltage_c) / 3;
}

export function getReadingTimestamp(r: Reading | null | undefined): string | null {
  if (!r) return null;
  return r.ts ?? r.timestamp ?? null;
}

export type MeterHealthStatus = 'critical' | 'warning' | 'normal';

export function getMeterStatus(meter: MeterSummary): MeterHealthStatus {
  const alerts = meter.open_alerts ?? [];
  if (alerts.some((a) => a.severity === 'critical' || a.severity === 'high')) {
    return 'critical';
  }
  if (alerts.length > 0) {
    return 'warning';
  }
  const r = meter.latest_reading;
  if (r) {
    const minV = Math.min(r.voltage_a, r.voltage_b, r.voltage_c);
    const maxV = Math.max(r.voltage_a, r.voltage_b, r.voltage_c);
    if (minV < 207 || maxV > 253) {
      return 'critical';
    }
  }
  return 'normal';
}

export function parseExplanation(explanation: Alert['explanation']): ExplanationItem[] {
  if (Array.isArray(explanation)) return explanation;
  if (typeof explanation === 'string') {
    try {
      const parsed = JSON.parse(explanation);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [{ feature: 'summary', deviation_pct: 0, z_score: 0, description: explanation }];
    }
  }
  return [];
}

export function formatFaultLabel(type: string): string {
  return type
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function formatTimeShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
