// Anon-RPC transport for the SDK.
//
// Phase 4 adds these parts here, with @anon-rpc/browser-harness:
// - Worker lifecycle: create, await `ready`, and close.
// - Nox configuration and the Sepolia bootstrap RPC for the specifier.
// - One isolation key per batch, and a separate isolation key for registry paths.
//
// On transport failure, fail the request. Never fall back to a direct fetch.
// See anon-rpc-demo/LEARNINGS.md for the measured harness behavior.

// Default Anon-RPC worker.
export const DEFAULT_WORKER = "nox";

// Nox specifier contract and its chain (Sepolia).
export const NOX_SPECIFIER = "0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A";
export const NOX_SPECIFIER_CHAIN_ID = 11_155_111;

// A fetch that sends each request through Anon-RPC under an isolation key.
export interface AnonTransport {
  readonly fetch: (isolationKey: string, request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}
