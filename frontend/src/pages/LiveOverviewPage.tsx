import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, AlertTriangle, Gauge, Search, Zap } from 'lucide-react';
import clsx from 'clsx';
import { getMeters } from '../api';
import { useSocket } from '../context/SocketContext';
import type { MeterSummary } from '../types';
import {
  computeAvgVoltage,
  computeLoadKw,
  formatFaultLabel,
  formatTimeShort,
  getMeterStatus,
  getReadingTimestamp,
} from '../utils/format';

export const LiveOverviewPage: React.FC = () => {
  const navigate = useNavigate();
  const { onReading, onAlert, onAlertUpdate } = useSocket();

  const [meters, setMeters] = useState<MeterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'critical' | 'warning' | 'normal'>('all');

  useEffect(() => {
    let active = true;
    getMeters()
      .then((res) => {
        if (active) setMeters(res.meters);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Subscribe to real-time Socket.IO telemetry and alerts
  useEffect(() => {
    const unsubReading = onReading((reading) => {
      const ts = getReadingTimestamp(reading);
      setMeters((prev) => {
        const idx = prev.findIndex((m) => m.id === reading.meter_id);
        if (idx === -1) {
          return [
            ...prev,
            {
              id: reading.meter_id,
              name: reading.meter_id,
              last_seen: ts,
              latest_reading: reading,
              open_alerts: [],
            },
          ];
        }
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          last_seen: ts ?? next[idx].last_seen,
          latest_reading: reading,
        };
        return next;
      });
    });

    const unsubAlert = onAlert((alert) => {
      setMeters((prev) =>
        prev.map((m) =>
          m.id === alert.meter_id
            ? {
                ...m,
                open_alerts: [
                  { severity: alert.severity, type: alert.type },
                  ...m.open_alerts.filter((a) => a.type !== alert.type),
                ],
              }
            : m,
        ),
      );
    });

    const unsubAlertUpdate = onAlertUpdate((alert) => {
      if (alert.status === 'closed') {
        setMeters((prev) =>
          prev.map((m) =>
            m.id === alert.meter_id
              ? { ...m, open_alerts: m.open_alerts.filter((a) => a.type !== alert.type) }
              : m,
          ),
        );
      }
    });

    return () => {
      unsubReading();
      unsubAlert();
      unsubAlertUpdate();
    };
  }, [onReading, onAlert, onAlertUpdate]);

  const kpis = useMemo(() => {
    let totalKw = 0;
    let freqSum = 0;
    let freqCount = 0;
    let criticalCount = 0;
    let warningCount = 0;

    for (const m of meters) {
      totalKw += computeLoadKw(m.latest_reading);
      if (m.latest_reading?.frequency) {
        freqSum += m.latest_reading.frequency;
        freqCount += 1;
      }
      const st = getMeterStatus(m);
      if (st === 'critical') criticalCount += 1;
      else if (st === 'warning') warningCount += 1;
    }

    return {
      totalMeters: meters.length,
      criticalCount,
      warningCount,
      totalKw,
      avgFreq: freqCount > 0 ? freqSum / freqCount : 50.0,
    };
  }, [meters]);

  const filteredMeters = useMemo(() => {
    const q = search.trim().toLowerCase();
    return meters.filter((m) => {
      const matchesText =
        !q || m.id.toLowerCase().includes(q) || (m.location ?? '').toLowerCase().includes(q);
      const st = getMeterStatus(m);
      const matchesStatus = statusFilter === 'all' || st === statusFilter;
      return matchesText && matchesStatus;
    });
  }, [meters, search, statusFilter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live Fleet Overview</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Real-time 3-phase smart-meter health, load telemetry, and active fault status.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              type="search"
              aria-label="Search meters"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search meter ID..."
              className="pl-9 pr-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
            />
          </div>
          <select
            aria-label="Filter meters by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
          >
            <option value="all">All Statuses</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="normal">Normal</option>
          </select>
        </div>
      </div>

      {/* Fleet KPIs */}
      <section aria-label="Fleet summary metrics" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center justify-between text-xs font-mono uppercase text-slate-500 dark:text-slate-400">
            <span>Monitored Meters</span>
            <Activity className="h-4 w-4 text-cyan-500" aria-hidden="true" />
          </div>
          <div className="mt-2 text-2xl font-bold tabular-nums font-mono">{kpis.totalMeters}</div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center justify-between text-xs font-mono uppercase text-slate-500 dark:text-slate-400">
            <span>Critical / Warning</span>
            <AlertTriangle className="h-4 w-4 text-rose-500" aria-hidden="true" />
          </div>
          <div className="mt-2 text-2xl font-bold tabular-nums font-mono">
            <span className="text-rose-500">{kpis.criticalCount}</span>
            <span className="text-slate-400 mx-1">/</span>
            <span className="text-amber-500">{kpis.warningCount}</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center justify-between text-xs font-mono uppercase text-slate-500 dark:text-slate-400">
            <span>Aggregate Fleet Load</span>
            <Zap className="h-4 w-4 text-emerald-500" aria-hidden="true" />
          </div>
          <div className="mt-2 text-2xl font-bold tabular-nums font-mono">
            {kpis.totalKw.toFixed(1)} <span className="text-sm font-normal text-slate-400">kW</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center justify-between text-xs font-mono uppercase text-slate-500 dark:text-slate-400">
            <span>Mean Grid Frequency</span>
            <Gauge className="h-4 w-4 text-indigo-500" aria-hidden="true" />
          </div>
          <div className="mt-2 text-2xl font-bold tabular-nums font-mono">
            {kpis.avgFreq.toFixed(2)} <span className="text-sm font-normal text-slate-400">Hz</span>
          </div>
        </div>
      </section>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-600 dark:text-rose-300"
        >
          Failed to load meters: {error}
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-40 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 animate-pulse"
            />
          ))}
        </div>
      ) : filteredMeters.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center text-sm text-slate-500">
          No meters match your current filter.
        </div>
      ) : (
        <section
          aria-label="Smart meter grid"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
        >
          {filteredMeters.map((meter) => {
            const status = getMeterStatus(meter);
            const loadKw = computeLoadKw(meter.latest_reading);
            const avgV = computeAvgVoltage(meter.latest_reading);
            const pf = meter.latest_reading?.power_factor;
            const lastTs = getReadingTimestamp(meter.latest_reading) ?? meter.last_seen;
            const primaryAlert = meter.open_alerts?.[0];

            return (
              <div
                key={meter.id}
                role="link"
                tabIndex={0}
                aria-label={`Meter ${meter.id}, status ${status}, load ${loadKw.toFixed(2)} kW`}
                onClick={() => navigate(`/meters/${encodeURIComponent(meter.id)}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(`/meters/${encodeURIComponent(meter.id)}`);
                  }
                }}
                className={clsx(
                  'cursor-pointer rounded-xl border p-4 transition-all hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 bg-white dark:bg-slate-900',
                  status === 'critical' && 'border-rose-500/60 shadow-rose-500/10',
                  status === 'warning' && 'border-amber-500/60 shadow-amber-500/10',
                  status === 'normal' && 'border-slate-200 dark:border-slate-800 hover:border-cyan-500/50',
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono font-bold text-base">{meter.id}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[140px]">
                      {meter.location || '3-Phase Feeder'}
                    </div>
                  </div>
                  <span
                    className={clsx(
                      'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold uppercase tracking-wider border',
                      status === 'critical' &&
                        'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30',
                      status === 'warning' &&
                        'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
                      status === 'normal' &&
                        'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
                    )}
                  >
                    <span
                      className={clsx(
                        'h-1.5 w-1.5 rounded-full',
                        status === 'critical' && 'bg-rose-500 animate-ping',
                        status === 'warning' && 'bg-amber-500',
                        status === 'normal' && 'bg-emerald-500',
                      )}
                    />
                    {status}
                  </span>
                </div>

                <div className="mt-4 flex items-baseline justify-between">
                  <div>
                    <div className="text-[10px] font-mono uppercase text-slate-400">Active Load</div>
                    <div className="text-2xl font-bold font-mono tabular-nums">
                      {loadKw.toFixed(2)} <span className="text-xs font-normal text-slate-400">kW</span>
                    </div>
                  </div>
                  <div className="text-right font-mono text-xs tabular-nums">
                    <div className="text-slate-600 dark:text-slate-300">
                      {meter.latest_reading ? `${avgV.toFixed(1)} V` : '—'}
                    </div>
                    <div className="text-slate-400">
                      PF {pf !== undefined ? pf.toFixed(2) : '—'}
                    </div>
                  </div>
                </div>

                <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[11px]">
                  <span className="text-slate-400 font-mono">Last: {formatTimeShort(lastTs)}</span>
                  {primaryAlert ? (
                    <span className="font-medium text-rose-500 truncate max-w-[125px]">
                      {formatFaultLabel(primaryAlert.type)}
                    </span>
                  ) : (
                    <span className="text-emerald-600 dark:text-emerald-400">Balanced</span>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
};
