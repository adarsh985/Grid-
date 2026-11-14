import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const backendTarget = process.env.BACKEND_PROXY_URL || 'http://127.0.0.1:4000';
const mlTarget = process.env.ML_PROXY_URL || 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/socket.io': {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
      '/model/': {
        target: mlTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    css: true,
  },
});
