import type {
  Alert,
  ExplanationItem,
  FaultFrequencyItem,
  MeterSummary,
  Reading,
  WeeklyEnergyLossItem,
} from '../types';
import { generateDeterministicAlertHistory, getIstDayStartMs } from '../analytics/aggregate';

export interface FeederSpec {
  id: string;
  code: string;
  name: string;
  substationBus: string;
  yCenter: number;
}

export const SUBSTATION_FEEDERS: FeederSpec[] = [
  {
    id: 'FDR-01',
    code: 'F01-N',
    name: 'FEEDER 01 // NORTH INDUSTRIAL 11kV',
    substationBus: 'BUS-A 33/11kV',
    yCenter: 130,
  },
  {
    id: 'FDR-02',
    code: 'F02-C',
    name: 'FEEDER 02 // CENTRAL COMMERCIAL 11kV',
    substationBus: 'BUS-A 33/11kV',
    yCenter: 290,
  },
  {
    id: 'FDR-03',
    code: 'F03-S',
    name: 'FEEDER 03 // SOUTH RESIDENTIAL 11kV',
    substationBus: 'BUS-B 33/11kV',
    yCenter: 450,
  },
];

const METER_LOCATIONS = [
  'Arc Furnace Bay #2',
  'Cold Storage Plant A',
  'CNC Stamping Line #4',
  'Water Pumping Station',
  'Textile Mill Transformer',
  'Chemical Dosing Unit',
  'Logistics Cold Dock',
  'Metro Traction Sub-7',
  'Central Hospital Wing B',
  'Data Center Annex',
  'Municipal Telecom Hub',
  'Commercial Plaza North',
  'High-Rise Tower 14',
  'EV Fast-Charge Depot',
  'Sector 9 Substation',
  'Riverfront Apartments',
  'Westgate Housing Block',
  'Solar Microgrid Tie-In',
  'Hillcrest Feeder Tap',
  'South Canal Distribution',
];

export function getFeederForMeterIndex(idx: number): FeederSpec {
  if (idx < 7) return SUBSTATION_FEEDERS[0];
  if (idx < 14) return SUBSTATION_FEEDERS[1];
  return SUBSTATION_FEEDERS[2];
}

export function getFeederForMeterId(meterId: string): FeederSpec {
  const m = /(\d+)$/.exec(meterId.trim());
  if (!m) return SUBSTATION_FEEDERS[0];
  const num = Number(m[1]);
  const rawIdx = num >= 101 ? num - 101 : num >= 1 ? num - 1 : 0;
  const idx = ((rawIdx % 20) + 20) % 20;
  return getFeederForMeterIndex(idx);
}

export function buildInitialMockMeters(): MeterSummary[] {
  const now = new Date();
  return Array.from({ length: 20 }, (_, i) => {
    const id = `MTR-${String(101 + i).padStart(4, '0')}`;
    const feeder = getFeederForMeterIndex(i);
    const baseCurrent = 11.5 + (i % 7) * 2.4;

    let va = 230.2 + ((i % 3) - 1) * 0.6;
    let vb = 229.8 + ((i % 2) - 0.5) * 0.8;
    let vc = 230.5 - ((i % 3) - 1) * 0.5;
    let ia = baseCurrent;
    let ib = baseCurrent * 0.99;
    let ic = baseCurrent * 1.01;
    let pf = 0.954;
    const openAlerts: { severity: string; type: string }[] = [];

    // Seed 3 active anomalies so the Control Room is immediately alive
    if (i === 3) {
      // MTR-0104: Active Power Theft (48% current bypass drop, normal voltage)
      ia = +(baseCurrent * 0.52).toFixed(2);
      ib = +(baseCurrent * 0.51).toFixed(2);
      ic = +(baseCurrent * 0.53).toFixed(2);
      openAlerts.push({ severity: 'critical', type: 'power_theft' });
    } else if (i === 8) {
      // MTR-0109: Phase B Imbalance (+34% current surge & slight voltage droop on Phase B)
      ib = +(baseCurrent * 1.34).toFixed(2);
      vb = 219.4;
      openAlerts.push({ severity: 'high', type: 'phase_imbalance' });
    } else if (i === 15) {
      // MTR-0116: Voltage Sag on all 3 phases
      va = 196.4;
      vb = 198.1;
      vc = 197.2;
      openAlerts.push({ severity: 'critical', type: 'voltage_sag' });
    }

    const reading: Reading = {
      meter_id: id,
      ts: now.toISOString(),
      voltage_a: +va.toFixed(2),
      voltage_b: +vb.toFixed(2),
      voltage_c: +vc.toFixed(2),
      current_a: +ia.toFixed(2),
      current_b: +ib.toFixed(2),
      current_c: +ic.toFixed(2),
      power_factor: pf,
      frequency: 50.01,
      active_energy_kwh: +(1840 + i * 215.4).toFixed(2),
      fault_label: openAlerts[0]?.type ?? 'normal',
    };

    return {
      id,
      name: id,
      location: `${feeder.code} · ${METER_LOCATIONS[i]}`,
      last_seen: now.toISOString(),
      latest_reading: reading,
      open_alerts: openAlerts,
    };
  });
}

