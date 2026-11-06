// Transport errors. Logic branches on the code, never on the message text (Anon-RPC SPEC 12).

import { RpcError } from "@anon-rpc/browser-harness";
import { z } from "zod";

export const transportErrorCodeSchema = z.enum([
  // The worker did not answer in time. Mixnets can need more time to start.
  "timeout",
  // The worker could not reach its network or the destination.
  "network_error",
  // The worker refused its configuration.
  "bad_config",
  // The browser does not supply a capability that the worker needs.
  "unsupported_platform",
  // The worker refused the request.
  "permission_denied",
  // The worker was closed or the call was stopped.
  "closed",
  // The specifier read, the bundle check, or the bundle load failed (a plain Error).
  "boot_failed",
  // The bootstrap RPC is on a different chain than the specifier.
  "wrong_bootstrap_chain",
  // The request options are not valid, for example an empty isolation key.
  "invalid_request",
  // A worker code that this package does not know.
  "worker_error",
]);
export type TransportErrorCode = z.infer<typeof transportErrorCodeSchema>;

// Error of the anonymous transport.
export class TransportError extends Error {
  override readonly name = "TransportError";
  readonly code: TransportErrorCode;
  // The original RpcError code, if the error came from the worker.
  readonly workerCode: string | undefined;

  constructor(code: TransportErrorCode, message: string, workerCode?: string) {
    super(message);
    this.code = code;
    this.workerCode = workerCode;
  }
}

// Any thrown value. A catch clause gives a value of this type.
export type Thrown = {} | null | undefined;

function errorText(error: Thrown): string {
  switch (true) {
    case error instanceof Error:
      return `${error.name}: ${error.message}`;
    default:
      return String(error);
  }
}

// Convert any thrown value to a TransportError. Branch on RpcError.code with a switch.
// Some boot errors are a plain Error without a code (LEARNINGS.md entry 4).
export function explainTransportError(error: Thrown): TransportError {
  if (error instanceof TransportError) return error;
  if (!(error instanceof RpcError)) {
    return new TransportError("boot_failed", errorText(error));
  }
  const code = error.code;
  switch (code) {
    case "timeout":
      return new TransportError("timeout", `the worker did not answer in time: ${error.message}`, code);
    case "network-error":
      return new TransportError("network_error", `the worker could not reach its network or the destination: ${error.message}`, code);
    case "bad-config":
      return new TransportError("bad_config", `the worker refused its config: ${error.message}`, code);
    case "unsupported":
    case "unsupported-platform":
      return new TransportError("unsupported_platform", `the browser does not supply a capability that the worker needs: ${error.message}`, code);
    case "permission-denied":
      return new TransportError("permission_denied", error.message, code);
    case "cancelled":
    case "closed":
      return new TransportError("closed", `the worker was closed or the call was stopped: ${error.message}`, code);
    case undefined:
      return new TransportError("worker_error", `${error.name} (no code): ${error.message}`);
    default:
      return new TransportError("worker_error", `${code}: ${error.message}`, code);
  }
}
