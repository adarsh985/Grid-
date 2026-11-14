import type {
  Alert,
  FaultFrequencyItem,
  MeterSummary,
  ModelInfo,
  Reading,
  User,
  WeeklyEnergyLossItem,
} from './types';

export const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

// JWT held strictly in module/application memory (never localStorage or sessionStorage).
let inMemoryToken: string | null = null;

export function setAuthToken(token: string | null): void {
  inMemoryToken = token;
}

export function getAuthToken(): string | null {
  return inMemoryToken;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = inMemoryToken;
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    let errBody: any = null;
    try {
      errBody = await res.json();
    } catch {
      // ignore non-json error response
    }
    throw new ApiError(res.status, errBody?.error || `Request failed (${res.status})`, errBody?.details);
  }
  return res.json() as Promise<T>;
}

export async function loginApi(email: string, password: string): Promise<{ token: string; user: User }> {
  return request<{ token: string; user: User }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function getMeApi(): Promise<{ user: User }> {
  return request<{ user: User }>('/api/auth/me');
}

export async function getMeters(): Promise<{ meters: MeterSummary[] }> {
  return request<{ meters: MeterSummary[] }>('/api/meters');
}

export async function getMeter(id: string): Promise<MeterSummary> {
  return request<MeterSummary>(`/api/meters/${encodeURIComponent(id)}`);
}

export async function getMeterReadings(
  id: string,
  params: { from?: string; to?: string; bucket_seconds?: number; limit?: number } = {},
): Promise<{ meter_id: string; from: string; to: string; count: number; readings: Reading[] }> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.bucket_seconds) qs.set('bucket_seconds', String(params.bucket_seconds));
  if (params.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return request(`/api/meters/${encodeURIComponent(id)}/readings${query ? `?${query}` : ''}`);
}

export async function getAlerts(
  params: {
    severity?: string;
    type?: string;
    status?: string;
    meter_id?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ total: number; open_count?: number; alerts: Alert[] }> {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  });
  const query = qs.toString();
  return request(`/api/alerts${query ? `?${query}` : ''}`);
}

export async function injectSimulatorFaultApi(
  meter_id: string,
  fault_type: 'power_theft' | 'phase_imbalance' | 'voltage_sag',
): Promise<{ meter_id: string; fault_type: string; alerts_created: number; alerts_updated: number }> {
  return request('/api/simulator/inject-fault', {
    method: 'POST',
    body: JSON.stringify({ meter_id, fault_type }),
  });
}

export async function getAlertDetail(id: number): Promise<Alert> {
  return request<Alert>(`/api/alerts/${id}`);
}

export async function acknowledgeAlert(id: number): Promise<Alert> {
  return request<Alert>(`/api/alerts/${id}/acknowledge`, { method: 'POST', body: '{}' });
}

export async function assignAlert(id: number, assigned_to: string): Promise<Alert> {
  return request<Alert>(`/api/alerts/${id}/assign`, {
    method: 'POST',
    body: JSON.stringify({ assigned_to }),
  });
}

export async function closeAlert(id: number, note?: string): Promise<Alert> {
  return request<Alert>(`/api/alerts/${id}/close`, {
    method: 'POST',
    body: JSON.stringify(note ? { note } : {}),
  });
}

export async function getFaultFrequency(params: { from?: string; to?: string } = {}): Promise<{
  from: string;
  to: string;
  frequency: FaultFrequencyItem[];
}> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const query = qs.toString();
  return request(`/api/reports/fault-frequency${query ? `?${query}` : ''}`);
}

export async function getEnergyLoss(params: { from?: string; to?: string } = {}): Promise<{
  from: string;
  to: string;
  weeks: WeeklyEnergyLossItem[];
  today_date_ist?: string;
  today_energy_loss_kwh?: number;
}> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const query = qs.toString();
  return request(`/api/reports/energy-loss${query ? `?${query}` : ''}`);
}

export async function downloadCsvReport(
  endpoint: '/api/reports/incidents' | '/api/reports/energy-loss',
  filename: string,
  params: { from?: string; to?: string } = {},
): Promise<void> {
  const token = inMemoryToken;
  const qs = new URLSearchParams({ format: 'csv' });
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);

  const res = await fetch(`${API_BASE_URL}${endpoint}?${qs.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new ApiError(res.status, `Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function getModelInfo(): Promise<ModelInfo> {
  return request<ModelInfo>('/api/model/info');
}
