// SDK errors. Logic branches on the code, never on the message text.

import type { ErrorCode, ReceiptMetadata } from "@anon-credit/protocol";
import { z } from "zod";

export const sdkErrorCodeSchema = z.enum([
  // The configuration gave a direct transport without the explicit allowance.
  "direct_transport_refused",
  // The transport failed. The SDK never falls back to a direct fetch.
  "transport_failed",
  // The gateway or the issuer returned an error body. See GatewayError.
  "service_error",
  // A response does not match its schema or the expected values.
  "invalid_response",
  // Gateway, issuer, or pinned identities do not agree.
  "deployment_mismatch",
  // The membership proof or the public inputs do not pass the local checks.
  "proof_check_failed",
  // The batch is not known, not issued, or not open.
  "batch_not_found",
  "batch_not_issued",
  "session_not_open",
  // A signed request of this session waits for an answer. Call resume() first.
  "pending_request",
  // The gateway charged a request, and its response is no longer kept (response_expired).
  "lost_result",
  // The frozen price table has no price for the method.
  "method_not_priced",
  // The wait for an eligible root or for issuance did not end in time.
  "timeout",
  // The storage passphrase is wrong or the data is damaged.
  "storage_locked",
  // A backup string is not valid.
  "backup_invalid",
]);
export type SdkErrorCode = z.infer<typeof sdkErrorCodeSchema>;

export class SdkError extends Error {
  override readonly name: string = "SdkError";
  readonly code: SdkErrorCode;

  constructor(code: SdkErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// An error body from the gateway or the issuer. `serviceCode` is the stable protocol code.
export class ServiceError extends SdkError {
  override readonly name = "ServiceError";
  readonly serviceCode: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly receipt: ReceiptMetadata | undefined;

  constructor(serviceCode: ErrorCode, httpStatus: number, message: string, retryable: boolean, receipt?: ReceiptMetadata) {
    super("service_error", `${serviceCode} (HTTP ${httpStatus}): ${message}`);
    this.serviceCode = serviceCode;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.receipt = receipt;
  }
}

// The gateway charged a request, and the SDK could not get its response. The local session
// state is updated from the signed status call, so the next request has the next sequence.
export class LostResultError extends SdkError {
  override readonly name = "LostResultError";
  readonly receipt: ReceiptMetadata | undefined;
  readonly seq: bigint;

  constructor(seq: bigint, receipt: ReceiptMetadata | undefined) {
    super("lost_result", `the response of sequence ${seq} is lost; the gateway charged it`);
    this.seq = seq;
    this.receipt = receipt;
  }
}

// Any thrown value. A catch clause gives a value of this type.
export type Thrown = {} | null | undefined;

export function messageOf(error: Thrown): string {
  return error instanceof Error ? error.message : String(error);
}