export function buildInitialMockAlerts(nowMs: number = Date.now()): Alert[] {
  const now = nowMs;
  const min = 60_000;
  const hr = 60 * min;
  const istTodayStart = getIstDayStartMs(now);

  const initialAlerts: Alert[] = [
    {
      id: 9043,
      meter_id: 'MTR-0106',
      type: 'overcurrent',
      severity: 'medium',
      score: 0.78,
      status: 'open',
      assigned_to: null,
      detected_at: new Date(now - 9 * min).toISOString(),
      last_detected_at: new Date(now - 25_000).toISOString(),
      loss_kw: 0,
      energy_loss_kwh: 0,
      explanation: [
        {
          feature: 'current_a',
          deviation_pct: 28.4,
          z_score: 3.15,
          description: 'Phase A current (29.8 A) exceeded 60-minute nominal dosing pump profile by 28%',
        },
        {
          feature: 'current_c',
          deviation_pct: 21.6,
          z_score: 2.6,
          description: 'Phase C feeder current elevated to 28.1 A during cycle overlap',
        },
        {
          feature: 'power_factor',
          deviation_pct: -6.4,
          z_score: 1.5,
          description: 'Power factor dipped to 0.89 under sustained inductive motor draw',
        },
      ],
      events: [
        {
          id: 101,
          alert_id: 9043,
          actor: 'ensemble-v1.0.0',
          action: 'created',
          details: 'IF=0.76 LSTM=0.80 RULE=overcurrent',
          created_at: new Date(now - 9 * min).toISOString(),
        },
      ],
    },
    {
      id: 9042,
      meter_id: 'MTR-0118',
      type: 'voltage_swell',
      severity: 'low',
      score: 0.69,
      status: 'open',
      assigned_to: null,
      detected_at: new Date(now - 27 * min).toISOString(),
      last_detected_at: new Date(now - 90_000).toISOString(),
      loss_kw: 0,
      energy_loss_kwh: 0,
      explanation: [
        {
          feature: 'voltage_c',
          deviation_pct: 7.4,
          z_score: 2.45,
          description: 'Phase C voltage peaked at 247.1 V during daytime microgrid reverse feed-in',
        },
        {
          feature: 'voltage_a',
          deviation_pct: 5.9,
          z_score: 2.05,
          description: 'Phase A terminal voltage rose +5.9% above 230.0 V nominal reference',
        },
        {
          feature: 'frequency',
          deviation_pct: 0.2,
          z_score: 0.8,
          description: 'Bus frequency held 50.10 Hz within statutory deadband',
        },
      ],
      events: [
        {
          id: 102,
          alert_id: 9042,
          actor: 'ensemble-v1.0.0',
          action: 'created',
          details: 'IF=0.68 LSTM=0.70 RULE=voltage_swell',
          created_at: new Date(now - 27 * min).toISOString(),
        },
      ],
    },
    {
      id: 9041,
      meter_id: 'MTR-0104',
      type: 'power_theft',
      severity: 'critical',
      score: 0.94,
      status: 'open',
      assigned_to: null,
      detected_at: new Date(now - 4 * min).toISOString(),
      last_detected_at: new Date(now - 15_000).toISOString(),
      loss_kw: 6.42,
      energy_loss_kwh: 18.65,
      expected_kwh: 38.85,
      measured_kwh: 20.2,
      explanation: [
        {
          feature: 'load_vs_profile',
          deviation_pct: -48.2,
          z_score: 4.45,
          description: "Three-phase load (9.6 A) is 48% below this meter's time-of-day profile while bus voltage holds 230.1 V",
        },
        {
          feature: 'current_mean_rel_dev_60m',
          deviation_pct: -46.0,
          z_score: 3.92,
          description: 'Mean phase current dropped 46% below its 60-minute rolling baseline',
        },
        {
          feature: 'voltage_a',
          deviation_pct: 0.1,
          z_score: 0.12,
          description: 'Phase A voltage (230.2 V) remained nominal during load drop (bypass signature)',
        },
      ],
      events: [
        {
          id: 1,
          alert_id: 9041,
          actor: 'ensemble-v1.0.0',
          action: 'created',
          details: 'IF=0.91 LSTM=0.96 RULE=power_theft',
          created_at: new Date(now - 4 * min).toISOString(),
        },
      ],
    },
    {
      id: 9040,
      meter_id: 'MTR-0109',
      type: 'phase_imbalance',
      severity: 'high',
      score: 0.88,
      status: 'open',
      assigned_to: 'dispatch-north',
      detected_at: new Date(now - 19 * min).toISOString(),
      last_detected_at: new Date(now - 40_000).toISOString(),
      loss_kw: 0,
      energy_loss_kwh: 0,
      explanation: [
        {
          feature: 'current_b',
          deviation_pct: 34.4,
          z_score: 3.85,
          description: 'Phase B current (24.6 A) is 34% above its 60-minute baseline',
        },
        {
          feature: 'current_imbalance_nema',
          deviation_pct: 22.8,
          z_score: 3.4,
          description: 'NEMA phase current imbalance index reached 22.8% (limit 10.0%)',
        },
        {
          feature: 'voltage_b',
          deviation_pct: -4.6,
          z_score: 1.95,
          description: 'Phase B voltage (219.4 V) sagged 4.6% below balanced bus average',
        },
      ],
      events: [
        {
          id: 2,
          alert_id: 9040,
          actor: 'ensemble-v1.0.0',
          action: 'created',
          details: 'IF=0.86 LSTM=0.90 RULE=phase_imbalance',
          created_at: new Date(now - 19 * min).toISOString(),
        },
      ],
    },
    {
      id: 9039,
      meter_id: 'MTR-0116',
      type: 'voltage_sag',
      severity: 'critical',
      score: 0.92,
      status: 'open',
      assigned_to: null,
      detected_at: new Date(now - 42 * min).toISOString(),
      last_detected_at: new Date(now - 2 * min).toISOString(),
      loss_kw: 0,
      energy_loss_kwh: 0,
      explanation: [
        {
          feature: 'voltage_a',
          deviation_pct: -14.6,
          z_score: 4.82,
          description: 'Phase A voltage (196.4 V) breached EN 50160 lower limit (207.0 V)',
        },
        {
          feature: 'voltage_c',
          deviation_pct: -14.3,
          z_score: 4.71,
          description: 'Phase C voltage (197.2 V) is 14% below nominal 230.0 V reference',
        },
        {
          feature: 'voltage_b',
          deviation_pct: -13.9,
          z_score: 4.55,
          description: 'Phase B voltage (198.1 V) is 14% below its 60-minute baseline',
        },
      ],
      events: [
        {
          id: 3,
          alert_id: 9039,
          actor: 'ensemble-v1.0.0',
          action: 'created',
          details: 'IF=0.90 LSTM=0.94 RULE=voltage_sag',
          created_at: new Date(now - 42 * min).toISOString(),
        },
      ],
    },
    {
      id: 9038,
      meter_id: 'MTR-0102',
      type: 'harmonic_distortion',
      severity: 'medium',
      score: 0.81,
      status: 'acknowledged',
      assigned_to: 'operator@gridsense.local',
      detected_at: new Date(now - 3.2 * hr).toISOString(),
      last_detected_at: new Date(now - 2.9 * hr).toISOString(),
      loss_kw: 0,
      energy_loss_kwh: 0,
      explanation: [
        {
          feature: 'power_factor',
          deviation_pct: -27.4,
          z_score: 4.02,
          description: 'Power factor (0.69) dropped 27% below 0.95 nominal reference',
        },
        {
          feature: 'current_c',
          deviation_pct: 19.2,
          z_score: 2.35,
          description: 'Phase C current (19.4 A) is 19% above its 60-minute baseline',
        },
        {
          feature: 'frequency',
          deviation_pct: -0.5,
          z_score: 1.4,
          description: 'Grid frequency jittered to 49.76 Hz during non-linear load switching',
        },
      ],
      events: [
        {
          id: 41,
          alert_id: 9038,
          actor: 'operator@gridsense.local',
          action: 'acknowledged',
          details: 'Assigned harmonic filter inspection',
          created_at: new Date(now - 3.0 * hr).toISOString(),
        },
        {
          id: 4,
          alert_id: 9038,
          actor: 'ensemble-v1.0.0',
          action: 'created',
          details: 'IF=0.79 LSTM=0.83 RULE=harmonic_distortion',
          created_at: new Date(now - 3.2 * hr).toISOString(),
        },
      ],
    },
    {
      id: 9037,
      meter_id: 'MTR-0112',
      type: 'overcurrent_spike',
      severity: 'critical',
      score: 0.95,
      status: 'closed',
      assigned_to: 'field-crew-04',
      detected_at: new Date(now - 7.5 * hr).toISOString(),
      last_detected_at: new Date(now - 7.4 * hr).toISOString(),
      loss_kw: 0,
      energy_loss_kwh: 0,
      explanation: [
        {
          feature: 'current_a',
          deviation_pct: 142.0,
          z_score: 6.1,
          description: 'Phase A current (38.7 A) spiked 142% above its 60-minute baseline',
        },
        {
          feature: 'current_b',
          deviation_pct: 136.5,
          z_score: 5.85,
          description: 'Phase B current (37.8 A) spiked 137% above its 60-minute baseline',
        },
        {
          feature: 'voltage_mean',
          deviation_pct: -3.1,
          z_score: 1.7,
          description: 'Bus voltage drooped 3.1% to 222.9 V under inrush current',
        },
      ],
      events: [
        {
          id: 51,
          alert_id: 9037,
          actor: 'field-crew-04',
          action: 'closed',
          details: 'Chiller inrush soft-starter reset',
          created_at: new Date(now - 7.3 * hr).toISOString(),
        },
        {
          id: 5,
          alert_id: 9037,
          actor: 'ensemble-v1.0.0',
          action: 'created',
          details: 'IF=0.94 LSTM=0.96 RULE=overcurrent_spike',
          created_at: new Date(now - 7.5 * hr).toISOString(),
        },
      ],
    },
    {
      id: 9036,
      meter_id: 'MTR-0104',
      type: 'power_theft',
      severity: 'critical',
      score: 0.91,
      status: 'closed',
      assigned_to: 'revenue-protection',
      detected_at: new Date(istTodayStart - 2.2 * hr).toISOString(),
      last_detected_at: new Date(istTodayStart - 0.8 * hr).toISOString(),
      loss_kw: 5.8,
      energy_loss_kwh: 14.2,
      baseline_kw: 12.9,
      measured_kw: 7.1,
      duration_hours: 2.448,
      explanation: [
        {
          feature: 'load_vs_profile',
          deviation_pct: -44.5,
          z_score: 4.1,
          description: "Load dropped 45% below this meter's typical level for this time of day",
        },
        {
          feature: 'current_mean_rel_dev_60m',
          deviation_pct: -42.1,
          z_score: 3.7,
          description: 'Three-phase average load (8.9 A) is 42% below its 60-minute baseline',
        },
        {
          feature: 'voltage_b',
          deviation_pct: 0.2,
          z_score: 0.15,
          description: 'Phase B voltage (230.5 V) remained unchanged during load drop',
        },
      ],
      events: [
        {
          id: 9,
          alert_id: 9036,
          actor: 'revenue-protection',
          action: 'closed',
          details: 'Bypass clamp removed',
          created_at: new Date(now - 12.8 * hr).toISOString(),
        },
        {
          id: 8,
          alert_id: 9036,
          actor: 'ensemble-v1.0.0',
          action: 'created',
          details: 'IF=0.89 LSTM=0.93 RULE=power_theft',
          created_at: new Date(now - 14.2 * hr).toISOString(),
        },
      ],
    },
    {
      id: 9035,
      meter_id: 'MTR-0109',
      type: 'phase_imbalance',
      severity: 'medium',
      score: 0.79,
      status: 'acknowledged',
      assigned_to: 'dispatch-central',
      detected_at: new Date(now - 5.5 * hr).toISOString(),
      last_detected_at: new Date(now - 5.2 * hr).toISOString(),
      loss_kw: 0,
      energy_loss_kwh: 0,
      explanation: [
        {
          feature: 'current_b',
          deviation_pct: 26.2,
          z_score: 3.1,
          description: 'Phase B current (22.9 A) rose 26% above balanced 3-phase reference',
        },
        {
          feature: 'current_imbalance_nema',
          deviation_pct: 17.4,
          z_score: 2.75,
          description: 'NEMA current imbalance reached 17.4% during HVAC compressor cycle',
        },
        {
          feature: 'voltage_b',
          deviation_pct: -3.2,
          z_score: 1.45,
          description: 'Phase B voltage dipped to 222.6 V under single-phase load concentration',
        },
      ],
      events: [
        {
          id: 71,
          alert_id: 9035,
          actor: 'dispatch-central',
          action: 'acknowledged',
          details: 'Scheduled phase rebalancing check',
          created_at: new Date(now - 5.3 * hr).toISOString(),
        },
        {
          id: 7,
          alert_id: 9035,
          actor: 'ensemble-v1.0.0',
          action: 'created',
          details: 'IF=0.77 LSTM=0.81 RULE=phase_imbalance',
          created_at: new Date(now - 5.5 * hr).toISOString(),
        },
      ],
    },
    {
      id: 9034,
      meter_id: 'MTR-0109',
      type: 'voltage_sag',
      severity: 'critical',
      score: 0.91,
      status: 'closed',
      assigned_to: 'substation-ops',
      detected_at: new Date(now - 11.2 * hr).toISOString(),
      last_detected_at: new Date(now - 11.0 * hr).toISOString(),
      loss_kw: 0,
      energy_loss_kwh: 0,
      explanation: [
        {
          feature: 'voltage_b',
          deviation_pct: -12.8,
          z_score: 4.2,
          description: 'Phase B voltage sagged to 200.5 V during feeder tap switching',
        },
        {
          feature: 'current_b',
          deviation_pct: 29.0,
          z_score: 3.3,
          description: 'Phase B inrush current peaked at 23.5 A',
        },
        {
          feature: 'power_factor',
          deviation_pct: -11.5,
          z_score: 2.1,
          description: 'Inductive power factor dipped to 0.84 during motor restart',
        },
      ],
      events: [
        {
          id: 61,
          alert_id: 9034,
          actor: 'substation-ops',
          action: 'closed',
          details: 'Tap changer restored nominal voltage',
          created_at: new Date(now - 11.0 * hr).toISOString(),
        },
        {
          id: 6,
          alert_id: 9034,
          actor: 'ensemble-v1.0.0',
          action: 'created',
          details: 'IF=0.90 LSTM=0.92 RULE=voltage_sag',
          created_at: new Date(now - 11.2 * hr).toISOString(),
        },
      ],
    },
  ];

  return [
    ...initialAlerts,
    ...generateDeterministicAlertHistory(now),
  ];
}

