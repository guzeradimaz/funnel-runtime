import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist', emptyOutDir: true },
  server: {
    port: 5173,
    // Trailing slash matters: a bare '/api' prefix would also proxy the frontend module /api.ts.
    proxy: { '/api/': 'http://localhost:3000' },
  },
});
