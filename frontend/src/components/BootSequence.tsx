import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { TOKENS } from '../design/tokens';
import { usePrefersReducedMotion } from '../utils/animationQueue';

export const BOOT_SEEN_KEY = 'gridsense_boot_seen';
export const BOOT_DURATION_MS = 1800;

const TARGET_TITLE = 'GRIDSENSE // SUB-HMI 50Hz';
const SCRAMBLE_CHARS = '0123456789ABCDEF/#ΔΦΩ';

function scrambleTitle(progress: number): string {
  const lockedCount = Math.floor(progress * TARGET_TITLE.length);
  return TARGET_TITLE.split('')
    .map((ch, idx) => {
      if (ch === ' ' || idx < lockedCount) return ch;
      const hash = (idx * 7 + Math.floor(progress * 30)) % SCRAMBLE_CHARS.length;
      return SCRAMBLE_CHARS[hash];
    })
    .join('');
}

export const BootSequence: React.FC = () => {
  const reducedMotion = usePrefersReducedMotion();

  const [visible, setVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    if (window.location.search.includes('skipBoot=1')) {
      sessionStorage.setItem(BOOT_SEEN_KEY, '1');
      return false;
    }
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      sessionStorage.setItem(BOOT_SEEN_KEY, '1');
      return false;
    }
    if (sessionStorage.getItem(BOOT_SEEN_KEY) === '1') {
      return false;
    }
    return true;
  });

  const [titleText, setTitleText] = useState<string>(() => scrambleTitle(0));

  useEffect(() => {
    if (reducedMotion && visible) {
      sessionStorage.setItem(BOOT_SEEN_KEY, '1');
      setVisible(false);
    }
  }, [reducedMotion, visible]);

  useEffect(() => {
    if (!visible) return;

    const finish = () => {
      sessionStorage.setItem(BOOT_SEEN_KEY, '1');
      setVisible(false);
    };

    const onKeyDown = () => finish();
    window.addEventListener('keydown', onKeyDown, { once: true });

    const startMs = performance.now();
    let rafId: number | null = null;
    const step = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - startMs) / 1150));
      setTitleText(scrambleTitle(progress));
      if (progress < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        setTitleText(TARGET_TITLE);
      }
    };
    rafId = requestAnimationFrame(step);

    const timer = window.setTimeout(finish, BOOT_DURATION_MS);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.clearTimeout(timer);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      data-testid="hmi-boot-sequence"
      role="region"
      aria-label="Substation HMI power-up sequence"
      onClick={() => {
        sessionStorage.setItem(BOOT_SEEN_KEY, '1');
        setVisible(false);
      }}
      style={{
        backgroundColor: TOKENS.colors.dark.bg,
        color: TOKENS.colors.dark.textPrimary,
      }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6 select-none cursor-pointer"
    >
      {/* Animated Graticule Draw-In */}
      <motion.div
        aria-hidden="true"
        initial={{ scaleX: 0, opacity: 0 }}
        animate={{ scaleX: 1, opacity: 0.35 }}
        transition={{ duration: 0.7, ease: 'easeOut' }}
        style={{ borderColor: TOKENS.colors.dark.border }}
        className="w-full max-w-2xl border-t origin-left mb-6"
      />

      <div className="w-full max-w-2xl border border-[#1E2633] bg-[#0C1017] p-6">
        <div className="text-[11px] font-mono uppercase tracking-widest text-[#7D899C] mb-2">
          BUSBAR TELEMETRY INITIALIZATION // SEQUENCE 1.8S
        </div>

        {/* Resolved Title */}
        <div className="text-xl sm:text-2xl font-mono font-bold tracking-wider text-[#F59E0B] mb-5">
          {titleText}
        </div>

        {/* Three Phase Traces Sweeping In From Left */}
        <svg viewBox="0 0 600 84" className="w-full h-20 block mb-4">
          {(['A', 'B', 'C'] as const).map((phaseKey, idx) => {
            const yBase = 16 + idx * 24;
            const d = Array.from({ length: 48 }, (_, sIdx) => {
              const x = (sIdx / 47) * 600;
              const y = yBase + Math.sin(sIdx * 0.45 + idx * 2.09) * 8;
              return `${sIdx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
            }).join(' ');

            return (
              <motion.path
                key={phaseKey}
                d={d}
                fill="none"
                stroke={TOKENS.colors.phases[phaseKey].color}
                strokeWidth={2}
                style={{ transformOrigin: 'left center' }}
                initial={{ scaleX: 0, opacity: 0.3 }}
                animate={{ scaleX: 1, opacity: 1 }}
                transition={{ duration: 1.0, delay: idx * 0.14, ease: 'easeOut' }}
              />
            );
          })}
        </svg>

        <div className="flex items-center justify-between text-xs font-mono text-[#7D899C] pt-3 border-t border-[#1E2633]">
          <span>SYNCHRONIZING 20 TERMINAL NODES @ 1Hz</span>
          <span
            data-testid="boot-skip-hint"
            className="text-[#F59E0B] uppercase tracking-wider font-semibold"
          >
            Press any key to skip
          </span>
        </div>
      </div>

      <motion.div
        aria-hidden="true"
        initial={{ scaleX: 0, opacity: 0 }}
        animate={{ scaleX: 1, opacity: 0.35 }}
        transition={{ duration: 0.7, ease: 'easeOut' }}
        style={{ borderColor: TOKENS.colors.dark.border }}
        className="w-full max-w-2xl border-b origin-right mt-6"
      />
    </div>
  );
};
