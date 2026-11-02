import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useCommitPhaseEffect } from './internal/environment';
import { reportError } from './internal/errors';
import { createUnstableDepsDetector, depsEqual } from './internal/deps';
import { createRun, isPromiseLike } from './internal/run';
import type { Run } from './internal/run';
import type { DependencyList, EffectTaskScope } from './types';
import { useEvent } from './useEvent';

export type EffectStateStatus = 'idle' | 'pending' | 'success' | 'error';

/**
 * The function run by `useEffectState`: its return value (or resolved value)
 * becomes `data`. The scope is the same as `useEffectTask`'s; it deliberately
 * does not depend on `T`, so TypeScript infers `T` from the return type even
 * when the task destructures its argument.
 */
export type EffectStateTask<T> = (scope: EffectTaskScope) => T | PromiseLike<T>;

export interface UseEffectStateOptions<T> {
  /** When `false`, the task does not run. Defaults to `true`. */
  enabled?: boolean | undefined;
  /** `data` until the first successful run (and after deps change, unless `keepPreviousData`). */
  initialData?: T | (() => T) | undefined;
  /** Keep showing the previous `data` while the task runs for new deps. Defaults to `false`. */
  keepPreviousData?: boolean | undefined;
  /** Called after a run succeeds (only for the current run). */
  onSuccess?: ((data: T) => void) | undefined;
  /** Called after a run fails (only for the current run). The error is also stored in state. */
  onError?: ((error: unknown) => void) | undefined;
  /** Label for this hook in console messages (for example when a callback throws). */
  debugName?: string | undefined;
}

/**
 * Blocks inference from a position, so `T` is inferred from the task's return
 * type only (works on every TypeScript version, unlike the `NoInfer` intrinsic).
 */
type NoInferFrom<T> = [T][T extends unknown ? 0 : never];

export type SetEffectStateData<T, TFallback = T | undefined> = (
  value: T | ((previous: T | TFallback) => T)
) => void;

interface EffectStateControls<T, TFallback> {
  /** `true` while a run is in flight (first run, deps change or `reload()`). */
  readonly isRunning: boolean;
  /** Aborts the current run (if any) and runs the task again with the same deps. */
  readonly reload: () => void;
  /** Replaces `data` locally (for example an optimistic update). Sets status to `'success'`. */
  readonly setData: SetEffectStateData<T, TFallback>;
}

export type EffectState<T, TFallback = T | undefined> = EffectStateControls<T, TFallback> &
  (
    | {
        readonly status: 'idle';
        readonly data: TFallback;
        readonly error: undefined;
        readonly isPending: false;
        readonly isSuccess: false;
        readonly isError: false;
      }
    | {
        readonly status: 'pending';
        readonly data: TFallback;
        readonly error: undefined;
        readonly isPending: true;
        readonly isSuccess: false;
        readonly isError: false;
      }
    | {
        readonly status: 'success';
        readonly data: T;
        readonly error: undefined;
        readonly isPending: false;
        readonly isSuccess: true;
        readonly isError: false;
      }
    | {
        readonly status: 'error';
        readonly data: TFallback;
        readonly error: unknown;
        readonly isPending: false;
        readonly isSuccess: false;
        readonly isError: true;
      }
  );

interface Snapshot<T> {
  status: EffectStateStatus;
  data: T | undefined;
  error: unknown;
  isRunning: boolean;
  /**
   * Deps the visible state belongs to. Recorded together with a visible change
   * or when a run settles, never on its own: a deps array that is a new object
   * on every render must not be able to re-render the hook by itself.
   */
  deps: DependencyList;
  /** `enabled` when `deps` was recorded. */
  enabled: boolean;
  /** Incremented by `reload()`; part of the effect's dependencies. */
  reloads: number;
  /** `initialData`, resolved once on mount; `data` falls back to it on deps change. */
  initial: T | undefined;
}

/** What the latest render asks for. */
interface Target {
  deps: DependencyList;
  enabled: boolean;
  keep: boolean;
}

type Action<T> =
  | ({ type: 'sync' } & Target)
  | { type: 'success'; data: T; deps: DependencyList }
  | { type: 'failure'; error: unknown; deps: DependencyList }
  | { type: 'set'; value: T | ((previous: T | undefined) => T); target: Target }
  | { type: 'reload' };

