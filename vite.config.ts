import { defineConfig } from 'vite';
import { configDefaults, defineConfig as defineTestConfig, mergeConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';
import { visualizer } from 'rollup-plugin-visualizer';

export default mergeConfig(
  defineConfig({
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 60,
      reportCompressedSize: true,
      // Explicit Vite default (4 KiB): imported assets smaller than this
      // inline as data-URLs. Pinned so a Vite upgrade can't silently
      // base64-bloat the bundle. public/ icons bypass this (copied
      // verbatim) and fonts (~9–24 KiB each) always emit as files.
      assetsInlineLimit: 4096,
      rollupOptions: {
        output: {
          manualChunks: { peerjs: ['peerjs'] },
          /* stable font URLs (no hash) so index.html can preload them and
             kill the swap flash; fonts are effectively immutable. */
          assetFileNames: (info) => {
            if (info.names?.some((n) => n.endsWith('.woff') || n.endsWith('.woff2'))) {
              return 'assets/fonts/[name][extname]';
            }
            return 'assets/[name]-[hash][extname]';
          },
        },
      },
    },
    server: {
      // mic + wake lock + clipboard all require a secure context
      https: false,
      host: true,
    },
    plugins: [
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        // Source service worker. The plugin compiles src/sw.ts and emits
        // dist/sw.js, so the '/sw.js' registration in main.ts keeps working.
        filename: 'sw.ts',
        // main.ts registers the SW manually; don't auto-inject a duplicate.
        injectRegister: false,
        // Precache fonts/icons/manifest too (defaults cover only js/css/html).
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,woff,woff2,svg,webmanifest}'],
        },
      }),
      // Bundle visualizer — dev-only, only when ANALYZE=1 (`npm run analyze`).
      ...(process.env.ANALYZE
        ? [visualizer({ filename: 'dist/stats.html', gzipSize: true, brotliSize: true })]
        : []),
    ],
  }),
  defineTestConfig({
    test: {
      environment: 'node',
      globals: true,
      include: ['tests/**/*.test.js'],
      coverage: { provider: 'v8', include: ['src/core/**', 'src/audio/**', 'src/webrtc/**', 'src/security/**'] },
    },
  }),
);
