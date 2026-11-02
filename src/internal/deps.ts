import type { DependencyList } from '../types';

/** Compares two deps arrays the way React does: same length, `Object.is` per item. */
export function depsEqual(a: DependencyList, b: DependencyList): boolean {
  if (a === b) {
    return true;
  }

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
