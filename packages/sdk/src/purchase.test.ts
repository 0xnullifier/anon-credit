// Purchase coordination: CreditSale.buy calldata and issuer topup polling with a fake issuer.

import { encodeHex, type TopupResponse } from "@anon-credit/protocol";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import { buyCalldata, waitForIssuance } from "./purchase.ts";

const TX = `0x${"ab".repeat(32)}`;

function topup(status: TopupResponse["status"]): TopupResponse {
  return {
    chain_id: 31_337,
    tx_hash: TX,
    log_index: 1,
    status,
    pending_reason: status === "pending" ? "awaiting_finality" : null,
    reject_reason: status === "rejected" ? "reverted" : null,
    block_number: "7",
    finalized_block: "5",
    issuance:
      status === "issued"
        ? {
            purchase_id: "0",
            payer: `0x${"11".repeat(20)}`,
            amount_wei: "100",
            block_number: "7",
            insertion_epoch: "10",
            eligible_epoch: "11",
            expiry: "35050",
            leaves: [{ leaf_index: 0, commitment: `0x${"01".repeat(32)}`, leaf: `0x${"02".repeat(32)}` }],
          }
        : null,
  };
}

describe("buyCalldata", () => {
  it("encodes buy(bytes32[]) with the commitments", () => {
    const commitments = [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`];
    const data = buyCalldata(commitments);
    const selector = encodeHex(keccak_256(new TextEncoder().encode("buy(bytes32[])")).subarray(0, 4));
    expect(data.slice(0, 10)).toBe(selector);
    // offset 0x20, length 2, then the two words.
    expect(data.slice(10)).toBe(
      `${"20".padStart(64, "0")}${"2".padStart(64, "0")}${"01".repeat(32)}${"02".repeat(32)}`,
    );
  });

  it("rejects a value that is not a canonical field element and an empty list", () => {
    expect(() => buyCalldata([`0x${"ff".repeat(32)}`])).toThrow();
    expect(() => buyCalldata([])).toThrow();
  });
});

describe("waitForIssuance", () => {
  it("polls until issued and registers again when the issuer forgot the payment", async () => {
    const answers: Response[] = [
      new Response(JSON.stringify({ code: "not_found", message: "x", retryable: false }), { status: 404 }),
      new Response(JSON.stringify(topup("pending")), { status: 202 }),
      new Response(JSON.stringify(topup("pending")), { status: 200 }),
      new Response(JSON.stringify(topup("issued")), { status: 200 }),
    ];
    const requests: string[] = [];
    const reasons: (string | null)[] = [];
    const issuance = await waitForIssuance(
      {
        issuerUrl: "https://issuer.test",
        fetch: async (input, init) => {
          requests.push(`${init?.method ?? "GET"} ${String(input)}`);
          const next = answers.shift();
          if (next === undefined) throw new Error("no more answers");
          return next;
        },
      },
      TX,
      1,
      { sleep: async () => undefined, onProgress: (item) => reasons.push(item.pending_reason) },
    );
    expect(issuance.eligible_epoch).toBe("11");
    expect(requests).toEqual([
      `GET https://issuer.test/v1/topups/${TX}/1`,
      "POST https://issuer.test/v1/topups",
      `GET https://issuer.test/v1/topups/${TX}/1`,
      `GET https://issuer.test/v1/topups/${TX}/1`,
    ]);
    expect(reasons).toEqual(["awaiting_finality", "awaiting_finality", null]);
  });

  it("fails on a rejected payment and on the timeout", async () => {
    const rejected = waitForIssuance(
      { issuerUrl: "https://issuer.test", fetch: async () => new Response(JSON.stringify(topup("rejected"))) },
      TX,
      1,
    );
    await expect(rejected).rejects.toMatchObject({ code: "invalid_response" });
    let now = 0;
    const late = waitForIssuance(
      { issuerUrl: "https://issuer.test", fetch: async () => new Response(JSON.stringify(topup("pending"))) },
      TX,
      1,
      {
        timeoutMs: 10,
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        pollMs: 5,
      },
    );
    await expect(late).rejects.toMatchObject({ code: "timeout" });
  });
});
