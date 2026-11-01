import { useEffect, useRef, useState } from 'react';
import type { DependencyList } from 'react';
import { useCommitPhaseEffect, useIsomorphicLayoutEffect } from './internal/environment';
import { isAbortError, reportError } from './internal/errors';
import { createRun, isPromiseLike } from './internal/run';
import type { EffectTaskCleanup, EffectTaskScope } from './types';
import { useEvent } from './useEvent';

/**
 * The function run by `useEffectTask`. It may be sync or async and may return
 * (or resolve to) a cleanup function. Prefer `scope.onCleanup` for cleanups:
 * it also works for resources acquired before an `await`.
 */
export type EffectTask = (
  scope: EffectTaskScope
) => void | EffectTaskCleanup | PromiseLike<void | EffectTaskCleanup>;

export interface UseEffectTaskOptions {
  /**
   * Receives errors thrown by the task and by its cleanups. Without it they are
   * logged with `console.error`. Abort errors and errors from runs that already
   * ended are never reported. The latest value is always used.
   */
  onError?: ((error: unknown) => void) | undefined;
  /** Label included in logged errors. */
  debugName?: string | undefined;
  /**
   * Run as a layout effect.
   *
   * @deprecated Use `useLayoutEffectTask` instead. Read once on mount: changing
   * it later has no effect (switching effect kinds would break the Rules of Hooks).
   */
  layout?: boolean | undefined;
}

type EffectHook = typeof useEffect;

function useTaskRunner(
  useEffectHook: EffectHook,
  hookName: string,
  task: EffectTask,
  deps: DependencyList,
  options: UseEffectTaskOptions | undefined,
  frozenLayout?: boolean
): void {
  const runTask = useEvent(task);
  const optionsRef = useRef(options);
  const runIdRef = useRef(0);
  const warnedRef = useRef(false);

  useCommitPhaseEffect(() => {
    optionsRef.current = options;

    if (
      frozenLayout !== undefined &&
      !warnedRef.current &&
      (options?.layout === true) !== frozenLayout
    ) {
      warnedRef.current = true;
      console.warn(
        `[effect-runtime] ${hookName}: the \`layout\` option changed after mount and is ignored. ` +
          'Use useLayoutEffectTask for layout effects.'
      );
    }
  });

  // `useEffectHook` is always useEffect or useLayoutEffect (picked once per
  // environment), so this callback never runs during render.
  // eslint-disable-next-line react-hooks/refs
  useEffectHook(() => {
    const report = (what: string, error: unknown): void => {
      const current = optionsRef.current;
      reportError(error, `${hookName} ${what}`, current?.debugName, current?.onError);
    };

    const run = createRun(++runIdRef.current, (error) => report('cleanup failed', error));

    const reportTaskError = (error: unknown): void => {
      if (run.isActive() && !isAbortError(error, run.signal)) {
        report('task failed', error);
      }
    };

    try {
      const output = runTask(run.scope);

      if (typeof output === 'function') {
        run.addCleanup(output);
      } else if (isPromiseLike<void | EffectTaskCleanup>(output)) {
        Promise.resolve(output).then((cleanup) => {
          // A cleanup that arrives after the run ended is executed immediately.
          if (typeof cleanup === 'function') {
            run.addCleanup(cleanup);
          }
        }, reportTaskError);
      }
    } catch (error) {
      reportTaskError(error);
    }

    return run.dispose;
    // The task is read through useEvent, so only the caller's deps decide when a run starts.
  }, deps);
}

/**
 * `useEffect` for async work, done right.
 *
 * Every run gets its own `AbortSignal` (aborted on re-run and unmount), a
 * `commit()` guard against stale results, LIFO cleanups via `onCleanup()`,
 * abortable `sleep()` / `abortable()` helpers, and errors are reported instead
 * of disappearing. The latest `task` is always the one that runs, so it never
 * sees stale props or state; `deps` decide *when* it runs.
 *
 * @example
 * useEffectTask(async ({ signal, commit }) => {
 *   const response = await fetch(`/api/users/${id}`, { signal });
 *   const user = await response.json();
 *   commit(() => setUser(user));
 * }, [id]);
 */
export function useEffectTask(
  task: EffectTask,
  deps: DependencyList,
  options?: UseEffectTaskOptions
): void {
  // Read once: the effect kind must not change between renders.
  const [layout] = useState(() => options?.layout === true);

  useTaskRunner(
    layout ? useIsomorphicLayoutEffect : useEffect,
    'useEffectTask',
    task,
    deps,
    options,
    layout
  );
}

/**
 * Same as `useEffectTask`, but runs as a layout effect: after DOM mutations and
 * before the browser paints. Falls back to a passive effect on the server, so it
 * never triggers React's SSR `useLayoutEffect` warning.
 */
export function useLayoutEffectTask(
  task: EffectTask,
  deps: DependencyList,
  options?: Omit<UseEffectTaskOptions, 'layout'>
): void {
  useTaskRunner(useIsomorphicLayoutEffect, 'useLayoutEffectTask', task, deps, options);
}
