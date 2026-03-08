import { useState } from "react";
import { useEffectTask } from "@clagradi/effect-runtime";

type TodoResponse = {
  id: number;
  title: string;
  completed: boolean;
};

export function FetchDemo() {
  const [todoId, setTodoId] = useState("1");
  const [status, setStatus] = useState("idle");
  const [todo, setTodo] = useState<TodoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffectTask(
    async ({ signal, commit }) => {
      commit(() => {
        setStatus("loading");
        setError(null);
      });

      try {
        const response = await fetch(
          `https://jsonplaceholder.typicode.com/todos/${todoId}`,
          { signal }
        );
        const nextTodo = (await response.json()) as TodoResponse;

        commit(() => {
          setTodo(nextTodo);
          setStatus("ready");
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }

        commit(() => {
          setStatus("error");
          setError(err instanceof Error ? err.message : "Unknown error");
        });
      }
    },
    [todoId]
  );

  return (
    <article className="demo-card">
      <h2>FetchDemo</h2>
      <p>Uses `signal` + `commit` to avoid stale writes when requests overlap.</p>

      <label>
        Todo ID:
        <select value={todoId} onChange={(event) => setTodoId(event.target.value)}>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="4">4</option>
        </select>
      </label>

      <div className="status">status: {status}</div>
      {error ? <div className="error">error: {error}</div> : null}
      {todo ? (
        <pre>{JSON.stringify({ id: todo.id, title: todo.title, completed: todo.completed }, null, 2)}</pre>
      ) : null}
    </article>
  );
}
