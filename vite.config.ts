import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/VISI0N-OS-BETA/',
  build: {
    target: ['safari16'],
    sourcemap: true,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: (id) => id.includes('/node_modules/three/') ? 'three' : undefined,
      },
    },
  },
});
