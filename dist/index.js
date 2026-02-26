"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  useEffectTask: () => useEffectTask,
  useEvent: () => useEvent
});
module.exports = __toCommonJS(index_exports);

// src/useEvent.ts
var import_react = require("react");
function useEvent(fn) {
  const fnRef = (0, import_react.useRef)(fn);
  fnRef.current = fn;
  const stableFn = (0, import_react.useCallback)((...args) => {
    return fnRef.current(...args);
  }, []);
  return stableFn;
}

// src/useEffectTask.ts
var import_react2 = require("react");
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
  const runIdRef = (0, import_react2.useRef)(0);
  const latestTask = useEvent(task);
  const selectedEffect = options?.layout ? import_react2.useLayoutEffect : import_react2.useEffect;
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  useEffectTask,
  useEvent
});
