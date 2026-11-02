# useEffectState and useEffectTask for React

[![npm version](https://img.shields.io/npm/v/@clagradi/effect-runtime.svg)](https://www.npmjs.com/package/@clagradi/effect-runtime)
[![CI](https://github.com/clagradi/UseEffectState/actions/workflows/ci.yml/badge.svg)](https://github.com/clagradi/UseEffectState/actions/workflows/ci.yml)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@clagradi/effect-runtime)](https://bundlephobia.com/package/@clagradi/effect-runtime)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/clagradi/UseEffectState/blob/main/LICENSE)

**`@clagradi/effect-runtime`: async effects for React that cancel, clean up and race correctly.**
Tiny, dependency-free, typed, React 18 and 19, StrictMode-, SSR- and `<Activity>`-safe.
(Not related to the Effect-TS library.)

```tsx
import { useEffectState } from '@clagradi/effect-runtime';

function UserCard({ userId }: { userId: string }) {
  const user = useEffectState(async ({ signal }) => {
    const response = await fetch(`/api/users/${userId}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as User;
  }, [userId]);

  if (user.status === 'error') return <ErrorMessage error={user.error} retry={user.reload} />;
  if (user.status !== 'success') return <Spinner />;
  return <Profile user={user.data} refreshing={user.isRunning} />; // user.data: User
}
```

- **No races.** Every run gets its own `AbortSignal`; outcomes of runs that ended are ignored.
- **No leaks.** Runs are aborted on re-run and unmount; cleanups run in LIFO order, even when they arrive late.
- **No stale UI.** When deps change, `useEffectState` is `pending` in the same render: a previous result is never shown as the result for new deps.
- **No stale closures.** The latest committed task always runs; deps only decide *when*.
- **No swallowed errors.** Task and cleanup errors are reported (or stored in state), cancellations are not.

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

Requires React 18 or 19. Ships ESM and CommonJS with TypeScript types (TS 5.0+). No dependencies.

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
and 19 (including StrictMode, `<Activity>` and concurrent rendering):

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
resolved value) becomes `data`. It receives the same [scope](#the-task-scope) as `useEffectTask`
(`signal`, `commit`, `onCleanup`, `sleep`, ...), so side effects that belong to a run go in the task.

`deps` work exactly like `useEffect`'s (compared with `Object.is`). Keep them primitive or stable: a
dependency recreated on every render (an inline object, array or function) makes React stop with
"Too many re-renders", so the mistake shows up immediately instead of refetching forever.

### Returned state

| Field               | Type                                          | Description                                                                                         |
| ------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `status`            | `'idle' \| 'pending' \| 'success' \| 'error'` | Outcome for the **current deps**. `pending`: no outcome yet. `idle`: disabled and no outcome.        |
| `data`              | `T \| undefined`                              | Latest result, or a stand-in (see `isPlaceholderData`). Typed `T` when `status === 'success'`.       |
| `error`             | `unknown`                                     | The error when `status === 'error'`, otherwise `undefined`.                                          |
| `isRunning`         | `boolean`                                     | A run whose outcome will be applied is in flight: first run, deps change or `reload()`.             |
| `isPlaceholderData` | `boolean`                                     | `data` is a stand-in (`placeholderData`, or the previous deps' data kept by `keepPreviousData`).    |
| `reload()`          | `() => void`                                  | Runs the task again with the same deps (the run in flight is aborted at the next commit). Keeps `status`, `data` and `error` until the new run settles. Does nothing while disabled. |
| `setData()`         | `(value \| (previous) => value) => void`       | Replaces `data` locally (optimistic updates): `status` becomes `success`. A run in flight still replaces it when it settles. |

`status` and `isRunning` are independent on purpose: during `reload()` you keep showing the data
(`status: 'success'`) or the error (`status: 'error'`) while `isRunning` drives a refresh indicator.

`status` is a discriminated union, so TypeScript narrows the other fields for you, also after
destructuring:

```tsx
const { status, data, error } = useEffectState(loadTodos, []);
if (status === 'success') data.map(/* data: Todo[] */);
```

### Options

| Option             | Default     | Description                                                                                       |
| ------------------ | ----------- | ------------------------------------------------------------------------------------------------- |
| `enabled`          | `true`      | When `false` the task does not run: a run in flight is aborted, `reload()` does nothing, `pending` becomes `idle`. Other values go through `Boolean()`. |
| `placeholderData`  | `undefined` | `data` while there is no outcome for the current deps. Captured when the hook enters new deps (mount and each deps change), so a value derived from props stays right. With it, `data` is typed `T` instead of `T \| undefined`. |
| `keepPreviousData` | `false`     | On deps change, keep the data on screen (with `isPlaceholderData: true`) until the new run settles, instead of switching to `placeholderData`. Never carries data into `idle`. |

There are no `onSuccess` / `onError` callbacks: the task body is already the place for side
effects of a run, and errors live in `error`.

### Transitions

| Event                              | `status`                                     | `data`                                            | `isRunning` |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------- | ----------- |
| mount (enabled)                    | `pending`                                    | `placeholderData`                                 | `true`      |
| run resolves                       | `success`                                    | result                                            | `false`     |
| run rejects                        | `error`                                      | unchanged                                         | `false`     |
| deps change (same render)          | `pending`                                    | `placeholderData`, or the data on screen with `keepPreviousData` | `true` |
| `reload()`                         | unchanged                                    | unchanged                                         | `true`      |
| `setData(v)`                       | `success`                                    | `v`                                               | unchanged   |
| `enabled: false`                   | `idle` if `pending`, otherwise unchanged      | `placeholderData` if it was `pending`, otherwise unchanged | `false` |
| `enabled: true` again              | `pending` if `idle`, otherwise unchanged     | unchanged                                         | `true`      |

Outcomes of runs that ended are ignored, so cancelling a run (deps change, `reload()`,
`enabled: false`, unmount) never produces an `error`. This holds from the moment the change
commits, even before React runs the effect cleanup that aborts the old run.

## `useEffectTask` and `useLayoutEffectTask`

`useEffect` for async work, when you do not need the result as state (or manage state yourself).

```ts
function useEffectTask(task: EffectTask, deps: DependencyList, options?: UseEffectTaskOptions): void;
function useLayoutEffectTask(
  task: EffectTask,
  deps: DependencyList,
  options?: Omit<UseEffectTaskOptions, 'layout'>
): void;

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
  right after acquiring a resource, and check `isActive()` after an `await`.
- `useLayoutEffectTask` runs as a layout effect (after DOM mutations, before paint) and falls back
  to `useEffect` on the server, so React 18 never prints its SSR `useLayoutEffect` warning.

| Option      | Description                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `onError`   | Receives errors thrown by the task and by cleanups. Without it they surface like errors in a plain effect: through the global `reportError` in browsers (reaching `window.onerror`, error monitoring and dev overlays), `ErrorUtils.reportError` on React Native, otherwise `console.error`. The latest value is always used. |
| `debugName` | Labels this hook in console messages. With it, errors handed to `reportError` / `ErrorUtils` also get a labelled `console.warn`. |
| `layout`    | **Deprecated**, use `useLayoutEffectTask`. Read once on mount.                                                   |

## The task scope

All hooks pass the same scope to the task. A *run* starts when the effect fires and ends when it is
disposed: deps change, `reload()`, `enabled: false`, `<Activity>` hiding the component, or unmount.
Its members are plain functions, so destructuring them is safe.

| Member          | Description                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `signal`        | `AbortSignal` aborted when the run ends (reason: an `AbortError`, "The effect run ended."). Pass it to `fetch`, `axios`, ...      |
| `isActive()`    | `true` until the run ends.                                                                                                          |
| `commit(fn)`    | Calls `fn` only if the run is still active. Use it around state updates after an `await`.                                          |
| `onCleanup(fn)` | Registers a cleanup. Cleanups run in reverse order (LIFO) when the run ends; registering after that runs `fn` immediately. Returns a function that runs `fn` early (at most once) and unregisters it. |
| `sleep(ms)`     | Abortable delay: resolves after `ms`, rejects with the abort reason when the run ends. `await sleep(300)` first = debounce.        |
| `runId`         | Sequential run number for this hook instance (handy for logging).                                                                  |

When a run ends, it is marked inactive, its signal is aborted, and then its cleanups run, newest
first. The cleanup returned by the task counts as registered when it is returned, so it runs before
earlier `onCleanup` registrations:

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
function useEvent<T extends Function>(fn: T): T;
```

Returns a function with a stable identity that always calls the latest committed `fn`: like React
19.2's `useEffectEvent` (same typing), but usable on React 18 too, and callable from anywhere that
is not render (effects, event handlers, timers, subscriptions, child components).

```tsx
const onTick = useEvent(() => setLog(`${count} ${label}`)); // always sees the latest count/label

useEffectTask(({ onCleanup }) => {
  const id = setInterval(onTick, 1000); // created once
  onCleanup(() => clearInterval(id));
}, [onTick]);
```

The latest `fn` is published in the commit phase, before layout and passive effects run (also those
of child components), so discarded concurrent renders never leak into it. Do not call it during
render or from insertion effects: before the first commit it throws, and later it would still see
the previous render's values. Only the call is forwarded, not properties of a callable object.

## Recipes

### Debounced search

```tsx
const results = useEffectState(
  async ({ signal, sleep }) => {
    await sleep(300); // typing ends this run, so the request below is never sent
    return searchUsers(query, { signal });
  },
  [query],
  { enabled: query.length > 0, placeholderData: [], keepPreviousData: true }
);
```

### Pagination

```tsx
const page = useEffectState(({ signal }) => fetchPage(pageNumber, { signal }), [pageNumber], {
  keepPreviousData: true
});

<List items={page.data ?? []} dimmed={page.isPlaceholderData} />;
<button disabled={page.isPlaceholderData} onClick={() => setPageNumber((n) => n + 1)}>Next</button>;
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

### Run on demand

```tsx
const [request, setRequest] = useState<ReportRequest | null>(null);
const report = useEffectState(({ signal }) => buildReport(request!, { signal }), [request], {
  enabled: request !== null
});

// A new request object starts a new run; clearing it cancels.
<button onClick={() => setRequest({ from, to })}>Generate</button>;
<button onClick={() => setRequest(null)} disabled={!report.isRunning}>Cancel</button>;
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
const [saving, setSaving] = useState(0);
const todos = useEffectState(({ signal }) => fetchTodos({ signal }), [], {
  enabled: saving === 0, // pause reads while saving, so an older read cannot overwrite the change
  placeholderData: []
});

async function toggle(todo: Todo) {
  todos.setData((list) => list.map((t) => (t.id === todo.id ? { ...t, done: !t.done } : t)));
  setSaving((count) => count + 1);
  try {
    await saveTodo({ ...todo, done: !todo.done });
  } finally {
    setSaving((count) => count - 1); // enabling again re-reads from the server
  }
}
```

### Load more

```tsx
const [page, setPage] = useState(1);
const [items, setItems] = useState<Item[]>([]);

const current = useEffectState(async ({ signal, commit }) => {
  const next = await fetchItems(page, { signal });
  commit(() => setItems((previous) => (page === 1 ? next : [...previous, ...next])));
  return next;
}, [page]);

// Changing `page` aborts the page in flight, so wait for it before asking for the next one.
<button disabled={current.isRunning} onClick={() => setPage((value) => value + 1)}>
  Load more
</button>;
```

### Subscriptions to APIs without a signal

```tsx
useEffectTask(async ({ isActive, onCleanup, commit }) => {
  const sdk = await loadSdk();
  if (!isActive()) return; // the run ended while loading
  onCleanup(sdk.onChange((value) => commit(() => setValue(value))));
}, []);
```

### Error boundaries

Errors are stored (`useEffectState`) or reported (`useEffectTask`), not thrown into render. To hand
one to the nearest error boundary, rethrow it during render:

```tsx
const user = useEffectState(loadUser, [id]);
if (user.status === 'error') throw user.error;
```

## Behaviour details

- **StrictMode**: React mounts effects twice in development. The first run is aborted and cleaned
  up like any other run, and its outcome is ignored. (A task that finishes synchronously completes
  before React's extra unmount, so in development its side effects run twice, like any synchronous
  effect code.)
- **Concurrent rendering**: the task that runs is always the latest *committed* one, and late
  callbacks read the latest committed options, so renders that React throws away never leak in.
  A deps change is applied during the render itself and commits once.
- **SSR and hydration**: effects never run on the server. `useEffectState` renders `pending` (or
  `idle` when disabled) with `placeholderData`, so hydration matches; the task starts on the client.
- **`<Activity mode="hidden">`** (React 19.2+): hiding a subtree ends its runs (signal aborted,
  cleanups run) while state is preserved; showing it again starts a new run without a `pending`
  flash (`isRunning` turns `true` one commit after the reveal).
- **Errors**: cancellation never produces errors: anything from runs that already ended is ignored
  (many libraries reject with their own error type when aborted, such as axios' `CanceledError`).
  `useEffectTask` also ignores `AbortError`s and reports other errors to `onError`; without it they
  surface like errors thrown in a plain effect (`reportError` in browsers, `ErrorUtils.reportError`
  on React Native, `console.error` elsewhere). `useEffectState` stores every error of the current run
  in `error`, an `AbortError` from your own controller included, so the state never hangs in
  `isRunning`. Errors thrown by cleanups are always reported, never swallowed.
- **Environments**: browsers, React Native, Node/Deno/Bun SSR and edge runtimes. Nothing relies on
  `DOMException`, `process.env` or `reportError` existing.

## ESLint

`eslint-plugin-react-hooks` can check the deps of these hooks too. Its shared setting covers both
`exhaustive-deps` and the `useEffectEvent` call-site rule:

```js
// eslint.config.js
export default [
  // ...
  {
    settings: {
      'react-hooks': {
        additionalEffectHooks: '^(useEffectTask|useLayoutEffectTask|useEffectState)$'
      }
    }
  }
];
```

It also flags the inline object/array/function deps that make `useEffectState` stop with "Too many
re-renders". One caveat: the plugin treats every hook whose name contains `Effect` like
`useEffect`, so it also warns that "Effect callbacks are synchronous" for `async` tasks. Tasks
written as functions that return a promise do not trigger it, for example
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

`0.2` is a drop-in upgrade for almost all `useEffectTask` / `useEvent` code. Behaviour changes:

- Errors thrown by cleanup functions are now reported (they were silently swallowed).
- The cleanup returned by a task now runs **before** cleanups registered earlier with `onCleanup`
  (consistent LIFO order).
- Without `onError`, task errors surface in every environment: through `reportError` in browsers
  (like errors thrown in a plain effect), `ErrorUtils.reportError` on React Native, otherwise
  `console.error`. 0.1 tried to log only outside production, but bundlers never replaced that check.
- The run's `signal.reason` is an `AbortError` with the message "The effect run ended.".
- `onCleanup()` returns a function that runs the cleanup early (the 0.1 idiom
  `({ onCleanup }) => onCleanup(fn)` still runs `fn` exactly once).
- `useEvent` callbacks throw if called during the first render (they would run with uncommitted
  values); call them from effects or event handlers. `useEvent` is now typed like React's
  `useEffectEvent`: annotate callback parameters (strict TypeScript no longer lets them be `any`).
- `layout: true` is deprecated in favour of `useLayoutEffectTask`, and is read once on mount.
- The package is now `"type": "module"` with correct dual ESM/CommonJS exports and types, and the
  peer range is `react ^18.0.0 || ^19.0.0`. If you deep-imported files from `dist/`, import from
  the package root instead.

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
npm run check          # lint, typecheck, tests with coverage, build, package checks
npm run smoke:consumer # installs the packed tarball into a Node consumer and the example app
```

## License

[MIT](./LICENSE)
