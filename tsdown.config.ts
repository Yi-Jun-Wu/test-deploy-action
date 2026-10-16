import { defineConfig } from 'tsdown';

export default defineConfig({
  // Bundle the composite-action wrapper into the action directory, next to
  // its action.yml. `clean` is disabled so the manifest and README survive.
  entry: { index: 'scripts/deploy.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: '.github/actions/deploy',
  minify: true,
  clean: false,
  dts: false,
  treeshake: true,
  shims: true,
});
