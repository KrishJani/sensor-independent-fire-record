import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Dev: same-origin /api → local api-worker (wrangler dev), so VITE_API_BASE is optional locally.
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
});
