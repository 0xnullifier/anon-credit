import type { AcceptedRoot, IssuerRootRecord, TopupResponse } from "@anon-credit/protocol";
import { describe, expect, it } from "vitest";
import { epochOf, gatewayRootFor, postedRootFor, secondsUntilNextEpoch, topupWords } from "./inclusion.ts";

const ROOT = `0x${"11".repeat(32)}`;
const TX = `0x${"22".repeat(32)}`;

function record(epoch: string, leafCount: number, status: IssuerRootRecord["status"], tx: string | null = TX): IssuerRootRecord {
  return { epoch, leaf_count: leafCount, root: ROOT, status, tx_hash: tx, block_number: tx === null ? null : "10" };
}

describe("postedRootFor", () => {
  it("picks the oldest sent publication at or after the eligible epoch that has the leaf", () => {
    const records = [record("7", 3, "finalized"), record("8", 3, "included"), record("9", 5, "submitted"), record("10", 5, "pending", null)];
    expect(postedRootFor(records, 8n, 2)?.epoch).toBe("8");
    expect(postedRootFor(records, 8n, 4)?.epoch).toBe("9");
    expect(postedRootFor(records, 10n, 0)).toBeNull();
  });
});

describe("gatewayRootFor", () => {
  it("picks the newest accepted root at or after the eligible epoch with the leaf", () => {
    const roots: AcceptedRoot[] = [
      { source_epoch: "9", root: ROOT, leaf_count: 5 },
      { source_epoch: "8", root: ROOT, leaf_count: 3 },
      { source_epoch: "7", root: ROOT, leaf_count: 3 },
    ];
    expect(gatewayRootFor(roots, 8n, 2)?.source_epoch).toBe("9");
    expect(gatewayRootFor(roots, 8n, 4)?.source_epoch).toBe("9");
    expect(gatewayRootFor(roots, 10n, 0)).toBeNull();
  });
});

describe("topupWords", () => {
  const base: TopupResponse = {
    chain_id: 31337,
    tx_hash: TX,
    log_index: 0,
    status: "pending",
    pending_reason: "awaiting_finality",
    reject_reason: null,
    block_number: "12",
    finalized_block: "10",
    issuance: null,
  };
  it("says what the issuer waits for", () => {
    expect(topupWords(base)).toContain("block 12");
    expect(topupWords({ ...base, pending_reason: "awaiting_receipt" })).toContain("no receipt");
    expect(topupWords({ ...base, status: "rejected", pending_reason: null, reject_reason: "reverted" })).toBe("rejected: reverted");
    expect(topupWords({ ...base, status: "issued", pending_reason: null })).toBe("issued in block 12");
  });
});

describe("epoch clock", () => {
  it("computes the epoch and the seconds until the next boundary", () => {
    expect(epochOf(90_000, 30)).toBe(3n);
    expect(secondsUntilNextEpoch(90_000, 30)).toBe(30);
    expect(secondsUntilNextEpoch(95_000, 30)).toBe(25);
  });
});
