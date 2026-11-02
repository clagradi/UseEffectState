import {
  StrictMode,
  Suspense,
  memo,
  startTransition,
  useEffect,
  useLayoutEffect,
  useState
} from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEffectState } from '../src';
import type { EffectState, EffectTaskScope } from '../src';
import { Activity, captureConsole, createSuspender, deferred, flushMicrotasks, wait } from './helpers';
import type { SetEffectStateData } from '../src';

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

  it('keepPreviousData does not keep data when the deps change also disables the hook', async () => {
    const { result, rerender } = renderHook(
      ({ query }) =>
        useEffectState(async () => [`${query}-result`], [query], {
          enabled: query.length > 0,
          initialData: [] as string[],
          keepPreviousData: true
        }),
      { initialProps: { query: 'ab' } }
    );

    await flush();
    expect(result.current.data).toEqual(['ab-result']);

    rerender({ query: '' });
    expect(snapshot(result.current)).toEqual({
      status: 'idle',
      data: [],
      error: undefined,
      isRunning: false
    });
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

describe('useEffectState: races and robustness', () => {
  it('reload() aborts the run in flight immediately, and its late result never lands', async () => {
    const first = deferred<string>();
    const onSuccess = vi.fn();
    const scopes: EffectTaskScope[] = [];
    const { result } = renderHook(() =>
      useEffectState(
        (scope) => {
          scopes.push(scope);
          return scopes.length === 1 ? first.promise : new Promise<string>(() => undefined);
        },
        [],
        { onSuccess }
      )
    );

    act(() => {
      result.current.reload();
      // Synchronously, before React even re-rendered.
      expect(scopes[0]?.signal.aborted).toBe(true);
    });

    await act(async () => first.resolve('stale'));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.isRunning).toBe(true);
    expect(result.current.data).toBeUndefined();
  });

  it('ignores a stale outcome that lands between the commit and the effect cleanup', async () => {
    // Outside act(), a default-priority update commits in one task and runs its
    // passive effects (which dispose the old run) in a later one. A result that
    // arrives in between must not land.
    const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = false;

    const gates = new Map<number, ReturnType<typeof deferred<string>>>();
    const gateFor = (id: number) => {
      if (!gates.has(id)) gates.set(id, deferred<string>());
      return gates.get(id)!;
    };
    const onSuccess = vi.fn();
    const seen: string[] = [];

    // Resolves the previous run's promise during the commit (layout phase).
    function ResolveAtCommit({ previousId }: { previousId: number }) {
      useLayoutEffect(() => {
        gateFor(previousId).resolve(`stale-${previousId}`);
      }, [previousId]);
      return null;
    }

    function Demo({ id, enabled, previousId }: { id: number; enabled: boolean; previousId?: number }) {
      const state = useEffectState(() => gateFor(id).promise, [id], { onSuccess, enabled });
      seen.push(`${id}:${state.status}:${String(state.data)}`);
      return previousId === undefined ? null : <ResolveAtCommit previousId={previousId} />;
    }

    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      root.render(<Demo id={1} enabled />);
      await wait(30); // committed, and run 1 started

      root.render(<Demo id={2} enabled previousId={1} />); // default priority
      await wait(30);
      expect(onSuccess).not.toHaveBeenCalled();

      gateFor(2).resolve('two');
      await wait(30);
      expect(onSuccess.mock.calls).toEqual([['two']]);

      // Same for enabled: false.
      root.render(<Demo id={3} enabled />);
      await wait(30);
      root.render(<Demo id={3} enabled={false} previousId={3} />);
      await wait(30);
      expect(onSuccess.mock.calls).toEqual([['two']]);
      expect(seen[seen.length - 1]).toBe('3:idle:undefined');
    } finally {
      flushSync(() => root.unmount());
      actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it('keeps a setData() made by a child effect in the commit that changed deps', async () => {
    const gates = new Map<number, ReturnType<typeof deferred<string>>>();
    const gateFor = (id: number) => {
      if (!gates.has(id)) gates.set(id, deferred<string>());
      return gates.get(id)!;
    };
    let latest: { status: string; data: string | undefined; isRunning: boolean } | undefined;

    function Child({ id, setData }: { id: number; setData: SetEffectStateData<string> }) {
      useEffect(() => {
        if (id === 2) {
          setData('optimistic-2');
        }
      }, [id, setData]);
      return null;
    }

    function Parent({ id }: { id: number }) {
      const state = useEffectState(() => gateFor(id).promise, [id]);
      latest = { status: state.status, data: state.data, isRunning: state.isRunning };
      return <Child id={id} setData={state.setData} />;
    }

    const { rerender } = render(<Parent id={1} />);
    await act(async () => gateFor(1).resolve('one'));
    rerender(<Parent id={2} />);

    expect(latest).toEqual({ status: 'success', data: 'optimistic-2', isRunning: true });

    await act(async () => gateFor(2).resolve('two'));
    expect(latest).toEqual({ status: 'success', data: 'two', isRunning: false });
  });

  it('does not render-loop when a dep is recreated on every render, and warns once', async () => {
    // Outside act() so that a regression shows up as a failing count, not a hang.
    const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = false;
    const { warn } = captureConsole();
    let renders = 0;
    let runs = 0;

    function Demo({ id, tick }: { id: number; tick: number }) {
      renders += 1;
      const filter = { id }; // a new object on every render (a common mistake)
      const state = useEffectState(
        () => {
          runs += 1;
          return new Promise<number>(() => undefined);
        },
        [filter],
        { debugName: 'Filters' }
      );
      return <div>{`${state.status}:${tick}`}</div>;
    }

    const root = createRoot(document.createElement('div'));
    try {
      root.render(<Demo id={1} tick={0} />);
      await wait(50);
      expect(renders).toBeLessThanOrEqual(3);

      for (let tick = 1; tick <= 4; tick += 1) {
        root.render(<Demo id={1} tick={tick} />);
        await wait(10);
      }
      await wait(50);

      expect(renders).toBeLessThanOrEqual(12);
      expect(runs).toBe(5);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('useEffectState (Filters)');
    } finally {
      flushSync(() => root.unmount());
      actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  it('does not warn about deps that really change', async () => {
    const { warn } = captureConsole();
    const { rerender } = renderHook(({ id }) => useEffectState(async () => id, [{ id }.id]), {
      initialProps: { id: 1 }
    });
    for (let id = 2; id <= 6; id += 1) {
      rerender({ id });
    }
    await flush();
    expect(warn).not.toHaveBeenCalled();
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
