import React, { StrictMode, useState } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
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
  it('blocks stale commit from run1 when run2 resolves first (anti-race)', async () => {
    const deferred1 = deferred<void>();
    const deferred2 = deferred<void>();

    function Demo({ id }: { id: number }) {
      const [value, setValue] = useState('idle');

      useEffectTask(
        async ({ commit }) => {
          if (id === 1) {
            await deferred1.promise;
            commit(() => setValue('one'));
            return;
          }

          await deferred2.promise;
          commit(() => setValue('two'));
        },
        [id]
      );

      return <div>{value}</div>;
    }

    const { rerender } = render(<Demo id={1} />);

    rerender(<Demo id={2} />);

    await act(async () => {
      deferred2.resolve();
      await flushMicrotasks();
    });

    expect(screen.getByText('two')).toBeTruthy();

    await act(async () => {
      deferred1.resolve();
      await flushMicrotasks();
    });

    expect(screen.getByText('two')).toBeTruthy();
  });

  it('aborts previous run on rerender', () => {
    const signals: AbortSignal[] = [];

    const { rerender } = renderHook(
      ({ id }) =>
        useEffectTask(({ signal }) => {
          signals.push(signal);
        }, [id]),
      { initialProps: { id: 1 } }
    );

    rerender({ id: 2 });

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('aborts current run on unmount', () => {
    let signalRef: AbortSignal | undefined;

    const { unmount } = renderHook(() =>
      useEffectTask(({ signal }) => {
        signalRef = signal;
      }, [])
    );

    expect(signalRef?.aborted).toBe(false);

    unmount();

    expect(signalRef?.aborted).toBe(true);
  });

  it('runs late async cleanup after unmount when cleanup arrives late', async () => {
    const gate = deferred<void>();
    const cleanup = vi.fn();

    const { unmount } = renderHook(() =>
      useEffectTask(async () => {
        await gate.promise;
        return cleanup;
      }, [])
    );

    unmount();

    await act(async () => {
      gate.resolve();
      await flushMicrotasks();
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('is strict-mode safe for interval cleanup', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );

    const { unmount } = renderHook(
      () =>
        useEffectTask(({ onCleanup }) => {
          const handle = setInterval(() => {
            // no-op
          }, 1000);

          onCleanup(() => {
            clearInterval(handle);
          });
        }, []),
      { wrapper }
    );

    unmount();

    expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(0);
    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThanOrEqual(
      setIntervalSpy.mock.calls.length
    );
  });
});
