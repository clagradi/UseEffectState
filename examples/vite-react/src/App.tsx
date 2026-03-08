import { FetchDemo } from "./demos/FetchDemo";
import { IntervalDemo } from "./demos/IntervalDemo";
import { SubscriptionDemo } from "./demos/SubscriptionDemo";

export default function App() {
  return (
    <main className="app-shell">
      <header>
        <h1>@clagradi/effect-runtime playground</h1>
        <p>Practical demos for fetch, interval and subscription cleanup patterns.</p>
      </header>

      <section className="demo-grid">
        <FetchDemo />
        <IntervalDemo />
        <SubscriptionDemo />
      </section>
    </main>
  );
}
