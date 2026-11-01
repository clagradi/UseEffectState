/**
 * True for errors that only mean "this work was cancelled": the abort reason of
 * the run's own signal, or any error named `AbortError` (fetch, DOMException,
 * Node's `AbortError` from `timers/promises` / `events`, polyfills).
 *
 * Duck-typed on purpose: `DOMException` does not exist in every runtime
 * (for example React Native / Hermes), so `instanceof DOMException` can throw.
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal !== undefined && signal.aborted && error !== undefined && error === signal.reason) {
    return true;
  }

  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** Creates an `AbortError` without assuming `DOMException` exists. */
export function createAbortError(message = 'The operation was aborted.'): Error {
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'AbortError') as unknown as Error;
  }

  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** The signal's abort reason, or a fresh `AbortError` for runtimes without `reason`. */
export function abortReasonOf(signal: AbortSignal): unknown {
  return signal.reason !== undefined ? signal.reason : createAbortError();
}

export type ErrorHandler = (error: unknown) => void;

type GlobalWithReportError = typeof globalThis & { reportError?: (error: unknown) => void };

/**
 * Surfaces an error nobody handled, the way an error thrown in a plain effect
 * would surface: through the global `reportError` where it exists (browsers;
 * it reaches `window.onerror`, error monitoring and dev overlays), otherwise
 * through `console.error` with a recognisable prefix.
 */
function reportUnhandled(error: unknown, prefix: string): void {
  const runtime = globalThis as GlobalWithReportError;

  if (typeof runtime.reportError === 'function') {
    try {
      runtime.reportError(error);
      return;
    } catch {
      // Fall through to console.error.
    }
  }

  console.error(`${prefix}:`, error);
}

/**
 * Hands an unexpected error to `onError`, or reports it as unhandled.
 * Never throws: a failing `onError` is reported instead of becoming an
 * unhandled rejection.
 */
export function reportError(
  error: unknown,
  label: string,
  debugName: string | undefined,
  onError: ErrorHandler | undefined
): void {
  const prefix = `[effect-runtime] ${label}${debugName ? ` (${debugName})` : ''}`;

  if (onError) {
    try {
      onError(error);
      return;
    } catch (handlerError) {
      // Report both: the handler's own failure and the error it failed to handle.
      reportUnhandled(handlerError, `${prefix}: onError threw while handling an error`);
    }
  }

  reportUnhandled(error, prefix);
}
