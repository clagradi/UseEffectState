# effect-runtime

[![npm version](https://img.shields.io/npm/v/@clagradi/effect-runtime.svg)](https://www.npmjs.com/package/@clagradi/effect-runtime)
[![CI](https://github.com/clagradi/UseEffectState/actions/workflows/ci.yml/badge.svg)](https://github.com/clagradi/UseEffectState/actions/workflows/ci.yml)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@clagradi/effect-runtime)](https://bundlephobia.com/package/@clagradi/effect-runtime)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/clagradi/UseEffectState/blob/main/LICENSE)

**Async effects for React that cancel, clean up and race correctly.**
Tiny, dependency-free, typed, React 18 and 19, StrictMode-, SSR- and `<Activity>`-safe.

```tsx
import { useEffectState } from '@clagradi/effect-runtime';

function UserCard({ userId }: { userId: string }) {
  const user = useEffectState(async ({ signal }) => {
    const response = await fetch(`/api/users/${userId}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as User;
  }, [userId]);

  if (user.status === 'pending') return <Spinner />;
  if (user.status === 'error') return <ErrorMessage error={user.error} retry={user.reload} />;
  return <Profile user={user.data} refreshing={user.isRunning} />;
}
```

- **No races.** Every run gets its own `AbortSignal`; results of runs that ended are ignored.
- **No leaks.** Runs are aborted on re-run and unmount; cleanups run in LIFO order, even when they arrive late.
- **No stale UI.** When deps change, `useEffectState` reports `pending` in the same render: the previous result is never shown as the result for new deps.
- **No stale closures.** The latest task always runs; deps only decide *when*.
- **No swallowed errors.** Task and cleanup errors are reported (or stored in state), abort errors are not.

## Contents

- [Install](#install)
- [Why](#why)
- [`useEffectState`](#useeffectstate)
- [`useEffectTask` and `useLayoutEffectTask`](#useeffecttask-and-uselayouteffecttask)
- [The task scope](#the-task-scope)
- [`useEvent`](#useevent)
- [Recipes](#recipes)
- [Behaviour details](#behaviour-details)
- [ESLint](#eslint)
- [When to use something else](#when-to-use-something-else)
- [Migrating from 0.1](#migrating-from-01)
- [Playground](#playground)
- [Contributing](#contributing)

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

Requires React 18 or 19. Ships ESM and CommonJS with TypeScript types. No dependencies.

## Why

The textbook async effect has four bugs hiding in plain sight:

```tsx
useEffect(() => {
  fetch(`/api/users/${userId}`)        // 1. never aborted: wasted work, and it can resolve after unmount
    .then((response) => response.json())
    .then((user) => setUser(user));    // 2. race: a slow response for the previous userId can land last
}, [userId]);                          // 3. the previous user stays on screen for the new userId
                                       // 4. errors vanish, and there is no loading state
```

Fixing it by hand means an `AbortController`, a `cancelled` flag, loading/error state, and cleanup
bookkeeping in every effect. This library is that bookkeeping, done once and tested against React 18
and 19 (including StrictMode and concurrent rendering):

```tsx
const user = useEffectState(({ signal }) => fetchUser(userId, { signal }), [userId]);
```

## `useEffectState`

Runs an async task as an effect and keeps its result in state.

```ts
function useEffectState<T>(
  task: (scope: EffectTaskScope) => T | PromiseLike<T>,
  deps: DependencyList,
  options?: UseEffectStateOptions<T>
): EffectState<T>;
```

The task runs after mount, again whenever `deps` change, and on `reload()`. Its return value (or
resolved value) becomes `data`. It receives the same [scope](#the-task-scope) as `useEffectTask`:
`signal`, `commit`, `onCleanup`, `sleep`, `abortable`, ...

### Returned state

| Field       | Type                                         | Description                                                                                       |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `status`    | `'idle' \| 'pending' \| 'success' \| 'error'` | Outcome for the **current deps**. `pending`: no result yet. `idle`: disabled and no result.        |
| `data`      | `T \| undefined`                             | Latest successful result (or `initialData`). Typed `T` when `status === 'success'`.               |
| `error`     | `unknown`                                    | The error when `status === 'error'`, otherwise `undefined`.                                        |
| `isRunning` | `boolean`                                    | A run is in flight: first load, deps change or `reload()`.                                         |
| `isPending` / `isSuccess` / `isError` | `boolean`          | Shorthands for `status` checks (they narrow the type too).                                         |
| `reload()`  | `() => void`                                 | Aborts the current run (if any) and runs the task again with the same deps. Keeps `data`/`status`. |
| `setData()` | `(value \| (previous) => value) => void`      | Replaces `data` locally (optimistic updates). Sets `status` to `success`.                          |

`status` and `isRunning` are independent on purpose: during `reload()` you keep showing data
(`status: 'success'`) while `isRunning` drives a subtle refresh indicator.

`status` is a discriminated union, so TypeScript narrows `data` and `error` for you:

```tsx
const { status, data, error } = useEffectState(loadTodos, []);
if (status === 'success') data.map(/* data: Todo[] */);
```

### Options

| Option             | Default     | Description                                                                                      |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------ |
| `enabled`          | `true`      | When `false` the task does not run (and a running one is aborted). `reload()` is ignored.        |
| `initialData`      | `undefined` | `data` until the first success, and after deps change. Value or lazy function (read once on mount). With it, `data` is typed `T` instead of `T \| undefined`. |
| `keepPreviousData` | `false`     | On deps change, keep the previous `data` while the new run is pending instead of resetting it.   |
| `onSuccess`        | —           | Called with the data after a run succeeds (current run only).                                    |
| `onError`          | —           | Called with the error after a run fails (current run only). The error is stored in state either way, and never logged. |
| `debugName`        | —           | Included in logged messages (for example cleanup errors).                                       |

### Transitions

| Event                         | `status`                                            | `data`                                    | `isRunning` |
| ----------------------------- | --------------------------------------------------- | ----------------------------------------- | ----------- |
| mount (enabled)               | `pending`                                           | `initialData`                             | `true`      |
| run resolves                  | `success`                                           | result                                    | `false`     |
| run rejects                   | `error`                                             | unchanged                                 | `false`     |
| deps change (same render)     | `pending`                                           | `initialData` (or previous with `keepPreviousData`) | `true` |
| `reload()`                    | unchanged                                           | unchanged                                 | `true`      |
| `setData(v)`                  | `success`                                           | `v`                                       | unchanged   |
| `enabled: false`              | `idle` if nothing settled yet, otherwise unchanged  | unchanged                                 | `false`     |

Results and errors from runs that already ended are ignored, so cancelling a run (deps change,
`reload()`, `enabled: false`, unmount) never produces an `error`.

## `useEffectTask` and `useLayoutEffectTask`

`useEffect` for async work, when you do not need the result as state (or manage state yourself).

```ts
function useEffectTask(task: EffectTask, deps: DependencyList, options?: UseEffectTaskOptions): void;
function useLayoutEffectTask(task: EffectTask, deps: DependencyList, options?: UseEffectTaskOptions): void;

type EffectTask = (scope: EffectTaskScope) =>
  void | (() => void) | PromiseLike<void | (() => void)>;
```

```tsx
useEffectTask(async ({ signal, commit }) => {
  const response = await fetch(`/api/todos/${todoId}`, { signal });
  const todo = await response.json();
  commit(() => setTodo(todo)); // skipped if this run already ended
}, [todoId]);
```

- The task may be sync or async. It may return (or resolve to) a cleanup function; a cleanup that
  arrives after the run ended is executed immediately. Because React cannot wait for promises, such
  a late cleanup can run after the next run already started: register cleanups with `onCleanup`
  right after acquiring a resource, and use `abortable()` / `isActive()` after an `await`.
- `useLayoutEffectTask` runs as a layout effect (after DOM mutations, before paint) and silently
  falls back to `useEffect` on the server, so React 18 never prints its SSR `useLayoutEffect` warning.

| Option      | Description                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `onError`   | Receives errors thrown by the task and by cleanups. Without it they surface like errors in a plain effect: through the global `reportError` in browsers (reaching `window.onerror`, error monitoring and dev overlays), otherwise `console.error`. The latest value is always used. |
| `debugName` | Included in logged errors.                                                                                      |
| `layout`    | **Deprecated**, use `useLayoutEffectTask`. Read once on mount.                                                   |

## The task scope

Both hooks pass the same scope to the task. A *run* starts when the effect fires and ends when it
is disposed: deps change, `reload()`, `enabled: false`, or unmount.

| Member              | Description                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `signal`            | `AbortSignal` aborted when the run ends. Pass it to `fetch`, `axios`, and other abortable APIs.                              |
| `isActive()`        | `true` until the run ends.                                                                                                   |
| `commit(fn)`        | Calls `fn` only if the run is still active. Use it around state updates after an `await`.                                  |
| `onCleanup(fn)`     | Registers a cleanup. Cleanups run in reverse order (LIFO) when the run ends; registering after that runs `fn` immediately.  |
| `sleep(ms)`         | Abortable delay: resolves after `ms`, rejects with the abort reason when the run ends. `await sleep(300)` first = debounce. |
| `abortable(promise)`| Wraps a promise that cannot take a signal; it rejects as soon as the run ends, so the task stops waiting.                    |
| `runId`             | Sequential run number for this hook instance (handy for logging).                                                           |

When a run ends, its signal is aborted first and then its cleanups run, newest first. The cleanup
returned by the task counts as registered when it is returned, so it runs before earlier
`onCleanup` registrations:

```tsx
useEffectTask(async ({ signal, onCleanup }) => {
  const connection = await connect({ signal });
  onCleanup(() => connection.close());         // runs second
  const subscription = connection.subscribe(onMessage);
  return () => subscription.unsubscribe();     // runs first
}, []);
```

## `useEvent`

```ts
function useEvent<T extends (...args: any[]) => any>(fn: T): T;
```

Returns a function with a stable identity that always calls the latest `fn`: the userland twin of
React 19.2's `useEffectEvent`, usable on React 18 too. Use it for callbacks that intervals,
subscriptions, effects or event handlers call later.

```tsx
const onTick = useEvent(() => setLog(`${count} ${label}`)); // always sees the latest count/label

useEffectTask(({ onCleanup }) => {
  const id = setInterval(onTick, 1000); // created once
  onCleanup(() => clearInterval(id));
}, [onTick]);
```

The latest `fn` is published in the commit phase, before any effect runs, so discarded concurrent
renders never leak into it. Do not call it during render: it throws on the first render, and on
later renders it would still see the previous render's values.

## Recipes

### Debounced search

```tsx
const results = useEffectState(
  async ({ signal, sleep }) => {
    await sleep(300); // typing ends this run, so the request below is never sent
    return searchUsers(query, { signal });
  },
  [query],
  { enabled: query.length > 0, initialData: [], keepPreviousData: true }
);
```

### Polling

```tsx
useEffectTask(async ({ signal, sleep, commit }) => {
  for (;;) {
    const status = await getJobStatus(jobId, { signal });
    commit(() => setStatus(status));
    if (status.done) return;
    await sleep(2000); // unmount / jobId change ends the loop
  }
}, [jobId]);
```

### Dependent requests

```tsx
const user = useEffectState(({ signal }) => fetchUser(userId, { signal }), [userId]);
const orgId = user.data?.orgId;
const org = useEffectState(({ signal }) => fetchOrg(orgId!, { signal }), [orgId], {
  enabled: orgId !== undefined
});
```

### Retry with backoff

```tsx
const report = useEffectState(async ({ signal, sleep }) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchReport(reportId, { signal });
    } catch (error) {
      if (attempt === 3 || signal.aborted) throw error;
      await sleep(2 ** attempt * 500);
    }
  }
}, [reportId]);
```

### Optimistic update

```tsx
const todos = useEffectState(({ signal }) => fetchTodos({ signal }), [], { initialData: [] });

