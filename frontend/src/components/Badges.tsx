import React from 'react';
import clsx from 'clsx';
import type { Role } from '../types';

export type SeverityIconKind = 'diamond' | 'triangle' | 'circle' | 'hollow-circle';

function getSeverityMeta(severity: string): {
  icon: string;
  iconKind: SeverityIconKind;
  className: string;
} {
  const s = severity.toLowerCase();
  if (s === 'critical') {
    return {
      icon: '◆',
      iconKind: 'diamond',
      className: 'border-[#FF4D2D]/60 text-[#FF4D2D] bg-[#FF4D2D]/15',
    };
  }
  if (s === 'high') {
    return {
      icon: '▲',
      iconKind: 'triangle',
      className: 'border-[#FF4D2D]/40 text-[#FF4D2D] bg-[#FF4D2D]/10',
    };
  }
  if (s === 'medium') {
    return {
      icon: '●',
      iconKind: 'circle',
      className: 'border-[#F59E0B]/60 text-[#F59E0B] bg-[#F59E0B]/15',
    };
  }
  return {
    icon: '○',
    iconKind: 'hollow-circle',
    className:
      'border-[#7D899C]/50 text-[#576070] dark:text-[#7D899C] bg-[#7D899C]/10',
  };
}

export const SeverityBadge: React.FC<{ severity: string }> = ({ severity }) => {
  const meta = getSeverityMeta(severity);
  return (
    <span
      data-severity-icon={meta.iconKind}
      className={clsx(
        'inline-flex items-center gap-1.5 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider border whitespace-nowrap',
        meta.className,
      )}
    >
      <span aria-hidden="true" className="leading-none">
        {meta.icon}
      </span>
      <span>{severity}</span>
    </span>
  );
};

export const StatusBadge: React.FC<{ status: 'open' | 'acknowledged' | 'closed' }> = ({ status }) => (
  <span
    className={clsx(
      'inline-flex items-center px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider border whitespace-nowrap',
      status === 'open' && 'border-[#FF4D2D]/50 text-[#FF4D2D] bg-[#FF4D2D]/10',
      status === 'acknowledged' &&
        'border-[#F59E0B]/50 text-[#F59E0B] bg-[#F59E0B]/10',
      status === 'closed' &&
        'border-[#7D899C]/40 text-[#576070] dark:text-[#7D899C] bg-[#7D899C]/10',
    )}
  >
    {status}
  </span>
);

export const RoleBadge: React.FC<{ role: Role }> = ({ role }) => (
  <span
    className={clsx(
      'inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono font-semibold uppercase tracking-wider border whitespace-nowrap',
      role === 'admin' && 'border-[#00E5FF]/50 text-[#00E5FF] bg-[#00E5FF]/10',
      role === 'operator' && 'border-[#F59E0B]/50 text-[#F59E0B] bg-[#F59E0B]/10',
      role === 'viewer' &&
        'border-[#7D899C]/50 text-[#576070] dark:text-[#7D899C] bg-[#7D899C]/10',
    )}
  >
    {role}
  </span>
);
