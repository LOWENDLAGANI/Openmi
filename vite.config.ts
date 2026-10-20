import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

// The Cloud preview host is injected per-VM; never hardcode it in tracked files.
const previewHosts = (process.env.VITE_PREVIEW_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': `${rootDir}shared`,
      '@': `${rootDir}src`,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
    // Vite reads __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS as well; this keeps an
    // explicit, per-environment allowlist without touching tracked config.
    allowedHosts: previewHosts.length > 0 ? previewHosts : undefined,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
});
