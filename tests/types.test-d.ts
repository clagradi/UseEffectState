// Type-level tests, checked by `npm run typecheck` (never executed).
import { expectTypeOf } from 'vitest';
import { useEffectState, useEffectTask, useEvent, useLayoutEffectTask } from '../src';
import type { EffectState, EffectTaskScope, UseEffectStateOptions } from '../src';

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

  // Narrowing on status, also after destructuring.
  if (user.status === 'success') {
    expectTypeOf(user.data).toEqualTypeOf<User>();
    expectTypeOf(user.error).toEqualTypeOf<undefined>();
    expectTypeOf(user.isPlaceholderData).toEqualTypeOf<false>();
  }
  if (user.status === 'pending') {
    expectTypeOf(user.isRunning).toEqualTypeOf<true>();
  }
  if (user.status === 'idle') {
    expectTypeOf(user.isRunning).toEqualTypeOf<false>();
  }
  if (user.status === 'error') {
    expectTypeOf(user.error).toEqualTypeOf<unknown>();
    expectTypeOf(user.data).toEqualTypeOf<User | undefined>();
  }
  const { status, data } = user;
  if (status === 'success') {
    expectTypeOf(data).toEqualTypeOf<User>();
  }

  // placeholderData makes data non-undefined in every state.
  const list = useEffectState(async () => [1, 2, 3], [], { placeholderData: [] as number[] });
  expectTypeOf(list.data).toEqualTypeOf<number[]>();
  list.setData((previous) => {
    expectTypeOf(previous).toEqualTypeOf<number[]>();
    return [...previous, 4];
  });

  // T comes from the task: an empty-array placeholder does not become never[].
  const users = useEffectState(async ({ signal }) => [await fetchUser(id, signal)], [id], {
    placeholderData: [],
    keepPreviousData: true
  });
  expectTypeOf(users.data).toEqualTypeOf<User[]>();

  // A placeholder that may be undefined does not widen T or break narrowing.
  const maybePlaceholder = undefined as User | undefined;
  const seeded = useEffectState(({ signal }) => fetchUser(id, signal), [id], {
    placeholderData: maybePlaceholder
  });
  expectTypeOf(seeded.data).toEqualTypeOf<User | undefined>();
  if (seeded.status === 'success') {
    expectTypeOf(seeded.data).toEqualTypeOf<User>();
  }

  // @ts-expect-error -- placeholderData must match the task's result type.
  useEffectState(async () => 1, [], { placeholderData: 'not a number' });

  // Options accept explicit undefined (exactOptionalPropertyTypes-friendly) and readonly deps.
  useEffectState(async () => 1, [id] as const, {
    enabled: undefined,
    placeholderData: undefined,
    keepPreviousData: undefined
  });

  // Without placeholderData the updater receives T | undefined.
  user.setData((previous) => {
    expectTypeOf(previous).toEqualTypeOf<User | undefined>();
    return { id: 1, name: 'x' };
  });
  expectTypeOf(user.reload).toEqualTypeOf<() => void>();
  expectTypeOf(user.isRunning).toEqualTypeOf<boolean>();
  expectTypeOf(user.isPlaceholderData).toEqualTypeOf<boolean>();

  // useEffectTask accepts sync/async tasks, with or without cleanups.
  useEffectTask(() => undefined, []);
  useEffectTask(() => () => undefined, [id]);
  useEffectTask(async ({ signal }: EffectTaskScope) => {
    await fetchUser(id, signal);
  }, [id] as const);
  useEffectTask(async () => () => undefined, []);
  useEffectTask(
    ({ commit, signal }) => fetchUser(id, signal).then(() => commit(() => undefined)),
    [id]
  );
  // The 0.1 concise cleanup idiom keeps compiling (onCleanup returns a function).
  useLayoutEffectTask(({ onCleanup }) => onCleanup(() => undefined), []);
  // @ts-expect-error -- returning data is a mistake: use useEffectState instead.
  useEffectTask(async () => 42, []);

  // Scope members are plain functions: destructuring keeps them callable.
  useEffectTask(({ isActive, commit, onCleanup, sleep, runId }) => {
    expectTypeOf(isActive).toEqualTypeOf<() => boolean>();
    expectTypeOf(commit).toEqualTypeOf<(fn: () => void) => void>();
    expectTypeOf(onCleanup).toEqualTypeOf<(fn: () => void) => () => void>();
    expectTypeOf(sleep).toEqualTypeOf<(ms: number) => Promise<void>>();
    expectTypeOf(runId).toEqualTypeOf<number>();
  }, []);

  // useEvent preserves the callback type.
  const handler = useEvent((value: string, count: number) => value.repeat(count));
  expectTypeOf(handler).toEqualTypeOf<(value: string, count: number) => string>();

  // Like React's useEffectEvent, unannotated parameters are not silently `any`.
  // @ts-expect-error -- TS7006: parameter 'value' implicitly has an 'any' type.
  useEvent((value) => value);
}

// Generic wrappers keep inferring T.
export function useApi<T>(url: string, options?: UseEffectStateOptions<T>): EffectState<T> {
  return useEffectState(
    async ({ signal }) => (await (await fetch(url, { signal })).json()) as T,
    [url],
    options
  );
}

export function useApiWithPlaceholder<T>(url: string, placeholder: T): EffectState<T, T> {
  return useEffectState(
    async ({ signal }) => (await (await fetch(url, { signal })).json()) as T,
    [url],
    { placeholderData: placeholder }
  );
}
