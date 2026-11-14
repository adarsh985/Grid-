export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: number;
  email: string;
  role: Role;
}

export interface Reading {
  id?: number;
  meter_id: string;
  ts?: string;
  timestamp?: string;
  voltage_a: number;
  voltage_b: number;
  voltage_c: number;
  current_a: number;
  current_b: number;
  current_c: number;
  power_factor: number;
  frequency: number;
  active_energy_kwh: number;
  fault_label?: string | null;
}

export interface MeterOpenAlert {
  severity: string;
  type: string;
}

export interface MeterSummary {
  id: string;
  name: string;
  location?: string | null;
  last_seen?: string | null;
  latest_reading: Reading | null;
  open_alerts: MeterOpenAlert[];
}

export interface ExplanationItem {
  feature: string;
  deviation_pct: number;
  z_score: number;
  description: string;
}

export interface AlertEvent {
  id: number;
  alert_id: number;
  actor: string;
  action: string;
  details?: string | null;
  created_at: string;
}

export interface Alert {
  id: number;
  meter_id: string;
  type: string;
  severity: string;
  score: number;
  explanation: ExplanationItem[] | string;
  status: 'open' | 'acknowledged' | 'closed';
  assigned_to?: string | null;
  detected_at: string;
  last_detected_at: string;
  loss_kw: number;
  energy_loss_kwh: number;
  expected_kwh?: number;
  measured_kwh?: number;
  baseline_kw?: number;
  measured_kw?: number;
  duration_hours?: number;
  events?: AlertEvent[];
}

export interface FaultMetric {
  support: number;
  precision: number;
  recall: number;
  f1: number;
  fpr: number;
  tp?: number;
  fp?: number;
  fn?: number;
  tn?: number;
}

export interface ModelFeatureImportance {
  feature: string;
  psi?: number;
  importance?: number;
  contribution?: number;
}

export interface ModelEvaluationHistoryEntry {
  version: string;
  evaluated_at: string;
  precision: number;
  recall: number;
  f1: number;
  fpr: number;
  test_samples?: number;
}

export interface ModelInfo {
  version: string;
  trained_at: string;
  feature_count: number;
  sequence_length: number;
  lstm_threshold: number;
  component_versions?: {
    isolation_forest?: string;
    lstm_autoencoder?: string;
  };
  hard_rules?: {
    voltage_min_v?: number;
    voltage_max_v?: number;
    nema_imbalance_threshold?: number;
    overcurrent_ratio_threshold?: number;
    power_factor_min?: number;
  };
  ensemble_weights: {
    isolation_forest_weight: number;
    lstm_autoencoder_weight: number;
    anomaly_threshold: number;
  };
  metrics: {
    evaluated_at?: string;
    test_samples?: number;
    split_description?: string;
    overall?: {
      precision: number;
      recall: number;
      f1: number;
      fpr: number;
      tp: number;
      fp: number;
      fn: number;
      tn: number;
    };
    per_fault?: Record<string, FaultMetric>;
  };
  drift: {
    sample_count: number;
    psi_threshold: number;
    max_psi: number;
    drift_warning: boolean;
    feature_psi: Record<string, number>;
  };
  top_features?: ModelFeatureImportance[];
  evaluation_history?: ModelEvaluationHistoryEntry[];
}

export interface FaultFrequencyItem {
  type: string;
  count: number;
}

export interface WeeklyEnergyLossItem {
  week_start: string;
  incidents: number;
  energy_loss_kwh: number;
}