export function buildRollingReadingsForMeter(meter: MeterSummary, count = 180): Reading[] {
  const now = Date.now();
  const base = meter.latest_reading;
  const va0 = base?.voltage_a ?? 230.2;
  const vb0 = base?.voltage_b ?? 229.9;
  const vc0 = base?.voltage_c ?? 230.4;
  const ia0 = base?.current_a ?? 14.2;
  const ib0 = base?.current_b ?? 14.0;
  const ic0 = base?.current_c ?? 14.3;
  const pf0 = base?.power_factor ?? 0.952;
  const isMtr0109 = meter.id === 'MTR-0109';
  const stepMs = Math.max(1000, Math.floor((15 * 60 * 1000) / Math.max(1, count)));

  return Array.from({ length: count }, (_, idx) => {
    const t = now - (count - 1 - idx) * stepMs;
    const wave = Math.sin(idx * 0.22);
    const waveB = Math.cos(idx * 0.19);
    // Ensure MTR-0109 shows a clear Phase B imbalance transition and sustained fault
    const imbFactor = isMtr0109 && idx < Math.floor(count * 0.25) ? 0.76 : 1.0;
    const vbSample = isMtr0109 && idx < Math.floor(count * 0.25) ? 229.6 : vb0;

    return {
      meter_id: meter.id,
      ts: new Date(t).toISOString(),
      voltage_a: +(va0 + wave * 0.65).toFixed(2),
      voltage_b: +(vbSample + waveB * 0.65).toFixed(2),
      voltage_c: +(vc0 - wave * 0.55).toFixed(2),
      current_a: +Math.max(0.5, ia0 + wave * 0.35).toFixed(2),
      current_b: +Math.max(0.5, ib0 * imbFactor + waveB * 0.35).toFixed(2),
      current_c: +Math.max(0.5, ic0 - wave * 0.3).toFixed(2),
      power_factor: +Math.min(0.995, Math.max(0.55, pf0 + wave * 0.004)).toFixed(3),
      frequency: +(50.0 + Math.sin(idx * 0.15) * 0.035).toFixed(3),
      active_energy_kwh: +((base?.active_energy_kwh ?? 1800) - (count - idx) * 0.03).toFixed(2),
      fault_label:
        isMtr0109 && idx >= Math.floor(count * 0.25)
          ? 'phase_imbalance'
          : (base?.fault_label ?? 'normal'),
    };
  });
}

