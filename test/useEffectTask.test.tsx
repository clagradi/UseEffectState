import React, { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffectTask } from '../src';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useEffectTask', () => {
  it('prevents stale commits from older runs (anti-race)', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const commits: number[] = [];

    const { rerender } = renderHook(
      ({ dep }) =>
        useEffectTask(async (scope) => {
          if (dep === 1) {
            await first.promise;
          } else {
            await second.promise;
          }

          scope.commit(() => {
            commits.push(dep);
          });
        }, [dep]),
      { initialProps: { dep: 1 } }
    );

    rerender({ dep: 2 });

    await act(async () => {
      second.resolve();
      await flushMicrotasks();
    });

    await act(async () => {
      first.resolve();
      await flushMicrotasks();
    });

    expect(commits).toEqual([2]);
  });

  it('aborts previous run on dependency change', () => {
    const signals: AbortSignal[] = [];

    const { rerender } = renderHook(
      ({ dep }) =>
        useEffectTask(({ signal }) => {
          signals.push(signal);
        }, [dep]),
      { initialProps: { dep: 1 } }
    );

    rerender({ dep: 2 });

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('aborts current run on unmount', () => {
    let capturedSignal: AbortSignal | undefined;

    const { unmount } = renderHook(() =>
      useEffectTask(({ signal }) => {
        capturedSignal = signal;
      }, [])
    );

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('executes late async cleanup even if run already disposed', async () => {
    const lateCleanup = vi.fn();
    const asyncCleanup = deferred<() => void>();

    const { unmount } = renderHook(() =>
      useEffectTask(async () => {
        return asyncCleanup.promise;
      }, [])
    );

    unmount();

    await act(async () => {
      asyncCleanup.resolve(lateCleanup);
      await flushMicrotasks();
    });

    expect(lateCleanup).toHaveBeenCalledTimes(1);
  });

  it('works under StrictMode without leaking subscriptions', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );

    const { unmount } = renderHook(
      () =>
        useEffectTask(({ onCleanup }) => {
          const intervalId = setInterval(() => {
            // intentional no-op
          }, 1_000);
          onCleanup(() => {
            clearInterval(intervalId);
          });
        }, []),
      { wrapper }
    );

    unmount();

    expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(0);
    expect(clearIntervalSpy.mock.calls.length).toBe(setIntervalSpy.mock.calls.length);
  });
});
