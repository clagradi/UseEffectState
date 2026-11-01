import { StrictMode, Suspense, memo, startTransition, useState } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEffectState } from '../src';
import type { EffectState, EffectTaskScope } from '../src';
import { Activity, captureConsole, createSuspender, deferred, flushMicrotasks, wait } from './helpers';

async function flush(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
  });
}

function snapshot<T>(state: EffectState<T>) {
  return {
    status: state.status,
    data: state.data,
    error: state.error,
    isRunning: state.isRunning
  };
}

describe('useEffectState: transitions', () => {
  it('starts pending and running, then succeeds', async () => {
    const gate = deferred<string>();
    const { result } = renderHook(() => useEffectState(() => gate.promise, []));

    expect(snapshot(result.current)).toEqual({
      status: 'pending',
      data: undefined,
      error: undefined,
      isRunning: true
    });
    expect(result.current.isPending).toBe(true);

    await act(async () => {
      gate.resolve('hello');
    });

    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: 'hello',
      error: undefined,
      isRunning: false
    });
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.isPending).toBe(false);
  });

  it('supports sync tasks', async () => {
    const { result } = renderHook(() => useEffectState(() => 42, []));
    await flush();
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: 42,
      error: undefined,
      isRunning: false
    });
  });

  it('stores sync and async errors', async () => {
    const syncError = new Error('sync');
    const asyncError = new Error('async');
    const { result: sync } = renderHook(() =>
      useEffectState((): number => {
        throw syncError;
      }, [])
    );
    const { result: async } = renderHook(() =>
      useEffectState(async (): Promise<number> => {
        await Promise.resolve();
        throw asyncError;
      }, [])
    );

    await flush();

    expect(sync.current.status).toBe('error');
    expect(sync.current.error).toBe(syncError);
    expect(sync.current.isError).toBe(true);
    expect(async.current.status).toBe('error');
    expect(async.current.error).toBe(asyncError);
    expect(async.current.isRunning).toBe(false);
  });

  it('reports pending in the same render when deps change (never old data for new deps)', async () => {
    const renders: Array<{ id: number; status: string; data: unknown }> = [];
    const gates = new Map<number, ReturnType<typeof deferred<string>>>();
    const gateFor = (id: number) => {
      if (!gates.has(id)) gates.set(id, deferred<string>());
      return gates.get(id)!;
    };

    function Demo({ id }: { id: number }) {
      const user = useEffectState(() => gateFor(id).promise, [id]);
      renders.push({ id, status: user.status, data: user.data });
      return null;
    }

    const { rerender } = render(<Demo id={1} />);
    await act(async () => gateFor(1).resolve('user-1'));

    renders.length = 0;
    rerender(<Demo id={2} />);

    expect(renders.length).toBeGreaterThan(0);
    for (const entry of renders) {
      expect(entry).toEqual({ id: 2, status: 'pending', data: undefined });
    }

    await act(async () => gateFor(2).resolve('user-2'));
    expect(renders[renders.length - 1]).toEqual({ id: 2, status: 'success', data: 'user-2' });
  });

  it('ignores a stale run that resolves after a newer one', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const onSuccess = vi.fn();

    const { result, rerender } = renderHook(
      ({ id }) =>
        useEffectState(() => (id === 1 ? first.promise : second.promise), [id], { onSuccess }),
      { initialProps: { id: 1 } }
    );

    rerender({ id: 2 });
    await act(async () => second.resolve('two'));
    await act(async () => first.resolve('one'));

    expect(result.current.data).toBe('two');
    expect(onSuccess.mock.calls).toEqual([['two']]);
  });

  it('ignores errors from runs that ended', async () => {
    const first = deferred<string>();
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ id }) =>
        useEffectState(() => (id === 1 ? first.promise : Promise.resolve('two')), [id], { onError }),
      { initialProps: { id: 1 } }
    );

    rerender({ id: 2 });
    await flush();
    await act(async () => first.reject(new Error('stale failure')));

    expect(result.current.status).toBe('success');
    expect(result.current.data).toBe('two');
    expect(onError).not.toHaveBeenCalled();
  });

  it('turns an AbortError from another source into an error instead of hanging', async () => {
    const { result } = renderHook(() =>
      useEffectState(async (): Promise<string> => {
        const timeout = new AbortController();
        timeout.abort();
        throw timeout.signal.reason;
      }, [])
    );

    await flush();

    expect(result.current.status).toBe('error');
    expect((result.current.error as Error).name).toBe('AbortError');
    expect(result.current.isRunning).toBe(false);
  });

  it('aborts the run when deps change and on unmount', () => {
    const scopes: EffectTaskScope[] = [];
    const { rerender, unmount } = renderHook(
      ({ id }) =>
        useEffectState(
          (scope) => {
            scopes.push(scope);
            return new Promise<number>(() => undefined);
          },
          [id]
        ),
      { initialProps: { id: 1 } }
    );

    rerender({ id: 2 });
    expect(scopes[0]?.signal.aborted).toBe(true);
    expect(scopes[1]?.signal.aborted).toBe(false);

    unmount();
    expect(scopes[1]?.signal.aborted).toBe(true);
  });

  it('runs onCleanup cleanups when the run ends', () => {
    const cleanup = vi.fn();
    const { unmount } = renderHook(() =>
      useEffectState(({ onCleanup }) => {
        onCleanup(cleanup);
        return 1;
      }, [])
    );

    expect(cleanup).not.toHaveBeenCalled();
    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not re-run for unrelated re-renders', async () => {
    const task = vi.fn(async () => 1);

    function Demo() {
      const [count, setCount] = useState(0);
      const state = useEffectState(task, []);
      return (
        <button onClick={() => setCount((value) => value + 1)}>
          {state.status}:{count}
        </button>
      );
    }

    render(<Demo />);
    await flush();
    act(() => screen.getByRole('button').click());
    act(() => screen.getByRole('button').click());
    await flush();

    expect(task).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button').textContent).toBe('success:2');
  });

  it('returns the same object while nothing changes', async () => {
    const { result, rerender } = renderHook(() => useEffectState(async () => 1, []));
    await flush();
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('useEffectState: reload and setData', () => {
  it('reload keeps data and status while running, then updates', async () => {
    let calls = 0;
    const gates = [deferred<number>(), deferred<number>()];
    const { result } = renderHook(() => useEffectState(() => gates[calls++]!.promise, []));

    await act(async () => gates[0]!.resolve(1));
    expect(result.current.data).toBe(1);

    act(() => result.current.reload());
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: 1,
      error: undefined,
      isRunning: true
    });

    await act(async () => gates[1]!.resolve(2));
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: 2,
      error: undefined,
      isRunning: false
    });
  });

  it('reload aborts the run in flight', () => {
    const scopes: EffectTaskScope[] = [];
    const { result } = renderHook(() =>
      useEffectState((scope) => {
        scopes.push(scope);
        return new Promise<number>(() => undefined);
      }, [])
    );

    act(() => result.current.reload());

    expect(scopes.length).toBe(2);
    expect(scopes[0]?.signal.aborted).toBe(true);
    expect(scopes[1]?.signal.aborted).toBe(false);
  });

  it('keeps the previous data when a reload fails, and recovers on retry', async () => {
    let attempt = 0;
    const { result } = renderHook(() =>
      useEffectState(async () => {
        attempt += 1;
        if (attempt === 2) throw new Error('boom');
        return attempt;
      }, [])
    );

    await flush();
    act(() => result.current.reload());
    await flush();

    expect(result.current.status).toBe('error');
    expect(result.current.data).toBe(1);
    expect((result.current.error as Error).message).toBe('boom');

    act(() => result.current.reload());
    expect(result.current.status).toBe('error'); // until the retry settles
    expect(result.current.isRunning).toBe(true);
    await flush();
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: 3,
      error: undefined,
      isRunning: false
    });
  });

  it('reload and setData are stable', async () => {
    const { result, rerender } = renderHook(({ id }) => useEffectState(async () => id, [id]), {
      initialProps: { id: 1 }
    });
    const { reload, setData } = result.current;
    rerender({ id: 2 });
    await flush();
    expect(result.current.reload).toBe(reload);
    expect(result.current.setData).toBe(setData);
  });

  it('setData accepts a value or an updater and marks the state as success', async () => {
    const gate = deferred<number[]>();
    const { result } = renderHook(() => useEffectState(() => gate.promise, []));

    act(() => result.current.setData([1]));
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: [1],
      error: undefined,
      isRunning: true
    });

    act(() => result.current.setData((previous) => [...(previous ?? []), 2]));
    expect(result.current.data).toEqual([1, 2]);

    // The run still in flight wins when it settles.
    await act(async () => gate.resolve([9]));
    expect(result.current.data).toEqual([9]);
  });

  it('setData clears a stored error', async () => {
    const { result } = renderHook(() =>
      useEffectState(async (): Promise<string> => {
        throw new Error('boom');
      }, [])
    );
    await flush();
    expect(result.current.status).toBe('error');

    act(() => result.current.setData('recovered'));
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: 'recovered',
      error: undefined,
      isRunning: false
    });
  });
});

