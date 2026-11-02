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
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEffectState } from '../src';
import type { EffectState, EffectTaskScope, SetEffectStateData } from '../src';
import {
  Activity,
  ErrorBoundary,
  captureConsole,
  createSuspender,
  deferred,
  flushMicrotasks,
  wait
} from './helpers';

async function flush(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
  });
}

function snapshot<T, TData>(state: EffectState<T, TData>) {
  return {
    status: state.status,
    data: state.data,
    error: state.error,
    isRunning: state.isRunning,
    isPlaceholderData: state.isPlaceholderData
  };
}

function gates<T>() {
  const map = new Map<number, ReturnType<typeof deferred<T>>>();
  return (id: number) => {
    if (!map.has(id)) map.set(id, deferred<T>());
    return map.get(id)!;
  };
}

/** Runs a test body outside act(), the way React schedules work in a real browser. */
async function withoutAct(body: () => Promise<void>): Promise<void> {
  const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = actGlobal.IS_REACT_ACT_ENVIRONMENT;
  actGlobal.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await body();
  } finally {
    actGlobal.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

describe('useEffectState: transitions', () => {
  it('starts pending and running, then succeeds', async () => {
    const gate = deferred<string>();
    const { result } = renderHook(() => useEffectState(() => gate.promise, []));

    expect(snapshot(result.current)).toEqual({
      status: 'pending',
      data: undefined,
      error: undefined,
      isRunning: true,
      isPlaceholderData: false
    });

    await act(async () => {
      gate.resolve('hello');
    });

    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: 'hello',
      error: undefined,
      isRunning: false,
      isPlaceholderData: false
    });
  });

  it('supports sync tasks', async () => {
    const { result } = renderHook(() => useEffectState(() => 42, []));
    await flush();
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: 42,
      error: undefined,
      isRunning: false,
      isPlaceholderData: false
    });
  });

  it('stores sync and async errors, without logging them', async () => {
    const { error: consoleError } = captureConsole();
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
    expect(async.current.status).toBe('error');
    expect(async.current.error).toBe(asyncError);
    expect(async.current.isRunning).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('is pending in the same render when deps change (never old data for new deps)', async () => {
    const renders: Array<{ id: number; status: string; data: unknown }> = [];
    const gateFor = gates<string>();

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

  it('commits a deps change once', async () => {
    const gateFor = gates<string>();
    let commits = 0;

    function Demo({ id }: { id: number }) {
      useEffectState(() => gateFor(id).promise, [id]);
      useLayoutEffect(() => {
        commits += 1;
      });
      return null;
    }

    const { rerender } = render(<Demo id={1} />);
    await act(async () => gateFor(1).resolve('one'));
    commits = 0;
    rerender(<Demo id={2} />);

    expect(commits).toBe(1);
  });

  it('ignores a stale run that resolves after a newer one', async () => {
    const first = deferred<string>();
    const second = deferred<string>();

    const { result, rerender } = renderHook(
      ({ id }) => useEffectState(() => (id === 1 ? first.promise : second.promise), [id]),
      { initialProps: { id: 1 } }
    );

    rerender({ id: 2 });
    await act(async () => second.resolve('two'));
    await act(async () => first.resolve('one'));

    expect(result.current.data).toBe('two');
  });

  it('ignores errors from runs that ended', async () => {
    const first = deferred<string>();
    const { result, rerender } = renderHook(
      ({ id }) => useEffectState(() => (id === 1 ? first.promise : Promise.resolve('two')), [id]),
      { initialProps: { id: 1 } }
    );

    rerender({ id: 2 });
    await flush();
    await act(async () => first.reject(new Error('stale failure')));

    expect(result.current.status).toBe('success');
    expect(result.current.data).toBe('two');
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

  it('aborts the run when deps change and on unmount, with a library abort reason', () => {
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
    expect((scopes[0]?.signal.reason as Error).name).toBe('AbortError');
    expect((scopes[0]?.signal.reason as Error).message).toBe('The effect run ended.');
    expect(scopes[1]?.signal.aborted).toBe(false);

    unmount();
    expect(scopes[1]?.signal.aborted).toBe(true);
  });

  it('runs onCleanup cleanups when the run ends and reports their errors', () => {
    const { error: consoleError } = captureConsole();
    const cleanup = vi.fn();
    const failure = new Error('cleanup failed');
    const { unmount } = renderHook(() =>
      useEffectState(({ onCleanup }) => {
        onCleanup(cleanup);
        onCleanup(() => {
          throw failure;
        });
        return 1;
      }, [])
    );

    expect(cleanup).not.toHaveBeenCalled();
    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('[effect-runtime] useEffectState cleanup failed:', failure);
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
    const runs = [deferred<number>(), deferred<number>()];
    const { result } = renderHook(() => useEffectState(() => runs[calls++]!.promise, []));

    await act(async () => runs[0]!.resolve(1));
    expect(result.current.data).toBe(1);

    act(() => result.current.reload());
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: 1,
      error: undefined,
      isRunning: true,
      isPlaceholderData: false
    });

    await act(async () => runs[1]!.resolve(2));
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: 2,
      error: undefined,
      isRunning: false,
      isPlaceholderData: false
    });
  });

  it('reload aborts the run in flight at the next commit and ignores its late outcome', async () => {
    const first = deferred<string>();
    const scopes: EffectTaskScope[] = [];
    const { result } = renderHook(() =>
      useEffectState((scope) => {
        scopes.push(scope);
        return scopes.length === 1 ? first.promise : new Promise<string>(() => undefined);
      }, [])
    );

    act(() => result.current.reload());

    expect(scopes.length).toBe(2);
    expect(scopes[0]?.signal.aborted).toBe(true);
    expect(scopes[1]?.signal.aborted).toBe(false);

    await act(async () => first.resolve('stale'));
    expect(snapshot(result.current)).toEqual({
      status: 'pending',
      data: undefined,
      error: undefined,
      isRunning: true,
      isPlaceholderData: false
    });
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
      isRunning: false,
      isPlaceholderData: false
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

  it('setData accepts a value or an updater; the run in flight still wins', async () => {
    const gate = deferred<number[]>();
    const { result } = renderHook(() => useEffectState(() => gate.promise, []));

    act(() => result.current.setData([1]));
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: [1],
      error: undefined,
      isRunning: true,
      isPlaceholderData: false
    });

    act(() => result.current.setData((previous) => [...(previous ?? []), 2]));
    expect(result.current.data).toEqual([1, 2]);

    await act(async () => gate.resolve([9]));
    expect(result.current.data).toEqual([9]);
  });

  it('setData clears a stored error; setting the same value is a no-op', async () => {
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
      isRunning: false,
      isPlaceholderData: false
    });

    const before = result.current;
    act(() => result.current.setData('recovered'));
    expect(result.current).toBe(before);
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
      isRunning: false,
      isPlaceholderData: false
    });
    expect(task).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(result.current.status).toBe('pending');
    expect(result.current.isRunning).toBe(true);

    await flush();
    expect(result.current.status).toBe('success');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('coerces enabled with Boolean() (for JavaScript callers)', async () => {
    const task = vi.fn(async () => 'ok');
    const { result, rerender } = renderHook(
      ({ enabled }) => useEffectState(task, [], { enabled: enabled as unknown as boolean }),
      { initialProps: { enabled: 0 as unknown } }
    );
    expect(result.current.status).toBe('idle');

    rerender({ enabled: 'yes' });
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
      isRunning: false,
      isPlaceholderData: false
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

  it('deps changes while disabled reset data to the placeholder', async () => {
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
      isRunning: false,
      isPlaceholderData: false
    });
  });

  it('placeholderData is captured for each new set of deps', async () => {
    const placeholders: Record<number, string> = { 1: 'cached-1', 2: 'cached-2' };
    const { result, rerender } = renderHook(
      ({ id }) =>
        useEffectState(async () => `fresh-${id}`, [id], { placeholderData: placeholders[id]! }),
      { initialProps: { id: 1 } }
    );

    expect(snapshot(result.current)).toEqual({
      status: 'pending',
      data: 'cached-1',
      error: undefined,
      isRunning: true,
      isPlaceholderData: true
    });
    await flush();
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: 'fresh-1',
      error: undefined,
      isRunning: false,
      isPlaceholderData: false
    });

    rerender({ id: 2 });
    expect(snapshot(result.current)).toEqual({
      status: 'pending',
      data: 'cached-2', // not the placeholder captured on mount
      error: undefined,
      isRunning: true,
      isPlaceholderData: true
    });
    await flush();
    expect(result.current.data).toBe('fresh-2');
  });

  it('keepPreviousData keeps the data on screen while new deps are pending', async () => {
    const { result, rerender } = renderHook(
      ({ page }) =>
        useEffectState(async () => [page], [page], { placeholderData: [], keepPreviousData: true }),
      { initialProps: { page: 1 } }
    );

    expect(snapshot(result.current)).toMatchObject({ data: [], isPlaceholderData: true });
    await flush();
    rerender({ page: 2 });
    expect(snapshot(result.current)).toEqual({
      status: 'pending',
      data: [1],
      error: undefined,
      isRunning: true,
      isPlaceholderData: true
    });

    await flush();
    expect(snapshot(result.current)).toEqual({
      status: 'success',
      data: [2],
      error: undefined,
      isRunning: false,
      isPlaceholderData: false
    });
  });

  it('keepPreviousData never carries data into idle', async () => {
    const gateFor = gates<string[]>();
    const { result, rerender } = renderHook(
      ({ query, enabled }) =>
        useEffectState(() => gateFor(query.length).promise, [query], {
          enabled,
          placeholderData: [] as string[],
          keepPreviousData: true
        }),
      { initialProps: { query: 'ab', enabled: true } }
    );

    await act(async () => gateFor(2).resolve(['ab-result']));
    expect(result.current.data).toEqual(['ab-result']);

    // A deps change that also disables the hook: back to the placeholder.
    rerender({ query: '', enabled: false });
    expect(snapshot(result.current)).toEqual({
      status: 'idle',
      data: [],
      error: undefined,
      isRunning: false,
      isPlaceholderData: true
    });

    // Disabled with the same deps while pending with kept data: back to the placeholder.
    rerender({ query: 'abc', enabled: true });
    await act(async () => gateFor(3).resolve(['abc-result']));
    rerender({ query: 'abcd', enabled: true });
    expect(snapshot(result.current)).toMatchObject({
      status: 'pending',
      data: ['abc-result'],
      isPlaceholderData: true
    });
    rerender({ query: 'abcd', enabled: false });
    expect(snapshot(result.current)).toEqual({
      status: 'idle',
      data: [],
      error: undefined,
      isRunning: false,
      isPlaceholderData: true
    });
  });
});

