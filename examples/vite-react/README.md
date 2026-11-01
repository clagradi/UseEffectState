# Vite + React playground

A standalone demo app for `@clagradi/effect-runtime`. It runs in `StrictMode` and uses a
simulated API (random latency, `AbortSignal` support, optional failures) with a live network log,
so you can see exactly which requests get aborted.

## Run locally

```bash
cd examples/vite-react
npm install
npm run dev
```

The app installs `@clagradi/effect-runtime` from npm. To try unreleased changes from this
repository instead, run the consumer smoke test from the repository root (it installs the packed
tarball here) and then `npm run dev`:

```bash
npm run smoke:consumer
cd examples/vite-react && npm run dev
```

## Demos

- **Race lab**: naive `useEffect` + `useState` vs `useEffectState` with out-of-order responses.
- **useEffectState**: `status` / `data` / `error` / `isRunning`, `reload()`, simulated failures.
- **Debounced search**: `await sleep(300)` + `enabled` + `initialData` + `keepPreviousData`.
- **Polling loop**: `useEffectTask` with a `for (;;)` loop, `commit()` and `sleep()`.
- **useEvent**: an interval created once that always sees the latest state.
- **onCleanup**: subscribe / unsubscribe per room, LIFO cleanups.

## Notes

- This folder is not published to npm (the root package ships only `dist/`).
- CI installs the packed tarball here and runs `typecheck` + `build` to verify the consumer path.
