import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      // The server owns /manifest.webmanifest so the installed-app name and
      // language follow the viewer's enrollment. index.html links to it
      // directly; emitting a build-time file here would collide with that route
      // in @fastify/static.
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/recording': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});