describe('useEffectState: options', () => {
  it('enabled=false does not run; enabling starts a run in the same render', async () => {
    const task = vi.fn(async () => 'ok');
    const { result, rerender } = renderHook(({ enabled }) => useEffectState(task, [], { enabled }), {
      initialProps: { enabled: false }
    });

    expect(snapshot(result.current)).toEqual({
      status: 'idle',
      data: undefined,
      error: undefined,
      isRunning: false
    });
    expect(task).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(result.current.status).toBe('pending');
    expect(result.current.isRunning).toBe(true);

    await flush();
    expect(result.current.status).toBe('success');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('disabling aborts the run in flight and keeps settled data', async () => {
    const scopes: EffectTaskScope[] = [];
    let resolveFirst!: (value: string) => void;
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useEffectState(
          (scope) => {
            scopes.push(scope);
            return scopes.length === 1
              ? new Promise<string>((resolve) => {
                  resolveFirst = resolve;
                })
              : new Promise<string>(() => undefined);
          },
          [],
          { enabled }
        ),
      { initialProps: { enabled: true } }
    );

    await act(async () => resolveFirst('first'));
    act(() => result.current.reload());
    expect(result.current.isRunning).toBe(true);

    rerender({ enabled: false });
    expect(scopes[1]?.signal.aborted).toBe(true);
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: 'first',
      error: undefined,
      isRunning: false
    });
  });

  it('disabling before anything settled reports idle', () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useEffectState(() => new Promise<string>(() => undefined), [], { enabled }),
      { initialProps: { enabled: true } }
    );
    rerender({ enabled: false });
    expect(result.current.status).toBe('idle');
    expect(result.current.isRunning).toBe(false);
  });

  it('reload is ignored while disabled', () => {
    const task = vi.fn(async () => 1);
    const { result } = renderHook(() => useEffectState(task, [], { enabled: false }));
    act(() => result.current.reload());
    expect(task).not.toHaveBeenCalled();
    expect(result.current.isRunning).toBe(false);
  });

  it('deps changes while disabled reset data to initialData', async () => {
    const { result, rerender } = renderHook(
      ({ id, enabled }) => useEffectState(async () => `user-${id}`, [id], { enabled }),
      { initialProps: { id: 1, enabled: true } }
    );
    await flush();
    expect(result.current.data).toBe('user-1');

    rerender({ id: 2, enabled: false });
    expect(snapshot(result.current)).toEqual({
      status: 'idle',
      data: undefined,
      error: undefined,
      isRunning: false
    });
  });

  it('initialData is used before the first success and after deps change', async () => {
    const init = vi.fn(() => ['initial']);
    const { result, rerender } = renderHook(
      ({ id }) => useEffectState(async () => [`item-${id}`], [id], { initialData: init }),
      { initialProps: { id: 1 } }
    );

    expect(result.current.status).toBe('pending');
    expect(result.current.data).toEqual(['initial']);
    await flush();
    expect(result.current.data).toEqual(['item-1']);

    rerender({ id: 2 });
    expect(result.current.status).toBe('pending');
    expect(result.current.data).toEqual(['initial']);
    await flush();
    expect(result.current.data).toEqual(['item-2']);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('keepPreviousData keeps the previous data while new deps are pending', async () => {
    const { result, rerender } = renderHook(
      ({ page }) => useEffectState(async () => [page], [page], { keepPreviousData: true }),
      { initialProps: { page: 1 } }
    );

    await flush();
    rerender({ page: 2 });
    expect(snapshot(result.current)).toEqual({
      status: 'pending',
      data: [1],
      error: undefined,
      isRunning: true
    });

    await flush();
    expect(result.current.data).toEqual([2]);
  });

  it('calls onSuccess and onError with the latest callbacks, only for the current run', async () => {
    const firstSuccess = vi.fn();
    const latestSuccess = vi.fn();
    const onError = vi.fn();
    const gate = deferred<number>();
    let fail = false;

    const { result, rerender } = renderHook(
      ({ onSuccess }) =>
        useEffectState(
          () => {
            if (fail) return Promise.reject(new Error('failed'));
            return gate.promise;
          },
          [],
          { onSuccess, onError }
        ),
      { initialProps: { onSuccess: firstSuccess } }
    );

    rerender({ onSuccess: latestSuccess });
    await act(async () => gate.resolve(7));
    expect(firstSuccess).not.toHaveBeenCalled();
    expect(latestSuccess).toHaveBeenCalledWith(7);

    fail = true;
    act(() => result.current.reload());
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('failed');
  });

  it('does not log task errors, but reports failing callbacks', async () => {
    const { error } = captureConsole();
    const { result } = renderHook(() =>
      useEffectState(
        async (): Promise<number> => {
          throw new Error('stored, not logged');
        },
        [],
        {
          onError: () => {
            throw new Error('onError failed');
          }
        }
      )
    );
    const { result: successful } = renderHook(() =>
      useEffectState(async () => 1, [], {
        onSuccess: () => {
          throw new Error('onSuccess failed');
        },
        debugName: 'Probe'
      })
    );

    await flush();

    expect(result.current.status).toBe('error');
    expect(successful.current.status).toBe('success');
    const messages = error.mock.calls.map((call) => (call[1] as Error).message);
    expect(messages).toEqual(['onError failed', 'onSuccess failed']);
    expect(error.mock.calls[1]?.[0]).toContain('(Probe)');
  });
});