export const MOCK_FAULT_FREQUENCY: FaultFrequencyItem[] = [
  { type: 'power_theft', count: 38 },
  { type: 'phase_imbalance', count: 29 },
  { type: 'voltage_sag', count: 24 },
  { type: 'harmonic_distortion', count: 19 },
  { type: 'overcurrent_spike', count: 14 },
  { type: 'voltage_swell', count: 11 },
];

export const MOCK_WEEKLY_LOSS: WeeklyEnergyLossItem[] = [
  { week_start: '2026-09-21', incidents: 4, energy_loss_kwh: 112.4 },
  { week_start: '2026-09-28', incidents: 6, energy_loss_kwh: 164.8 },
  { week_start: '2026-10-05', incidents: 5, energy_loss_kwh: 138.2 },
  { week_start: '2026-10-12', incidents: 7, energy_loss_kwh: 196.5 },
  { week_start: '2026-10-19', incidents: 8, energy_loss_kwh: 228.0 },
  { week_start: '2026-10-26', incidents: 6, energy_loss_kwh: 171.3 },
  { week_start: '2026-11-02', incidents: 9, energy_loss_kwh: 254.6 },
  { week_start: '2026-11-09', incidents: 7, energy_loss_kwh: 209.4 },
];

/** 7 days (Mon..Sun) x 24 hours fault occurrence matrix for Analytics Heatmap */
export const MOCK_HOURLY_HEATMAP: { day: string; hours: number[] }[] = [
  { day: 'MON', hours: [1, 0, 0, 0, 1, 1, 2, 3, 4, 3, 2, 2, 3, 2, 2, 3, 4, 6, 8, 9, 7, 5, 2, 1] },
  { day: 'TUE', hours: [0, 1, 0, 0, 0, 1, 2, 4, 3, 2, 2, 3, 2, 3, 2, 4, 5, 7, 9, 8, 6, 4, 2, 1] },
  { day: 'WED', hours: [1, 0, 0, 1, 0, 1, 3, 3, 4, 3, 3, 2, 2, 2, 3, 4, 6, 8, 10, 9, 6, 3, 2, 1] },
  { day: 'THU', hours: [0, 0, 1, 0, 1, 2, 3, 4, 4, 3, 2, 2, 3, 3, 3, 5, 6, 8, 9, 11, 7, 4, 2, 1] },
  { day: 'FRI', hours: [1, 1, 0, 0, 1, 2, 3, 5, 4, 3, 3, 3, 4, 3, 4, 5, 7, 9, 12, 10, 8, 5, 3, 2] },
  { day: 'SAT', hours: [2, 1, 1, 0, 0, 1, 1, 2, 3, 4, 4, 5, 4, 4, 3, 4, 6, 8, 9, 8, 6, 4, 3, 2] },
  { day: 'SUN', hours: [1, 1, 0, 0, 0, 1, 1, 1, 2, 3, 3, 4, 4, 3, 3, 4, 5, 7, 8, 7, 5, 3, 2, 1] },
];