async function toggle(todo: Todo) {
  todos.setData((list) => list.map((t) => (t.id === todo.id ? { ...t, done: !t.done } : t)));
  try {
    await saveTodo({ ...todo, done: !todo.done });
  } finally {
    todos.reload(); // re-sync with the server either way
  }
}
```

### Load more

```tsx
const [page, setPage] = useState(1);
const [items, setItems] = useState<Item[]>([]);

useEffectTask(async ({ signal, commit }) => {
  const next = await fetchItems(page, { signal });
  commit(() => setItems((previous) => (page === 1 ? next : [...previous, ...next])));
}, [page]);
```

### Subscriptions and non-abortable APIs

```tsx
useEffectTask(async ({ onCleanup, abortable, commit }) => {
  const sdk = await abortable(loadSdk()); // stops here if the run ends while loading
  const unsubscribe = sdk.onChange((value) => commit(() => setValue(value)));
  onCleanup(unsubscribe);
}, []);
```

## Behaviour details

- **StrictMode**: React mounts effects twice in development. The first run is aborted and cleaned
  up like any other run, and its result is ignored.
- **Concurrent rendering**: the latest task, callbacks and options are published in the commit
  phase, so renders that React throws away never leak into effects.
- **SSR**: effects never run on the server. `useEffectState` renders `pending` (or `idle` when
  disabled) with `initialData`, so hydration matches; the task starts on the client.
- **`<Activity mode="hidden">`** (React 19.2+): hiding a subtree ends its runs (signal aborted,
  cleanups run) while state is preserved; showing it again starts a new run.
- **Errors**: cancellation never produces errors: results and errors of runs that already ended are
  ignored (many libraries reject with their own error type when aborted, such as axios'
  `CanceledError`). `useEffectTask` also ignores `AbortError`s and reports other errors to
  `onError`; without it they surface like errors thrown in a plain effect (`reportError` in
  browsers, `console.error` elsewhere). `useEffectState` stores every error of the current run in
  `error` (an `AbortError` from your own controller included, so the state can never get stuck in
  `isRunning`). Errors thrown by cleanups are always reported, never swallowed.
- **Error boundaries**: task errors are reported, not thrown into render. To hand one to the nearest
  error boundary, rethrow it from a state update:
  `const [, setCrash] = useState(); ... { onError: (error) => setCrash(() => { throw error; }) }`.
- **Environments**: browsers, React Native, Node/Deno/Bun SSR, and edge runtimes. No reliance on
  `DOMException` or `process.env`.

## ESLint

`react-hooks/exhaustive-deps` can check the deps of these hooks too:

```js
// eslint.config.js
export default [
  // ...
  {
    rules: {
      'react-hooks/exhaustive-deps': [
        'warn',
        { additionalHooks: '(useEffectTask|useLayoutEffectTask|useEffectState)' }
      ]
    }
  }
];
```

One caveat: the plugin treats every hook whose name contains `Effect` like `useEffect`, so it also
warns that "Effect callbacks are synchronous" for `async` tasks. Tasks written as functions that
return a promise do not trigger it, for example
`useEffectState(({ signal }) => fetchUser(id, { signal }), [id])`.

## When to use something else

- **Server state shared across components** (caching, deduplication, background refetching,
  invalidation): use [TanStack Query](https://tanstack.com/query) or [SWR](https://swr.vercel.app).
  `useEffectState` is component-local and keeps no cache.
- **Suspense-first data loading**: React 19's `use()` with a cached promise, or your framework's
  loaders.
- **Everything else that belongs in an effect** (fetching for one component, subscriptions, timers,
  polling, imperative APIs): this library.

## Migrating from 0.1

`0.2` is a drop-in upgrade for almost all code. Behaviour changes:

- Errors thrown by cleanup functions are now reported (they were silently swallowed).
- The cleanup returned by a task now runs **before** cleanups registered earlier with `onCleanup`
  (consistent LIFO order).
- Without `onError`, task errors surface in every environment: through `reportError` in browsers
  (like errors thrown in a plain effect), otherwise `console.error`. 0.1 tried to log only outside
  production, but bundlers never replaced that check.
- `useEvent` callbacks throw if called during the first render (they would run with uncommitted
  values); call them from effects or event handlers.
- `layout: true` is deprecated in favour of `useLayoutEffectTask`, and is read once on mount.
- The package is now `"type": "module"` with correct dual ESM/CommonJS exports and types. If you
  deep-imported files from `dist/`, import from the package root instead.

## Playground

The [example app](./examples/vite-react) shows every feature against a simulated API with random
latency and a live network log, including a side-by-side race between naive `useEffect` and
`useEffectState`.

```bash
cd examples/vite-react
npm install
npm run dev
```

Or open it online: [StackBlitz](https://stackblitz.com/github/clagradi/UseEffectState/tree/main/examples/vite-react) ·
[CodeSandbox](https://codesandbox.io/s/github/clagradi/UseEffectState/tree/main/examples/vite-react).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). In short:

```bash
npm install
npm run check          # lint, typecheck, tests, build, package checks
npm run smoke:consumer # installs the packed tarball into a Node consumer and the example app
```

## License

[MIT](./LICENSE)
