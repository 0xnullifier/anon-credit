// Dashboard shell.
//
// Phase 5 adds these views, from the gateway admin API only:
// 1. Health and counters.
// 2. Live event list (Server-Sent Events over an authenticated fetch).
// 3. Session details.
// 4. Connection diagnostics. Label: "Observed source IP".
//
// Never put the admin token in a URL. Never show data that the gateway did not emit.

import { PROTOCOL_VERSION } from "@anon-credit/protocol";

export function App() {
  return (
    <main>
      <h1>Gateway dashboard</h1>
      <p>Protocol version {PROTOCOL_VERSION}. Phase 0 skeleton: no admin API connection yet.</p>
    </main>
  );
}
