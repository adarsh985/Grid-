import React, { useMemo } from 'react';
import { LiveValue } from './LiveValue';
import { TOKENS } from '../design/tokens';
import type { Reading } from '../types';

export interface ReadingsTableProps {
  reading: Reading | null;
  isScrubbing?: boolean;
}

export const ReadingsTable: React.FC<ReadingsTableProps> = ({
  reading,
  isScrubbing = false,
}) => {
  const rows = useMemo(() => {
    const va = reading?.voltage_a ?? TOKENS.limits.nominalVoltage;
    const vb = reading?.voltage_b ?? TOKENS.limits.nominalVoltage;
    const vc = reading?.voltage_c ?? TOKENS.limits.nominalVoltage;
    const ia = reading?.current_a ?? 0;
    const ib = reading?.current_b ?? 0;
    const ic = reading?.current_c ?? 0;
    const pf = reading?.power_factor ?? TOKENS.limits.nominalPowerFactor;

    const iMean = (ia + ib + ic) / 3;
    const devPct = (iVal: number) => (iMean > 0 ? ((iVal - iMean) / iMean) * 100 : 0);

    return [
      {
        key: 'A' as const,
        label: TOKENS.colors.phases.A.short,
        color: TOKENS.colors.phases.A.color,
        voltage: va,
        current: ia,
        kw: (va * ia * pf) / 1000,
        imbPct: devPct(ia),
      },
      {
        key: 'B' as const,
        label: TOKENS.colors.phases.B.short,
        color: TOKENS.colors.phases.B.color,
        voltage: vb,
        current: ib,
        kw: (vb * ib * pf) / 1000,
        imbPct: devPct(ib),
      },
      {
        key: 'C' as const,
        label: TOKENS.colors.phases.C.short,
        color: TOKENS.colors.phases.C.color,
        voltage: vc,
        current: ic,
        kw: (vc * ic * pf) / 1000,
        imbPct: devPct(ic),
      },
    ];
  }, [reading]);

  const pf = reading?.power_factor ?? TOKENS.limits.nominalPowerFactor;
  const frequency = reading?.frequency ?? TOKENS.limits.nominalFrequency;
  const activeEnergyKwh = reading?.active_energy_kwh ?? 0;
  const totalKw = rows.reduce((sum, r) => sum + r.kw, 0);

  return (
    <section
      aria-label="Three-phase telemetry readings table"
      className="border border-[#C8CDD6] dark:border-[#1E2633] bg-[#FFFFFF] dark:bg-[#0C1017] flex flex-col"
    >
      {/* Header */}
      <div className="px-3.5 py-2 border-b border-[#C8CDD6] dark:border-[#1E2633] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2 w-2 bg-[#F59E0B] inline-block"
          />
          <h2 className="text-[11px] font-mono font-semibold uppercase tracking-wider text-[#11141C] dark:text-[#E6E9EF]">
            PHASE TELEMETRY MATRIX
          </h2>
        </div>
        <span className="text-[10px] font-mono uppercase text-[#7D899C]">
          {isScrubbing ? 'SCRUB CURSOR LOCKED' : '1Hz LIVE STREAM'}
        </span>
      </div>

      {/* Per-Phase Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] sm:text-xs font-mono tabular-nums text-left border-collapse">
          <thead>
            <tr className="border-b border-[#C8CDD6] dark:border-[#1E2633] bg-[#E7E9E2]/60 dark:bg-[#121822]/70 text-[10px] uppercase tracking-wider text-[#7D899C]">
              <th scope="col" className="px-2 py-1.5 sm:px-3 sm:py-2">
                PHASE
              </th>
              <th scope="col" className="px-2 py-1.5 sm:px-3 sm:py-2 text-right">
                VOLTAGE
              </th>
              <th scope="col" className="px-2 py-1.5 sm:px-3 sm:py-2 text-right">
                CURRENT
              </th>
              <th scope="col" className="px-2 py-1.5 sm:px-3 sm:py-2 text-right">
                LOAD
              </th>
              <th scope="col" className="px-2 py-1.5 sm:px-3 sm:py-2 text-right">
                Δ IMB
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#C8CDD6] dark:divide-[#1E2633]">
            {rows.map((row) => {
              const vOutOfBounds =
                row.voltage < TOKENS.limits.voltageMin ||
                row.voltage > TOKENS.limits.voltageMax;
              const highImb = Math.abs(row.imbPct) >= 10;

              return (
                <tr key={row.key} className="hover:bg-[#121822]/25">
                  <th scope="row" className="px-2 py-2 sm:px-3 font-bold whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 inline-block shrink-0"
                        style={{ backgroundColor: row.color }}
                      />
                      <span style={{ color: row.color }}>{row.label}</span>
                    </span>
                  </th>

                  <td className="px-2 py-2 sm:px-3 text-right">
                    <LiveValue
                      value={row.voltage}
                      decimals={2}
                      unit="V"
                      flashOnChange
                      className={
                        vOutOfBounds
                          ? 'font-bold text-[#FF4D2D] px-0.5 sm:px-1'
                          : 'font-semibold text-[#11141C] dark:text-[#E6E9EF] px-0.5 sm:px-1'
                      }
                    />
                  </td>

                  <td className="px-2 py-2 sm:px-3 text-right">
                    <LiveValue
                      value={row.current}
                      decimals={2}
                      unit="A"
                      flashOnChange
                      className="font-semibold text-[#11141C] dark:text-[#E6E9EF] px-0.5 sm:px-1"
                    />
                  </td>

                  <td className="px-2 py-2 sm:px-3 text-right">
                    <LiveValue
                      value={row.kw}
                      decimals={2}
                      unit="kW"
                      flashOnChange
                      className="text-[#7D899C] px-0.5 sm:px-1"
                    />
                  </td>

                  <td className="px-2 py-2 sm:px-3 text-right">
                    <LiveValue
                      value={row.imbPct}
                      decimals={1}
                      prefix={row.imbPct >= 0 ? '+' : ''}
                      unit="%"
                      flashOnChange
                      className={
                        highImb
                          ? 'font-bold text-[#FF4D2D] px-0.5 sm:px-1'
                          : 'text-[#7D899C] px-0.5 sm:px-1'
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Aggregate Scalar Row: Power Factor, Frequency, Active Energy, Total Load */}
      <div className="grid grid-cols-2 border-t border-[#C8CDD6] dark:border-[#1E2633] divide-x divide-y divide-[#C8CDD6] dark:divide-[#1E2633] font-mono">
        <div className="p-2.5 flex flex-col justify-between">
          <span className="text-[10px] uppercase tracking-wider text-[#7D899C]">
            POWER FACTOR (cos φ)
          </span>
          <div className="mt-1 flex items-baseline justify-between">
            <LiveValue
              value={pf}
              decimals={3}
              flashOnChange
              className={
                pf < 0.85
                  ? 'text-base font-bold text-[#FF4D2D] px-1'
                  : 'text-base font-bold text-[#F59E0B] px-1'
              }
            />
            <span className="text-[10px] text-[#7D899C]">NOM 0.950</span>
          </div>
        </div>

        <div className="p-2.5 flex flex-col justify-between">
          <span className="text-[10px] uppercase tracking-wider text-[#7D899C]">
            GRID FREQUENCY
          </span>
          <div className="mt-1 flex items-baseline justify-between">
            <LiveValue
              value={frequency}
              decimals={3}
              unit="Hz"
              flashOnChange
              className="text-base font-bold text-[#F59E0B] px-1"
            />
            <span className="text-[10px] text-[#7D899C]">50.000 Hz</span>
          </div>
        </div>

        <div className="p-2.5 flex flex-col justify-between">
          <span className="text-[10px] uppercase tracking-wider text-[#7D899C]">
            ACTIVE ENERGY REGISTER
          </span>
          <div className="mt-1 flex items-baseline justify-between">
            <LiveValue
              value={activeEnergyKwh}
              decimals={2}
              unit="kWh"
              flashOnChange
              className="text-base font-bold text-[#11141C] dark:text-[#E6E9EF] px-1"
            />
            <span className="text-[10px] text-[#7D899C]">∑ IMPORT</span>
          </div>
        </div>

        <div className="p-2.5 flex flex-col justify-between">
          <span className="text-[10px] uppercase tracking-wider text-[#7D899C]">
            3Ø ACTIVE DEMAND
          </span>
          <div className="mt-1 flex items-baseline justify-between">
            <LiveValue
              value={totalKw}
              decimals={2}
              unit="kW"
              flashOnChange
              className="text-base font-bold text-[#11141C] dark:text-[#E6E9EF] px-1"
            />
            <span className="text-[10px] text-[#7D899C]">REAL P</span>
          </div>
        </div>
      </div>
    </section>
  );
};
