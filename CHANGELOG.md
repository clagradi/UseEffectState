# Changelog

All notable changes to this project are documented in this file.

## [0.2.0] - 2026-11-01

A new version of the runtime: the long-planned `useEffectState`, a layout variant, abortable
helpers, correctness fixes found by an audit against React 18.3 and 19.3, and a packaging fix for
Node ESM consumers.

### Added

- `useEffectState(task, deps, options?)`: runs an async task as an effect and keeps its result in
  state: `status` (`idle` / `pending` / `success` / `error`), `data`, `error`, `isRunning`,
  `isPending` / `isSuccess` / `isError`, `reload()` and `setData()`. Options: `enabled`,
  `initialData` (typed: `data` becomes non-optional), `keepPreviousData`, `onSuccess`, `onError`,
  `debugName`. When deps change it reports `pending` in the same render, so a previous result is
  never shown for new deps.
- `useLayoutEffectTask(task, deps, options?)`: layout-effect variant that falls back to a passive
  effect on the server (no React 18 SSR warning).
- Task scope helpers: `sleep(ms)` (abortable delay, for debouncing and polling) and
  `abortable(promise)` (stop waiting for promises that cannot take a signal).
- Type-level tests, React 18 + 19 test matrix, publint and are-the-types-wrong checks, a consumer
  smoke test that imports the packed tarball through ESM and CommonJS and server-renders with it.
- Playground: race lab (naive `useEffect` vs `useEffectState`), debounced search, polling,
  `useEffectState` demo, simulated API with a live network log.

### Fixed

- Errors thrown by cleanup functions were silently swallowed (the signal was aborted before the
  cleanups ran, and aborted runs suppressed every error). They are now always reported.
- Abort detection used `instanceof DOMException`, which throws where `DOMException` is missing
  (older React Native / Hermes) and missed Node's `AbortError` and custom abort reasons. It is now
  duck-typed and also matches `signal.reason`.
- `onError` and `debugName` were captured per run, so a new `onError` was ignored until deps
  changed. The latest options are now always used.
- A throwing `onError` produced an unhandled promise rejection.
- The cleanup returned by a task ran after the `onCleanup` cleanups; all cleanups now run in one
  LIFO order.
- `useEvent` wrote its ref during render, which leaks values from renders React discards under
  concurrent rendering; through `useEffectTask` this could even run a task closure from a
  discarded render when an effect reconnected (Suspense re-reveal, `<Activity>` hidden to
  visible). The latest callback is now published in the commit phase, and the stable wrapper is
  kept in state (memoization caches may be discarded).
- Thenables without `.catch` broke the async path; tasks may now return any `PromiseLike`.
- The `layout` option selected the effect hook on every render (a Rules of Hooks hazard); it is now
  read once on mount.
- Packaging: the ESM build was a `.js` file in a package without `"type": "module"`, so Node only
  loaded it through module-syntax detection (and failed where detection is off), and the ESM types
  were never referenced. The package is now `"type": "module"` with `.js`/`.cjs` builds, matching
  `.d.ts`/`.d.cts` types and a `./package.json` export.

### Changed

- `deps` accept any `DependencyList` (readonly arrays and tuples).
- Without `onError`, task and cleanup errors now surface like errors thrown in a plain effect:
  through the global `reportError` in browsers (so `window.onerror`, error monitoring and dev
  overlays see them), otherwise `console.error`, in every environment. 0.1 tried to log only
  outside production, but bundlers never replaced its `process.env` check, and runtimes with a real
  `process.env.NODE_ENV === 'production'` (React Native release builds) dropped errors silently.
- `useEvent` throws when called during the first render (before its callback is committed).
- CI: Node 22 / 24 / 26 x React 18 / 19, lint (ESLint 10 + React hooks rules), package checks;
  publishing via npm trusted publishing (OIDC) with provenance, GitHub release notes from this
  changelog; Dependabot.
- Tooling: TypeScript 6, Vitest 5, tsup 9, jsdom 30, Vite 8 for the playground.

### Deprecated

- `useEffectTask(..., { layout: true })`: use `useLayoutEffectTask`.

## [0.1.2] - 2026-03-08

### Changed

- Added a real consumer smoke test that installs the packed tarball into the Vite example app and runs typecheck plus build.
- Split CI into core validation and consumer package validation.
- Refined README structure with before / after usage, local example instructions, consumer verification, and release flow.
- Removed provenance from local `publishConfig`; CI remains the supported provenance publish path.
- Stopped versioning generated `dist/` output and tarball artifacts.

### Fixed

- Added focused `useEvent` tests for stable identity and latest closure behavior.

## [0.1.1] - 2026-02-27

### Changed

- Hardened release metadata for npm package consumers.
- Refined publish and release documentation for scoped package workflows.
- Added OSS hygiene docs: contributing guide, issue templates, and security policy.
- Confirmed CI and publish workflows for tag-based release automation.

## [0.1.0] - 2026-02-26

### Added

- Initial release of `@clagradi/effect-runtime`.
- `useEffectTask` and `useEvent` primitives for safer async effect handling.