/** The state once the effect for `target` has started (enabled) or stopped (disabled) a run. */
function synced<T>(state: Snapshot<T>, target: Target): Snapshot<T> {
  const fresh = !depsEqual(state.deps, target.deps);
  // keepPreviousData bridges the wait for a new run; without a run (the deps
  // change also disabled the hook) the old data would stay forever.
  const data = fresh && !(target.keep && target.enabled) ? state.initial : state.data;
  let status: EffectStateStatus = fresh ? 'pending' : state.status;

  if (target.enabled) {
    status = status === 'idle' ? 'pending' : status;
  } else {
    status = status === 'pending' ? 'idle' : status;
  }

  return {
    ...state,
    status,
    data,
    error: fresh ? undefined : state.error,
    isRunning: target.enabled,
    deps: target.deps,
    enabled: target.enabled
  };
}

function sameVisibleState<T>(a: Snapshot<T>, b: Snapshot<T>): boolean {
  return (
    a.status === b.status &&
    Object.is(a.data, b.data) &&
    Object.is(a.error, b.error) &&
    a.isRunning === b.isRunning
  );
}

function reducer<T>(state: Snapshot<T>, action: Action<T>): Snapshot<T> {
  switch (action.type) {
    case 'sync': {
      const next = synced(state, action);
      return sameVisibleState(next, state) ? state : next;
    }
    case 'success':
      return {
        ...state,
        status: 'success',
        data: action.data,
        error: undefined,
        isRunning: false,
        deps: action.deps,
        enabled: true
      };
    case 'failure':
      return {
        ...state,
        status: 'error',
        error: action.error,
        isRunning: false,
        deps: action.deps,
        enabled: true
      };
    case 'set': {
      // setData() can run before the effect that syncs new deps (for example
      // from a child's effect in the same commit): apply it to the new deps.
      const base =
        state.enabled === action.target.enabled && depsEqual(state.deps, action.target.deps)
          ? state
          : synced(state, action.target);
      const value =
        typeof action.value === 'function'
          ? (action.value as (previous: T | undefined) => T)(base.data)
          : action.value;

      if (base === state && state.status === 'success' && Object.is(value, state.data)) {
        return state;
      }

      return { ...base, status: 'success', data: value, error: undefined };
    }
    case 'reload':
      return { ...state, isRunning: true, reloads: state.reloads + 1 };
  }
}

function resolveInitial<T>(initialData: T | (() => T) | undefined): T | undefined {
  return typeof initialData === 'function' ? (initialData as () => T)() : initialData;
}

/**
 * Runs an async task as an effect and keeps its result in state.
 *
 * Same run semantics as `useEffectTask` (per-run AbortSignal, cleanups,
 * stale results ignored), plus `status`, `data`, `error`, `isRunning`,
 * `reload()` and `setData()`. When `deps` change, the hook reports
 * `'pending'` in that very render, so old data is never shown as the result
 * for new deps.
 *
 * @example
 * const user = useEffectState(async ({ signal }) => {
 *   const response = await fetch(`/api/users/${id}`, { signal });
 *   return (await response.json()) as User;
 * }, [id]);
 */
