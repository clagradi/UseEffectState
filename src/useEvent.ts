import { useRef, useState } from 'react';
import { useCommitPhaseEffect } from './internal/environment';

/**
 * Returns a function with a stable identity that always calls the latest `fn`.
 *
 * Use it for callbacks that effects, intervals, subscriptions or event handlers
 * call later, so they see the latest props and state without being listed as
 * dependencies. It is the userland equivalent of React 19.2's `useEffectEvent`.
 *
 * The latest `fn` is published during the commit phase, before any layout or
 * passive effect runs, so renders that React discards never leak into it.
 * Do not call the returned function during render: before the first commit it
 * throws, and afterwards it would see the previous render's values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- `any` keeps parameter types of any callback assignable.
export function useEvent<T extends (...args: any[]) => any>(fn: T): T {
  const latestRef = useRef<T | null>(null);

  useCommitPhaseEffect(() => {
    latestRef.current = fn;
  });

  // useState (not useCallback): React may discard memoization caches, but state
  // is kept for the lifetime of the component, so the identity never changes.
  const [stable] = useState(
    () =>
      function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
        const latest = latestRef.current;

        if (latest === null) {
          throw new Error(
            '[effect-runtime] A function returned by useEvent() was called during render. ' +
              'Call it from an effect, a subscription or an event handler instead.'
          );
        }

        return latest.apply(this, args) as ReturnType<T>;
      }
  );

  return stable as unknown as T;
}
