/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', '"JetBrains Mono"', 'monospace'],
      },
      colors: {
        hmi: {
          bg: '#07090D',
          panel: '#0C1017',
          elevated: '#121822',
          border: '#1E2633',
          muted: '#7D899C',
          text: '#E6E9EF',
          signal: '#F59E0B',     // Warm phosphor amber (primary signal)
          alert: '#FF4D2D',      // Hot red-orange (active fault / alert)
          phaseA: '#F59E0B',     // Phase A: Amber
          phaseB: '#00E5FF',     // Phase B: Cyan
          phaseC: '#FF3EA5',     // Phase C: Magenta
        },
      },
    },
  },
  plugins: [],
};
