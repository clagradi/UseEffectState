import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  tsconfig: 'tsconfig.build.json',
  format: ['esm', 'cjs'],
  target: 'es2020',
  dts: true,
  clean: true,
  outDir: 'dist',
  banner: { js: "'use client';" }
});
