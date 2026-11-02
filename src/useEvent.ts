import { useRef, useState } from 'react';
import { useCommitPhaseEffect } from './internal/environment';

/**
 * Returns a function with a stable identity that always calls the latest `fn`.
 *
 * Use it for callbacks that effects, intervals, subscriptions or event handlers
 * call later, so they see the latest props and state without being listed as
 * dependencies. It is the userland equivalent of React 19.2's `useEffectEvent`.
 *
 * The latest `fn` is published during the commit phase, before layout and
 * passive effects run (including those of child components), so renders that
 * React discards never leak into it. Only the call is forwarded: properties of
 * a callable object are not. Do not call it during render (or from insertion
 * effects): before the first commit it throws, and afterwards it would see the
 * previous render's values.
 */
// `Function` (like React's own `useEffectEvent`) gives unannotated callback
// parameters no contextual type, so strict mode reports them instead of
// silently typing them as `any`.
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export function useEvent<T extends Function>(fn: T): T {
  const latestRef = useRef<T | null>(null);

  useCommitPhaseEffect(() => {
    latestRef.current = fn;
  });

  // useState (not useCallback): React may discard memoization caches, but state
  // is kept for the lifetime of the component, so the identity never changes.
  const [stable] = useState(
    () =>
      function (this: unknown, ...args: unknown[]): unknown {
        const latest = latestRef.current as ((...params: unknown[]) => unknown) | null;

        if (latest === null) {
          throw new Error(
            '[effect-runtime] A function returned by useEvent() was called before its component ' +
              'committed (during render, or from an insertion effect). Call it from an effect, a ' +
              'subscription or an event handler instead.'
          );
        }

        return latest.apply(this, args);
      }
  );

  return stable as unknown as T;
}
