import { Suspense, startTransition, useLayoutEffect, useState } from 'react';
import { act, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useEvent } from '../src';
import { createSuspender, wait } from './helpers';

describe('useEvent', () => {
  it('keeps a stable identity between renders', () => {
    const { result, rerender } = renderHook(({ value }) => useEvent(() => value), {
      initialProps: { value: 'one' }
    });

    const first = result.current;
    rerender({ value: 'two' });
    rerender({ value: 'three' });

    expect(result.current).toBe(first);
  });

  it('always calls the latest committed callback', () => {
    const { result, rerender } = renderHook(({ value }) => useEvent(() => value), {
      initialProps: { value: 'one' }
    });

    const handler = result.current;
    expect(handler()).toBe('one');

    rerender({ value: 'two' });
    expect(handler()).toBe('two');
  });

  it('forwards arguments, the return value and `this`', () => {
    const { result } = renderHook(() =>
      useEvent(function (this: { base: number } | undefined, a: number, b: number) {
        return (this?.base ?? 0) + a + b;
      })
    );

    const handler = result.current;
    expect(handler.call(undefined, 1, 2)).toBe(3);
    expect(handler.call({ base: 10 }, 1, 2)).toBe(13);
  });

  it('throws when called during the first render', () => {
    function Demo() {
      const read = useEvent(() => 'value');
      return <div>{read()}</div>;
    }

    const consoleError = console.error;
    console.error = () => undefined; // React logs the render error
    try {
      expect(() => render(<Demo />)).toThrow(/called during render/);
    } finally {
      console.error = consoleError;
    }
  });

  it('is updated before child layout effects run', () => {
    const seen: string[] = [];

    function Child({ onCommit }: { onCommit: () => void }) {
      useLayoutEffect(() => {
        onCommit();
      });
      return null;
    }

    function Parent({ value }: { value: string }) {
      const onCommit = useEvent(() => seen.push(value));
      return <Child onCommit={onCommit} />;
    }

    const { rerender } = render(<Parent value="one" />);
    rerender(<Parent value="two" />);

    expect(seen).toEqual(['one', 'two']);
  });

  it('never exposes values from a render that React discarded', async () => {
    const gate = createSuspender();
    let handler!: () => string;
    let setValue!: (value: string) => void;

    function Gate({ value }: { value: string }) {
      if (value === 'two' && !gate.state.ready) {
        throw gate.promise;
      }
      return null;
    }

    function App() {
      const [value, update] = useState('one');
      setValue = update;
      handler = useEvent(() => value);
      return (
        <>
          <div data-testid="value">{value}</div>
          <Suspense fallback={null}>
            <Gate value={value} />
          </Suspense>
        </>
      );
    }

    render(<App />);
    await act(async () => {
      // Renders App with "two", then suspends: the transition stays pending and
      // that render is never committed.
      startTransition(() => setValue('two'));
    });

    expect(screen.getByTestId('value').textContent).toBe('one');
    expect(handler()).toBe('one');

    await act(async () => {
      await gate.release();
      await wait(10);
    });
    expect(screen.getByTestId('value').textContent).toBe('two');
    expect(handler()).toBe('two');
  });
});
