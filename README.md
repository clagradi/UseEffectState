# effect-runtime

`@clagradi/effect-runtime` is a tiny React 18+ primitive that makes async effects safer than raw `useEffect`.

## Install

```bash
npm i @clagradi/effect-runtime
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

## Quickstart

### Example 1: fetch with `signal` + anti-race `commit`

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

### Example 2: interval with `useEvent`

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

### Example 3: subscription with `onCleanup`

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

## Why better than useEffect

- Per-run `AbortController` (auto-abort on rerun/unmount)
- `commit()` anti-race guard for stale async completions
- Multiple cleanups with LIFO execution via `onCleanup()`
- Late async cleanup is never lost (executes immediately if resolved after dispose)
- `useEvent` gives stable identity + latest closure

## Caveats

- This is not a data-fetching cache layer (not React Query/SWR).
- No SSR orchestration/caching features.

## Release checklist

1. Run package checks:

	 ```bash
	 npm run typecheck
	 npm run test
	 npm run build
	 ```

2. Create a package tarball:

	 ```bash
	 npm pack
	 ```

3. Install locally in a separate app (use either method):

	 ```bash
	 # from repo folder path
	 npm i /absolute/path/to/UseEffectState

	 # from generated tarball
	 npm i /absolute/path/to/UseEffectState/clagradi-effect-runtime-0.1.0.tgz
	 ```

4. Verify in the consumer app:

	 - `import { useEffectTask, useEvent } from '@clagradi/effect-runtime'` resolves.
	 - TypeScript picks up package types from `dist/index.d.ts` (run `npm run typecheck`).

## Publishing to npm

1. Check package name availability:

	 ```bash
	 npm view @clagradi/effect-runtime
	 # 404 => available
	 ```

2. Login:

	 ```bash
	 npm login
	 ```

3. Publish the package:

	 ```bash
	 npm publish --access public
	 ```

	 Scoped packages default to private. Always pass `--access public` for public releases.

4. Versioning:

	 ```bash
	 npm version patch # or minor / major
	 git push
	 git push --tags
	 ```

5. Tag/release strategy:

	 - CI publish runs when pushing a tag matching `v*` (for example `v0.1.0`) or when a GitHub Release is published.
	 - The publish workflow uses `npm publish --provenance --access public` with `NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }}`.
