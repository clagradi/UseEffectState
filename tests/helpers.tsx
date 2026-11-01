import * as React from 'react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';

export const reactMajor = Number(React.version.split('.')[0]);

type ActivityProps = { mode: 'visible' | 'hidden'; children?: ReactNode };

/** `<Activity>` (React 19.2+), or undefined on older React versions. */
export const Activity = (React as unknown as { Activity?: React.ComponentType<ActivityProps> })
  .Activity;

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run. */
export async function flushMicrotasks(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise that suspends a component until `release()` is called. */
export function createSuspender() {
  const gate = deferred();
  const state = { ready: false };
  return {
    state,
    promise: gate.promise,
    async release() {
      state.ready = true;
      gate.resolve();
      await gate.promise;
    }
  };
}

/** Spies on console.error / console.warn and returns the captured calls. */
export function captureConsole() {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return { error, warn };
}

export class ErrorBoundary extends React.Component<
  { onError?: (error: unknown) => void; children?: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    this.props.onError?.(error);
  }

  override render() {
    return this.state.failed ? <div>boundary-fallback</div> : this.props.children;
  }
}

/**
 * Collects unhandled promise rejections during a test without letting Vitest
 * fail the run, so tests can assert that there are none.
 */
export function captureUnhandledRejections() {
  const saved = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  const reasons: unknown[] = [];
  const handler = (reason: unknown) => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', handler);

  return {
    reasons,
    restore() {
      process.off('unhandledRejection', handler);
      for (const listener of saved) {
        process.on('unhandledRejection', listener as (...args: unknown[]) => void);
      }
    }
  };
}
