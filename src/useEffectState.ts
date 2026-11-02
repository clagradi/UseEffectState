import { useEffect, useMemo, useRef, useState } from 'react';
import { depsEqual } from './internal/deps';
import { useCommitPhaseEffect } from './internal/environment';
import { reportError } from './internal/errors';
import { createRun, isPromiseLike } from './internal/run';
import type { DependencyList, EffectTaskScope } from './types';

export type EffectStateStatus = 'idle' | 'pending' | 'success' | 'error';

/**
 * The function run by `useEffectState`: its return value (or resolved value)
 * becomes `data`. The scope deliberately does not depend on `T`, so TypeScript
 * infers `T` from the return type even when the task destructures its scope.
 */
export type EffectStateTask<T> = (scope: EffectTaskScope) => T | PromiseLike<T>;

/**
 * Blocks inference from a position, so `T` is inferred from the task's return
 * type only (works on every TypeScript version, unlike the `NoInfer` intrinsic).
 */
type NoInferFrom<T> = [T][T extends unknown ? 0 : never];

export interface UseEffectStateOptions<T> {
  /**
   * When `false`, the task does not run: a run in flight is aborted, `reload()`
   * does nothing and `pending` becomes `idle`. Defaults to `true`; any other
   * value goes through `Boolean()`, so `enabled: items.length` is safe.
   */
  enabled?: boolean | undefined;
  /**
   * `data` while there is no outcome for the current deps (status `pending` or
   * `idle`). Captured when the hook enters new deps (mount and every deps
   * change), so a value derived from props stays right for the deps it belongs
   * to. With it, `data` is typed `T` instead of `T | undefined`.
   */
  placeholderData?: NoInferFrom<T> | undefined;
  /**
   * When deps change, keep the data on screen (marked `isPlaceholderData`)
   * until the run for the new deps settles, instead of switching to
   * `placeholderData`. Never carries data into `idle`. Defaults to `false`.
   */
  keepPreviousData?: boolean | undefined;
}

export type SetEffectStateData<T, TData = T | undefined> = (
  value: T | ((previous: TData) => T)
) => void;

interface EffectStateControls<T, TData> {
  /**
   * Runs the task again with the same deps: the run in flight is aborted at the
   * next commit and `isRunning` stays `true` until the new run settles. Keeps
   * `status`, `data` and `error`. Does nothing while disabled. Do not call it
   * during render.
   */
  readonly reload: () => void;
  /**
   * Replaces `data` locally (for example an optimistic update): status becomes
   * `'success'`. Does not stop a run in flight, whose outcome replaces the
   * value when it settles; pause runs with `enabled` while saving.
   */
  readonly setData: SetEffectStateData<T, TData>;
}

/**
 * The state returned by `useEffectState`, narrowed by `status`. `TData` is the
 * type of `data` when there is no outcome for the current deps: `T | undefined`,
 * or `T` with a `placeholderData`.
 */
export type EffectState<T, TData = T | undefined> = EffectStateControls<T, TData> &
  (
    | {
        readonly status: 'idle';
        readonly data: TData;
        readonly error: undefined;
        readonly isRunning: false;
        readonly isPlaceholderData: boolean;
      }
    | {
        readonly status: 'pending';
        readonly data: TData;
        readonly error: undefined;
        readonly isRunning: true;
        readonly isPlaceholderData: boolean;
      }
    | {
        readonly status: 'success';
        readonly data: T;
        readonly error: undefined;
        readonly isRunning: boolean;
        readonly isPlaceholderData: false;
      }
    | {
        readonly status: 'error';
        readonly data: TData;
        readonly error: unknown;
        readonly isRunning: boolean;
        readonly isPlaceholderData: boolean;
      }
  );

/** What one render asks for. */
interface Slot<T> {
  readonly deps: DependencyList;
  readonly enabled: boolean;
  readonly keep: boolean;
  readonly placeholder: T | undefined;
}

interface State<T> {
  /** The deps and `enabled` this state belongs to. */
  readonly deps: DependencyList;
  readonly enabled: boolean;
  readonly status: EffectStateStatus;
  readonly data: T | undefined;
  readonly error: unknown;
  /** `data` is a stand-in (placeholder or other deps' data), not an outcome for `deps`. */
  readonly placeholder: boolean;
  /** A run whose outcome will be applied is in flight (or starts in this commit). */
  readonly running: boolean;
  /** Incremented by `reload()`; part of the effect's dependencies. */
  readonly reloads: number;
}

/** Brings `state` to what `slot` asks for. Pure; returns `state` itself when nothing changes. */
function adopt<T>(state: State<T>, slot: Slot<T>): State<T> {
  if (depsEqual(state.deps, slot.deps)) {
    if (state.enabled === slot.enabled) {
      return state;
    }

    if (slot.enabled) {
      return {
        ...state,
        enabled: true,
        running: true,
        status: state.status === 'idle' ? 'pending' : state.status
      };
    }

    // Disabled with the same deps: an outcome is kept, anything else falls back
    // to the placeholder (kept data never shows under 'idle').
    return state.status === 'pending'
      ? {
          ...state,
          enabled: false,
          running: false,
          status: 'idle',
          data: slot.placeholder,
          placeholder: slot.placeholder !== undefined
        }
      : { ...state, enabled: false, running: false };
  }

  const data =
    slot.enabled && slot.keep && state.data !== undefined ? state.data : slot.placeholder;

  return {
    deps: slot.deps,
    enabled: slot.enabled,
    status: slot.enabled ? 'pending' : 'idle',
    data,
    error: undefined,
    placeholder: data !== undefined,
    running: slot.enabled,
    reloads: state.reloads
  };
}

