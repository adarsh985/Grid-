import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { getAuthToken, setAuthToken } from '../api';
import { BOOT_SEEN_KEY } from '../components/BootSequence';
import { DeviationBars } from '../components/DeviationBars';
import { LiveValue } from '../components/LiveValue';
import {
  getSampleAtScrubRatio,
  mapScrubRatioToSampleIndex,
  mapTimestampToScrubRatio,
} from '../components/Oscilloscope';
import {
  buildPhasorTrailAngles,
  MAX_PHASOR_TRAIL_LENGTH,
  PhasorDiagram,
} from '../components/PhasorDiagram';
import {
  appendToRingBuffer,
  MAX_RING_BUFFER_SAMPLES,
  useTelemetry,
} from '../context/TelemetryContext';
import {
  classifyPsi,
  formatPsiAriaText,
  psiToMeterPercent,
} from '../analytics/driftStatus';
import { buildInitialMockMeters } from '../mock/mockData';
import type { Alert, ModelInfo, Reading } from '../types';
import {
  computeFeederParticles,
  MAX_CONCURRENT_ONESHOTS,
  MAX_PARTICLES,
  OneShotAnimationQueue,
} from '../utils/animationQueue';

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

function renderConsole(
  route = '/',
  initialAlerts?: Alert[],
  options: { offlineDemo?: boolean } = { offlineDemo: true },
) {
  return render(
    <AppProviders
      initialAlerts={initialAlerts}
      initialOfflineDemo={options.offlineDemo ?? true}
    >
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
}

function makeSample(index: number, baseMs: number): Reading {
  return {
    meter_id: 'MTR-0109',
    ts: new Date(baseMs + index * 1000).toISOString(),
    voltage_a: 230 + (index % 3),
    voltage_b: 219.4,
    voltage_c: 230.2,
    current_a: 15.0,
    current_b: 20.0 + index * 0.01,
    current_c: 15.1,
    power_factor: 0.95,
    frequency: 50.0,
    active_energy_kwh: 1000 + index * 0.1,
  };
}

const HistoryProbe: React.FC<{ meterId: string }> = ({ meterId }) => {
  const { getMeterHistory, meters } = useTelemetry();
  const history = getMeterHistory(meterId);
  const meter = meters.find((m) => m.id === meterId);
  return (
    <div>
      <span data-testid="probe-count">{history.length}</span>
      <span data-testid="probe-latest-ts">{meter?.last_seen ?? ''}</span>
    </div>
  );
};

const defaultMatchMedia = window.matchMedia;

function setReducedMotionMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? matches : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe('GridSense HMI Step 1 & Step 2: Control Room & Meter Detail', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.setItem(BOOT_SEEN_KEY, '1');
    document.documentElement.classList.add('dark');
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: defaultMatchMedia,
    });
  });

  afterEach(() => {
    setAuthToken(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
    sessionStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: defaultMatchMedia,
    });
  });

  it('LiveValue renders tabular formatted numbers, units, and updates target value', () => {
    const { rerender } = render(
      <LiveValue value={230.42} decimals={1} unit="V" durationMs={0} flashOnChange />,
    );
    const el = screen.getByTestId('live-value');
    expect(el).toHaveAttribute('data-target-value', '230.4');
    expect(el).toHaveTextContent('230.4');
    expect(el).toHaveTextContent('V');

    rerender(<LiveValue value={196.4} decimals={1} unit="V" durationMs={0} flashOnChange />);
    expect(screen.getByTestId('live-value')).toHaveAttribute('data-target-value', '196.4');
    expect(screen.getByTestId('live-value')).toHaveTextContent('196.4');
  });

  it('DeviationBars renders bidirectional bars extending left (<0%) and right (>0%) from 0% baseline', () => {
    render(
      <DeviationBars
        explanations={[
          {
            feature: 'load_vs_profile',
            deviation_pct: -48.2,
            z_score: 4.45,
            description: "Three-phase load is 48% below this meter's time-of-day profile",
          },
          {
            feature: 'current_b',
            deviation_pct: 34.4,
            z_score: 3.85,
            description: 'Phase B current (24.6 A) is 34% above its 60-minute baseline',
          },
        ]}
      />,
    );

    const leftBar = screen.getByTestId('deviation-bar-0');
    const rightBar = screen.getByTestId('deviation-bar-1');

    expect(leftBar).toHaveAttribute('data-direction', 'left');
    expect(rightBar).toHaveAttribute('data-direction', 'right');
    expect(screen.getByTestId('deviation-pct-0')).toHaveTextContent('-48.2%');
    expect(screen.getByTestId('deviation-pct-1')).toHaveTextContent('+34.4%');
    expect(screen.getByText(/48% below this meter's time-of-day profile/i)).toBeInTheDocument();
  });

  it('CommandPalette opens with Cmd/Ctrl+K under fake timers, filters meters, and navigates on Enter', () => {
    vi.useFakeTimers();
    renderConsole('/');

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: /command palette/i })).toBeInTheDocument();

    const searchInput = screen.getByLabelText(/search commands, meters, or alerts/i);
    expect(searchInput).toHaveFocus();

    fireEvent.change(searchInput, { target: { value: 'MTR-0109' } });
    const option = screen.getByRole('option', { name: /inspect meter mtr-0109/i });
    expect(option).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('dialog', { name: /command palette/i }), {
      key: 'Enter',
    });

    expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /MTR-0109/i })).toBeInTheDocument();
  });

  it('Control Room renders single-line schematic GridMap, labeled Simulator Controls, and live AlertFeed', () => {
    vi.useFakeTimers();
    renderConsole('/');

    expect(
      screen.getByRole('region', { name: /substation single-line schematic diagram/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/alarm & theft telemetry feed/i)).toBeInTheDocument();
    expect(screen.getByText(/simulator controls/i)).toBeInTheDocument();
    expect(screen.getByText(/demo only/i)).toBeInTheDocument();

    expect(screen.getByLabelText(/open alerts: 5/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /sim: \+ inject theft/i }));
    expect(screen.getByLabelText(/open alerts: 6/i)).toBeInTheDocument();
  });

  it('Light theme toggle removes dark class and persists preference in localStorage', () => {
    vi.useFakeTimers();
    renderConsole('/');

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    const themeToggle = screen.getByRole('button', { name: /toggle dark mode/i });

    fireEvent.click(themeToggle);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('gridsense_theme')).toBe('light');

    fireEvent.click(themeToggle);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('gridsense_theme')).toBe('dark');
  });

  it('Telemetry 1Hz mock generator advances under fake timers and ring buffer caps at 900 samples', () => {
    vi.useFakeTimers();
    const baseMs = Date.UTC(2026, 10, 14, 12, 0, 0);
    vi.setSystemTime(baseMs);

    // 1. Unit check on appendToRingBuffer strict 900-sample cap within 15-minute window
    let buffer: Reading[] = [];
    for (let i = 0; i < 950; i += 1) {
      buffer = appendToRingBuffer(buffer, makeSample(i, baseMs), MAX_RING_BUFFER_SAMPLES);
    }
    expect(buffer).toHaveLength(900);
    expect(buffer[0].ts).toBe(new Date(baseMs + 50 * 1000).toISOString());
    expect(buffer[buffer.length - 1].ts).toBe(new Date(baseMs + 949 * 1000).toISOString());

    // 2. Unit check on sweep/scrub mapping helpers
    expect(mapScrubRatioToSampleIndex(900, 0)).toBe(0);
    expect(mapScrubRatioToSampleIndex(900, 0.5)).toBe(450);
    expect(mapScrubRatioToSampleIndex(900, 1)).toBe(899);
    const midSample = getSampleAtScrubRatio(buffer, 0.5);
    expect(midSample?.ts).toBe(buffer[450].ts);
    const ratioForTs = mapTimestampToScrubRatio(buffer, buffer[225].ts!);
    expect(Math.round(ratioForTs * 899)).toBe(225);

    // 3. Integration check of 1 Hz interval pushing readings into TelemetryContext ring buffer
    render(
      <AppProviders>
        <HistoryProbe meterId="MTR-0109" />
      </AppProviders>,
    );
    const initialCount = Number(screen.getByTestId('probe-count').textContent);
    const initialTs = screen.getByTestId('probe-latest-ts').textContent;

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(Number(screen.getByTestId('probe-count').textContent)).toBe(initialCount + 3);
    expect(screen.getByTestId('probe-latest-ts').textContent).not.toBe(initialTs);
  });

  it('MeterDetailPage shows a designed not-found state for unknown meter IDs', () => {
    renderConsole('/meters/MTR-9999');

    expect(screen.getByRole('region', { name: /meter not found/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /meter not found: mtr-9999/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to control room/i })).toHaveAttribute('href', '/');
  });

  it('MeterDetailPage toggles phases via aria-pressed and clicking an alert tick sets oscilloscope scrub position', () => {
    vi.useFakeTimers();
    renderConsole('/meters/MTR-0109');

    // Header, feeder metadata, status pill, and Phase B imbalance visibility
    expect(screen.getByRole('heading', { name: 'MTR-0109' })).toBeInTheDocument();
    expect(screen.getByTestId('meter-status-pill')).toHaveTextContent(/high.*phase imbalance/i);
    expect(screen.getByText(/feeder 02 \/\/ central commercial 11kv/i)).toBeInTheDocument();

    // PhasorDiagram ARIA label & 3-phase vector summaries
    const phasorImg = screen.getByRole('img', {
      name: /three-phase voltage and current phasor diagram for mtr-0109/i,
    });
    expect(phasorImg).toBeInTheDocument();

    // ReadingsTable and Oscilloscope canvas + sr-only 10-sample table
    expect(
      screen.getByRole('region', { name: /three-phase telemetry readings table/i }),
    ).toBeInTheDocument();
    const oscCanvas = screen.getByRole('img', {
      name: /three-phase oscilloscope for mtr-0109/i,
    });
    expect(oscCanvas).toBeInTheDocument();
    expect(
      screen.getByText(/last 10 three-phase oscilloscope samples for mtr-0109/i),
    ).toBeInTheDocument();

    // AlertTimeline 3-hour ticks present (-24h, -12h, NOW)
    expect(screen.getByTestId('timeline-hour-24')).toHaveTextContent('-24h');
    expect(screen.getByTestId('timeline-hour-12')).toHaveTextContent('-12h');
    expect(screen.getByTestId('timeline-hour-0')).toHaveTextContent('NOW');

    // Phase toggle hides Phase B trace and updates aria-pressed & canvas ARIA summary
    const phaseGroup = screen.getByRole('group', { name: /toggle oscilloscope phase traces/i });
    const phaseBToggle = within(phaseGroup).getByRole('button', { name: /^phase b$/i });
    expect(phaseBToggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('osc-readout')).toHaveTextContent(/ØB:/i);

    fireEvent.click(phaseBToggle);
    expect(phaseBToggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('osc-readout')).not.toHaveTextContent(/ØB:/i);
    expect(
      screen.getByRole('img', {
        name: /three-phase oscilloscope for mtr-0109.*visible phases: a, c/i,
      }),
    ).toBeInTheDocument();

    // Clicking an alert tick on AlertTimeline locks scrub cursor & shows "Return to live"
    expect(screen.getByTestId('osc-mode-badge')).toHaveTextContent(/live sweep/i);
    const alertTick = screen.getByTestId('alert-tick-9040');
    fireEvent.click(alertTick);

    expect(screen.getByTestId('osc-mode-badge')).toHaveTextContent(/paused @/i);
    const returnLiveBtn = screen.getByRole('button', { name: /return to live/i });
    expect(returnLiveBtn).toBeInTheDocument();

    // Clicking Return to live resumes live mode
    fireEvent.click(returnLiveBtn);
    expect(screen.getByTestId('osc-mode-badge')).toHaveTextContent(/live sweep/i);
    expect(screen.queryByRole('button', { name: /return to live/i })).not.toBeInTheDocument();
  });

  it('Visual & Motion constraints: particle cap <= 120, 3-slot ripple queue, and reduced-motion disables particles & trails', () => {
    // 1. Particle cap never exceeded even under 60 high-load meters
    const baseMeters = buildInitialMockMeters();
    const stressedFleet = [...baseMeters, ...baseMeters, ...baseMeters].map((m, idx) => ({
      ...m,
      id: `MTR-${idx + 1}`,
      latest_reading: {
        ...m.latest_reading!,
        current_a: 65,
        current_b: 64,
        current_c: 66,
      },
    }));
    const activeParticles = computeFeederParticles(stressedFleet, false, MAX_PARTICLES);
    expect(activeParticles.length).toBeGreaterThan(0);
    expect(activeParticles.length).toBeLessThanOrEqual(MAX_PARTICLES);

    // Reduced motion disables particle array and phasor trail angles
    expect(computeFeederParticles(stressedFleet, true, MAX_PARTICLES)).toHaveLength(0);
    expect(buildPhasorTrailAngles(45, MAX_PHASOR_TRAIL_LENGTH, false)).toHaveLength(24);
    expect(buildPhasorTrailAngles(45, MAX_PHASOR_TRAIL_LENGTH, true)).toHaveLength(0);

    // 2. One-shot animation queue caps active ripples at 3 and skips acknowledged alerts
    const queue = new OneShotAnimationQueue(MAX_CONCURRENT_ONESHOTS);
    expect(
      queue.enqueue(
        {
          id: 'r-ack',
          alertId: 500,
          meterId: 'MTR-0102',
          feederIdx: 0,
          severity: 'high',
          createdAt: 1,
          durationMs: 900,
        },
        'acknowledged',
      ).accepted,
    ).toBe(false);

    for (let i = 1; i <= 5; i += 1) {
      queue.enqueue(
        {
          id: `r-${i}`,
          alertId: 600 + i,
          meterId: `MTR-010${i}`,
          feederIdx: 0,
          severity: 'critical',
          createdAt: i,
          durationMs: 900,
        },
        'open',
      );
    }
    expect(queue.getState().active).toHaveLength(3);
    expect(queue.getState().queued).toHaveLength(2);

    const promoted = queue.complete('r-1');
    expect(promoted.map((p) => p.id)).toEqual(['r-4']);
    expect(queue.getState().active).toHaveLength(3);
    expect(queue.getState().queued).toHaveLength(1);

    // 3. Component check under prefers-reduced-motion: 0 phasor trail lines & static feeder dashed flow
    setReducedMotionMatchMedia(true);
    const { container: phasorDom } = render(
      <PhasorDiagram reading={baseMeters[8].latest_reading!} meterId="MTR-0109" />,
    );
    expect(phasorDom.querySelectorAll('[data-testid^="phasor-trail-"]')).toHaveLength(0);

    renderConsole('/');
    expect(screen.queryAllByTestId('power-flow-particle')).toHaveLength(0);
    expect(screen.getAllByTestId('static-power-flow-line').length).toBeGreaterThanOrEqual(3);
  });

  it('Hovering a GridMap meter node shows magnetic readout, dims same-feeder neighbors, and Shift+F toggles FPS overlay', () => {
    vi.useFakeTimers();
    const { container } = renderConsole('/');

    const targetNode = container.querySelector('[data-meter-node="MTR-0104"]')!;
    const sameFeederSibling = container.querySelector('[data-meter-node="MTR-0101"]')!;
    const otherFeederNode = container.querySelector('[data-meter-node="MTR-0108"]')!;

    expect(screen.queryByTestId('magnetic-node-readout')).not.toBeInTheDocument();

    fireEvent.mouseEnter(targetNode);
    const readout = screen.getByTestId('magnetic-node-readout');
    expect(readout).toHaveTextContent('MTR-0104');
    expect(sameFeederSibling).toHaveAttribute('data-dimmed', 'true');
    expect(otherFeederNode).toHaveAttribute('data-dimmed', 'false');

    fireEvent.mouseLeave(targetNode);
    expect(screen.queryByTestId('magnetic-node-readout')).not.toBeInTheDocument();

    // Shift+F toggles dev FPS overlay
    expect(screen.queryByTestId('fps-overlay')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'F', shiftKey: true });
    expect(screen.getByTestId('fps-overlay')).toHaveTextContent(/hmi perf monitor/i);
    expect(screen.getByTestId('fps-overlay')).toHaveTextContent(/20 @ 1hz/i);
  });

  it('BootSequence runs on first session load with skip hint and is removed under prefers-reduced-motion', () => {
    vi.useFakeTimers();
    sessionStorage.clear();

    // 1. Reduced-motion immediately suppresses the boot sequence
    setReducedMotionMatchMedia(true);
    const { unmount } = renderConsole('/');
    expect(screen.queryByTestId('hmi-boot-sequence')).not.toBeInTheDocument();
    unmount();

    // 2. Normal motion on fresh session renders boot sequence and skips on keypress
    sessionStorage.clear();
    setReducedMotionMatchMedia(false);
    renderConsole('/');
    expect(screen.getByTestId('hmi-boot-sequence')).toBeInTheDocument();
    expect(screen.getByTestId('boot-skip-hint')).toHaveTextContent(/press any key to skip/i);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('hmi-boot-sequence')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(BOOT_SEEN_KEY)).toBe('1');
  });
});

