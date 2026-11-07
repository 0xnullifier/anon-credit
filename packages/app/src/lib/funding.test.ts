import { describe, expect, it } from "vitest";
import { purchaseCost, shortfallWei } from "./funding.ts";

const PRICE = 100_000_000_000_000n; // 0.0001 ETH
const GAS_PRICE = 1_000_000_000n; // 1 gwei

describe("purchaseCost", () => {
  it("adds the payment and a doubled gas estimate", () => {
    const cost = purchaseCost(PRICE, 2, GAS_PRICE);
    expect(cost.paymentWei).toBe(2n * PRICE);
    expect(cost.gasWei).toBe((80_000n + 60_000n) * GAS_PRICE * 2n);
    expect(cost.totalWei).toBe(cost.paymentWei + cost.gasWei);
  });

  it("treats a count below one as zero batches", () => {
    expect(purchaseCost(PRICE, 0, GAS_PRICE).paymentWei).toBe(0n);
    expect(purchaseCost(PRICE, -3, GAS_PRICE).paymentWei).toBe(0n);
  });
});

describe("shortfallWei", () => {
  it("is zero when the balance covers the cost, else the exact difference", () => {
    const cost = purchaseCost(PRICE, 1, GAS_PRICE);
    expect(shortfallWei(cost.totalWei, cost)).toBe(0n);
    expect(shortfallWei(cost.totalWei + 1n, cost)).toBe(0n);
    expect(shortfallWei(cost.totalWei - 7n, cost)).toBe(7n);
    expect(shortfallWei(0n, cost)).toBe(cost.totalWei);
  });
});

describe("eth format", () => {
  it("shows small values in gwei and larger values in ETH", async () => {
    const { eth } = await import("./format.ts");
    expect(eth(0n)).toBe("0 ETH");
    expect(eth(123_456_789n)).toBe("0.123 gwei");
    expect(eth(100_000_000_000_000n)).toBe("0.0001 ETH");
    expect(eth(10n ** 18n)).toBe("1 ETH");
  });
});