describe('useEffectState: React integration', () => {
  it('works under StrictMode and aborts the discarded run', async () => {
    const signals: AbortSignal[] = [];

    function Demo() {
      const state = useEffectState(async ({ signal }) => {
        signals.push(signal);
        return signals.length;
      }, []);
      return <div data-testid="state">{`${state.status}:${String(state.data)}`}</div>;
    }

    render(
      <StrictMode>
        <Demo />
      </StrictMode>
    );

    await flush();
    expect(signals.length).toBe(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(screen.getByTestId('state').textContent).toBe('success:2');
  });

  it('debounces with sleep', async () => {
    const requests: string[] = [];
    const { result, rerender } = renderHook(
      ({ query }) =>
        useEffectState(
          async ({ sleep }) => {
            await sleep(20);
            requests.push(query);
            return query.toUpperCase();
          },
          [query]
        ),
      { initialProps: { query: 'r' } }
    );

    rerender({ query: 're' });
    rerender({ query: 'react' });
    await act(async () => {
      await wait(60);
    });

    expect(requests).toEqual(['react']);
    expect(result.current.data).toBe('REACT');
  });

  it.skipIf(!Activity)('keeps state while hidden by <Activity> and runs again when shown', async () => {
    const ActivityComponent = Activity!;
    let runs = 0;
    let setMode!: (mode: 'visible' | 'hidden') => void;
    const scopes: EffectTaskScope[] = [];

    function Child() {
      const state = useEffectState(async (scope) => {
        scopes.push(scope);
        runs += 1;
        return runs;
      }, []);
      return <div data-testid="child">{`${state.status}:${String(state.data)}`}</div>;
    }

    function App() {
      const [mode, updateMode] = useState<'visible' | 'hidden'>('visible');
      setMode = updateMode;
      return (
        <ActivityComponent mode={mode}>
          <Child />
        </ActivityComponent>
      );
    }

    render(<App />);
    await flush();
    expect(screen.getByTestId('child').textContent).toBe('success:1');

    await act(async () => {
      setMode('hidden');
      await wait(10);
    });
    expect(scopes[0]?.signal.aborted).toBe(true);

    await act(async () => {
      setMode('visible');
      await wait(10);
    });
    expect(screen.getByTestId('child').textContent).toBe('success:2');
  });

  it.skipIf(!Activity)('never re-runs a task from a discarded render', async () => {
    const ActivityComponent = Activity!;
    const runs: number[] = [];
    const gate = createSuspender();
    let setId!: (id: number) => void;
    let setMode!: (mode: 'visible' | 'hidden') => void;

    const Child = memo(function Child({ id }: { id: number }) {
      useEffectState(async () => {
        runs.push(id);
        return id;
      }, [id]);
      return null;
    });

    function Gate({ id }: { id: number }) {
      if (id === 2 && !gate.state.ready) throw gate.promise;
      return null;
    }

    function App() {
      const [id, updateId] = useState(1);
      const [mode, updateMode] = useState<'visible' | 'hidden'>('visible');
      setId = updateId;
      setMode = updateMode;
      return (
        <>
          <ActivityComponent mode={mode}>
            <Child id={id} />
          </ActivityComponent>
          <Suspense fallback={null}>
            <Gate id={id} />
          </Suspense>
        </>
      );
    }

    render(<App />);
    await act(async () => {
      startTransition(() => setId(2));
    });
    await act(async () => {
      setMode('hidden');
      await wait(10);
    });
    await act(async () => {
      setMode('visible');
      await wait(10);
    });

    expect(runs).toEqual([1, 1]);

    await act(async () => {
      await gate.release();
      await wait(10);
    });
    expect(runs[runs.length - 1]).toBe(2);
  });
});
