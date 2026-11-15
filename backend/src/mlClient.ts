export interface Explanation {
  feature: string;
  deviation_pct: number;
  z_score: number;
  description: string;
}
export interface ScoreResult {
  timestamp: string;
  meter_id: string;
  is_anomaly: boolean;
  anomaly_score: number;
  predicted_type: string;
  severity: string;
  explanations: Explanation[];
}
export interface MlClient {
  score(readings: any[]): Promise<ScoreResult[]>;
  modelInfo(): Promise<any>;
}

export class HttpMlClient implements MlClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private timeoutMs = 15000) {
    const trimmed = baseUrl.trim().replace(/\/$/, '');
    this.baseUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  }

  private async call(path: string, init?: RequestInit) {
    const res = await fetch(this.baseUrl + path, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`ML service ${path} responded ${res.status}`);
    return res.json();
  }

  async score(readings: any[]): Promise<ScoreResult[]> {
    const body = JSON.stringify({
      readings: readings.map((r) => ({
        timestamp: r.timestamp,
        meter_id: r.meter_id,
        voltage_a: r.voltage_a,
        voltage_b: r.voltage_b,
        voltage_c: r.voltage_c,
        current_a: r.current_a,
        current_b: r.current_b,
        current_c: r.current_c,
        power_factor: r.power_factor,
        frequency: r.frequency,
        active_energy_kwh: r.active_energy_kwh,
      })),
    });
    const data = await this.call('/score', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return data.results;
  }

  modelInfo() {
    return this.call('/model/info');
  }
}
