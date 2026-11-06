// Token entry. The token is kept in the session storage of this tab only, and the dashboard
// sends it only in the Authorization header of admin requests.

import { useState, type FormEvent } from "react";
import type { Connection } from "../lib/api.ts";

export interface LoginProps {
  readonly adminUrl: string;
  readonly gatewayUrl: string;
  readonly onConnect: (connection: Connection) => void;
}

export function Login(props: LoginProps) {
  const [adminUrl, setAdminUrl] = useState(props.adminUrl);
  const [gatewayUrl, setGatewayUrl] = useState(props.gatewayUrl);
  const [token, setToken] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = token.trim();
    if (trimmed !== "") {
      props.onConnect({ adminUrl: adminUrl.trim(), gatewayUrl: gatewayUrl.trim(), token: trimmed });
    }
  };
  return (
    <main className="login">
      <form className="panel login-form" onSubmit={submit}>
        <h1>Gateway dashboard</h1>
        <label>
          <span>Admin API URL</span>
          <input type="url" required value={adminUrl} onChange={(e) => setAdminUrl(e.target.value)} spellCheck={false} />
        </label>
        <label>
          <span>Public gateway URL (direct probe, prices, roots)</span>
          <input type="url" required value={gatewayUrl} onChange={(e) => setGatewayUrl(e.target.value)} spellCheck={false} />
        </label>
        <label>
          <span>
            Admin token (<code>GATEWAY_ADMIN_TOKEN</code>)
          </span>
          <input
            type="password"
            required
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            spellCheck={false}
          />
        </label>
        <button type="submit" className="primary">
          Connect
        </button>
        <p className="note">
          The token stays in the session storage of this tab. It goes only in the Authorization header, never in a URL.
          Keep the admin listener private.
        </p>
      </form>
    </main>
  );
}
