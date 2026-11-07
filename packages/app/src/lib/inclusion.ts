// Pure selections for the inclusion tracker. The tracker polls the issuer and the gateway
// and passes the responses here.

import type { AcceptedRoot, Issuance, IssuerRootRecord, TopupResponse } from "@anon-credit/protocol";

// The eligible epoch of an issuance: the first epoch whose root can have the leaves.
export function eligibleEpochOf(issuance: Issuance): bigint {
  return BigInt(issuance.eligible_epoch);
}

// The issuer publication record that a leaf can open against: the oldest record at or after
// the eligible epoch with a sent transaction. The status tells how far it is.
export function postedRootFor(records: readonly IssuerRootRecord[], eligibleEpoch: bigint, leafIndex: number): IssuerRootRecord | null {
  const candidates = records
    .filter((record) => BigInt(record.epoch) >= eligibleEpoch && record.leaf_count > leafIndex && record.tx_hash !== null)
    .sort((a, b) => Number(BigInt(a.epoch) - BigInt(b.epoch)));
  return candidates[0] ?? null;
}

// The newest gateway root at or after the eligible epoch that has the leaf.
export function gatewayRootFor(roots: readonly AcceptedRoot[], eligibleEpoch: bigint, leafIndex: number): AcceptedRoot | null {
  const candidates = roots
    .filter((root) => BigInt(root.source_epoch) >= eligibleEpoch && root.leaf_count > leafIndex)
    .sort((a, b) => Number(BigInt(b.source_epoch) - BigInt(a.source_epoch)));
  return candidates[0] ?? null;
}

// Plain words for a topup response.
export function topupWords(topup: TopupResponse): string {
  switch (topup.status) {
    case "issued":
      return `issued in block ${topup.block_number ?? "?"}`;
    case "rejected":
      return `rejected: ${topup.reject_reason ?? "unknown"}`;
    case "pending":
      switch (topup.pending_reason) {
        case "awaiting_receipt":
          return "payment seen, no receipt yet";
        case "awaiting_finality":
          return `payment in block ${topup.block_number ?? "?"}, confirmed block ${topup.finalized_block ?? "?"}`;
        case "finality_unavailable":
          return "the issuer RPC gives no confirmed block";
        case "chain_unavailable":
          return "the issuer RPC did not answer; the issuer tries again";
        case null:
          return "pending";
      }
  }
}

// Epoch arithmetic with wall-clock time.
export function epochOf(nowMs: number, epochSeconds: number): bigint {
  return BigInt(Math.floor(nowMs / 1000 / epochSeconds));
}

export function secondsUntilNextEpoch(nowMs: number, epochSeconds: number): number {
  const seconds = Math.floor(nowMs / 1000);
  return epochSeconds - (seconds % epochSeconds);
}