function build200Alerts(): Alert[] {
  const baseMs = Date.UTC(2026, 10, 14, 14, 0, 0);
  const types = [
    'power_theft',
    'phase_imbalance',
    'overcurrent',
    'voltage_sag',
    'voltage_swell',
    'harmonic_distortion',
  ];
  const severities = ['critical', 'high', 'medium', 'low'];

  return Array.from({ length: 200 }, (_, idx) => {
    const id = 20000 - idx;
    const meterNum = 101 + (idx % 20);
    const ts = new Date(baseMs - idx * 15_000).toISOString();
    return {
      id,
      meter_id: `MTR-${String(meterNum).padStart(4, '0')}`,
      type: types[idx % types.length],
      severity: severities[idx % severities.length],
      score: Number((0.98 - (idx % 30) * 0.01).toFixed(2)),
      status: idx % 5 === 0 ? 'acknowledged' : 'open',
      assigned_to: idx % 5 === 0 ? 'operator@gridsense.local' : null,
      detected_at: ts,
      last_detected_at: ts,
      loss_kw: idx % 3 === 0 ? 4.2 : 0,
      energy_loss_kwh: idx % 3 === 0 ? 9.5 : 0,
      explanation: [
        {
          feature: 'current_b',
          deviation_pct: idx % 2 === 0 ? -38.5 : 29.4,
          z_score: 3.6,
          description: `Telemetry deviation on sample alert #${id}`,
        },
      ],
      events: [
        {
          id: id * 10,
          alert_id: id,
          actor: 'ensemble-v1.0.0',
          action: 'created',
          details: 'Automated anomaly detection trigger',
          created_at: ts,
        },
      ],
    };
  });
}

