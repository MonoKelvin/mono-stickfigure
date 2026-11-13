import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts', core: 'src/core.ts' },
  format: { esm: { platform: 'browser' }, cjs: { platform: 'neutral' } },
  target: 'es2022',
  dts: true,
  fixedExtension: true,
  clean: true,
  sourcemap: true,
});
