import type { DependencyList } from 'react';

/** Compares two deps arrays the way React does: same length, `Object.is` per item. */
export function depsEqual(a: DependencyList, b: DependencyList): boolean {
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

/** `b` is `a` recreated with the same content: a plain object/array or a function. */
function isRecreated(a: unknown, b: unknown): boolean {
  if (typeof a === 'function' && typeof b === 'function') {
    return Function.prototype.toString.call(a) === Function.prototype.toString.call(b);
  }

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(a) as unknown;
  if (prototype !== Object.getPrototypeOf(b)) {
    return false;
  }
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    return false;
  }

  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return keys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && Object.is(left[key], right[key])
  );
}

/** True when every changed item of `next` is a recreated copy of the previous one. */
export function changedOnlyByIdentity(previous: DependencyList, next: DependencyList): boolean {
  if (previous.length !== next.length) {
    return false;
  }

  let changed = false;
  for (let index = 0; index < next.length; index += 1) {
    if (Object.is(previous[index], next[index])) {
      continue;
    }
    if (!isRecreated(previous[index], next[index])) {
      return false;
    }
    changed = true;
  }

  return changed;
}

/** Consecutive identity-only deps changes before the warning is printed. */
const UNSTABLE_DEPS_STREAK = 3;

/**
 * Detects deps that are recreated on every render (an inline object, array or
 * function), which makes a task re-run after every render, and warns once.
 * Call it from the effect, with the deps of each run.
 */
export function createUnstableDepsDetector(
  hookName: string
): (deps: DependencyList, debugName: string | undefined) => void {
  let previous: DependencyList | undefined;
  let streak = 0;
  let warned = false;

  return (deps, debugName) => {
    if (previous !== undefined && !depsEqual(previous, deps)) {
      streak = changedOnlyByIdentity(previous, deps) ? streak + 1 : 0;

      if (streak >= UNSTABLE_DEPS_STREAK && !warned) {
        warned = true;
        console.warn(
          `[effect-runtime] ${hookName}${debugName ? ` (${debugName})` : ''}: a dependency is a new ` +
            'object, array or function on every render, so the task re-runs after every render. ' +
            "Deps are compared with Object.is, like useEffect's: depend on primitive values, or " +
            'create the value outside render / memoize it.'
        );
      }
    }

    previous = deps;
  };
}
