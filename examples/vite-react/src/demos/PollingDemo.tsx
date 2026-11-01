import { useState } from 'react';
import { useEffectTask } from '@clagradi/effect-runtime';
import { api } from '../api';

export function PollingDemo() {
  const [paused, setPaused] = useState(false);
  const [time, setTime] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);

  useEffectTask(
    async ({ signal, commit, sleep }) => {
      if (paused) {
        return;
      }

      // A plain loop: when the run ends (pause, unmount), the pending request is
      // aborted or sleep() rejects, which exits the loop.
      for (;;) {
        const serverTime = await api.getServerTime({ signal });
        commit(() => {
          setTime(serverTime);
          setPolls((count) => count + 1);
        });
        await sleep(2000);
      }
    },
    [paused]
  );

  return (
    <article className="demo-card">
      <h2>Polling loop</h2>
      <p>
        A <code>for (;;)</code> loop with <code>sleep()</code> is safe: pausing or unmounting ends
        the run, which aborts the in-flight request and stops the loop.
      </p>

      <div className="status-line">
        <button type="button" onClick={() => setPaused((value) => !value)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <span className={`badge ${paused ? 'idle' : 'success'}`}>{paused ? 'paused' : 'polling'}</span>
      </div>

      <p>
        server time: <strong>{time ?? '…'}</strong> <span className="muted">({polls} polls)</span>
      </p>
    </article>
  );
}