describe('GridSense HMI Step 3: Operator Triage Alerts Page (/alerts)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.setItem(BOOT_SEEN_KEY, '1');
    document.documentElement.classList.add('dark');
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
  });

  it('Filters combine correctly (severity AND status AND feeder), closed hidden by default, and severity icons present', () => {
    vi.useFakeTimers();
    renderConsole('/alerts');

    // Closed alerts (9037, 9036, 9034) hidden by default; 7 open/ack alerts visible + 1 header row = 8
    expect(screen.queryByTestId('alert-row-9037')).not.toBeInTheDocument();
    expect(screen.getByTestId('alert-row-9041')).toBeInTheDocument();
    expect(screen.getByTestId('alert-row-9039')).toBeInTheDocument();

    // Check geometric severity icons + visible labels (never color alone)
    const critRow = screen.getByTestId('alert-row-9041');
    expect(critRow.querySelector('[data-severity-icon="diamond"]')).toHaveTextContent(/critical/i);
    const highRow = screen.getByTestId('alert-row-9040');
    expect(highRow.querySelector('[data-severity-icon="triangle"]')).toHaveTextContent(/high/i);
    const medRow = screen.getByTestId('alert-row-9043');
    expect(medRow.querySelector('[data-severity-icon="circle"]')).toHaveTextContent(/medium/i);
    const lowRow = screen.getByTestId('alert-row-9042');
    expect(lowRow.querySelector('[data-severity-icon="hollow-circle"]')).toHaveTextContent(/low/i);

    // Combine severity=critical AND status=open AND feeder=FDR-01 -> isolates MTR-0104 (9041) from MTR-0116 (9039, FDR-03)
    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'critical' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'open' } });
    fireEvent.change(screen.getByLabelText('Feeder'), { target: { value: 'FDR-01' } });

    expect(screen.getByTestId('active-filter-count')).toHaveTextContent(/filters:\s*3/i);
    expect(screen.getByTestId('alert-row-9041')).toBeInTheDocument();
    expect(screen.queryByTestId('alert-row-9039')).not.toBeInTheDocument();
    expect(screen.queryByTestId('alert-row-9040')).not.toBeInTheDocument();

    // Clear restores default view; Show closed reveals closed rows
    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(screen.getByTestId('active-filter-count')).toHaveTextContent(/filters:\s*0/i);
    expect(screen.getByTestId('alert-row-9039')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /show closed/i }));
    expect(screen.getByTestId('alert-row-9037')).toBeInTheDocument();
  });

  it('J/K moves selection, only one row expands inline, Enter opens detail drawer, Escape closes it, and ? toggles shortcuts', () => {
    vi.useFakeTimers();
    renderConsole('/alerts');

    // J selects first row (9041) without opening drawer
    fireEvent.keyDown(window, { key: 'j' });
    expect(screen.getByTestId('alert-row-9041')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('complementary', { name: /alert detail drawer/i })).not.toBeInTheDocument();

    // J moves to second row (9039); K moves back to first row (9041)
    fireEvent.keyDown(window, { key: 'j' });
    expect(screen.getByTestId('alert-row-9039')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('alert-row-9041')).toHaveAttribute('aria-selected', 'false');

    fireEvent.keyDown(window, { key: 'k' });
    expect(screen.getByTestId('alert-row-9041')).toHaveAttribute('aria-selected', 'true');

    // Only one row can expand inline at a time
    fireEvent.click(screen.getByRole('button', { name: /toggle explanation for alert 9041/i }));
    expect(screen.getByTestId('expanded-row-9041')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /toggle explanation for alert 9039/i }));
    expect(screen.queryByTestId('expanded-row-9041')).not.toBeInTheDocument();
    expect(screen.getByTestId('expanded-row-9039')).toBeInTheDocument();

    // Enter opens right-side detail drawer with DeviationBars, last 10 readings, and audit log
    fireEvent.keyDown(window, { key: 'Enter' });
    const drawer = screen.getByRole('complementary', { name: /alert detail drawer/i });
    expect(drawer).toBeInTheDocument();
    expect(within(drawer).getByText(/contributing feature deviations/i)).toBeInTheDocument();
    expect(within(drawer).getByText(/last 10 readings for mtr-0104/i)).toBeInTheDocument();
    expect(within(drawer).getByText(/alert audit log/i)).toBeInTheDocument();

    // Escape closes the detail drawer; '?' toggles shortcuts legend
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: /alert detail drawer/i })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('complementary', { name: /keyboard shortcuts legend/i })).toBeInTheDocument();
  });

  it('A acknowledges selected alert, writes an audit log entry, shows row confirmation, and updates Control Room open-alert count', () => {
    vi.useFakeTimers();
    renderConsole('/alerts');

    expect(screen.getByTestId('alerts-page-open-count')).toHaveTextContent(/5\s*open/i);
    expect(screen.getByLabelText(/open alerts: 5/i)).toBeInTheDocument();

    // Select first row (9041, open) and press 'a' to acknowledge
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'a' });

    expect(screen.getByTestId('row-confirmation-9041')).toHaveTextContent(/acknowledged/i);
    expect(within(screen.getByTestId('alert-row-9041')).getByText(/^acknowledged$/i)).toBeInTheDocument();

    // Header & Control Room open-alert counter decrements immediately from 5 -> 4
    expect(screen.getByTestId('alerts-page-open-count')).toHaveTextContent(/4\s*open/i);
    expect(screen.getByLabelText(/open alerts: 4/i)).toBeInTheDocument();

    // Press Shift+A to assign to current user, then Enter to verify audit log entries
    fireEvent.keyDown(window, { key: 'A', shiftKey: true });
    expect(screen.getByTestId('row-confirmation-9041')).toHaveTextContent(/assigned/i);

    fireEvent.keyDown(window, { key: 'Enter' });
    const drawer = screen.getByRole('complementary', { name: /alert detail drawer/i });
    const auditSection = within(drawer).getByRole('region', { name: /alert audit log/i });
    expect(within(auditSection).getByText(/^acknowledged$/i)).toBeInTheDocument();
    expect(within(auditSection).getByText(/^assigned$/i)).toBeInTheDocument();
    expect(within(auditSection).getAllByText(/operator@gridsense\.local/i).length).toBeGreaterThanOrEqual(2);

    // Navigate back to Control Room and confirm consistent open-alert count (4)
    fireEvent.click(screen.getByRole('link', { name: /01 \/\/ control room/i }));
    expect(screen.getByLabelText(/open alerts: 4/i)).toBeInTheDocument();
  });

  it('Shows "3 new alerts" pill without reordering rows when a row is selected and 3 alerts arrive', () => {
    vi.useFakeTimers();
    renderConsole('/alerts');

    // Select row with J
    fireEvent.keyDown(window, { key: 'j' });
    const rowsBefore = screen
      .getAllByTestId(/^alert-row-/)
      .map((el) => el.getAttribute('data-testid'));

    // Trigger 3 new live alerts while row is selected
    const injectBtn = screen.getByRole('button', { name: /sim: \+ inject alert/i });
    fireEvent.click(injectBtn);
    fireEvent.click(injectBtn);
    fireEvent.click(injectBtn);

    const pill = screen.getByTestId('new-alerts-pill');
    expect(pill).toHaveTextContent(/3 new alerts/i);

    // Existing row order must remain completely frozen
    const rowsWhileFrozen = screen
      .getAllByTestId(/^alert-row-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(rowsWhileFrozen).toEqual(rowsBefore);

    // Clicking the pill reveals the 3 new alerts at the top of the table
    fireEvent.click(pill);
    expect(screen.queryByTestId('new-alerts-pill')).not.toBeInTheDocument();
    const rowsAfterReveal = screen
      .getAllByTestId(/^alert-row-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(rowsAfterReveal.length).toBe(rowsBefore.length + 3);
    expect(rowsAfterReveal.slice(3)).toEqual(rowsBefore);
  });

  it('Renders 200 alert rows cleanly and preserves selection under filters', () => {
    vi.useFakeTimers();
    const alerts200 = build200Alerts();
    renderConsole('/alerts', alerts200);

    const table = screen.getByRole('table');
    expect(table.querySelector('caption')).toHaveTextContent(/gridsense operator alert triage table/i);

    const dataRows = screen.getAllByTestId(/^alert-row-/);
    expect(dataRows).toHaveLength(200);
    // 1 header row + 200 alert rows = 201 <tr> elements in the DOM
    expect(screen.getAllByRole('row')).toHaveLength(201);

    // Filtering 200 alerts down works accurately
    fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'critical' } });
    expect(screen.getAllByTestId(/^alert-row-/)).toHaveLength(50);
  });
});