describe('useEffectState: races and robustness', () => {
  it('never lets a stale outcome land between the commit and the effect cleanup', async () => {
    await withoutAct(async () => {
      const gateFor = gates<string>();
      const seen: string[] = [];

      // Resolves the previous run's promise during the commit (layout phase), so
      // its outcome arrives before the passive cleanup disposes that run.
      function ResolveAtCommit({ previousId }: { previousId: number }) {
        useLayoutEffect(() => {
          gateFor(previousId).resolve(`stale-${previousId}`);
        }, [previousId]);
        return null;
      }

      function Demo({ id, enabled, previousId }: { id: number; enabled: boolean; previousId?: number }) {
        const state = useEffectState(() => gateFor(id).promise, [id], { enabled });
        seen.push(`${id}:${state.status}:${String(state.data)}`);
        return previousId === undefined ? null : <ResolveAtCommit previousId={previousId} />;
      }

      const root = createRoot(document.createElement('div'));
      try {
        root.render(<Demo id={1} enabled />);
        await wait(30);

        root.render(<Demo id={2} enabled previousId={1} />); // default priority
        await wait(30);
        gateFor(2).resolve('two');
        await wait(30);
        expect(seen[seen.length - 1]).toBe('2:success:two');

        root.render(<Demo id={3} enabled />);
        await wait(30);
        root.render(<Demo id={3} enabled={false} previousId={3} />);
        await wait(30);
        expect(seen[seen.length - 1]).toBe('3:idle:undefined');

        expect(seen.some((entry) => entry.includes('stale'))).toBe(false);
      } finally {
        flushSync(() => root.unmount());
      }
    });
  });

  it('keeps a setData() made by a child effect in the commit that changed deps', async () => {
    const gateFor = gates<string>();
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

  it('fails fast when a dependency is recreated on every render', async () => {
    captureConsole(); // React reports the error caught by the boundary
    const caught: unknown[] = [];
    let runs = 0;

    function Demo({ id, tick }: { id: number; tick: number }) {
      const filter = { id }; // a new object on every render (a common mistake)
      const state = useEffectState(() => {
        runs += 1;
        return new Promise<number>(() => undefined);
      }, [filter]);
      return <div>{`${state.status}:${tick}`}</div>;
    }

    const onError = (error: unknown) => caught.push(error);
    const { rerender } = render(
      <ErrorBoundary onError={onError}>
        <Demo id={1} tick={0} />
      </ErrorBoundary>
    );
    rerender(
      <ErrorBoundary onError={onError}>
        <Demo id={1} tick={1} />
      </ErrorBoundary>
    );
    await flush();

    expect(caught.length).toBe(1);
    expect(String((caught[0] as Error).message)).toMatch(/Too many re-renders/);
    expect(runs).toBeLessThanOrEqual(2);
    expect(screen.getByText('boundary-fallback')).toBeTruthy();
  });
});

describe('useEffectState: React integration', () => {
  it('works under StrictMode and drops the discarded run', async () => {
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

  it('hydrates server HTML without mismatches', async () => {
    const { error: consoleError } = captureConsole();

    function Page() {
      const state = useEffectState(async () => 'client data', [], { placeholderData: 'placeholder' });
      return <p>{`${state.status}:${state.data}`}</p>;
    }

    const container = document.createElement('div');
    container.innerHTML = renderToString(<Page />);
    expect(container.textContent).toBe('pending:placeholder');

    await act(async () => {
      hydrateRoot(container, <Page />);
    });
    await flush();

    expect(container.textContent).toBe('success:client data');
    expect(consoleError).not.toHaveBeenCalled();
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
