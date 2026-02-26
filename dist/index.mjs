// src/useEvent.ts
import { useCallback, useRef } from "react";
function useEvent(fn) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const stableFn = useCallback((...args) => {
    return fnRef.current(...args);
  }, []);
  return stableFn;
}

// src/useEffectTask.ts
import { useEffect, useLayoutEffect, useRef as useRef2 } from "react";
function isPromise(value) {
  return typeof value?.then === "function";
}
function isAbortError(error) {
  return error instanceof DOMException && (error.name === "AbortError" || error.code === DOMException.ABORT_ERR);
}
function reportError(error, signal, options) {
  if (signal.aborted || isAbortError(error)) {
    return;
  }
  if (options?.onError) {
    options.onError(error);
    return;
  }
  const runtime = globalThis;
  if (runtime.process?.env?.NODE_ENV !== "production") {
    console.error(
      `[useEffectTask${options?.debugName ? `:${options.debugName}` : ""}]`,
      error
    );
  }
}
function useEffectTask(task, deps, options) {
  const runIdRef = useRef2(0);
  const latestTask = useEvent(task);
  const selectedEffect = options?.layout ? useLayoutEffect : useEffect;
  selectedEffect(() => {
    const runId = ++runIdRef.current;
    const controller = new AbortController();
    const cleanupStack = [];
    let taskCleanup;
    let disposed = false;
    const isActive = () => {
      return !controller.signal.aborted && runIdRef.current === runId && !disposed;
    };
    const runCleanup = (cleanup) => {
      if (!cleanup) {
        return;
      }
      try {
        cleanup();
      } catch (error) {
        reportError(error, controller.signal, options);
      }
    };
    const dispose = () => {
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
      taskCleanup = void 0;
    };
    const scope = {
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
        output.then((resolvedCleanup) => {
          if (typeof resolvedCleanup !== "function") {
            return;
          }
          if (disposed || !isActive()) {
            runCleanup(resolvedCleanup);
            return;
          }
          taskCleanup = resolvedCleanup;
        }).catch((error) => {
          reportError(error, controller.signal, options);
        });
      } else if (typeof output === "function") {
        taskCleanup = output;
      }
    } catch (error) {
      reportError(error, controller.signal, options);
    }
    return dispose;
  }, deps);
}
export {
  useEffectTask,
  useEvent
};
