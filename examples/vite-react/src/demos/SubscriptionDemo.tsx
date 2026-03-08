import { useState } from "react";
import { useEffectTask } from "@clagradi/effect-runtime";

type MessageHandler = (message: string) => void;

function subscribeToRoom(roomId: string, onMessage: MessageHandler): () => void {
  const timerId = window.setInterval(() => {
    onMessage(`[${roomId}] message at ${new Date().toLocaleTimeString()}`);
  }, 1500);

  return () => {
    window.clearInterval(timerId);
  };
}

export function SubscriptionDemo() {
  const [roomId, setRoomId] = useState("alpha");
  const [messages, setMessages] = useState<string[]>([]);

  useEffectTask(({ onCleanup }) => {
    setMessages([]);

    const unsubscribe = subscribeToRoom(roomId, (message) => {
      setMessages((prev) => [message, ...prev].slice(0, 5));
    });

    onCleanup(() => unsubscribe());
  }, [roomId]);

  return (
    <article className="demo-card">
      <h2>SubscriptionDemo</h2>
      <p>Uses `onCleanup` to pair subscribe/unsubscribe on every room change.</p>

      <label>
        Room:
        <select value={roomId} onChange={(event) => setRoomId(event.target.value)}>
          <option value="alpha">alpha</option>
          <option value="beta">beta</option>
          <option value="gamma">gamma</option>
        </select>
      </label>

      <ul className="messages">
        {messages.map((message, index) => (
          <li key={`${message}-${index}`}>{message}</li>
        ))}
      </ul>
    </article>
  );
}
