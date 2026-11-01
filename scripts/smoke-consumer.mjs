// Consumer smoke test: validates the *packed tarball* exactly the way users receive it.
//
// 1. Builds dist/ and packs the library with `npm pack`.
// 2. Installs the tarball into a throwaway plain-Node project and checks that
//    - `import` (ESM) and `require` (CJS) both resolve and expose the public API,
//    - server rendering through both entry points works without any console output
//      (for example, no "useLayoutEffect does nothing on the server" warning).
// 3. Installs the tarball into examples/vite-react and runs its build (tsc -b + vite build).
//
// Usage: node ./scripts/smoke-consumer.mjs [--skip-example]
// Env:   SMOKE_REACT_VERSION=18|19 (default 19) for the plain-Node consumer.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = path.join(rootDir, '.tmp', 'consumer-smoke');
const nodeConsumerDir = path.join(tempDir, 'node-consumer');
const exampleDir = path.join(rootDir, 'examples', 'vite-react');
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';
const skipExample = process.argv.includes('--skip-example');
const reactVersion = process.env.SMOKE_REACT_VERSION || '19';

const EXPECTED_EXPORTS = ['useEffectTask', 'useLayoutEffectTask', 'useEffectState', 'useEvent'];

function run(command, args, cwd) {
  console.log(`\n$ ${path.basename(command)} ${args.join(' ')}   (cwd: ${path.relative(rootDir, cwd) || '.'})`);
  // Spawning npm.cmd on Windows requires a shell since the CVE-2024-27980 fix.
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: isWindows });
}

function capture(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', shell: isWindows });
}

const checkBody = (importLine) => `${importLine}

const expected = ${JSON.stringify(EXPECTED_EXPORTS)};
for (const name of expected) {
  if (typeof lib[name] !== 'function') {
    throw new Error('Missing export "' + name + '" (got ' + typeof lib[name] + ')');
  }
}

const logged = [];
for (const method of ['error', 'warn']) {
  const original = console[method];
  console[method] = (...args) => {
    logged.push(method + ': ' + args.map(String).join(' '));
    original.apply(console, args);
  };
}

function Probe() {
  lib.useEffectTask(async ({ signal }) => {
    await Promise.resolve(signal);
  }, []);
  lib.useLayoutEffectTask(() => undefined, []);
  const state = lib.useEffectState(async () => 42, []);
  const onClick = lib.useEvent(() => state.status);
  return React.createElement('button', { onClick }, state.status);
}

const html = renderToString(React.createElement(Probe));
if (!html.includes('pending')) {
  throw new Error('Unexpected SSR output: ' + html);
}
if (logged.length > 0) {
  throw new Error('SSR produced console output:\\n' + logged.join('\\n'));
}
console.log('[smoke] ' + MODE + ' OK with React ' + React.version + ': ' + html);
`;

const ESM_CHECK = checkBody(`const MODE = 'esm';
import * as lib from '@clagradi/effect-runtime';
import * as React from 'react';
import { renderToString } from 'react-dom/server';`);

const CJS_CHECK = checkBody(`const MODE = 'cjs';
const lib = require('@clagradi/effect-runtime');
const React = require('react');
const { renderToString } = require('react-dom/server');`);

rmSync(tempDir, { recursive: true, force: true });
mkdirSync(nodeConsumerDir, { recursive: true });

run(npm, ['run', 'build'], rootDir);

// dist/ was just built: skip the prepack hook so its output cannot corrupt the JSON.
const packed = JSON.parse(
  capture(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', tempDir], rootDir)
);
const tarballPath = path.join(tempDir, packed[0].filename);

// --- 1) Plain Node consumer -------------------------------------------------
writeFileSync(
  path.join(nodeConsumerDir, 'package.json'),
  `${JSON.stringify({ name: 'node-consumer', version: '0.0.0', private: true }, null, 2)}\n`
);
run(
  npm,
  [
    'install',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    tarballPath,
    `react@${reactVersion}`,
    `react-dom@${reactVersion}`
  ],
  nodeConsumerDir
);
writeFileSync(path.join(nodeConsumerDir, 'check.mjs'), ESM_CHECK);
writeFileSync(path.join(nodeConsumerDir, 'check.cjs'), CJS_CHECK);

run(process.execPath, ['check.mjs'], nodeConsumerDir);
run(process.execPath, ['check.cjs'], nodeConsumerDir);

// The ESM entry must not depend on Node's module-syntax detection (that is what
// broke 0.1.x on older Node versions), so re-run with detection disabled when
// this Node version still supports the flag.
if (process.allowedNodeEnvironmentFlags.has('--experimental-detect-module')) {
  run(process.execPath, ['--no-experimental-detect-module', 'check.mjs'], nodeConsumerDir);
}

// --- 2) Example app (Vite + TypeScript) -------------------------------------
if (!skipExample) {
  // One install: the explicit tarball overrides the example's registry range for
  // the library (which may not be published yet), everything else comes from npm.
  run(npm, ['install', '--no-audit', '--no-fund', '--no-save', '--package-lock=false', tarballPath], exampleDir);
  run(npm, ['run', 'build'], exampleDir); // tsc -b (typecheck) + vite build
}

console.log('\n[smoke] consumer smoke test passed');
