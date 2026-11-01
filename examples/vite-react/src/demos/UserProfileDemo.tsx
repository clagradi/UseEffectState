import { useState } from 'react';
import { useEffectState } from '@clagradi/effect-runtime';
import { api, userIds } from '../api';

export function UserProfileDemo() {
  const [userId, setUserId] = useState(1);
  const [failRate, setFailRate] = useState(0);

  const user = useEffectState(
    ({ signal }) => api.getUser(userId, { signal, latency: [400, 1200], failRate }),
    [userId, failRate]
  );

  return (
    <article className="demo-card">
      <h2>useEffectState</h2>
      <p>
        The task&apos;s result becomes state. Switching users aborts the running request, and the
        hook reports <code>pending</code> in the same render, so the previous user is never shown
        for the new id.
      </p>

      <div className="row" role="group" aria-label="User">
        {userIds.map((id) => (
          <button
            key={id}
            type="button"
            className={id === userId ? 'selected' : undefined}
            onClick={() => setUserId(id)}
          >
            #{id}
          </button>
        ))}
      </div>

      <label>
        <input
          type="checkbox"
          checked={failRate > 0}
          onChange={(event) => setFailRate(event.target.checked ? 1 : 0)}
        />
        Make requests fail
      </label>

      <div className="status-line">
        <span className={`badge ${user.status}`} data-testid="profile-status">
          {user.status}
        </span>
        {user.isRunning ? <span className="spinner" aria-label="running" /> : null}
        <button type="button" onClick={user.reload}>
          Reload
        </button>
      </div>

      {user.status === 'pending' ? <p className="muted">Loading user #{userId}…</p> : null}
      {user.status === 'error' ? (
        <p className="error" role="alert">
          {user.error instanceof Error ? user.error.message : String(user.error)}
        </p>
      ) : null}
      {user.data ? (
        <dl className="profile" data-testid="profile">
          <dt>Name</dt>
          <dd>{user.data.name}</dd>
          <dt>Email</dt>
          <dd>{user.data.email}</dd>
          <dt>Company</dt>
          <dd>{user.data.company}</dd>
        </dl>
      ) : null}
    </article>
  );
}
