import { useCallback, useRef } from 'react';

export function useEvent<T extends (...args: any[]) => any>(fn: T): T {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const stableFn = useCallback((...args: Parameters<T>) => {
    return fnRef.current(...args);
  }, []);

  return stableFn as T;
}
