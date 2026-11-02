import type { EffectTaskCleanup, EffectTaskScope } from '../types';
import { abortReasonOf, createAbortError } from './errors';

/** The largest delay `setTimeout` supports before it overflows and fires immediately. */
const MAX_TIMEOUT = 2_147_483_647;

/** The abort reason of every run's signal: identifiable across runtimes and polyfills. */
const RUN_ENDED = 'The effect run ended.';

export interface Run {
  readonly scope: EffectTaskScope;
  readonly signal: AbortSignal;
  /** True until the run is disposed (re-run, unmount, reload, disable). */
  isActive(): boolean;
  /**
   * Registers a cleanup. Cleanups run in reverse registration order (LIFO) when
   * the run is disposed; registering after disposal runs the cleanup at once.
   */
  addCleanup(cleanup: EffectTaskCleanup): void;
  /** Ends the run: marks it inactive, aborts the signal, then runs the cleanups. Idempotent. */
  dispose(): void;
}

export function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

const noop = (): void => undefined;

/**
 * Creates one run of a task: its own AbortController, cleanup stack and the
 * scope object handed to user code. Framework-agnostic; the hooks decide when
 * a run starts and when it is disposed.
 *
 * @param reportCleanupError receives errors thrown by cleanups (never swallowed).
 */
export function createRun(runId: number, reportCleanupError: (error: unknown) => void): Run {
  const controller = new AbortController();
  const signal = controller.signal;
  // One entry per registration, so the same function can be registered twice.
  const cleanups: Array<{ fn: EffectTaskCleanup }> = [];
  let disposed = false;

  const isActive = (): boolean => !disposed;

  const runCleanup = (cleanup: EffectTaskCleanup): void => {
    try {
      cleanup();
    } catch (error) {
      reportCleanupError(error);
    }
  };

  const onCleanup = (cleanup: EffectTaskCleanup): (() => void) => {
    if (typeof cleanup !== 'function') {
      return noop;
    }

    if (disposed) {
      runCleanup(cleanup);
      return noop;
    }

    const entry = { fn: cleanup };
    cleanups.push(entry);

    // Runs the cleanup now (at most once) and unregisters it. Returning it from a
    // concise task (`({ onCleanup }) => onCleanup(fn)`) therefore still runs fn
    // exactly once when the run ends.
    return () => {
      const index = cleanups.indexOf(entry);
      if (index !== -1) {
        cleanups.splice(index, 1);
        runCleanup(cleanup);
      }
    };
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    controller.abort(createAbortError(RUN_ENDED));

    while (cleanups.length > 0) {
      runCleanup((cleanups.pop() as { fn: EffectTaskCleanup }).fn);
    }
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortReasonOf(signal));
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;

      const onAbort = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        reject(abortReasonOf(signal));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      if (ms !== Infinity) {
        const delay = Math.min(Math.max(Number(ms) || 0, 0), MAX_TIMEOUT);
        timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
      }
    });

  const scope: EffectTaskScope = {
    signal,
    runId,
    isActive,
    commit: (fn) => {
      if (!disposed) {
        fn();
      }
    },
    onCleanup,
    sleep
  };

  return {
    scope,
    signal,
    isActive,
    addCleanup: (cleanup) => {
      onCleanup(cleanup);
    },
    dispose
  };
}
