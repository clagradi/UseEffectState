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

## Why better than useEffect

- Per-run `AbortController` (auto abort on rerun/unmount)
- `commit()` anti-race guard for stale async completions
- Late async cleanup is still executed after dispose
- `onCleanup()` supports multiple cleanups with LIFO order
- `useEvent` gives stable callbacks without stale closures
- StrictMode-safe effect lifecycle behavior

## Examples

### 1) Fetch with `signal` + anti-race `commit`

```tsx
import { useState } from 'react';
import { useEffectTask } from '@clagradi/effect-runtime';

export function UserCard({ userId }: { userId: string }) {
  const [name, setName] = useState('loading...');

  useEffectTask(
    async ({ signal, commit }) => {
      const response = await fetch(`/api/users/${userId}`, { signal });
      const user = (await response.json()) as { name: string };

      commit(() => {
        setName(user.name);
      });
    },
    [userId]
  );

  return <div>{name}</div>;
}
```

### 2) Interval with `useEvent`

```tsx
import { useState } from 'react';
import { useEffectTask, useEvent } from '@clagradi/effect-runtime';

export function Counter() {
  const [count, setCount] = useState(0);
  const onTick = useEvent(() => setCount((value) => value + 1));

  useEffectTask(({ onCleanup }) => {
    const handle = setInterval(() => onTick(), 1000);
    onCleanup(() => clearInterval(handle));
  }, []);

  return <span>{count}</span>;
}
```

### 3) Subscription with `onCleanup`

```tsx
import { useEffectTask } from '@clagradi/effect-runtime';

type Subscription = { unsubscribe: () => void };
declare function subscribeToRoom(roomId: string, cb: (msg: string) => void): Subscription;

export function RoomFeed({ roomId }: { roomId: string }) {
  useEffectTask(({ onCleanup }) => {
    const sub = subscribeToRoom(roomId, (msg) => {
      console.log(msg);
    });

    onCleanup(() => sub.unsubscribe());
  }, [roomId]);

  return null;
}
```

## Caveats

- Not a data-fetching cache (this is not React Query/SWR).
- No caching/SSR orchestration features.

## Release checklist

1. Run checks:

```bash
npm run typecheck
npm run test
npm run build
```

2. Pack the library:

```bash
npm pack
# optional sanity check only
npm run pack:check
```

3. Install in a separate consumer app:

```bash
# from local folder
npm i /absolute/path/to/effect-runtime

# from package tarball
npm i /absolute/path/to/effect-runtime/clagradi-effect-runtime-<version>.tgz
```

4. Verify in consumer app:

- `import { useEffectTask, useEvent } from '@clagradi/effect-runtime'` resolves.
- TypeScript sees package types from `dist/index.d.ts`.

## Publishing to npm

1. Check package name status:

```bash
npm view @clagradi/effect-runtime
```

2. Bump version for the next release:

```bash
npm version patch # or minor / major
```

3. Publish manually:

```bash
npm login
npm publish --access public
```

4. Or publish via CI on tag push:

```bash
git push --follow-tags
```

Scoped packages default to private. Always pass `--access public` for public publish.

CI publish workflow runs on tags matching `v*` and publishes with provenance:

```bash
npm publish --provenance --access public
```
