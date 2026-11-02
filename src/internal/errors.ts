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

type Reporter = (error: unknown) => void;
type Host = typeof globalThis & {
  reportError?: Reporter;
  ErrorUtils?: { reportError?: Reporter };
};

/**
 * Surfaces an error nobody handled, the way an error thrown in a plain effect
 * would surface: through the global `reportError` (browsers, Deno, Bun: it
 * reaches `window.onerror`, error monitoring and dev overlays), then React
 * Native's `ErrorUtils.reportError` (LogBox and crash reporters), otherwise
 * `console.error` with a recognisable prefix.
 */
function reportUnhandled(error: unknown, prefix: string, labelled: boolean): void {
  const host = globalThis as Host;
  const reporters: Array<[unknown, unknown]> = [
    [host, host.reportError],
    [host.ErrorUtils, host.ErrorUtils?.reportError]
  ];

  for (const [receiver, report] of reporters) {
    if (typeof report !== 'function') {
      continue;
    }

    try {
      (report as Reporter).call(receiver, error);
    } catch {
      continue;
    }

    // Those reporters only carry the error itself: keep an explicit debugName visible.
    if (labelled) {
      console.warn(`${prefix}:`, error);
    }
    return;
  }

  console.error(`${prefix}:`, error);
}

/**
 * Hands an unexpected error to `onError`, or reports it as unhandled. With a
 * `debugName`, a labelled console.warn accompanies host reporters (which only
 * carry the error). Never throws: a failing `onError` is reported instead of
 * becoming an unhandled rejection.
 */
export function reportError(
  error: unknown,
  label: string,
  debugName: string | undefined,
  onError: ErrorHandler | undefined
): void {
  const prefix = `[effect-runtime] ${label}${debugName ? ` (${debugName})` : ''}`;

  const labelled = debugName !== undefined && debugName !== '';

  if (onError) {
    try {
      onError(error);
      return;
    } catch (handlerError) {
      // Report both: the handler's own failure and the error it failed to handle.
      reportUnhandled(handlerError, `${prefix}: onError threw while handling an error`, labelled);
    }
  }

  reportUnhandled(error, prefix, labelled);
}
