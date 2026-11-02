import { useEffect, useInsertionEffect, useLayoutEffect } from 'react';

const canUseDOM =
  typeof window !== 'undefined' &&
  typeof window.document !== 'undefined' &&
  typeof window.document.createElement !== 'undefined';

const isReactNative = typeof navigator !== 'undefined' && navigator.product === 'ReactNative';

/**
 * `useLayoutEffect` where layout effects exist (DOM, React Native) and `useEffect`
 * on the server, where layout effects never run and React 18 warns about them.
 * The choice is made once per environment, so hook order is stable.
 */
export const useIsomorphicLayoutEffect: typeof useEffect =
  canUseDOM || isReactNative ? useLayoutEffect : useEffect;

/**
 * Commit-phase hook used to publish the latest render's values (callbacks,
 * options) before any layout or passive effect of the same commit runs,
 * including effects of child components.
 */
export const useCommitPhaseEffect: typeof useEffect =
  typeof useInsertionEffect === 'function' ? useInsertionEffect : useIsomorphicLayoutEffect;
