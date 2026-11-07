// Error codes in plain words. The UI shows the stable code and one sentence. It never shows a
// stack trace as the only explanation.

import { ERROR_CODES, type ErrorCode } from "@anon-credit/protocol";
import { LostResultError, SdkError, ServiceError, type SdkErrorCode } from "@anon-credit/sdk";
import { TransportError } from "@anon-credit/anon-transport";
import { ProverError } from "@anon-credit/prover";

export interface Explained {
  // The stable code: a protocol code, an SDK code, a transport code, or "error".
  readonly code: string;
  // One short sentence.
  readonly text: string;
  // true if the same request can succeed later.
  readonly retryable: boolean;
}

export function explainServiceCode(code: ErrorCode): string {
  switch (code) {
    case "invalid_request":
      return "The service rejected the request format.";
    case "unsupported_version":
      return "The protocol version is not supported.";
    case "proof_invalid":
      return "The gateway verified the proof and rejected it.";
    case "root_not_accepted":
      return "The gateway does not accept this root. It is too old or not yet visible.";
    case "proof_epoch_stale":
      return "The proof is for an older epoch. A new proof is necessary.";
    case "session_conflict":
      return "This batch already has a session with another key.";
    case "signature_invalid":
      return "The session signature does not verify.";
    case "sequence_gap":
      return "The sequence number is ahead of the gateway.";
    case "sequence_conflict":
      return "This sequence number was used with a different request.";
    case "response_expired":
      return "The gateway charged the request, but the response is no longer kept.";
    case "insufficient_units":
      return "The batch has no units left for this method.";
    case "session_expired":
      return "The session is past its deadline.";
    case "method_not_allowed":
      return "The gateway does not serve this method or these parameters.";
    case "upstream_failed":
      return "The upstream RPC did not answer. Nothing was charged.";
    case "storage_unavailable":
      return "The gateway could not store the result. Nothing was charged.";
    case "busy":
      return "The gateway is busy. Try again.";
    case "not_found":
      return "The service has no record of this item.";
    case "payment_invalid":
      return "The issuer rejected the payment.";
  }
}

function explainSdkCode(code: SdkErrorCode): string {
  switch (code) {
    case "direct_transport_refused":
      return "The direct transport is not allowed here.";
    case "transport_failed":
      return "The transport could not deliver the request.";
    case "service_error":
      return "The service returned an error.";
    case "invalid_response":
      return "The response does not match the protocol schema.";
    case "deployment_mismatch":
      return "The issuer, the gateway, and the pinned values do not agree.";
    case "proof_check_failed":
      return "A local check of the path or the public inputs failed.";
    case "batch_not_found":
      return "This browser has no such batch.";
    case "batch_not_issued":
      return "The batch has no issued leaf yet.";
    case "session_not_open":
      return "The batch has no open session.";
    case "pending_request":
      return "A signed request still waits for an answer.";
    case "lost_result":
      return "The gateway charged the request, but the result is lost.";
    case "method_not_priced":
      return "The price table has no price for this method.";
    case "timeout":
      return "The wait ended before the condition was met.";
    case "storage_locked":
      return "The passphrase is wrong or the stored data is damaged.";
    case "backup_invalid":
      return "The backup string is not valid.";
  }
}

export function isServiceCode(text: string): text is ErrorCode {
  return ERROR_CODES.some((code) => code === text);
}

// Explain any thrown value.
export function explain(error: {} | null | undefined): Explained {
  switch (true) {
    case error instanceof ServiceError:
      return { code: error.serviceCode, text: `${explainServiceCode(error.serviceCode)} (HTTP ${error.httpStatus})`, retryable: error.retryable };
    case error instanceof LostResultError:
      return { code: "lost_result", text: `${explainSdkCode("lost_result")} Sequence ${error.seq}.`, retryable: false };
    case error instanceof SdkError:
      return { code: error.code, text: `${explainSdkCode(error.code)} ${error.message}`, retryable: error.code === "transport_failed" };
    case error instanceof TransportError:
      return { code: error.code, text: `Transport: ${error.message}`, retryable: false };
    case error instanceof ProverError:
      return { code: error.code, text: `Prover: ${error.message}`, retryable: false };
    case error instanceof Error:
      return { code: error.name === "Error" ? "error" : error.name, text: error.message, retryable: false };
    default:
      return { code: "error", text: String(error), retryable: false };
  }
}

// "code: text" on one line.
export function explainLine(error: {} | null | undefined): string {
  const explained = explain(error);
  return `${explained.code}: ${explained.text}`;
}
