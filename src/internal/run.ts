import type { EffectTaskCleanup, EffectTaskScope } from '../types';
import { abortReasonOf } from './errors';

/** The largest delay `setTimeout` supports before it overflows and fires immediately. */
const MAX_TIMEOUT = 2_147_483_647;

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
  /** Aborts the signal, then runs the cleanups. Idempotent. */
  dispose(): void;
}

export function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

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
  const cleanups: EffectTaskCleanup[] = [];
  let disposed = false;

  const isActive = (): boolean => !disposed;

  const runCleanup = (cleanup: EffectTaskCleanup): void => {
    try {
      cleanup();
    } catch (error) {
      reportCleanupError(error);
    }
  };

  const addCleanup = (cleanup: EffectTaskCleanup): void => {
    if (typeof cleanup !== 'function') {
      return;
    }

    if (disposed) {
      runCleanup(cleanup);
      return;
    }

    cleanups.push(cleanup);
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }

    disposed = true;
    controller.abort();

    while (cleanups.length > 0) {
      runCleanup(cleanups.pop() as EffectTaskCleanup);
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

  const abortable = <T>(work: PromiseLike<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortReasonOf(signal));
        return;
      }

      const onAbort = (): void => {
        reject(abortReasonOf(signal));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      Promise.resolve(work).then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
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
    onCleanup: addCleanup,
    sleep,
    abortable
  };

  return { scope, signal, isActive, addCleanup, dispose };
}
