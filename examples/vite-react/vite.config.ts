import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// During `vite dev`, use the library source from this repository when it is
// available, so edits to ../../src show up immediately. Production builds
// always use the installed package: the published one, or the tarball that
// `npm run smoke:consumer` installs.
const librarySource = fileURLToPath(new URL('../../src/index.ts', import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve:
    command === 'serve' && existsSync(librarySource)
      ? { alias: { '@clagradi/effect-runtime': librarySource }, dedupe: ['react', 'react-dom'] }
      : {}
}));
