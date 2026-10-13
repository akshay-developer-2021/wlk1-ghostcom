import { defineConfig } from 'vite';
import { configDefaults, defineConfig as defineTestConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  defineConfig({
    build: {
      target: 'es2020',
      sourcemap: true,
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
