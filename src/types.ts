/**
 * The dependency array of the hooks: compared item by item with `Object.is`,
 * like `useEffect`'s. Same shape as React's `DependencyList`, declared here so
 * the published types do not depend on `@types/react`.
 */
export type DependencyList = readonly unknown[];

/** A cleanup function registered for a run. */
export type EffectTaskCleanup = () => void;

/**
 * Everything a task needs to behave correctly while it runs.
 *
 * Members are plain functions (not methods), so destructuring them is safe:
 * `({ signal, commit, onCleanup }) => ...`.
 *
 * A *run* starts when the effect fires (mount, deps change, reload) and ends
 * when it is disposed (deps change, reload, unmount, or the hook is disabled).
 */
export interface EffectTaskScope {
  /** Aborted when this run ends. Pass it to `fetch` and other abortable APIs. */
  readonly signal: AbortSignal;
  /** Sequential id of this run within the hook instance (1, 2, 3, ...). */
  readonly runId: number;
  /** `true` while this run is the current one and has not been disposed. */
  readonly isActive: () => boolean;
  /**
   * Runs `fn` only if this run is still active, so stale async work can never
   * overwrite newer state.
   */
  readonly commit: (fn: () => void) => void;
  /**
   * Registers a cleanup for this run. Cleanups run in reverse order of
   * registration (LIFO). Registering after the run ended runs it immediately.
   */
  readonly onCleanup: (fn: EffectTaskCleanup) => void;
  /**
   * Resolves after `ms` milliseconds, or rejects with the abort reason as soon
   * as the run ends, which stops the task at that `await`. `await sleep(300)`
   * at the start of a task debounces it.
   */
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * Wraps a promise that cannot take an `AbortSignal` so that it rejects with
   * the abort reason as soon as the run ends. The underlying work is not
   * cancelled, but the task stops waiting for it.
   */
  readonly abortable: <T>(promise: PromiseLike<T>) => Promise<T>;
}
