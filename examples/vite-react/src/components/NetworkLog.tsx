import { useSyncExternalStore } from 'react';
import { requestLog } from '../api';

export function NetworkLog() {
  const entries = useSyncExternalStore(requestLog.subscribe, requestLog.getSnapshot);

  return (
    <aside className="network-log" aria-label="Simulated network log">
      <header>
        <h2>Network log</h2>
        <button type="button" className="ghost" onClick={requestLog.clear}>
          Clear
        </button>
      </header>
      <p className="hint">
        Every simulated request. <span className="badge aborted">aborted</span> means the run that
        started it ended first (deps changed, reload, unmount or StrictMode&apos;s extra mount).
      </p>
      {entries.length === 0 ? (
        <p className="hint">No requests yet.</p>
      ) : (
        <ol>
          {entries.map((entry) => (
            <li key={entry.id}>
              <span className={`badge ${entry.status}`}>{entry.status}</span>
              <code>{entry.label}</code>
              {entry.durationMs !== undefined ? <span className="muted">{entry.durationMs} ms</span> : null}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
