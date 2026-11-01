import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortReasonOf, createAbortError, isAbortError, reportError } from '../src/internal/errors';
import { createRun, isPromiseLike } from '../src/internal/run';

type GlobalWithReportError = { reportError?: (error: unknown) => void };

afterEach(() => {
  delete (globalThis as unknown as GlobalWithReportError).reportError;
});

describe('isAbortError', () => {
  it('matches the abort reason of an aborted signal, whatever its type', () => {
    const controller = new AbortController();
    const reason = { custom: 'reason' };
    controller.abort(reason);

    expect(isAbortError(reason, controller.signal)).toBe(true);
    expect(isAbortError({ custom: 'reason' }, controller.signal)).toBe(false);
  });

  it('matches anything named AbortError, without relying on DOMException', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
    expect(isAbortError(new DOMException('x', 'TimeoutError'))).toBe(false);
    expect(isAbortError(new TypeError('x'))).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });

  it('does not treat undefined as the reason of a signal that is not aborted', () => {
    expect(isAbortError(undefined, new AbortController().signal)).toBe(false);
  });
});

describe('createAbortError / abortReasonOf', () => {
  it('creates a DOMException AbortError when DOMException exists', () => {
    const error = createAbortError();
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe('AbortError');
  });

  it('falls back to a plain Error named AbortError without DOMException', () => {
    const original = globalThis.DOMException;
    // @ts-expect-error -- simulate a runtime without DOMException
    delete globalThis.DOMException;
    try {
      const error = createAbortError('gone');
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('AbortError');
      expect(error.message).toBe('gone');
    } finally {
      globalThis.DOMException = original;
    }
  });

  it('uses signal.reason, or creates an AbortError for polyfills without reason', () => {
    const controller = new AbortController();
    controller.abort('why');
    expect(abortReasonOf(controller.signal)).toBe('why');

    const legacy = { aborted: true, reason: undefined } as unknown as AbortSignal;
    expect((abortReasonOf(legacy) as Error).name).toBe('AbortError');
  });
});

describe('reportError', () => {
  it('hands the error to onError', () => {
    const onError = vi.fn();
    const error = new Error('x');
    reportError(error, 'label', undefined, onError);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('reports both errors when onError throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handlerError = new Error('handler');
    const error = new Error('original');

    reportError(error, 'useEffectTask task failed', 'Card', () => {
      throw handlerError;
    });

    expect(consoleError.mock.calls).toEqual([
      ['[effect-runtime] useEffectTask task failed (Card): onError threw while handling an error:', handlerError],
      ['[effect-runtime] useEffectTask task failed (Card):', error]
    ]);
  });

  it('prefers the global reportError and falls back to console.error when it throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error('x');
    const globalReport = vi.fn();
    (globalThis as unknown as GlobalWithReportError).reportError = globalReport;

    reportError(error, 'label', undefined, undefined);
    expect(globalReport).toHaveBeenCalledWith(error);
    expect(consoleError).not.toHaveBeenCalled();

    globalReport.mockImplementation(() => {
      throw new Error('reportError failed');
    });
    reportError(error, 'label', undefined, undefined);
    expect(consoleError).toHaveBeenCalledWith('[effect-runtime] label:', error);
  });
});

describe('createRun', () => {
  it('is idempotent and runs cleanups once, newest first, after aborting', () => {
    const order: string[] = [];
    const run = createRun(1, () => undefined);
    run.addCleanup(() => order.push(`first aborted=${run.signal.aborted}`));
    run.addCleanup(() => order.push('second'));

    run.dispose();
    run.dispose();

    expect(order).toEqual(['second', 'first aborted=true']);
    expect(run.isActive()).toBe(false);
    expect(run.scope.isActive()).toBe(false);
  });

  it('keeps running cleanups when one throws, and reports the error', () => {
    const reported: unknown[] = [];
    const ran: string[] = [];
    const run = createRun(1, (error) => reported.push(error));
    const failure = new Error('cleanup failed');

    run.addCleanup(() => ran.push('a'));
    run.addCleanup(() => {
      throw failure;
    });
    run.addCleanup(() => ran.push('c'));
    run.dispose();

    expect(ran).toEqual(['c', 'a']);
    expect(reported).toEqual([failure]);
  });

  it('commit only runs while active', () => {
    const run = createRun(1, () => undefined);
    const fn = vi.fn();
    run.scope.commit(fn);
    run.dispose();
    run.scope.commit(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('sleep treats negative and invalid delays as zero', async () => {
    const run = createRun(1, () => undefined);
    await expect(run.scope.sleep(-10)).resolves.toBeUndefined();
    await expect(run.scope.sleep(Number.NaN)).resolves.toBeUndefined();
  });

  it('sleep(Infinity) only settles when the run ends', async () => {
    const run = createRun(1, () => undefined);
    const settled = vi.fn();
    const sleeping = run.scope.sleep(Infinity).then(settled, (error: unknown) => {
      settled(error);
      throw error;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();

    run.dispose();
    await expect(sleeping).rejects.toBe(run.signal.reason);
  });

  it('clears the timer when aborted during sleep', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const run = createRun(1, () => undefined);
    const sleeping = run.scope.sleep(10_000);
    run.dispose();
    await expect(sleeping).rejects.toBe(run.signal.reason);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('exposes the run id', () => {
    expect(createRun(7, () => undefined).scope.runId).toBe(7);
  });
});

describe('isPromiseLike', () => {
  it('detects thenables', () => {
    expect(isPromiseLike(Promise.resolve())).toBe(true);
    expect(isPromiseLike({ then: () => undefined })).toBe(true);
    const thenableFunction = Object.assign(() => undefined, { then: () => undefined });
    expect(isPromiseLike(thenableFunction)).toBe(true);
    expect(isPromiseLike(() => undefined)).toBe(false);
    expect(isPromiseLike(null)).toBe(false);
    expect(isPromiseLike(undefined)).toBe(false);
    expect(isPromiseLike({ then: 1 })).toBe(false);
  });
});
