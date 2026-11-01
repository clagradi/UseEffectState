import { useEffect, useState } from 'react';
import { useEffectState } from '@clagradi/effect-runtime';
import { api, userIds } from '../api';
import type { User } from '../api';

// Wide latency range: later requests often finish before earlier ones.
const RACY_LATENCY: [number, number] = [100, 1600];

function NaiveUser({ userId }: { userId: number }) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    // The classic bug: no abort, no stale-result guard.
    api.getUser(userId, { latency: RACY_LATENCY }).then(setUser);
  }, [userId]);

  return <RaceResult title="useEffect + useState" userId={userId} shown={user} />;
}

function SafeUser({ userId }: { userId: number }) {
  const user = useEffectState(
    ({ signal }) => api.getUser(userId, { signal, latency: RACY_LATENCY }),
    [userId]
  );

  return <RaceResult title="useEffectState" userId={userId} shown={user.data ?? null} />;
}

function RaceResult({ title, userId, shown }: { title: string; userId: number; shown: User | null }) {
  const mismatch = shown !== null && shown.id !== userId;

  return (
    <div className={`race-result ${mismatch ? 'mismatch' : ''}`}>
      <h3>{title}</h3>
      <p>
        selected <strong>#{userId}</strong>, showing{' '}
        <strong data-testid={`${title}-shown`}>{shown ? `#${shown.id} ${shown.name}` : '…'}</strong>
      </p>
      {mismatch ? <p className="error">Stale response won the race!</p> : null}
    </div>
  );
}

export function RaceLabDemo() {
  const [userId, setUserId] = useState(1);

  const clickRapidly = () => {
    // Fire several selections in quick succession to provoke out-of-order responses.
    userIds.forEach((id, index) => {
      setTimeout(() => setUserId(id), index * 60);
    });
  };

  return (
    <article className="demo-card wide">
      <h2>Race lab</h2>
      <p>
        Both panels request the selected user with random latency. Click quickly (or use the
        button): the naive version can end up showing a user you did not select. The{' '}
        <code>useEffectState</code> version aborts stale requests and ignores late results.
      </p>

      <div className="row">
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
        <button type="button" className="accent" onClick={clickRapidly}>
          Click rapidly
        </button>
      </div>

      <div className="race-grid">
        <NaiveUser userId={userId} />
        <SafeUser userId={userId} />
      </div>
    </article>
  );
}