export function useEffectState<T>(
  task: EffectStateTask<T>,
  deps: DependencyList,
  options: UseEffectStateOptions<NoInferFrom<T>> & {
    initialData: NoInferFrom<T> | (() => NoInferFrom<T>);
  }
): EffectState<T, T>;
export function useEffectState<T>(
  task: EffectStateTask<T>,
  deps: DependencyList,
  options?: UseEffectStateOptions<NoInferFrom<T>>
): EffectState<T>;
export function useEffectState<T>(
  task: EffectStateTask<T>,
  deps: DependencyList,
  options?: UseEffectStateOptions<T>
): EffectState<T> {
  const enabled = options?.enabled !== false;
  const keep = options?.keepPreviousData === true;

  const runTask = useEvent(task);
  const optionsRef = useRef(options);
  const runIdRef = useRef(0);
  // What the latest *committed* render asks for (never a discarded render).
  const committedRef = useRef<Target>({ deps, enabled, keep });
  const currentRunRef = useRef<Run | null>(null);
  const [detectUnstableDeps] = useState(() => createUnstableDepsDetector('useEffectState'));

  useCommitPhaseEffect(() => {
    optionsRef.current = options;
    committedRef.current = { deps, enabled, keep };
  });

  const [state, dispatch] = useReducer(
    reducer as (state: Snapshot<T>, action: Action<T>) => Snapshot<T>,
    undefined,
    (): Snapshot<T> => {
      const initial = resolveInitial(options?.initialData);
      return {
        status: enabled ? 'pending' : 'idle',
        data: initial,
        error: undefined,
        isRunning: enabled,
        deps,
        enabled,
        reloads: 0,
        initial
      };
    }
  );

  // Render-time derivation: if this render's deps/enabled differ from the
  // snapshot's, the effect below is about to start (or stop) a run. Report that
  // now, so a render never shows a previous result as if it belonged to new deps.
  const view =
    state.enabled !== enabled || !depsEqual(state.deps, deps)
      ? reducer(state, { type: 'sync', deps, enabled, keep })
      : state;

  useEffect(() => {
    // Commit what the render derived (a no-op unless something visible changes).
    dispatch({ type: 'sync', deps, enabled, keep });

    if (!enabled) {
      return undefined;
    }

    detectUnstableDeps(deps, optionsRef.current?.debugName);

    const report = (what: string, error: unknown, onError?: (error: unknown) => void): void => {
      reportError(error, `useEffectState ${what}`, optionsRef.current?.debugName, onError);
    };

    const run = createRun(++runIdRef.current, (error) => report('cleanup failed', error));
    currentRunRef.current = run;

    // A run counts while it is not disposed and the latest committed render
    // still asks for it: between a commit with new deps (or enabled: false) and
    // the cleanup that disposes this run, its outcome must not land.
    const isCurrent = (): boolean => {
      const committed = committedRef.current;
      return run.isActive() && committed.enabled && depsEqual(committed.deps, deps);
    };

    const succeed = (data: T): void => {
      if (!isCurrent()) {
        return;
      }

      dispatch({ type: 'success', data, deps });

      const onSuccess = optionsRef.current?.onSuccess;
      if (onSuccess) {
        try {
          onSuccess(data);
        } catch (error) {
          report('onSuccess failed', error);
        }
      }
    };

    const fail = (error: unknown): void => {
      // The run's own signal is only aborted after the run became inactive, so
      // this already ignores every cancellation caused by the hook. An abort from
      // another source (for example the task's own timeout controller) settles
      // the task, so it must become an error instead of leaving `isRunning` stuck.
      if (!isCurrent()) {
        return;
      }

      dispatch({ type: 'failure', error, deps });

      const onError = optionsRef.current?.onError;
      if (onError) {
        try {
          onError(error);
        } catch (handlerError) {
          report('onError failed', handlerError);
        }
      }
    };

    try {
      const output = runTask(run.scope);

      if (isPromiseLike<T>(output)) {
        Promise.resolve(output).then(succeed, fail);
      } else {
        succeed(output);
      }
    } catch (error) {
      fail(error);
    }

    return () => {
      if (currentRunRef.current === run) {
        currentRunRef.current = null;
      }
      run.dispose();
    };
    // `deps` are the caller's; the task and callbacks are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, state.reloads]);

  const reload = useCallback(() => {
    if (!committedRef.current.enabled) {
      return;
    }
    // End the run in flight right away, so its outcome can never land.
    currentRunRef.current?.dispose();
    dispatch({ type: 'reload' });
  }, []);

  const setData = useCallback<SetEffectStateData<T>>((value) => {
    dispatch({ type: 'set', value, target: committedRef.current });
  }, []);

  return useMemo(
    () =>
      ({
        status: view.status,
        data: view.data,
        error: view.error,
        isRunning: view.isRunning,
        isPending: view.status === 'pending',
        isSuccess: view.status === 'success',
        isError: view.status === 'error',
        reload,
        setData
      }) as EffectState<T>,
    [view.status, view.data, view.error, view.isRunning, reload, setData]
  );
}
