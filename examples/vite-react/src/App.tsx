import { NetworkLog } from './components/NetworkLog';
import { IntervalDemo } from './demos/IntervalDemo';
import { PollingDemo } from './demos/PollingDemo';
import { RaceLabDemo } from './demos/RaceLabDemo';
import { SearchDemo } from './demos/SearchDemo';
import { SubscriptionDemo } from './demos/SubscriptionDemo';
import { UserProfileDemo } from './demos/UserProfileDemo';

export default function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>
          <code>@clagradi/effect-runtime</code> playground
        </h1>
        <p>
          Async effects that cancel, clean up and race correctly. Every request below goes to a
          simulated API with random latency; watch the network log to see what gets aborted.
          The app runs in <code>StrictMode</code>.
        </p>
      </header>

      <div className="layout">
        <main className="demo-grid">
          <RaceLabDemo />
          <UserProfileDemo />
          <SearchDemo />
          <PollingDemo />
          <IntervalDemo />
          <SubscriptionDemo />
        </main>
        <NetworkLog />
      </div>
    </div>
  );
}
