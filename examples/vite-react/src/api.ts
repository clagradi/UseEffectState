// A tiny simulated backend so every demo works offline and deterministically
// enough to show races: random latency, AbortSignal support, optional failures,
// and a live request log that makes cancellations visible.

export interface User {
  id: number;
  name: string;
  email: string;
  company: string;
}

const USERS: User[] = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Engines' },
  { id: 2, name: 'Alan Turing', email: 'alan@example.com', company: 'Bletchley Park' },
  { id: 3, name: 'Grace Hopper', email: 'grace@example.com', company: 'US Navy' },
  { id: 4, name: 'Edsger Dijkstra', email: 'edsger@example.com', company: 'Eindhoven University' },
  { id: 5, name: 'Barbara Liskov', email: 'barbara@example.com', company: 'MIT' },
  { id: 6, name: 'Margaret Hamilton', email: 'margaret@example.com', company: 'NASA' }
];

export type RequestStatus = 'pending' | 'done' | 'aborted' | 'failed';

export interface RequestLogEntry {
  id: number;
  label: string;
  status: RequestStatus;
  startedAt: number;
  durationMs?: number;
}

let entries: RequestLogEntry[] = [];
let nextRequestId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function updateEntry(id: number, patch: Partial<RequestLogEntry>): void {
  entries = entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  emit();
}

export const requestLog = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): RequestLogEntry[] {
    return entries;
  },
  clear(): void {
    entries = [];
    emit();
  }
};

interface RequestOptions {
  signal?: AbortSignal;
  /** [min, max] latency in milliseconds. */
  latency?: [number, number];
  /** Probability (0..1) that the request fails. */
  failRate?: number;
}

function createAbortError(): Error {
  return new DOMException('The request was aborted.', 'AbortError');
}

/** Simulates a network request that honours `signal` like `fetch` does. */
function simulateRequest<T>(label: string, produce: () => T, options: RequestOptions = {}): Promise<T> {
  const { signal, latency = [250, 900], failRate = 0 } = options;
  const id = nextRequestId++;
  const startedAt = performance.now();

  entries = [{ id, label, status: 'pending' as const, startedAt }, ...entries].slice(0, 25);
  emit();

  return new Promise<T>((resolve, reject) => {
    const finish = (status: RequestStatus): void => {
      updateEntry(id, { status, durationMs: Math.round(performance.now() - startedAt) });
    };

    if (signal?.aborted) {
      finish('aborted');
      reject(signal.reason ?? createAbortError());
      return;
    }

    const [min, max] = latency;
    const delay = Math.round(min + Math.random() * (max - min));

    const onAbort = (): void => {
      clearTimeout(timer);
      finish('aborted');
      reject(signal?.reason ?? createAbortError());
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);

      if (Math.random() < failRate) {
        finish('failed');
        reject(new Error(`${label} failed (simulated network error)`));
        return;
      }

      finish('done');
      resolve(produce());
    }, delay);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const api = {
  getUser(id: number, options?: RequestOptions): Promise<User> {
    return simulateRequest(
      `GET /users/${id}`,
      () => {
        const user = USERS.find((candidate) => candidate.id === id);
        if (!user) {
          throw new Error(`User ${id} not found`);
        }
        return user;
      },
      options
    );
  },

  searchUsers(query: string, options?: RequestOptions): Promise<User[]> {
    const needle = query.trim().toLowerCase();
    return simulateRequest(
      `GET /users?q=${encodeURIComponent(query)}`,
      () =>
        USERS.filter(
          (user) =>
            user.name.toLowerCase().includes(needle) || user.company.toLowerCase().includes(needle)
        ),
      { latency: [200, 600], ...options }
    );
  },

  getServerTime(options?: RequestOptions): Promise<string> {
    return simulateRequest('GET /time', () => new Date().toLocaleTimeString(), {
      latency: [100, 300],
      ...options
    });
  }
};

export const userIds = USERS.map((user) => user.id);
