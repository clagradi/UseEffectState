import { StrictMode, Suspense, memo, startTransition, useEffect, useState } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffectTask, useLayoutEffectTask, useEvent } from '../src';
import type { EffectTaskScope } from '../src';
import {
  Activity,
  ErrorBoundary,
  captureConsole,
  captureUnhandledRejections,
  createSuspender,
  deferred,
  flushMicrotasks,
  wait
} from './helpers';

// The DOM lib declares reportError as always present; jsdom does not provide it.
type GlobalWithReportError = { reportError?: (error: unknown) => void };

afterEach(() => {
  delete (globalThis as unknown as GlobalWithReportError).reportError;
});

describe('useEffectTask: lifecycle', () => {
  it('runs after mount with an active scope', () => {
    let scope: EffectTaskScope | undefined;
    renderHook(() =>
      useEffectTask((current) => {
        scope = current;
      }, [])
    );

    expect(scope?.runId).toBe(1);
    expect(scope?.signal.aborted).toBe(false);
    expect(scope?.isActive()).toBe(true);
  });

  it('aborts the previous run when deps change and starts a new one', () => {
    const scopes: EffectTaskScope[] = [];
    const { rerender } = renderHook(
      ({ id }) =>
        useEffectTask((scope) => {
          scopes.push(scope);
        }, [id]),
      { initialProps: { id: 1 } }
    );

    rerender({ id: 2 });

    expect(scopes.map((scope) => scope.runId)).toEqual([1, 2]);
    expect(scopes[0]?.signal.aborted).toBe(true);
    expect(scopes[0]?.isActive()).toBe(false);
    expect(scopes[1]?.signal.aborted).toBe(false);
    expect(scopes[1]?.isActive()).toBe(true);
  });

  it('aborts the current run on unmount', () => {
    let scope: EffectTaskScope | undefined;
    const { unmount } = renderHook(() =>
      useEffectTask((current) => {
        scope = current;
      }, [])
    );

    unmount();

    expect(scope?.signal.aborted).toBe(true);
    expect(scope?.isActive()).toBe(false);
    expect((scope?.signal.reason as Error).name).toBe('AbortError');
    expect((scope?.signal.reason as Error).message).toBe('The effect run ended.');
  });

  it('does not re-run when deps are unchanged', () => {
    const task = vi.fn();
    const { rerender } = renderHook(({ id }) => useEffectTask(task, [id]), {
      initialProps: { id: 1 }
    });

    rerender({ id: 1 });
    rerender({ id: 1 });

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('accepts readonly deps', () => {
    const deps = [1, 'two'] as const;
    const task = vi.fn();
    renderHook(() => useEffectTask(task, deps));
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('always runs the latest task closure', () => {
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ id, label }) =>
        useEffectTask(() => {
          seen.push(`${id}:${label}`);
        }, [id]),
      { initialProps: { id: 1, label: 'a' } }
    );

    rerender({ id: 1, label: 'b' }); // no re-run: deps unchanged
    rerender({ id: 2, label: 'c' }); // re-run sees the latest label

    expect(seen).toEqual(['1:a', '2:c']);
  });

  it('blocks a stale commit when an older run resolves last', async () => {
    const first = deferred();
    const second = deferred();

    function Demo({ id }: { id: number }) {
      const [value, setValue] = useState('idle');

      useEffectTask(
        async ({ commit }) => {
          await (id === 1 ? first.promise : second.promise);
          commit(() => setValue(id === 1 ? 'one' : 'two'));
        },
        [id]
      );

      return <div data-testid="value">{value}</div>;
    }

    const { rerender } = render(<Demo id={1} />);
    rerender(<Demo id={2} />);

    await act(async () => {
      second.resolve();
      await flushMicrotasks();
    });
    expect(screen.getByTestId('value').textContent).toBe('two');

    await act(async () => {
      first.resolve();
      await flushMicrotasks();
    });
    expect(screen.getByTestId('value').textContent).toBe('two');
  });

  it('commit runs synchronously while the run is active', () => {
    const calls: string[] = [];
    renderHook(() =>
      useEffectTask(({ commit }) => {
        commit(() => calls.push('committed'));
        calls.push('after commit');
      }, [])
    );

    expect(calls).toEqual(['committed', 'after commit']);
  });
});

describe('useEffectTask: cleanups', () => {
  it('runs onCleanup cleanups in LIFO order after aborting the signal', () => {
    const order: string[] = [];
    const { unmount } = renderHook(() =>
      useEffectTask(({ onCleanup, signal }) => {
        onCleanup(() => order.push(`a aborted=${signal.aborted}`));
        onCleanup(() => order.push('b'));
        onCleanup(() => order.push('c'));
      }, [])
    );

    unmount();

    expect(order).toEqual(['c', 'b', 'a aborted=true']);
  });

  it('runs the returned cleanup before earlier onCleanup registrations', () => {
    const order: string[] = [];
    const { unmount } = renderHook(() =>
      useEffectTask(({ onCleanup }) => {
        order.push('connect');
        onCleanup(() => order.push('close'));
        order.push('subscribe');
        return () => order.push('unsubscribe');
      }, [])
    );

    unmount();

    expect(order).toEqual(['connect', 'subscribe', 'unsubscribe', 'close']);
  });

  it('runs a cleanup resolved by an active async task before earlier registrations', async () => {
    const order: string[] = [];
    const { unmount } = renderHook(() =>
      useEffectTask(async ({ onCleanup }) => {
        await Promise.resolve();
        onCleanup(() => order.push('close'));
        return () => order.push('unsubscribe');
      }, [])
    );

    await act(async () => {
      await flushMicrotasks();
    });
    unmount();

    expect(order).toEqual(['unsubscribe', 'close']);
  });

  it('runs a cleanup immediately when it arrives after unmount', async () => {
    const gate = deferred();
    const cleanup = vi.fn();
    const { unmount } = renderHook(() =>
      useEffectTask(async () => {
        await gate.promise;
        return cleanup;
      }, [])
    );

    unmount();
    expect(cleanup).not.toHaveBeenCalled();

    await act(async () => {
      gate.resolve();
      await flushMicrotasks();
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs onCleanup immediately when called after the run ended', async () => {
    const gate = deferred();
    const cleanup = vi.fn();
    const { unmount } = renderHook(() =>
      useEffectTask(async ({ onCleanup }) => {
        await gate.promise;
        onCleanup(cleanup);
      }, [])
    );

    unmount();
    await act(async () => {
      gate.resolve();
      await flushMicrotasks();
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs every cleanup exactly once', () => {
    const cleanup = vi.fn();
    const returned = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ id }) =>
        useEffectTask(
          ({ onCleanup }) => {
            onCleanup(cleanup);
            return returned;
          },
          [id]
        ),
      { initialProps: { id: 1 } }
    );

    rerender({ id: 2 });
    unmount();

    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(returned).toHaveBeenCalledTimes(2);
  });

  it('onCleanup returns a function that runs the cleanup early, at most once', () => {
    const order: string[] = [];
    let early: (() => void) | undefined;
    const { unmount } = renderHook(() =>
      useEffectTask(({ onCleanup }) => {
        onCleanup(() => order.push('a'));
        early = onCleanup(() => order.push('b'));
        onCleanup(() => order.push('c'));
      }, [])
    );

    early?.();
    early?.();
    expect(order).toEqual(['b']);

    unmount();
    expect(order).toEqual(['b', 'c', 'a']);
  });

  it('still runs a cleanup once when the task returns onCleanup(...) (the 0.1 idiom)', () => {
    const cleanup = vi.fn();
    const { unmount } = renderHook(() =>
      useEffectTask(({ onCleanup }) => onCleanup(cleanup), [])
    );

    unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('ignores non-function values passed to onCleanup', () => {
    const { unmount } = renderHook(() =>
      useEffectTask(({ onCleanup }) => {
        onCleanup(undefined as unknown as () => void);
      }, [])
    );
    expect(() => unmount()).not.toThrow();
  });
});

describe('useEffectTask: errors', () => {
  it('passes sync and async task errors to onError', async () => {
    const onError = vi.fn();
    const syncError = new Error('sync');
    const asyncError = new Error('async');

    renderHook(() =>
      useEffectTask(
        () => {
          throw syncError;
        },
        [],
        { onError }
      )
    );
    renderHook(() =>
      useEffectTask(
        async () => {
          await Promise.resolve();
          throw asyncError;
        },
        [],
        { onError }
      )
    );

    await act(async () => {
      await flushMicrotasks();
    });

    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenNthCalledWith(1, syncError);
    expect(onError).toHaveBeenNthCalledWith(2, asyncError);
  });

  it('logs with a recognisable prefix when there is no onError and no global reportError', () => {
    const { error } = captureConsole();
    const failure = new Error('boom');

    renderHook(() =>
      useEffectTask(
        () => {
          throw failure;
        },
        [],
        { debugName: 'UserCard' }
      )
    );

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toBe('[effect-runtime] useEffectTask task failed (UserCard):');
    expect(error.mock.calls[0]?.[1]).toBe(failure);
  });

  it('surfaces unhandled errors through the global reportError when it exists', () => {
    const { error } = captureConsole();
    const reportError = vi.fn();
    (globalThis as unknown as GlobalWithReportError).reportError = reportError;
    const failure = new Error('boom');

    renderHook(() =>
      useEffectTask(() => {
        throw failure;
      }, [])
    );

    expect(reportError).toHaveBeenCalledWith(failure);
    expect(error).not.toHaveBeenCalled();
  });

  it('ignores the abort reason and any error from runs that already ended', async () => {
    const onError = vi.fn();
    const gate = deferred();

    const { unmount } = renderHook(() =>
      useEffectTask(
        async ({ signal }) => {
          await gate.promise;
          if (signal.aborted) {
            throw new TypeError('stale run failed after abort');
          }
        },
        [],
        { onError }
      )
    );
    const { unmount: unmountSecond } = renderHook(() =>
      useEffectTask(
        async ({ signal }) => {
          await gate.promise;
          throw signal.reason;
        },
        [],
        { onError }
      )
    );

    unmount();
    unmountSecond();
    await act(async () => {
      gate.resolve();
      await flushMicrotasks();
    });

    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores AbortErrors from other sources while the run is active', async () => {
    const onError = vi.fn();
    renderHook(() =>
      useEffectTask(
        async () => {
          const controller = new AbortController();
          controller.abort();
          throw controller.signal.reason;
        },
        [],
        { onError }
      )
    );

    await act(async () => {
      await flushMicrotasks();
    });

    expect(onError).not.toHaveBeenCalled();
  });

  it('reports errors thrown by every kind of cleanup and still runs the others', async () => {
    const onError = vi.fn();
    const ran: string[] = [];
    const late = deferred();

    const { unmount } = renderHook(() =>
      useEffectTask(
        ({ onCleanup }) => {
          onCleanup(() => ran.push('first'));
          onCleanup(() => {
            throw new Error('onCleanup failed');
          });
          return () => {
            throw new Error('returned cleanup failed');
          };
        },
        [],
        { onError }
      )
    );
    const { unmount: unmountLate } = renderHook(() =>
      useEffectTask(
        async ({ onCleanup }) => {
          await late.promise;
          onCleanup(() => {
            throw new Error('post-dispose cleanup failed');
          });
          return () => {
            throw new Error('late cleanup failed');
          };
        },
        [],
        { onError }
      )
    );

    unmount();
    unmountLate();
    await act(async () => {
      late.resolve();
      await flushMicrotasks();
    });

    expect(ran).toEqual(['first']);
    expect(onError.mock.calls.map(([error]) => (error as Error).message)).toEqual([
      'returned cleanup failed',
      'onCleanup failed',
      'post-dispose cleanup failed',
      'late cleanup failed'
    ]);
  });

  it('always uses the latest onError', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const gate = deferred();

    const { rerender } = renderHook(
      ({ onError }) =>
        useEffectTask(
          async () => {
            await gate.promise;
            throw new Error('late failure');
          },
          [],
          { onError }
        ),
      { initialProps: { onError: first } }
    );

    rerender({ onError: second });
    await act(async () => {
      gate.resolve();
      await flushMicrotasks();
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('never turns a throwing onError into an unhandled rejection or a render crash', async () => {
    const { error } = captureConsole();
    const rejections = captureUnhandledRejections();
    const boundaryErrors: unknown[] = [];
    const onError = () => {
      throw new Error('onError itself threw');
    };

    function SyncFailure() {
      useEffectTask(
        () => {
          throw new Error('sync failure');
        },
        [],
        { onError }
      );
      return <div>sync-child</div>;
    }

    function AsyncFailure() {
      useEffectTask(
        async () => {
          await Promise.resolve();
          throw new Error('async failure');
        },
        [],
        { onError }
      );
      return <div>async-child</div>;
    }

    try {
      render(
        <ErrorBoundary onError={(boundaryError) => boundaryErrors.push(boundaryError)}>
          <SyncFailure />
          <AsyncFailure />
        </ErrorBoundary>
      );
      await act(async () => {
        await wait(20);
      });
    } finally {
      rejections.restore();
    }

    expect(rejections.reasons).toEqual([]);
    expect(boundaryErrors).toEqual([]);
    expect(screen.getByText('sync-child')).toBeTruthy();
    // Both the handler failure and the original error are reported, for both tasks.
    const messages = error.mock.calls.map((call) => (call[1] as Error).message);
    expect(messages).toEqual([
      'onError itself threw',
      'sync failure',
      'onError itself threw',
      'async failure'
    ]);
  });

  it('works where DOMException does not exist (React Native / Hermes)', async () => {
    const original = globalThis.DOMException;
    const onError = vi.fn();
    const gate = deferred();
    let sleepRejection: unknown;

    // @ts-expect-error -- simulate a runtime without DOMException
    delete globalThis.DOMException;
    try {
      const { unmount } = renderHook(() =>
        useEffectTask(
          async ({ sleep }) => {
            try {
              await sleep(Infinity);
            } catch (error) {
              sleepRejection = error;
              throw error;
            }
          },
          [],
          { onError }
        )
      );
      renderHook(() =>
        useEffectTask(
          async () => {
            await gate.promise;
            throw new TypeError('real failure');
          },
          [],
          { onError }
        )
      );

      unmount();
      await act(async () => {
        gate.resolve();
        await flushMicrotasks();
      });
    } finally {
      globalThis.DOMException = original;
    }

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).name).toBe('TypeError');
    expect((sleepRejection as Error | undefined)?.name).toBe('AbortError');
  });

  it('accepts thenables that only implement then()', async () => {
    const onError = vi.fn();
    const cleanup = vi.fn();
    const failure = new Error('thenable rejected');

    const { unmount } = renderHook(() =>
      useEffectTask(
        () =>
          ({
            then(onFulfilled: (value: () => void) => void) {
              onFulfilled(cleanup);
            }
          }) as PromiseLike<() => void>,
        []
      )
    );
    renderHook(() =>
      useEffectTask(
        () =>
          ({
            then(_onFulfilled: unknown, onRejected: (reason: unknown) => void) {
              onRejected(failure);
            }
          }) as PromiseLike<void>,
        [],
        { onError }
      )
    );

    await act(async () => {
      await flushMicrotasks();
    });
    unmount();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

describe('useEffectTask: sleep', () => {
  it('sleep resolves after the delay', async () => {
    const done = vi.fn();
    renderHook(() =>
      useEffectTask(async ({ sleep }) => {
        await sleep(15);
        done();
      }, [])
    );

    expect(done).not.toHaveBeenCalled();
    await act(async () => {
      await wait(40);
    });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('sleep rejects with the abort reason when the run ends, so the task stops', async () => {
    const reached = vi.fn();
    let rejection: unknown;
    let signal: AbortSignal | undefined;

    const { unmount } = renderHook(() =>
      useEffectTask(async (scope) => {
        signal = scope.signal;
        try {
          await scope.sleep(1_000);
          reached();
        } catch (error) {
          rejection = error;
        }
      }, [])
    );

    unmount();
    await act(async () => {
      await flushMicrotasks();
    });

    expect(reached).not.toHaveBeenCalled();
    expect(rejection).toBe(signal?.reason);
  });

  it('sleep debounces: only the last of several quick deps changes gets past it', async () => {
    const requests: string[] = [];
    const { rerender } = renderHook(
      ({ query }) =>
        useEffectTask(
          async ({ sleep }) => {
            await sleep(20);
            requests.push(query);
          },
          [query]
        ),
      { initialProps: { query: 'r' } }
    );

    rerender({ query: 're' });
    rerender({ query: 'rea' });
    rerender({ query: 'react' });
    await act(async () => {
      await wait(60);
    });

    expect(requests).toEqual(['react']);
  });

  it('sleep rejects immediately when the run already ended', async () => {
    let scope: EffectTaskScope | undefined;
    const { unmount } = renderHook(() =>
      useEffectTask((current) => {
        scope = current;
      }, [])
    );
    unmount();

    await expect(scope?.sleep(10)).rejects.toBe(scope?.signal.reason);
  });

});

describe('useEffectTask: React integration', () => {
  it('is StrictMode safe: the extra run is aborted and every cleanup runs', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const scopes: EffectTaskScope[] = [];

    function Demo() {
      useEffectTask((scope) => {
        scopes.push(scope);
        const handle = setInterval(() => undefined, 1000);
        scope.onCleanup(() => clearInterval(handle));
      }, []);
      return null;
    }

    // Note: StrictMode must be the root element; a renderHook wrapper does not
    // double-invoke effects on React 19.
    const { unmount } = render(
      <StrictMode>
        <Demo />
      </StrictMode>
    );

    expect(scopes.length).toBe(2);
    expect(scopes[0]?.signal.aborted).toBe(true);
    expect(scopes[1]?.signal.aborted).toBe(false);

    unmount();

    expect(clearIntervalSpy.mock.calls.length).toBe(setIntervalSpy.mock.calls.length);
  });

  it('matches useEffect ordering between parents and children', () => {
    const log: string[] = [];

    function Child({ id }: { id: number }) {
      useEffectTask(
        ({ onCleanup }) => {
          log.push(`child run ${id}`);
          onCleanup(() => log.push(`child cleanup ${id}`));
        },
        [id]
      );
      return null;
    }

    function Parent({ id }: { id: number }) {
      useEffect(() => {
        log.push(`parent run ${id}`);
        return () => {
          log.push(`parent cleanup ${id}`);
        };
      }, [id]);
      return <Child id={id} />;
    }

    const { rerender, unmount } = render(<Parent id={1} />);
    rerender(<Parent id={2} />);
    unmount();

    expect(log).toEqual([
      'child run 1',
      'parent run 1',
      'child cleanup 1',
      'parent cleanup 1',
      'child run 2',
      'parent run 2',
      'parent cleanup 2',
      'child cleanup 2'
    ]);
  });

  it.skipIf(!Activity)(
    're-runs the committed task, not one from a discarded render, when <Activity> reveals it',
    async () => {
      const ActivityComponent = Activity!;
      const runs: string[] = [];
      const gate = createSuspender();
      let setId!: (id: number) => void;
      let setMode!: (mode: 'visible' | 'hidden') => void;

      const Child = memo(function Child({ id }: { id: number }) {
        useEffectTask(() => {
          runs.push(`run ${id}`);
        }, [id]);
        return <div data-testid="child">{id}</div>;
      });

      function Gate({ id }: { id: number }) {
        if (id === 2 && !gate.state.ready) {
          throw gate.promise;
        }
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
      // Child renders with id=2, but the transition suspends: that render is discarded.
      await act(async () => {
        startTransition(() => setId(2));
      });
      expect(screen.getByTestId('child').textContent).toBe('1');

      await act(async () => {
        setMode('hidden');
        await wait(10);
      });
      await act(async () => {
        setMode('visible');
        await wait(10);
      });

      expect(runs).toEqual(['run 1', 'run 1']);

      await act(async () => {
        await gate.release();
        await wait(10);
      });
      expect(runs[runs.length - 1]).toBe('run 2');
    }
  );

  it('re-runs the committed layout task when a Suspense boundary reveals it again', async () => {
    const runs: string[] = [];
    const gate = createSuspender();
    const sibling = createSuspender();
    let setId!: (id: number) => void;
    let setSuspendSibling!: (value: boolean) => void;

    const Child = memo(function Child({ id }: { id: number }) {
      useLayoutEffectTask(() => {
        runs.push(`run ${id}`);
      }, [id]);
      return <div data-testid="child">{id}</div>;
    });

    function Sibling({ suspend }: { suspend: boolean }) {
      if (suspend && !sibling.state.ready) {
        throw sibling.promise;
      }
      return null;
    }

    function Gate({ id }: { id: number }) {
      if (id === 2 && !gate.state.ready) {
        throw gate.promise;
      }
      return null;
    }

    function App() {
      const [id, updateId] = useState(1);
      const [suspend, updateSuspend] = useState(false);
      setId = updateId;
      setSuspendSibling = updateSuspend;
      return (
        <>
          <Suspense fallback={<div>loading A</div>}>
            <Child id={id} />
            <Sibling suspend={suspend} />
          </Suspense>
          <Suspense fallback={null}>
            <Gate id={id} />
          </Suspense>
        </>
      );
    }

    render(<App />);
    await act(async () => {
      startTransition(() => setId(2)); // discarded: Gate suspends
    });
    await act(async () => {
      setSuspendSibling(true); // hides boundary A: layout effects are destroyed
    });
    await act(async () => {
      await sibling.release(); // reveals boundary A: layout effects reconnect
      await wait(700);
    });

    expect(screen.getByTestId('child').textContent).toBe('1');
    expect(runs).not.toContain('run 2');
    expect(runs[runs.length - 1]).toBe('run 1');

    await act(async () => {
      await gate.release();
      await wait(10);
    });
  });

  it('calls useEvent handlers safely from tasks', () => {
    const seen: number[] = [];

    function Demo({ count }: { count: number }) {
      const onRun = useEvent(() => seen.push(count));
      useEffectTask(() => {
        onRun();
      }, [onRun]);
      return null;
    }

    render(<Demo count={1} />);
    expect(seen).toEqual([1]);
  });
});

describe('useLayoutEffectTask and the layout option', () => {
  it('useLayoutEffectTask runs before passive effects of the same commit', () => {
    const log: string[] = [];

    function Demo() {
      useEffect(() => {
        log.push('passive');
      }, []);
      useLayoutEffectTask(({ onCleanup }) => {
        log.push('layout');
        onCleanup(() => log.push('layout cleanup'));
      }, []);
      return null;
    }

    const { unmount } = render(<Demo />);
    unmount();

    expect(log).toEqual(['layout', 'passive', 'layout cleanup']);
  });

  it('the deprecated layout option is read once on mount and warns when it changes', () => {
    const { warn } = captureConsole();
    const log: string[] = [];

    function Demo({ layout, id }: { layout: boolean; id: number }) {
      useEffect(() => {
        log.push(`passive ${id}`);
      }, [id]);
      useEffectTask(
        () => {
          log.push(`task ${id}`);
        },
        [id],
        { layout }
      );
      return null;
    }

    const { rerender } = render(<Demo layout id={1} />);
    rerender(<Demo layout={false} id={2} />);
    rerender(<Demo layout={false} id={3} />);

    // Still a layout effect (runs before the passive effect) after the option changed.
    expect(log).toEqual(['task 1', 'passive 1', 'task 2', 'passive 2', 'task 3', 'passive 3']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('useLayoutEffectTask');
  });
});
