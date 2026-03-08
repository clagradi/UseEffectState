import { useState } from "react";
import { useEffectTask, useEvent } from "@clagradi/effect-runtime";

export function IntervalDemo() {
  const [count, setCount] = useState(0);
  const [label, setLabel] = useState("latest value");
  const [lastLog, setLastLog] = useState("No ticks yet");

  const onTick = useEvent(() => {
    const next = count + 1;
    const log = `tick=${next}, label="${label}"`;

    setCount(next);
    setLastLog(log);
    console.log(log);
  });

  useEffectTask(({ onCleanup }) => {
    const intervalId = window.setInterval(() => onTick(), 1000);
    onCleanup(() => window.clearInterval(intervalId));
  }, []);

  return (
    <article className="demo-card">
      <h2>IntervalDemo</h2>
      <p>Uses `useEvent` so the interval callback sees latest state without deps noise.</p>

      <label>
        Label:
        <input value={label} onChange={(event) => setLabel(event.target.value)} />
      </label>

      <div>count: {count}</div>
      <div className="status">last log: {lastLog}</div>
    </article>
  );
}
