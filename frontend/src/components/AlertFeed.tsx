import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { DeviationBars } from './DeviationBars';
import { useAuth } from '../context/AuthContext';
import { useTelemetry } from '../context/TelemetryContext';
import { TOKENS } from '../design/tokens';
import { usePrefersReducedMotion } from '../utils/animationQueue';
import { formatFaultLabel, formatTimeShort, parseExplanation } from '../utils/format';

export const AlertFeed: React.FC = () => {
  const { canMutate } = useAuth();
  const reducedMotion = usePrefersReducedMotion();
  const {
    alerts,
    selectedAlertId,
    setSelectedAlertId,
    recentHighlightAlertIds,
    acknowledgeAlert,
    closeAlert,
  } = useTelemetry();

  const [expandedId, setExpandedId] = useState<number | null>(alerts[0]?.id ?? null);

  return (
    <aside
      aria-label="Live alert feed"
      className="flex flex-col h-full bg-[#FFFFFF] dark:bg-[#0C1017] border-t lg:border-t-0 lg:border-l border-[#C8CDD6] dark:border-[#1E2633]"
    >
      {/* Feed Header */}
      <div className="px-3.5 py-2 border-b border-[#C8CDD6] dark:border-[#1E2633] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={clsx('h-2 w-2 bg-[#FF4D2D]', !reducedMotion && 'animate-pulse')}
            aria-hidden="true"
          />
          <h2 className="text-[11px] font-mono font-semibold uppercase tracking-wider">
            ALARM &amp; THEFT TELEMETRY FEED
          </h2>
        </div>
        <Link
          to="/alerts"
          className="text-[11px] font-mono text-[#F59E0B] hover:underline uppercase"
        >
          OPEN CONSOLE →
        </Link>
      </div>

      {/* Scrollable Alert Stream */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#C8CDD6] dark:divide-[#1E2633] max-h-[540px]">
        <AnimatePresence initial={false}>
          {alerts.map((alert) => {
            const isExpanded = expandedId === alert.id;
            const isSelected = selectedAlertId === alert.id;
            const explanations = parseExplanation(alert.explanation);
            const isOpen = alert.status === 'open';
            const isClosed = alert.status === 'closed';
            const hasFreshHighlight = Boolean(recentHighlightAlertIds[alert.id]) && isOpen;

            return (
              <motion.article
                key={alert.id}
                initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.2 }}
                onClick={() => setSelectedAlertId(alert.id)}
                className={clsx(
                  'relative p-3 transition-colors cursor-pointer border-l-2 overflow-hidden',
                  isOpen
                    ? 'border-l-[#FF4D2D]'
                    : alert.status === 'acknowledged'
                      ? 'border-l-[#F59E0B]'
                      : 'border-l-[#7D899C]/40 opacity-70',
                  isSelected && 'bg-[#F59E0B]/[0.06]',
                )}
              >
                {/* 1.5s Red Left-Edge Highlight Bar for newly arrived open alerts */}
                {hasFreshHighlight && (
                  <motion.div
                    data-testid={`alert-highlight-${alert.id}`}
                    aria-hidden="true"
                    initial={{ opacity: reducedMotion ? 0.25 : 0.4 }}
                    animate={{ opacity: 0 }}
                    transition={{ duration: 1.5, ease: 'easeOut' }}
                    style={{
                      background: `linear-gradient(90deg, ${TOKENS.colors.alert} 0%, transparent 100%)`,
                    }}
                    className="pointer-events-none absolute inset-y-0 left-0 w-16"
                  />
                )}

                <div className="relative flex items-start justify-between gap-2 font-mono text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={clsx(
                        'px-1.5 py-0.5 text-[10px] font-bold uppercase border shrink-0',
                        alert.severity === 'critical' || alert.severity === 'high'
                          ? 'border-[#FF4D2D]/60 text-[#FF4D2D] bg-[#FF4D2D]/15'
                          : 'border-[#F59E0B]/60 text-[#F59E0B] bg-[#F59E0B]/15',
                      )}
                    >
                      {alert.severity === 'critical' ? '▲ CRIT' : '◆ ' + alert.severity.toUpperCase()}
                    </span>
                    <Link
                      to={`/meters/${encodeURIComponent(alert.meter_id)}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-bold text-[#F59E0B] hover:underline"
                    >
                      {alert.meter_id}
                    </Link>
                    <span className="font-sans font-semibold truncate">
                      {formatFaultLabel(alert.type)}
                    </span>
                  </div>

                  <span className="text-[11px] text-[#7D899C] tabular-nums shrink-0">
                    {formatTimeShort(alert.detected_at)}
                  </span>
                </div>

                {/* Summary explanation snippet */}
                <p className="relative mt-1.5 text-xs text-[#576070] dark:text-[#7D899C] line-clamp-2">
                  {explanations[0]?.description ?? 'Anomaly threshold crossed'}
                </p>

                {/* Controls Row */}
                <div className="relative mt-2.5 flex items-center justify-between gap-2 text-[11px] font-mono">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedId(isExpanded ? null : alert.id);
                      }}
                      className="text-[#F59E0B] hover:underline uppercase"
                    >
                      {isExpanded ? '[- HIDE VECTORS]' : '[+ DEVIATION VECTORS]'}
                    </button>
                    <span className="text-[#7D899C]">
                      SCORE {alert.score.toFixed(2)}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {canMutate && !isClosed && (
                      <>
                        {isOpen && (
                          <button
                            type="button"
                            onClick={() => void acknowledgeAlert(alert.id)}
                            className="px-2 py-0.5 border border-[#F59E0B]/50 text-[#F59E0B] hover:bg-[#F59E0B]/15 uppercase"
                          >
                            ACK
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void closeAlert(alert.id)}
                          className="px-2 py-0.5 border border-[#7D899C]/50 text-[#7D899C] hover:text-[#E6E9EF] uppercase"
                        >
                          CLOSE
                        </button>
                      </>
                    )}
                    {!canMutate && (
                      <span className="text-[10px] text-[#7D899C] uppercase">
                        [{alert.status}]
                      </span>
                    )}
                  </div>
                </div>

                {/* Expanded Top-3 Bidirectional Deviation Bars */}
                {isExpanded && (
                  <div
                    className="relative mt-3 pt-2.5 border-t border-[#C8CDD6] dark:border-[#1E2633]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DeviationBars explanations={explanations} />
                  </div>
                )}
              </motion.article>
            );
          })}
        </AnimatePresence>
      </div>
    </aside>
  );
};
