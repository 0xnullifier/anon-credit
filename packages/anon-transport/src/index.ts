// Anon-RPC transport for the SDK.
//
// - createAnonTransport: wrap @anon-rpc/browser-harness 0.4.0 in the same way as
//   anon-rpc-demo/src/app.js. Nox is the default worker. A Sepolia bootstrap RPC reads the
//   specifier contract. The transport waits for `worker.ready`, collects the worker logs with
//   `acceptLog`, and branches on `RpcError.code` with a switch.
// - directTransport: a plain fetch. Use it only in tests, in the local integration harness, and
//   for the explicit demo peer probe. The SDK refuses it unless the caller allows it by name.
//
// On transport failure, the transport fails the request. It never falls back to a direct fetch.
// See anon-rpc-demo/LEARNINGS.md for the measured harness behavior.

export {
  BOOTSTRAP_RPC_URLS,
  DEFAULT_WORKER,
  NOX_SPECIFIER,
  NOX_SPECIFIER_CHAIN_ID,
  WORKERS,
  workerIdSchema,
  type WorkerId,
} from "./workers.ts";
export { TransportError, explainTransportError, transportErrorCodeSchema, type TransportErrorCode } from "./errors.ts";
export {
  isolationKeySchema,
  type Transport,
  type TransportFetchOptions,
  type TransportKind,
  type TransportLogEntry,
  type TransportRequestInit,
} from "./transport.ts";
export { createAnonTransport, type AnonTransportOptions, type HarnessFactory, type HarnessWorker } from "./anon.ts";
export { makeBootstrapProvider, type BootstrapProvider } from "./bootstrap.ts";
export { directTransport, type DirectTransportOptions } from "./direct.ts";
