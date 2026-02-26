import { useEffect, useLayoutEffect, useRef } from 'react';
import { useEvent } from './useEvent';

export type EffectTaskCleanup = () => void;

export interface EffectTaskScope {
  signal: AbortSignal;
  runId: number;
  isActive: () => boolean;
  commit: (fn: () => void) => void;
  onCleanup: (fn: EffectTaskCleanup) => void;
}

export interface UseEffectTaskOptions {
  layout?: boolean;
  onError?: (err: unknown) => void;
  debugName?: string;
}

export type EffectTask = (
  scope: EffectTaskScope
) => void | EffectTaskCleanup | Promise<void | EffectTaskCleanup>;

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === 'function';
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.code === DOMException.ABORT_ERR)
  );
}

function reportError(
  error: unknown,
  signal: AbortSignal,
  options?: UseEffectTaskOptions
): void {
  if (signal.aborted || isAbortError(error)) {
    return;
  }

  if (options?.onError) {
    options.onError(error);
    return;
  }

  const runtime = globalThis as typeof globalThis & {
    process?: { env?: { NODE_ENV?: string } };
  };

  if (runtime.process?.env?.NODE_ENV !== 'production') {
    console.error(
      `[useEffectTask${options?.debugName ? `:${options.debugName}` : ''}]`,
      error
    );
  }
}

export function useEffectTask(
  task: EffectTask,
  deps: any[],
  options?: UseEffectTaskOptions
): void {
  const runIdRef = useRef(0);
  const latestTask = useEvent(task);
  const selectedEffect = options?.layout ? useLayoutEffect : useEffect;

  selectedEffect(() => {
    const runId = ++runIdRef.current;
    const controller = new AbortController();
    const cleanupStack: EffectTaskCleanup[] = [];
    let taskCleanup: EffectTaskCleanup | undefined;
    let disposed = false;

    const isActive = (): boolean => {
      return !controller.signal.aborted && runIdRef.current === runId && !disposed;
    };

    const runCleanup = (cleanup?: EffectTaskCleanup): void => {
      if (!cleanup) {
        return;
      }

      try {
        cleanup();
      } catch (error) {
        reportError(error, controller.signal, options);
      }
    };

    const dispose = (): void => {
      if (disposed) {
        return;
      }

      disposed = true;
      controller.abort();

      for (let index = cleanupStack.length - 1; index >= 0; index -= 1) {
        runCleanup(cleanupStack[index]);
      }

      cleanupStack.length = 0;
      runCleanup(taskCleanup);
      taskCleanup = undefined;
    };

    const scope: EffectTaskScope = {
      signal: controller.signal,
      runId,
      isActive,
      commit: (fn) => {
        if (!isActive()) {
          return;
        }

        fn();
      },
      onCleanup: (fn) => {
        cleanupStack.push(fn);
      }
    };

    try {
      const output = latestTask(scope);

      if (isPromise(output)) {
        output
          .then((resolvedCleanup) => {
            if (typeof resolvedCleanup !== 'function') {
              return;
            }

            if (disposed || !isActive()) {
              runCleanup(resolvedCleanup);
              return;
            }

            taskCleanup = resolvedCleanup;
          })
          .catch((error) => {
            reportError(error, controller.signal, options);
          });
      } else if (typeof output === 'function') {
        taskCleanup = output;
      }
    } catch (error) {
      reportError(error, controller.signal, options);
    }

    return dispose;
  }, deps);
}
