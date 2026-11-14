/**
 * GridSense Industrial HMI Design Tokens
 * Single source of truth for palette, phase vectors, typography, spacing, and motion.
 */

export const TOKENS = {
  colors: {
    dark: {
      bg: '#07090D',
      panel: '#0C1017',
      elevated: '#121822',
      border: '#1E2633',
      textPrimary: '#E6E9EF',
      textMuted: '#7D899C',
    },
    light: {
      bg: '#F2F3EE',
      panel: '#FFFFFF',
      elevated: '#E7E9E2',
      border: '#C8CDD6',
      textPrimary: '#11141C',
      textMuted: '#576070',
    },
    // Core functional signals (strictly limited palette)
    signal: '#F59E0B',        // Phosphor Amber — primary telemetry, nominal lock, active cursor
    signalDim: 'rgba(245, 158, 11, 0.16)',
    alert: '#FF4D2D',         // Hot Red-Orange — active fault, critical threshold breach, theft
    alertDim: 'rgba(255, 77, 45, 0.16)',
    neutral: '#7D899C',       // Secondary technical labels & inactive ticks

    // Three-Phase Electrical Conductors (used identically across Phasor, Oscilloscope, Tables)
    phases: {
      A: {
        label: 'PHASE A',
        short: 'L1 / ØA',
        color: '#F59E0B',     // Warm Amber
        dim: 'rgba(245, 158, 11, 0.18)',
      },
      B: {
        label: 'PHASE B',
        short: 'L2 / ØB',
        color: '#00E5FF',     // Oscilloscope Cyan
        dim: 'rgba(0, 229, 255, 0.18)',
      },
      C: {
        label: 'PHASE C',
        short: 'L3 / ØC',
        color: '#FF3EA5',     // Signal Magenta
        dim: 'rgba(255, 62, 165, 0.18)',
      },
    },
  },

  typography: {
    fontDisplay: '"Space Grotesk", system-ui, sans-serif',
    fontMono: '"IBM Plex Mono", monospace',
    scale: {
      micro: '0.6875rem',     // 11px — panel headers, axis ticks, unit tags
      xs: '0.75rem',          // 12px — dense table cells, timestamps
      sm: '0.8125rem',        // 13px — console controls
      base: '0.875rem',       // 14px — primary descriptions
      lg: '1.125rem',         // 18px — section headers
      xl: '1.5rem',           // 24px — primary KPI readouts
      xxl: '2rem',            // 32px — busbar hero telemetry
    },
  },

  spacing: {
    hairline: '1px',
    panelPad: '12px',
    sectionGap: '1px',        // 1px structural divider grid
  },

  limits: {
    nominalVoltage: 230.0,
    voltageMin: 207.0,
    voltageMax: 253.0,
    nominalFrequency: 50.0,
    nominalPowerFactor: 0.95,
    psiWarningThreshold: 0.20,
  },
} as const;

export type PhaseKey = keyof typeof TOKENS.colors.phases;
