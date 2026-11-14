import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { AlertTriangle, ArrowLeft, CheckCircle2, Radio } from 'lucide-react';
import clsx from 'clsx';
import { AlertTimeline } from '../components/AlertTimeline';
import { DeviationBars } from '../components/DeviationBars';
import { Oscilloscope } from '../components/Oscilloscope';
import { PhasorDiagram } from '../components/PhasorDiagram';
import { ReadingsTable } from '../components/ReadingsTable';
import { findMeterById, useTelemetry } from '../context/TelemetryContext';
import { getFeederForMeterIndex } from '../mock/mockData';
import type { Alert, Reading } from '../types';
import { usePrefersReducedMotion } from '../utils/animationQueue';
import { formatDateTime, formatFaultLabel, parseExplanation } from '../utils/format';

export const MeterDetailPage: React.FC = () => {
  const { meterId = '' } = useParams<{ meterId: string }>();
  const reducedMotion = usePrefersReducedMotion();
  const {
    meters,
    alerts,
    getMeterHistory,
    loadMeterHistory,
    acknowledgeAlert,
    closeAlert,
    triggerSimulatedFault,
  } = useTelemetry();

  const [scrubTimestamp, setScrubTimestamp] = useState<string | null>(null);
  const [scrubbedSample, setScrubbedSample] = useState<Reading | null>(null);
  const [selectedTimelineAlertId, setSelectedTimelineAlertId] = useState<number | null>(null);

  const meter = useMemo(() => findMeterById(meters, meterId), [meters, meterId]);

  useEffect(() => {
    if (meter?.id) {
      void loadMeterHistory(meter.id);
    }
  }, [meter?.id, loadMeterHistory]);

  const meterIndex = useMemo(() => {
    if (!meter) return -1;
    return meters.findIndex((m) => m.id === meter.id);
  }, [meter, meters]);

  const feeder = useMemo(
    () => (meterIndex >= 0 ? getFeederForMeterIndex(meterIndex) : null),
    [meterIndex],
  );

  const samples = useMemo(
    () => (meter ? getMeterHistory(meter.id) : []),
    [meter, getMeterHistory],
  );

  const meterAlerts = useMemo(() => {
    if (!meter) return [];
    return alerts
      .filter((a) => a.meter_id.toUpperCase() === meter.id.toUpperCase())
      .sort((a, b) => Date.parse(b.detected_at) - Date.parse(a.detected_at));
  }, [alerts, meter]);

  const openAlerts = useMemo(
    () => meterAlerts.filter((a) => a.status !== 'closed'),
    [meterAlerts],
  );

  const activeAlert: Alert | null = useMemo(() => {
    if (selectedTimelineAlertId !== null) {
      const found = meterAlerts.find((a) => a.id === selectedTimelineAlertId);
      if (found) return found;
    }
    return openAlerts[0] ?? meterAlerts[0] ?? null;
  }, [meterAlerts, openAlerts, selectedTimelineAlertId]);

  // Unknown meter ID: designed industrial "meter not found" state
  if (!meter) {
    return (
      <section
        aria-label="Meter not found"
        className="flex-1 p-6 flex items-center justify-center"
      >
        <div className="max-w-xl w-full border border-[#FF4D2D]/60 bg-[#FFFFFF] dark:bg-[#0C1017] p-6">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-widest text-[#FF4D2D]">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>TELEMETRY LOOKUP FAULT // 404</span>
          </div>

          <h1 className="mt-3 text-xl font-display font-bold tracking-tight text-[#11141C] dark:text-[#E6E9EF]">
            METER NOT FOUND: <span className="font-mono text-[#FF4D2D]">{meterId || 'UNKNOWN'}</span>
          </h1>
          <p className="mt-2 text-sm text-[#576070] dark:text-[#7D899C]">
            The requested smart-meter terminal ID is not registered on this substation collector bus
            or has been decommissioned. Verify the terminal address or return to the Control Room
            single-line schematic.
          </p>

          <div className="mt-4 pt-4 border-t border-[#C8CDD6] dark:border-[#1E2633] flex flex-wrap items-center justify-between gap-3">
            <Link
              to="/"
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-mono font-semibold uppercase tracking-wider border border-[#F59E0B] bg-[#F59E0B]/15 text-[#F59E0B] hover:bg-[#F59E0B]/25 focus:outline-none focus:ring-1 focus:ring-[#F59E0B]"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Back to Control Room
            </Link>

            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-[#7D899C]">ACTIVE NODES:</span>
              {meters.slice(0, 3).map((m) => (
                <Link
                  key={m.id}
                  to={`/meters/${m.id}`}
                  className="px-2 py-1 border border-[#C8CDD6] dark:border-[#1E2633] hover:border-[#F59E0B] text-[#11141C] dark:text-[#E6E9EF]"
                >
                  {m.id}
                </Link>
              ))}
              <Link
                to="/meters/MTR-0109"
                className="px-2 py-1 border border-[#FF4D2D]/60 text-[#FF4D2D] hover:bg-[#FF4D2D]/15"
              >
                MTR-0109
              </Link>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const liveReading = samples[samples.length - 1] ?? meter.latest_reading ?? null;
  const displayedReading =
    scrubTimestamp !== null ? (scrubbedSample ?? liveReading) : liveReading;

  const hasCritical = meter.open_alerts.some((a) => a.severity === 'critical');
  const hasHigh = meter.open_alerts.some((a) => a.severity === 'high');
  const hasAnyOpen = meter.open_alerts.length > 0;

  const statusLabel = hasCritical
    ? `▲ CRITICAL (${formatFaultLabel(meter.open_alerts[0].type)})`
    : hasHigh
      ? `▲ HIGH (${formatFaultLabel(meter.open_alerts[0].type)})`
      : hasAnyOpen
        ? `● WARNING (${formatFaultLabel(meter.open_alerts[0].type)})`
        : '● NOMINAL';

  return (
    <motion.div
      initial={{ opacity: reducedMotion ? 1 : 0.7 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.25 }}
      className="flex-1 flex flex-col divide-y divide-[#C8CDD6] dark:divide-[#1E2633]"
    >
      {/* Meter Detail Header Strip */}
      <header className="px-4 py-2.5 bg-[#FFFFFF] dark:bg-[#0C1017] flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/"
            aria-label="Back to Control Room"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-mono uppercase tracking-wider border border-[#C8CDD6] dark:border-[#1E2633] text-[#576070] dark:text-[#7D899C] hover:border-[#F59E0B] hover:text-[#F59E0B] focus:outline-none focus:ring-1 focus:ring-[#F59E0B]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Control Room
          </Link>

          <div className="h-6 w-[1px] bg-[#C8CDD6] dark:bg-[#1E2633] hidden sm:block" />

          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <motion.h1
                layoutId={`meter-header-${meter.id}`}
                transition={{ duration: reducedMotion ? 0 : 0.32 }}
                className="text-lg font-mono font-bold tracking-tight text-[#11141C] dark:text-[#E6E9EF]"
              >
                {meter.id}
              </motion.h1>
              <motion.span
                layoutId={`meter-status-${meter.id}`}
                transition={{ duration: reducedMotion ? 0 : 0.32 }}
                data-testid="meter-status-pill"
                className={clsx(
                  'px-2 py-0.5 text-[11px] font-mono font-semibold uppercase border inline-flex items-center gap-1.5',
                  hasAnyOpen
                    ? 'border-[#FF4D2D] bg-[#FF4D2D]/15 text-[#FF4D2D]'
                    : 'border-[#F59E0B]/60 bg-[#F59E0B]/15 text-[#F59E0B]',
                )}
              >
                {hasAnyOpen ? (
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                )}
                {statusLabel}
              </motion.span>
            </div>
            <p className="text-xs font-mono text-[#7D899C] mt-0.5">
              {feeder ? `${feeder.name} · ${feeder.substationBus}` : 'SUBSTATION FEEDER'} —{' '}
              {meter.location}
            </p>
          </div>
        </div>

        {/* Right Header Telemetry Meta & Quick Demo Trigger */}
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <div className="px-2.5 py-1 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE] dark:bg-[#07090D] flex items-center gap-2">
            <Radio
              className={clsx(
                'h-3.5 w-3.5',
                scrubTimestamp ? 'text-[#FF4D2D]' : 'text-[#F59E0B]',
              )}
              aria-hidden="true"
            />
            <span className="text-[#7D899C]">BUS LOCK:</span>
            <span className="font-semibold text-[#11141C] dark:text-[#E6E9EF]">
              {scrubTimestamp ? 'PAUSED (SCRUB)' : '1Hz LIVE'}
            </span>
          </div>

          <button
            type="button"
            onClick={() => triggerSimulatedFault(meter.id, 'phase_imbalance')}
            className="px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider border border-[#F59E0B]/50 bg-[#F59E0B]/10 text-[#F59E0B] hover:bg-[#F59E0B]/20 focus:outline-none focus:ring-1 focus:ring-[#F59E0B]"
            title="Simulator control (demo only)"
          >
            SIM: + ØB IMB
          </button>
        </div>
      </header>

      {/* Main Content Workspace */}
      <div className="p-3 space-y-3">
        {/* Top Row: Left column (PhasorDiagram + ReadingsTable), Right column (Incident Root-Cause Diagnostics) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
          {/* Left Column: Phasor Diagram + Readings Table */}
          <div className="lg:col-span-6 xl:col-span-5 space-y-3">
            <PhasorDiagram reading={displayedReading} meterId={meter.id} />
            <ReadingsTable reading={displayedReading} isScrubbing={scrubTimestamp !== null} />
          </div>

          {/* Right Column: Active & Historical Root-Cause Explanations (DeviationBars) */}
          <section
            aria-label="Meter fault attribution and explanation diagnostics"
            className="lg:col-span-6 xl:col-span-7 border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] flex flex-col"
          >
            <div className="px-3.5 py-2 border-b border-[#C8CDD6] dark:border-[#1E2633] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={clsx(
                    'h-2 w-2 inline-block',
                    openAlerts.length > 0 ? 'bg-[#FF4D2D]' : 'bg-[#F59E0B]',
                  )}
                />
                <h2 className="text-[11px] font-mono font-semibold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
                  FAULT ROOT-CAUSE EXPLANATION &amp; FEATURE DEVIATIONS
                </h2>
              </div>
              <span className="text-[10px] font-mono text-[#7D899C]">
                {meterAlerts.length} RECORDED INCIDENTS
              </span>
            </div>

            {activeAlert ? (
              <div className="p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-[#C8CDD6] dark:border-[#1E2633]">
                  <div>
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <span
                        className={clsx(
                          'px-1.5 py-0.5 text-[10px] font-bold uppercase border',
                          activeAlert.severity === 'critical' || activeAlert.severity === 'high'
                            ? 'border-[#FF4D2D] bg-[#FF4D2D]/15 text-[#FF4D2D]'
                            : 'border-[#F59E0B] bg-[#F59E0B]/15 text-[#F59E0B]',
                        )}
                      >
                        {activeAlert.severity}
                      </span>
                      <span className="font-bold text-[#11141C] dark:text-[#E6E9EF]">
                        ALERT #{activeAlert.id} // {formatFaultLabel(activeAlert.type).toUpperCase()}
                      </span>
                      <span className="text-[#7D899C]">
                        SCORE {(activeAlert.score * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-[#7D899C] mt-1">
                      DETECTED: {formatDateTime(activeAlert.detected_at)} · STATUS:{' '}
                      <strong className="text-[#11141C] dark:text-[#E6E9EF]">
                        {activeAlert.status.toUpperCase()}
                      </strong>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 font-mono text-[11px]">
                    {activeAlert.status === 'open' && (
                      <button
                        type="button"
                        onClick={() => void acknowledgeAlert(activeAlert.id)}
                        className="px-2 py-1 border border-[#F59E0B]/60 text-[#F59E0B] hover:bg-[#F59E0B]/15"
                      >
                        ACK INCIDENT
                      </button>
                    )}
                    {activeAlert.status !== 'closed' && (
                      <button
                        type="button"
                        onClick={() => void closeAlert(activeAlert.id)}
                        className="px-2 py-1 border border-[#7D899C]/50 text-[#7D899C] hover:text-[#11141C] dark:hover:text-[#E6E9EF]"
                      >
                        CLOSE
                      </button>
                    )}
                  </div>
                </div>

                {/* Top 3 Contributing Features (Bidirectional DeviationBars) */}
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-wider text-[#7D899C] mb-2">
                    TOP CONTRIBUTING TELEMETRY SIGNATURES (BASELINE CENTERED)
                  </div>
                  <DeviationBars explanations={parseExplanation(activeAlert.explanation)} />
                </div>

                {/* Incident Selector List for this Meter */}
                {meterAlerts.length > 1 && (
                  <div className="pt-2 border-t border-[#C8CDD6] dark:border-[#1E2633]">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-[#7D899C] mb-1.5">
                      METER INCIDENT LOG (CLICK TO INSPECT &amp; SCRUB)
                    </div>
                    <div className="divide-y divide-[#C8CDD6] dark:divide-[#1E2633] border border-[#C8CDD6] dark:border-[#1E2633]">
                      {meterAlerts.slice(0, 5).map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setSelectedTimelineAlertId(item.id);
                            setScrubTimestamp(item.detected_at);
                          }}
                          className={clsx(
                            'w-full px-2.5 py-1.5 text-left flex items-center justify-between text-xs font-mono transition-colors',
                            activeAlert.id === item.id
                              ? 'bg-[#F59E0B]/15 text-[#11141C] dark:text-[#E6E9EF]'
                              : 'hover:bg-[#121822]/30 text-[#576070] dark:text-[#7D899C]',
                          )}
                        >
                          <span>
                            #{item.id} · {formatFaultLabel(item.type)} ({item.severity.toUpperCase()})
                          </span>
                          <span>{formatDateTime(item.detected_at)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-6 text-center font-mono text-xs text-[#7D899C]">
                NO ACTIVE OR HISTORICAL ANOMALIES RECORDED FOR {meter.id} IN LAST 24 HOURS.
              </div>
            )}
          </section>
        </div>

        {/* Full Width Section: 24-Hour AlertTimeline above Full-Width Oscilloscope */}
        <AlertTimeline
          alerts={meterAlerts}
          selectedTimestamp={scrubTimestamp}
          onSelectTimestamp={(isoTs, alert) => {
            setSelectedTimelineAlertId(alert.id);
            setScrubTimestamp(isoTs);
          }}
        />

        <Oscilloscope
          meterId={meter.id}
          samples={samples}
          externalScrubTimestamp={scrubTimestamp}
          onScrubChange={(sample, ts) => {
            setScrubbedSample(sample);
            if (ts !== null) {
              setScrubTimestamp(ts);
            }
          }}
          onReturnToLive={() => {
            setScrubTimestamp(null);
            setScrubbedSample(null);
          }}
        />
      </div>
    </motion.div>
  );
};
