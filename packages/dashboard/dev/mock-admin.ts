// Run the mock gateway admin API, and with --vite also the dashboard dev server.
//
// Usage (from packages/dashboard):
//   node dev/mock-admin.ts           mock only (admin 127.0.0.1:8082, public 127.0.0.1:8081)
//   node dev/mock-admin.ts --vite    mock and the dashboard on http://localhost:5174
//
// Environment:
//   MOCK_ADMIN_TOKEN   admin token (default: mock-admin-token-0123456789). Not a secret.
//   MOCK_IP_LOGGING    "true" (default) or "false": the normal profile, observed IP unavailable.
//   MOCK_ADMIN_PORT, MOCK_PUBLIC_PORT   listener ports (default 8082 and 8081).
//   MOCK_SPEED         multiplier of the script delays (default 1).

import { MOCK_TOKEN, startMock } from "./mock-server.ts";

function envNumber(name: string, fallback: number): number {
  const text = process.env[name];
  const value = text === undefined || text === "" ? fallback : Number(text);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a number that is not negative`);
  }
  return value;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const text = process.env[name];
  switch (text) {
    case undefined:
    case "":
      return fallback;
    case "true":
      return true;
    case "false":
      return false;
    default:
      throw new Error(`${name} must be "true" or "false"`);
  }
}

const mock = await startMock({
  adminPort: envNumber("MOCK_ADMIN_PORT", 8082),
  publicPort: envNumber("MOCK_PUBLIC_PORT", 8081),
  token: process.env["MOCK_ADMIN_TOKEN"] || MOCK_TOKEN,
  ipLogging: envBoolean("MOCK_IP_LOGGING", true),
  speed: envNumber("MOCK_SPEED", 1),
  prefill: 8,
});

console.log(`mock admin API   ${mock.adminUrl}   (token: ${mock.token})`);
console.log(`mock public API  ${mock.publicUrl}   (demo peer ${mock.gateway.ipLogging ? "on" : "off"})`);
console.log("This is a mock. It replays dev/fixtures/mock-admin.json; it is not a gateway.");

const closers: (() => Promise<void>)[] = [() => mock.close()];

if (process.argv.includes("--vite")) {
  // Vite gives VITE_* variables of the process to the page: the default URLs of the login form.
  process.env["VITE_ADMIN_URL"] = mock.adminUrl;
  process.env["VITE_GATEWAY_URL"] = mock.publicUrl;
  const { createServer } = await import("vite");
  const server = await createServer({
    root: new URL("..", import.meta.url).pathname,
    configFile: new URL("../vite.config.ts", import.meta.url).pathname,
  });
  await server.listen();
  server.printUrls();
  closers.push(() => server.close());
}

const stop = (): void => {
  Promise.all(closers.map((close) => close())).finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
