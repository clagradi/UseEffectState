# effect-runtime

Primitive React 18+ per effetti async più sicuri di `useEffect`.

## Install

```bash
npm i @tu_scope/effect-runtime
# oppure
pnpm add @tu_scope/effect-runtime
# oppure
yarn add @tu_scope/effect-runtime
```

## Quick example

```tsx
import { useEffectTask } from '@tu_scope/effect-runtime';

function UserCard({ userId }: { userId: string }) {
	useEffectTask(
		async ({ signal, commit, onCleanup }) => {
			const response = await fetch(`/api/users/${userId}`, { signal });
			const user = await response.json();

			commit(() => {
				console.log('safe update', user);
			});

			const intervalId = setInterval(() => {
				console.log('poll');
			}, 5000);

			onCleanup(() => clearInterval(intervalId));

			return () => {
				console.log('task cleanup');
			};
		},
		[userId],
		{ debugName: 'UserCardTask' }
	);

	return null;
}
```

## Why this is better than useEffect

- Abort per-run con `AbortController` dedicato.
- `commit()` anti-race: applica side effect solo se la run è ancora attiva.
- Late async cleanup: se cleanup arriva tardi dopo dispose/unmount, viene eseguita subito.
- `useEvent` anti-stale closure: il task vede sempre la versione più recente.
- Multi-cleanup con `onCleanup()` in ordine LIFO.

## Caveats

- Non sostituisce React Query/SWR: niente cache, dedup, retries, invalidation.
- Non è una soluzione SSR data-fetching; è una primitive runtime per effetti client-side.

## API

```ts
useEffectTask(
	task: (scope) => void | (() => void) | Promise<void | (() => void)>,
	deps: any[],
	options?: { layout?: boolean; onError?: (err: unknown) => void; debugName?: string }
)
```

`scope` include:

- `signal: AbortSignal`
- `runId: number`
- `isActive(): boolean`
- `commit(fn: () => void): void`
- `onCleanup(fn: () => void): void`

## Publishing

Checklist pratica:

1. Scegli nome/scope e verifica disponibilità:

	 ```bash
	 npm view @tu_scope/effect-runtime
	 ```

2. Build + test:

	 ```bash
	 npm run test
	 npm run build
	 ```

3. Crea tarball e testalo in un consumer:

	 ```bash
	 npm pack
	 # in un altro progetto:
	 npm i ../UseEffectState/tu_scope-effect-runtime-0.1.0.tgz
	 ```

4. Login npm:

	 ```bash
	 npm login
	 ```

5. Publish (scoped package pubblico):

	 ```bash
	 npm publish --access public
	 ```

6. Versioning semver:

	 ```bash
	 npm version patch
	 npm version minor
	 npm version major
	 ```

7. Opzionale CI (GitHub Actions su tag `v*` + `NPM_TOKEN` + provenance):

	 ```bash
	 npm publish --access public --provenance
	 ```