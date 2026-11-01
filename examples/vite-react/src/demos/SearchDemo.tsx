import { useState } from 'react';
import { useEffectState } from '@clagradi/effect-runtime';
import { api } from '../api';

export function SearchDemo() {
  const [query, setQuery] = useState('');

  const results = useEffectState(
    async ({ signal, sleep }) => {
      // Debounce: a keystroke within 300 ms ends this run, so sleep() rejects
      // and the request below is never sent.
      await sleep(300);
      return api.searchUsers(query, { signal });
    },
    [query],
    { enabled: query.trim().length > 0, initialData: [], keepPreviousData: true }
  );

  return (
    <article className="demo-card">
      <h2>Debounced search</h2>
      <p>
        <code>await sleep(300)</code> at the start of the task debounces it: typing ends the run,
        so only the last query hits the network. <code>keepPreviousData</code> keeps the old
        results on screen while the new ones load.
      </p>

      <label>
        Search people or companies
        <input
          type="search"
          value={query}
          placeholder="try “a” or “nasa”"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="status-line">
        <span className={`badge ${results.status}`}>{results.status}</span>
        {results.isRunning ? <span className="spinner" aria-label="searching" /> : null}
      </div>

      {results.status === 'idle' ? <p className="muted">Type to search.</p> : null}
      {results.status === 'success' && results.data.length === 0 ? (
        <p className="muted">No matches.</p>
      ) : null}
      <ul className="results">
        {results.data.map((user) => (
          <li key={user.id}>
            <strong>{user.name}</strong> <span className="muted">· {user.company}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}
