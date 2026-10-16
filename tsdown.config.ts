import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  minify: true,
  clean: true,
  dts: false,
  treeshake: true,
  shims: true,
});
