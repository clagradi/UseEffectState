# effect-runtime

[![npm version](https://img.shields.io/npm/v/@clagradi/effect-runtime.svg)](https://www.npmjs.com/package/@clagradi/effect-runtime)
[![CI](https://github.com/clagradi/UseEffectState/actions/workflows/ci.yml/badge.svg)](https://github.com/clagradi/UseEffectState/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/clagradi/UseEffectState/blob/main/LICENSE)

`@clagradi/effect-runtime` is a small React 18+ primitive for safer async effects.

## Install

```bash
npm i @clagradi/effect-runtime
```

```bash
pnpm add @clagradi/effect-runtime
```

```bash
yarn add @clagradi/effect-runtime
```

## Why better than useEffect

- Per-run `AbortController` (auto abort on rerun/unmount)
- `commit()` anti-race guard for stale async completions
- Late async cleanup is still executed after dispose
- `onCleanup()` supports multiple cleanups with LIFO order
- `useEvent` gives stable callbacks without stale closures
- StrictMode-safe effect lifecycle behavior

## Before / after

Before:

```tsx
useEffect(() => {
  const controller = new AbortController();
  let cancelled = false;

  fetch(`/api/users/${userId}`, { signal: controller.signal })
    .then((response) => response.json())
    .then((user) => {
      if (!cancelled) {
        setName(user.name);
      }
    });

  return () => {
    cancelled = true;
    controller.abort();
  };
}, [userId]);
```

After:

```tsx
useEffectTask(
  async ({ signal, commit }) => {
    const response = await fetch(`/api/users/${userId}`, { signal });
    const user = await response.json();

    commit(() => {
      setName(user.name);
    });
  },
  [userId]
);
```

## Examples

### FetchDemo

Uses `signal` + `commit` so overlapping requests do not commit stale state.

```tsx
useEffectTask(
  async ({ signal, commit }) => {
    const response = await fetch(`/api/todos/${todoId}`, { signal });
    const todo = await response.json();

    commit(() => {
      setTodo(todo);
    });
  },
  [todoId]
);
```

### IntervalDemo

Uses `useEvent` so an interval sees the latest state without growing dependency arrays.

```tsx
const onTick = useEvent(() => {
  setCount((value) => value + 1);
  console.log(label);
});

useEffectTask(({ onCleanup }) => {
  const handle = setInterval(() => onTick(), 1000);
  onCleanup(() => clearInterval(handle));
}, []);
```

### SubscriptionDemo

Uses `onCleanup` to pair subscribe / unsubscribe logic per run.

```tsx
useEffectTask(({ onCleanup }) => {
  const unsubscribe = subscribeToRoom(roomId, (message) => {
    setMessages((prev) => [message, ...prev].slice(0, 5));
  });

  onCleanup(() => unsubscribe());
}, [roomId]);
```

## Run the example app locally

```bash
cd examples/vite-react
npm install
npm run dev
```

Then open the local URL printed by Vite, usually `http://localhost:5173`.

Try it online:

- StackBlitz: `TODO`
- CodeSandbox: `TODO`

The example app depends on the published package, and the release smoke test temporarily installs the packed tarball on top of it. Examples are not published to npm because the root package ships only `dist/`.

## API

```ts
export function useEvent<T extends (...args: any[]) => any>(fn: T): T;

type EffectTaskScope = {
  signal: AbortSignal;
  runId: number;
  isActive(): boolean;
  commit(fn: () => void): void;
  onCleanup(fn: () => void): void;
};

type EffectTask =
  (scope: EffectTaskScope) =>
    void | (() => void) | Promise<void | (() => void)>;

export function useEffectTask(
  task: EffectTask,
  deps: any[],
  options?: { layout?: boolean; onError?: (err: unknown) => void; debugName?: string }
): void;
```

## Caveats

- Not a data-fetching cache. This is not React Query or SWR.
- No caching or SSR orchestration.
- It helps effect correctness; it does not replace application data architecture.

## How to verify the package as a consumer

Run the real consumer smoke test used by CI:

```bash
npm run smoke:consumer
```

What it does:

- builds `dist/` from source
- builds the library tarball with `npm pack`
- installs that tarball into `examples/vite-react`
- runs the example app `typecheck`
- runs the example app `build`

You can also do it manually:

```bash
npm run build
npm pack --pack-destination .tmp
cd examples/vite-react
npm install --package-lock=false
npm install --no-save --package-lock=false ../../.tmp/clagradi-effect-runtime-<version>.tgz
npm run typecheck
npm run build
```

## How release works

1. Validate the repo:

```bash
npm run typecheck
npm run test
npm run build
npm run smoke:consumer
```

2. Bump the version and create the release tag:

```bash
npm version patch
```

3. Push `main` and the tag:

```bash
git push origin main
git push origin --tags
```

4. GitHub Actions publishes on tags matching `v*` using:

```bash
npm publish --provenance --access public
```

5. Local manual publish remains available, but CI publish is the preferred path. If local npm tries to generate provenance outside a supported provider, use:

```bash
npm publish --access public --provenance=false
```
