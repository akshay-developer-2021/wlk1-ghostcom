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
      rollupOptions: {
        output: {
          manualChunks: { peerjs: ['peerjs'] },
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
