// Type-level tests, checked by `npm run typecheck` (never executed).
import { expectTypeOf } from 'vitest';
import { useEffectState, useEffectTask, useEvent, useLayoutEffectTask } from '../src';
import type { EffectState, EffectTaskScope } from '../src';

interface User {
  id: number;
  name: string;
}

declare function fetchUser(id: number, signal: AbortSignal): Promise<User>;

export function useTypeTests(id: number): void {
  // T is inferred from the task's return type, even when the task destructures its scope.
  const user = useEffectState(({ signal }) => fetchUser(id, signal), [id]);
  expectTypeOf(user.data).toEqualTypeOf<User | undefined>();
  expectTypeOf(user).toEqualTypeOf<EffectState<User>>();

  const asyncUser = useEffectState(async ({ signal, sleep }) => {
    await sleep(10);
    return fetchUser(id, signal);
  }, [id]);
  expectTypeOf(asyncUser.data).toEqualTypeOf<User | undefined>();

  // Narrowing on status (also after destructuring).
  if (user.status === 'success') {
    expectTypeOf(user.data).toEqualTypeOf<User>();
    expectTypeOf(user.error).toEqualTypeOf<undefined>();
  }
  if (user.isSuccess) {
    expectTypeOf(user.data).toEqualTypeOf<User>();
  }
  const { status, data } = user;
  if (status === 'success') {
    expectTypeOf(data).toEqualTypeOf<User>();
  }
  if (user.status === 'error') {
    expectTypeOf(user.error).toEqualTypeOf<unknown>();
  }

  // initialData makes data non-undefined in every state.
  const list = useEffectState(async () => [1, 2, 3], [], { initialData: [] as number[] });
  expectTypeOf(list.data).toEqualTypeOf<number[]>();
  list.setData((previous) => {
    expectTypeOf(previous).toEqualTypeOf<number[]>();
    return [...previous, 4];
  });

  const lazy = useEffectState(async () => 'x', [], { initialData: () => 'initial' });
  expectTypeOf(lazy.data).toEqualTypeOf<string>();

  // Without initialData the updater receives T | undefined.
  user.setData((previous) => {
    expectTypeOf(previous).toEqualTypeOf<User | undefined>();
    return { id: 1, name: 'x' };
  });
  expectTypeOf(user.reload).toEqualTypeOf<() => void>();
  expectTypeOf(user.isRunning).toEqualTypeOf<boolean>();

  // useEffectTask accepts sync/async tasks, with or without cleanups, and readonly deps.
  useEffectTask(() => undefined, []);
  useEffectTask(() => () => undefined, [id]);
  useEffectTask(async ({ signal }: EffectTaskScope) => {
    await fetchUser(id, signal);
  }, [id] as const);
  useEffectTask(async () => () => undefined, []);
  useEffectTask(({ commit }) => fetchUser(id, new AbortController().signal).then(() => commit(() => undefined)), [id]);
  useLayoutEffectTask(({ onCleanup }) => onCleanup(() => undefined), []);
  // @ts-expect-error -- returning data is a mistake: use useEffectState instead.
  useEffectTask(async () => 42, []);

  // useEvent preserves the callback type.
  const handler = useEvent((value: string, count: number) => value.repeat(count));
  expectTypeOf(handler).toEqualTypeOf<(value: string, count: number) => string>();
}
