// Stable error codes for the HTTP interfaces.
// Clients must branch on the code. They must not branch on the message text.

import { z } from "zod";

export const errorCodeSchema = z.enum([
  "invalid_request",
  "unsupported_version",
  "proof_invalid",
  "root_not_accepted",
  "proof_epoch_stale",
  "session_conflict",
  "signature_invalid",
  "sequence_gap",
  "sequence_conflict",
  "response_expired",
  "insufficient_units",
  "session_expired",
  "method_not_allowed",
  "upstream_failed",
  "storage_unavailable",
  "busy",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

// All error codes, in the same order as the Rust enum.
export const ERROR_CODES: readonly ErrorCode[] = errorCodeSchema.options;

// Tell if the client can send the same request again later.
// true: a later identical request can succeed, and no units were charged.
// false: the client must change the request, make a new proof, or stop.
export function isRetryable(code: ErrorCode): boolean {
  switch (code) {
    case "upstream_failed":
    case "storage_unavailable":
    case "busy":
      return true;
    case "invalid_request":
    case "unsupported_version":
    case "proof_invalid":
    case "root_not_accepted":
    case "proof_epoch_stale":
    case "session_conflict":
    case "signature_invalid":
    case "sequence_gap":
    case "sequence_conflict":
    case "response_expired":
    case "insufficient_units":
    case "session_expired":
    case "method_not_allowed":
      return false;
  }
}

// JSON error body for all HTTP error responses. Unknown fields are rejected.
export const errorBodySchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;
