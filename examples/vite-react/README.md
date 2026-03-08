# Vite React playground

This folder is a standalone demo app for `@clagradi/effect-runtime`.

## Run locally

```bash
cd examples/vite-react
npm install
npm run dev
```

## Validate against a packed tarball

From the repository root:

```bash
npm run smoke:consumer
```

This builds the library, packs it, installs the tarball here, then runs `typecheck` and `build`.

## Demos included

- `FetchDemo`: `useEffectTask` with `signal` + `commit` anti-race update.
- `IntervalDemo`: `useEvent` to read latest state in interval callbacks.
- `SubscriptionDemo`: `onCleanup` for subscribe/unsubscribe lifecycle pairing.

## Notes

- This app is for local/manual validation only.
- The npm package publish is still controlled by root `package.json` `files: ["dist"]`.
- CI installs the packed tarball here to verify the consumer path, not the source tree.
