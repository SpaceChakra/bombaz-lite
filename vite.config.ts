import { defineConfig } from 'vite';

// Base is relative so the build works from any folder (itch.io, GitHub Pages, a USB stick).
export default defineConfig({
  base: './',
  define: { __BUILD_ID__: JSON.stringify('BOMBAZ LITE · SpaceChakra') },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  server: { port: 5173, open: true },
});
