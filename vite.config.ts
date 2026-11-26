import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import {
  createPwaManifest,
  createWorkboxConfig,
  PWA_INCLUDE_ASSETS,
  PWA_SW_FILENAME,
} from './src/pwa/cache-config';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: 'auto',
      filename: PWA_SW_FILENAME,
      includeAssets: [...PWA_INCLUDE_ASSETS],
      manifest: createPwaManifest(),
      workbox: createWorkboxConfig(),
      devOptions: { enabled: false },
    }),
  ],
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