// NOTE: Hardcoded ModelInfo placeholder removed to satisfy the Honesty Rule:
// ModelHealthPage fetches live from GET /model/info (or renders NOT EVALUATED).

export function createSyntheticFaultExplanation(
  meterId: string,
  type: string,
  reading: Reading,
): ExplanationItem[] {
  if (type === 'power_theft') {
    return [
      {
        feature: 'load_vs_profile',
        deviation_pct: -49.5,
        z_score: 4.6,
        description: `Load on ${meterId} (${reading.current_a.toFixed(1)} A) dropped 50% below time-of-day baseline while voltage held ${reading.voltage_a.toFixed(1)} V`,
      },
      {
        feature: 'current_mean_rel_dev_60m',
        deviation_pct: -45.2,
        z_score: 3.95,
        description: 'Three-phase average current is 45% below its 60-minute rolling baseline',
      },
      {
        feature: 'voltage_a',
        deviation_pct: 0.2,
        z_score: 0.14,
        description: `Phase A voltage (${reading.voltage_a.toFixed(1)} V) remained stable during abrupt load drop`,
      },
    ];
  }
  if (type === 'phase_imbalance') {
    return [
      {
        feature: 'current_b',
        deviation_pct: 36.8,
        z_score: 4.1,
        description: `Phase B current (${reading.current_b.toFixed(1)} A) is 37% above its 60-minute baseline`,
      },
      {
        feature: 'current_imbalance_nema',
        deviation_pct: 24.5,
        z_score: 3.65,
        description: 'NEMA phase current imbalance index reached 24.5% (threshold 10.0%)',
      },
      {
        feature: 'voltage_b',
        deviation_pct: -4.2,
        z_score: 1.85,
        description: `Phase B voltage (${reading.voltage_b.toFixed(1)} V) drooped 4.2% under unbalanced load`,
      },
    ];
  }
  return [
    {
      feature: 'voltage_a',
      deviation_pct: -15.2,
      z_score: 4.9,
      description: `Phase A voltage (${reading.voltage_a.toFixed(1)} V) dropped 15% below nominal 230.0 V bus reference`,
    },
    {
      feature: 'voltage_b',
      deviation_pct: -14.8,
      z_score: 4.75,
      description: `Phase B voltage (${reading.voltage_b.toFixed(1)} V) breached 207.0 V lower statutory limit`,
    },
    {
      feature: 'current_a',
      deviation_pct: 12.4,
      z_score: 2.1,
      description: `Phase A current (${reading.current_a.toFixed(1)} A) rose 12% during voltage sag compensation`,
    },
  ];
}