describe('Step 4: Analytics Aggregation, Analytics Page, and Step 3 Review Fixes', () => {
  it('computes 7x24 faultHeatmap summing to input length, sorted faultsByType ~100%, and safe empty [] outputs', async () => {
    const agg = await import('../analytics/aggregate');
    const now = Date.UTC(2026, 10, 14, 18, 0, 0);
    const history = agg.generateDeterministicAlertHistory(now, { count: 48 });

    const matrix = agg.faultHeatmap(history);
    expect(matrix).toHaveLength(7);
    for (const row of matrix) {
      expect(row).toHaveLength(24);
    }
    const cellSum = matrix.flat().reduce((acc, cell) => acc + cell.count, 0);
    expect(cellSum).toBe(history.length);

    const breakdown = agg.faultsByType(history);
    expect(breakdown.length).toBeGreaterThan(0);
    for (let i = 1; i < breakdown.length; i += 1) {
      expect(breakdown[i - 1].count).toBeGreaterThanOrEqual(breakdown[i].count);
    }
    const pctSum = breakdown.reduce((acc, item) => acc + item.sharePct, 0);
    expect(pctSum).toBeGreaterThan(99.4);
    expect(pctSum).toBeLessThan(100.6);

    // Empty array safety: zero NaNs and clean default shapes
    const emptyHeatmap = agg.faultHeatmap([]);
    expect(emptyHeatmap).toHaveLength(7);
    expect(emptyHeatmap.flat().every((c) => c.count === 0 && Number.isFinite(c.energyLossKwh))).toBe(
      true,
    );
    expect(agg.faultsByType([])).toEqual([]);
    const emptySeries = agg.energyLossSeries([], '7d', 'day', now);
    expect(emptySeries).toHaveLength(7);
    expect(emptySeries.every((p) => p.lossKwh === 0 && !Number.isNaN(p.lossKwh))).toBe(true);
    const emptyFeeders = agg.feederComparison([]);
    expect(emptyFeeders).toHaveLength(3);
    expect(emptyFeeders.every((f) => f.totalFaults === 0 && f.healthScore === 100 && !f.isWorst)).toBe(
      true,
    );
    expect(agg.computeEnergyLossTodayKwh([], now)).toBe(0);
  });

  it('estimates energy loss using primary and fallback formulas and generates deterministic history', async () => {
    const agg = await import('../analytics/aggregate');
    const baseAlert = {
      id: 1,
      meter_id: 'MTR-0104',
      type: 'power_theft',
      severity: 'critical',
      score: 0.92,
      explanation: 'Test',
      status: 'open' as const,
      detected_at: '2026-11-14T10:00:00.000Z',
      last_detected_at: '2026-11-14T12:00:00.000Z',
      loss_kw: 4.0,
      energy_loss_kwh: 0,
    };

    // Primary formula: expected_kwh - measured_kwh
    expect(
      agg.estimateEnergyLossKwh({
        ...baseAlert,
        expected_kwh: 50,
        measured_kwh: 31.25,
      }),
    ).toBe(18.75);

    // Fallback A: (baseline_kw - measured_kw) * duration_hours
    expect(
      agg.estimateEnergyLossKwh({
        ...baseAlert,
        baseline_kw: 14.5,
        measured_kw: 8.5,
        duration_hours: 2.5,
      }),
    ).toBe(15);

    // Fallback B: stored energy_loss_kwh
    expect(
      agg.estimateEnergyLossKwh({
        ...baseAlert,
        energy_loss_kwh: 9.4,
      }),
    ).toBe(9.4);

    // Fallback C: loss_kw * window span hours
    expect(agg.estimateEnergyLossKwh(baseAlert)).toBe(8);

    // Determinism across two calls with identical reference clock
    const fixedNow = Date.UTC(2026, 10, 14, 14, 0, 0);
    const run1 = agg.generateDeterministicAlertHistory(fixedNow);
    const run2 = agg.generateDeterministicAlertHistory(fixedNow);
    expect(run1).toEqual(run2);
    expect(run1.length).toBeGreaterThanOrEqual(90);
  });

  it('matches Control Room LOSS TODAY identically on Analytics and supports URL params, range/feeder filters, and heatmap keyboard/click chip', () => {
    const { unmount } = renderConsole('/');
    const headerLossEl = screen.getByLabelText(/Estimated energy loss today:/i);
    const headerLossLabel = headerLossEl.getAttribute('aria-label') || '';
    const match = /([\d.]+)\s*kWh/i.exec(headerLossLabel);
    expect(match).not.toBeNull();
    const controlRoomLoss = Number(match![1]);
    unmount();

    // Visit Analytics with default filters
    const analyticsRender = renderConsole('/analytics');
    const analyticsLossEl = screen.getByLabelText(/Analytics loss today:/i);
    expect(analyticsLossEl.getAttribute('aria-label')).toContain(`${controlRoomLoss.toFixed(2)} kWh`);

    const countEl = screen.getByTestId('analytics-fault-count');
    const count7d = Number(countEl.textContent);
    expect(count7d).toBeGreaterThan(0);

    // Switch range to 30D and verify count expands
    fireEvent.click(screen.getByRole('button', { name: '30D' }));
    const count30d = Number(screen.getByTestId('analytics-fault-count').textContent);
    expect(count30d).toBeGreaterThan(count7d);

    // Narrow to Feeder 01 and verify count decreases
    fireEvent.change(screen.getByLabelText('Feeder'), { target: { value: '01' } });
    const countFeeder01 = Number(screen.getByTestId('analytics-fault-count').textContent);
    expect(countFeeder01).toBeGreaterThan(0);
    expect(countFeeder01).toBeLessThan(count30d);

    // Verify 168 SVG heatmap cells, select one with faults via Enter, confirm chip, then Escape to clear
    const cells = screen.getAllByTestId(/^heatmap-cell-/);
    expect(cells).toHaveLength(168);
    const nonZeroCell = cells.find((el) => !el.getAttribute('aria-label')?.endsWith('0 faults'));
    expect(nonZeroCell).toBeTruthy();
    fireEvent.keyDown(nonZeroCell!, { key: 'Enter' });
    expect(screen.getByTestId('heatmap-filter-chip')).toBeInTheDocument();
    fireEvent.keyDown(nonZeroCell!, { key: 'Escape' });
    expect(screen.queryByTestId('heatmap-filter-chip')).not.toBeInTheDocument();

    analyticsRender.unmount();

    // URL query restore ?range=14d&feeder=02
    renderConsole('/analytics?range=14d&feeder=02');
    expect(screen.getByRole('button', { name: '14D' })).toHaveAttribute('aria-pressed', 'true');
    expect((screen.getByLabelText('Feeder') as HTMLSelectElement).value).toBe('02');
    expect(screen.getByText('FDR-02')).toBeInTheDocument();
  });

  it('preserves explicit ARIA table roles and supports inline Undo restoring Control Room open-alerts count', () => {
    renderConsole('/alerts');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').length).toBeGreaterThanOrEqual(8);
    expect(screen.getAllByRole('cell').length).toBeGreaterThanOrEqual(8);

    const openBadgeBefore = screen.getByLabelText(/^Open alerts:/i);
    const openCountBefore = Number(
      openBadgeBefore.getAttribute('aria-label')!.replace(/\D+/g, ''),
    );
    expect(openCountBefore).toBeGreaterThan(0);

    const rows = screen.getAllByTestId(/^alert-row-/);
    expect(rows.length).toBeGreaterThan(0);
    const firstRowId = rows[0].getAttribute('data-testid')!.replace('alert-row-', '');

    // Select first row and trigger close shortcut C
    fireEvent.click(rows[0]);
    fireEvent.keyDown(window, { key: 'c' });

    const confirmBadge = screen.getByTestId(`row-confirmation-${firstRowId}`);
    expect(confirmBadge).toHaveTextContent('✓ CLOSED');
    expect(screen.getByLabelText(`Open alerts: ${openCountBefore - 1}`)).toBeInTheDocument();

    const undoBtn = screen.getByTestId(`undo-close-${firstRowId}`);
    fireEvent.click(undoBtn);

    expect(screen.getByTestId(`row-confirmation-${firstRowId}`)).toHaveTextContent('↺ RESTORED');
    expect(screen.queryByTestId(`undo-close-${firstRowId}`)).not.toBeInTheDocument();
    expect(screen.getByLabelText(`Open alerts: ${openCountBefore}`)).toBeInTheDocument();
  });

  it('displays Analytics in IST with simulated-history disclosure and sticky day labels SVG', () => {
    renderConsole('/analytics?range=30d');
    expect(screen.getByText(/SIMULATED DEMO HISTORY · IST/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Simulated 30-day history \(seeded generator\)/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId('heatmap-day-labels')).toBeInTheDocument();
    expect(screen.getByTestId('fault-heatmap-svg')).toBeInTheDocument();
  });

  it('driftStatus classifies PSI boundaries cleanly (<0.1 stable, 0.1..0.2 watch, >0.2 drift, invalid unknown)', () => {
    expect(classifyPsi(0).zone).toBe('stable');
    expect(classifyPsi(0.099).zone).toBe('stable');
    expect(classifyPsi(0.1).zone).toBe('watch');
    expect(classifyPsi(0.15).zone).toBe('watch');
    expect(classifyPsi(0.2).zone).toBe('watch');
    expect(classifyPsi(0.201).zone).toBe('drift');
    expect(classifyPsi(0.8581).zone).toBe('drift');
    expect(classifyPsi(-0.05).zone).toBe('unknown');
    expect(classifyPsi(Number.NaN).zone).toBe('unknown');
    expect(classifyPsi(null).zone).toBe('unknown');
    expect(psiToMeterPercent(0.05)).toBeCloseTo(16.67, 1);
    expect(psiToMeterPercent(0.15)).toBeCloseTo(50, 1);
    expect(psiToMeterPercent(1.4)).toBe(100);
    expect(formatPsiAriaText(0.14)).toBe('PSI 0.14, watch zone');
  });

  it('ModelHealthPage obeys Honesty Rule when /model/info is unavailable (NOT EVALUATED, zero fake numbers)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));
    renderConsole('/model-health');

    const emptyCard = await screen.findByTestId('model-not-evaluated');
    expect(emptyCard).toHaveTextContent('NOT EVALUATED');
    expect(emptyCard).toHaveTextContent('ml-service/evaluate.py');
    expect(screen.queryByText('0.8638')).not.toBeInTheDocument();
    expect(screen.queryByText('0.7624')).not.toBeInTheDocument();
    expect(screen.queryByText('0.9963')).not.toBeInTheDocument();
  });

  it('ModelHealthPage renders verified /model/info metrics, ARIA meter, source disclosure, and row drill-down to /alerts?type=', async () => {
    const mockInfo: ModelInfo = {
      version: 'v1.0.0',
      trained_at: '2026-11-14T10:00:00Z',
      feature_count: 18,
      sequence_length: 30,
      lstm_threshold: 0.72,
      ensemble_weights: {
        isolation_forest_weight: 0.45,
        lstm_autoencoder_weight: 0.55,
        anomaly_threshold: 0.65,
      },
      metrics: {
        test_samples: 11500,
        evaluated_at: '2026-11-14T10:05:00Z',
        overall: {
          precision: 0.7624,
          recall: 0.9963,
          f1: 0.8638,
          fpr: 0.0728,
          tp: 2175,
          fp: 678,
          fn: 8,
          tn: 8639,
        },
        per_fault: {
          power_theft: {
            support: 410,
            precision: 0.88,
            recall: 0.98,
            f1: 0.927,
            fpr: 0.014,
            tp: 402,
            fp: 55,
            fn: 8,
          },
          phase_imbalance: {
            support: 380,
            precision: 0.81,
            recall: 0.95,
            f1: 0.874,
            fpr: 0.022,
          },
        },
        split_description: 'Evaluated on held-out simulated split',
      },
      drift: {
        sample_count: 500,
        psi_threshold: 0.2,
        max_psi: 0.14,
        drift_warning: false,
        feature_psi: {
          phase_imbalance_ratio: 0.14,
          active_power_delta: 0.08,
        },
      },
      top_features: [
        { feature: 'phase_imbalance_ratio', importance: 0.34 },
        { feature: 'active_power_delta', importance: 0.28 },
      ],
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockInfo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderConsole('/model-health');

    expect(await screen.findByTestId('model-version-pill')).toHaveTextContent('v1.0.0');
    expect(screen.getAllByText(/Source: \/model\/info/i).length).toBeGreaterThanOrEqual(4);

    const meter = screen.getByTestId('psi-drift-meter');
    expect(meter).toHaveAttribute('role', 'meter');
    expect(meter).toHaveAttribute('aria-valuenow', '0.14');
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '1');
    expect(meter).toHaveAttribute('aria-valuetext', 'PSI 0.14, watch zone');
    expect(screen.getByTestId('drift-status-badge')).toHaveTextContent('WATCH');

    const theftRow = screen.getByTestId('matrix-row-power_theft');
    fireEvent.mouseEnter(theftRow);
    expect(screen.getByTestId('matrix-hover-counts')).toHaveTextContent('TP: 402');

    fireEvent.click(theftRow);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'ALERTS' })).toBeInTheDocument();
    });
    expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('power_theft');
  });

  it('redirects unauthenticated visitors to /login, stores JWT strictly in memory, and displays MOCK badge in fallback mode', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/auth/login')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'jwt-memory-only-token',
              user: { id: 2, email: 'operator@gridsense.local', role: 'operator' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.reject(new Error('Backend unavailable'));
    });

    renderConsole('/', undefined, { offlineDemo: false });
    expect(screen.getByText(/GRIDSENSE \/\/ OPERATOR AUTH/i)).toBeInTheDocument();

    fireEvent.submit(screen.getByRole('button', { name: /SIGN IN TO LIVE CONSOLE/i }).closest('form')!);

    await waitFor(() => {
      expect(screen.getByTestId('stream-status-badge')).toBeInTheDocument();
    });
    expect(mockFetch).toHaveBeenCalled();
    expect(getAuthToken()).toBe('jwt-memory-only-token');
    expect(localStorage.getItem('gridsense_token')).toBeNull();
    expect(sessionStorage.getItem('gridsense_token')).toBeNull();
    // Socket is mocked disconnected and backend meters call rejected -> visible MOCK badge
    expect(screen.getByTestId('stream-status-badge')).toHaveTextContent('MOCK');
  });
});
