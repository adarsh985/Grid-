import React from 'react';
import { TOKENS } from '../design/tokens';
import type { ExplanationItem } from '../types';

export interface DeviationBarsProps {
  explanations: ExplanationItem[];
  maxScalePct?: number;
}

export const DeviationBars: React.FC<DeviationBarsProps> = ({
  explanations,
  maxScalePct = 100,
}) => {
  const topThree = explanations.slice(0, 3);

  if (topThree.length === 0) {
    return (
      <div className="text-xs font-mono text-[#7D899C] py-2">
        NO FEATURE DEVIATION VECTOR RECORDED
      </div>
    );
  }

  return (
    <div
      role="list"
      aria-label="Top contributing feature deviations from baseline"
      className="space-y-2.5"
    >
      {topThree.map((item, idx) => {
        const pct = Number(item.deviation_pct || 0);
        const clampedAbs = Math.min(Math.abs(pct), maxScalePct);
        // Each half of the bidirectional track is 50% width
        const halfWidthPct = (clampedAbs / maxScalePct) * 50;
        const isNegative = pct < 0;
        const signStr = pct > 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
        const barColor =
          Math.abs(pct) >= 25 ? TOKENS.colors.alert : TOKENS.colors.signal;

        return (
          <div
            key={`${item.feature}-${idx}`}
            role="listitem"
            aria-label={`${item.feature}: ${signStr} deviation. ${item.description}`}
            className="border border-[#C8CDD6] dark:border-[#1E2633] bg-[#F2F3EE]/80 dark:bg-[#07090D] p-2.5"
          >
            <div className="flex items-center justify-between gap-3 text-xs font-mono mb-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-[#1E2633]/10 dark:bg-[#1E2633] text-[#11141C] dark:text-[#E6E9EF]">
                  #{idx + 1} · {item.feature}
                </span>
                <span className="text-[11px] text-[#7D899C] truncate">
                  Z={Number(item.z_score || 0).toFixed(2)}σ
                </span>
              </div>
              <span
                data-testid={`deviation-pct-${idx}`}
                className="font-bold tabular-nums shrink-0"
                style={{ color: barColor }}
              >
                {signStr}
              </span>
            </div>

            {/* Bidirectional Center-Zero Deviation Bar */}
            <div className="relative h-2.5 w-full bg-[#E7E9E2] dark:bg-[#121822] border border-[#C8CDD6] dark:border-[#1E2633] overflow-hidden">
              {/* Quarter-scale ticks */}
              <div className="absolute inset-y-0 left-1/4 w-px bg-[#7D899C]/25" />
              <div className="absolute inset-y-0 left-3/4 w-px bg-[#7D899C]/25" />
              {/* Center 0% Baseline Marker */}
              <div
                aria-hidden="true"
                className="absolute inset-y-0 left-1/2 w-[1.5px] -translate-x-1/2 bg-[#11141C] dark:bg-[#E6E9EF] z-10"
              />

              {/* Deviation Fill extending Left (<0%) or Right (>0%) from 50% center */}
              <div
                data-testid={`deviation-bar-${idx}`}
                data-direction={isNegative ? 'left' : 'right'}
                style={{
                  width: `${halfWidthPct}%`,
                  left: isNegative ? `${50 - halfWidthPct}%` : '50%',
                  backgroundColor: barColor,
                }}
                className="absolute inset-y-0 transition-all duration-200"
              />
            </div>

            <div className="mt-1.5 flex items-center justify-between text-[10px] font-mono text-[#7D899C]">
              <span>-{maxScalePct}% DROP</span>
              <span>0% BASELINE</span>
              <span>+{maxScalePct}% SURGE</span>
            </div>

            <p className="mt-1.5 text-xs text-[#11141C] dark:text-[#E6E9EF] leading-snug">
              {item.description}
            </p>
          </div>
        );
      })}
    </div>
  );
};
