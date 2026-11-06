// Dashboard shell: token entry, then the dashboard.
//
// The dashboard reads the gateway admin API only (and the public demo probe, prices, and
// roots). It does not use the SDK and has no batch secrets. It never puts the admin token in
// a URL and never shows data that the gateway did not send.

import { useCallback, useState } from "react";
import { DashboardView } from "./components/DashboardView.tsx";
import { Login } from "./components/Login.tsx";
import type { Connection } from "./lib/api.ts";
import { browserFetch } from "./lib/http.ts";
import {
  DEFAULT_ADMIN_URL,
  DEFAULT_GATEWAY_URL,
  forgetToken,
  loadSettings,
  saveConnection,
  tabStorage,
} from "./lib/session-store.ts";

// A URL from the Vite environment, or the default.
function envUrl(value: string | boolean | undefined, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

const defaults = {
  adminUrl: envUrl(import.meta.env["VITE_ADMIN_URL"], DEFAULT_ADMIN_URL),
  gatewayUrl: envUrl(import.meta.env["VITE_GATEWAY_URL"], DEFAULT_GATEWAY_URL),
};

export function App() {
  const [settings, setSettings] = useState(() => loadSettings(tabStorage(), defaults));
  const [connection, setConnection] = useState<Connection | null>(() =>
    settings.token === null ? null : { adminUrl: settings.adminUrl, gatewayUrl: settings.gatewayUrl, token: settings.token },
  );

  const connect = useCallback((next: Connection): void => {
    saveConnection(tabStorage(), next);
    setConnection(next);
  }, []);

  const signOut = useCallback((): void => {
    forgetToken(tabStorage());
    setSettings(loadSettings(tabStorage(), defaults));
    setConnection(null);
  }, []);

  const keepGatewayUrl = useCallback(
    (url: string): void => {
      if (connection !== null) {
        saveConnection(tabStorage(), { ...connection, gatewayUrl: url });
      }
    },
    [connection],
  );

  if (connection === null) {
    return <Login adminUrl={settings.adminUrl} gatewayUrl={settings.gatewayUrl} onConnect={connect} />;
  }
  return <DashboardView connection={connection} fetchFn={browserFetch} onSignOut={signOut} onGatewayUrl={keepGatewayUrl} />;
}
