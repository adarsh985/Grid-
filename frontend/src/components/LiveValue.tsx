import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

export interface LiveValueProps {
  value: number;
  decimals?: number;
  unit?: string;
  prefix?: string;
  className?: string;
  unitClassName?: string;
  flashOnChange?: boolean;
  durationMs?: number;
  ariaLabel?: string;
}

export const LiveValue: React.FC<LiveValueProps> = ({
  value,
  decimals = 1,
  unit,
  prefix = '',
  className,
  unitClassName,
  flashOnChange = false,
  durationMs = 240,
  ariaLabel,
}) => {
  const [displayValue, setDisplayValue] = useState<number>(value);
  const [flashing, setFlashing] = useState(false);
  const prevValueRef = useRef<number>(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const startVal = prevValueRef.current;
    if (Math.abs(value - startVal) < 1e-6) {
      setDisplayValue(value);
      return;
    }

    prevValueRef.current = value;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const isHidden = typeof document !== 'undefined' && document.hidden;

    if (flashOnChange && !prefersReducedMotion && !isHidden) {
      setFlashing(true);
      const t = window.setTimeout(() => setFlashing(false), 450);
      if (durationMs <= 0) {
        setDisplayValue(value);
        return () => window.clearTimeout(t);
      }
    }

    if (
      prefersReducedMotion ||
      isHidden ||
      durationMs <= 0 ||
      typeof window.requestAnimationFrame !== 'function'
    ) {
      setDisplayValue(value);
      return;
    }

    let startTime: number | null = null;
    const step = (now: number) => {
      if (typeof document !== 'undefined' && document.hidden) {
        setDisplayValue(value);
        return;
      }
      if (startTime === null) startTime = now;
      const elapsed = Math.max(0, now - startTime);
      const progress = Math.min(1, Math.max(0, elapsed / durationMs));
      // Cubic ease-out
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(startVal + (value - startVal) * eased);
      if (progress < 1) {
        rafRef.current = window.requestAnimationFrame(step);
      } else {
        setDisplayValue(value);
      }
    };

    rafRef.current = window.requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, [value, durationMs, flashOnChange]);

  const formatted = `${prefix}${displayValue.toFixed(decimals)}`;
  const targetFormatted = `${prefix}${value.toFixed(decimals)}${unit ? ` ${unit}` : ''}`;

  return (
    <span
      aria-label={ariaLabel ?? targetFormatted}
      data-testid="live-value"
      data-target-value={value.toFixed(decimals)}
      className={clsx(
        'font-mono tabular-nums inline-flex items-baseline gap-1 rounded-sm px-0.5 transition-colors',
        flashing && 'animate-value-flash',
        className,
      )}
    >
      <span>{formatted}</span>
      {unit && (
        <span className={clsx('text-[11px] font-normal text-[#7D899C]', unitClassName)}>
          {unit}
        </span>
      )}
    </span>
  );
};
