import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { DependencyList } from 'react';
import { useCommitPhaseEffect } from './internal/environment';
import { reportError } from './internal/errors';
import { createRun, isPromiseLike } from './internal/run';
import type { EffectTaskScope } from './types';
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
  /** Label included in logged errors. */
  debugName?: string | undefined;
}

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
  /** Deps the snapshot belongs to. */
  deps: DependencyList;
  /** Whether the hook was enabled when the snapshot was produced. */
  enabled: boolean;
  /** Incremented by `reload()`; part of the effect's dependencies. */
  reloads: number;
  /** `initialData`, resolved once on mount; `data` falls back to it on deps change. */
  initial: T | undefined;
}

type Action<T> =
  | { type: 'sync'; deps: DependencyList; enabled: boolean; keep: boolean }
  | { type: 'success'; data: T }
  | { type: 'failure'; error: unknown }
  | { type: 'set'; value: T | ((previous: T | undefined) => T) }
  | { type: 'reload' };

function depsEqual(a: DependencyList, b: DependencyList): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let index = 0; index < a.length; index += 1) {
    if (!Object.is(a[index], b[index])) {
      return false;
    }
  }

  return true;
}

function reducer<T>(state: Snapshot<T>, action: Action<T>): Snapshot<T> {
  switch (action.type) {
    case 'sync': {
      // A run is about to start (enabled) or the hook was disabled.
      const fresh = !depsEqual(state.deps, action.deps);
      const data = fresh && !action.keep ? state.initial : state.data;
      const error = fresh ? undefined : state.error;
      let status: EffectStateStatus = fresh ? 'pending' : state.status;

      if (action.enabled) {
        status = status === 'idle' ? 'pending' : status;
      } else {
        status = status === 'pending' ? 'idle' : status;
      }

      const next: Snapshot<T> = {
        ...state,
        status,
        data,
        error,
        isRunning: action.enabled,
        deps: fresh ? action.deps : state.deps,
        enabled: action.enabled
      };

      return next.status === state.status &&
        Object.is(next.data, state.data) &&
        Object.is(next.error, state.error) &&
        next.isRunning === state.isRunning &&
        next.deps === state.deps &&
        next.enabled === state.enabled
        ? state
        : next;
    }
    case 'success':
      return { ...state, status: 'success', data: action.data, error: undefined, isRunning: false };
    case 'failure':
      return { ...state, status: 'error', error: action.error, isRunning: false };
    case 'set': {
      const value =
        typeof action.value === 'function'
          ? (action.value as (previous: T | undefined) => T)(state.data)
          : action.value;
      return { ...state, status: 'success', data: value, error: undefined };
    }
    case 'reload':
      if (!state.enabled) {
        return state;
      }
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
  options: UseEffectStateOptions<T> & { initialData: T | (() => T) }
): EffectState<T, T>;
export function useEffectState<T>(
  task: EffectStateTask<T>,
  deps: DependencyList,
  options?: UseEffectStateOptions<T>
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

  useCommitPhaseEffect(() => {
    optionsRef.current = options;
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
  const willSync = state.enabled !== enabled || !depsEqual(state.deps, deps);
  const view = willSync
    ? reducer(state, { type: 'sync', deps, enabled, keep })
    : state;

  useEffect(() => {
    // Commit what the render already derived (no-op when nothing changed).
    dispatch({ type: 'sync', deps, enabled, keep });

    if (!enabled) {
      return undefined;
    }

    const report = (what: string, error: unknown, onError?: (error: unknown) => void): void => {
      reportError(error, `useEffectState ${what}`, optionsRef.current?.debugName, onError);
    };

    const run = createRun(++runIdRef.current, (error) => report('cleanup failed', error));

    const succeed = (data: T): void => {
      if (!run.isActive()) {
        return;
      }

      dispatch({ type: 'success', data });

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
      if (!run.isActive()) {
        return;
      }

      dispatch({ type: 'failure', error });

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

    return run.dispose;
    // `deps` are the caller's; the task and callbacks are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, state.reloads]);

  const reload = useCallback(() => {
    dispatch({ type: 'reload' });
  }, []);

  const setData = useCallback<SetEffectStateData<T>>((value) => {
    dispatch({ type: 'set', value });
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
