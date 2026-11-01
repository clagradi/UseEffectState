import { useState } from 'react';
import { useEffectTask, useEvent } from '@clagradi/effect-runtime';

export function IntervalDemo() {
  const [count, setCount] = useState(0);
  const [label, setLabel] = useState('latest value');
  const [lastLog, setLastLog] = useState('No ticks yet');

  // Stable identity, always sees the latest `count` and `label`.
  const onTick = useEvent(() => {
    const next = count + 1;
    setCount(next);
    setLastLog(`tick=${next}, label="${label}"`);
  });

  useEffectTask(({ onCleanup }) => {
    const intervalId = window.setInterval(() => onTick(), 1000);
    onCleanup(() => window.clearInterval(intervalId));
  }, [onTick]);

  return (
    <article className="demo-card">
      <h2>useEvent</h2>
      <p>
        The interval is created once, yet every tick sees the latest state because it calls a{' '}
        <code>useEvent</code> callback (the userland twin of React&apos;s{' '}
        <code>useEffectEvent</code>).
      </p>

      <label>
        Label
        <input value={label} onChange={(event) => setLabel(event.target.value)} />
      </label>

      <p>count: {count}</p>
      <p className="muted">last tick: {lastLog}</p>
    </article>
  );
}