/**
 * Runs an async task as an effect and keeps its result in state.
 *
 * Same run semantics as `useEffectTask` (per-run AbortSignal, LIFO cleanups,
 * stale outcomes ignored), plus `status`, `data`, `error`, `isRunning`,
 * `isPlaceholderData`, `reload()` and `setData()`. When `deps` change, the
 * hook is `pending` in that very render, so a previous result is never shown
 * as the result for new deps. Deps are compared with `Object.is` like
 * `useEffect`'s: a dependency recreated on every render makes React stop with
 * "Too many re-renders".
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
  options: Omit<UseEffectStateOptions<T>, 'placeholderData'> & {
    placeholderData: NoInferFrom<T>;
  }
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
  const enabled = options?.enabled === undefined ? true : Boolean(options.enabled);
  const slot: Slot<T> = {
    deps,
    enabled,
    keep: options?.keepPreviousData === true,
    placeholder: options?.placeholderData as T | undefined
  };

  // What the latest *committed* render asks for (never a discarded render).
  const committedRef = useRef(slot);
  const runIdRef = useRef(0);

  useCommitPhaseEffect(() => {
    committedRef.current = slot;
  });

  const [state, setState] = useState<State<T>>(() => ({
    deps,
    enabled,
    status: enabled ? 'pending' : 'idle',
    data: slot.placeholder,
    error: undefined,
    placeholder: slot.placeholder !== undefined,
    running: enabled,
    reloads: 0
  }));

  // Render-time sync, React's documented "adjusting state when a prop changes"
  // pattern: React re-renders right away with the adopted state and discards
  // the update together with this render if the render itself is discarded.
  // So no frame ever shows an outcome that belongs to other deps.
  let view = state;
  if (state.enabled !== enabled || !depsEqual(state.deps, deps)) {
    view = adopt(state, slot);
    setState(view);
  }

  const reloads = view.reloads;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    // A no-op (React bails out) unless this is a restart with the same deps:
    // StrictMode's second mount or an <Activity> reveal.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((current) => {
      const next = adopt(current, slot);
      return next.running ? next : { ...next, running: true };
    });

    const run = createRun(++runIdRef.current, (error) => {
      reportError(error, 'useEffectState cleanup failed', undefined, undefined);
    });

    // An outcome counts only while the run is active and the latest committed
    // render still asks for it: between a commit with new deps (or enabled:
    // false) and the cleanup that disposes this run, it must not land.
    const settle = (ok: boolean, value: unknown): void => {
      const committed = committedRef.current;
      if (!run.isActive() || !committed.enabled || !depsEqual(committed.deps, deps)) {
        return;
      }

      setState((current) => {
        const next = adopt(current, committed);
        // A reload() issued while this run was in flight restarts it next commit.
        const running = next.reloads !== reloads;
        return ok
          ? { ...next, status: 'success', data: value as T, error: undefined, placeholder: false, running }
          : { ...next, status: 'error', error: value, running };
      });
    };

    try {
      const output = task(run.scope);

      if (isPromiseLike<T>(output)) {
        Promise.resolve(output).then(
          (value) => settle(true, value),
          (error: unknown) => settle(false, error)
        );
      } else {
        settle(true, output);
      }
    } catch (error) {
      settle(false, error);
    }

    return run.dispose;
    // React stores the latest committed effect callback, so `task` is always the
    // committed one; `deps` are the caller's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, reloads]);

  // Stable for the lifetime of the component (state is never discarded).
  const [actions] = useState(() => ({
    reload: (): void => {
      const committed = committedRef.current;
      setState((current) => {
        const next = adopt(current, committed);
        return next.enabled ? { ...next, running: true, reloads: next.reloads + 1 } : current;
      });
    },
    setData: (value: T | ((previous: T | undefined) => T)): void => {
      const committed = committedRef.current;
      setState((current) => {
        const next = adopt(current, committed);
        const data =
          typeof value === 'function' ? (value as (previous: T | undefined) => T)(next.data) : value;

        if (next === current && current.status === 'success' && Object.is(data, current.data)) {
          return current;
        }

        return { ...next, status: 'success', data, error: undefined, placeholder: false };
      });
    }
  }));

  return useMemo(
    () =>
      ({
        status: view.status,
        data: view.data,
        error: view.error,
        isRunning: view.running,
        isPlaceholderData: view.placeholder,
        reload: actions.reload,
        setData: actions.setData
      }) as EffectState<T>,
    [view.status, view.data, view.error, view.running, view.placeholder, actions]
  );
}
