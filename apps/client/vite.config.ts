import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const clientPkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, './package.json'), 'utf8')) as { version: string };

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(clientPkg.version),
  },
  plugins: [react()],
  worker: {
    // Keep the plugin runtime self-contained for the desktop file origin and Android's embedded page.
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Libraries change less often than the app: their own files stay cached across releases
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          if (/[\\/](pixi\.js|@pixi|earcut)[\\/]/.test(id)) return 'vendor-pixi';
          if (/[\\/](jszip|ag-psd|gifenc|pako|@msgpack|qrcode)[\\/]/.test(id)) return 'vendor-export';
          if (/[\\/](socket\.io-client|socket\.io-parser|engine\.io-client|engine\.io-parser)[\\/]/.test(id)) return 'vendor-socket';
          if (/[\\/]lucide-react[\\/]/.test(id)) return 'vendor-icons';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
});
