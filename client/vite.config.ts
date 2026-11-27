import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// VITE_BASE: the IIS virtual directory in production (e.g. "/trading/"). "/" in dev.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  // Not "assets": that folder would shadow the SPA route /assets under IIS (refresh → 301 to the directory).
  build: { assetsDir: 'static' },
  server: {
    // 5173 is taken on this machine (WSL). strictPort: fail loudly instead of silently picking another port.
    // Explicit IPv4: by default Vite bound only to [::1], so browsers resolving localhost → 127.0.0.1 got nothing.
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT ?? 4100}` },
  },
});
