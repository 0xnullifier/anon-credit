// Can the signer pay for n batches? The same estimate as checkFunding in
// packages/sdk/src/purchase.ts: gas limit 80,000 + 30,000 per batch, times the gas price, with
// a 2x margin.

export interface PurchaseCost {
  readonly paymentWei: bigint;
  readonly gasWei: bigint;
  readonly totalWei: bigint;
}

export function purchaseCost(priceWei: bigint, count: number, gasPriceWei: bigint): PurchaseCost {
  const n = BigInt(Math.max(0, Math.trunc(count)));
  const paymentWei = priceWei * n;
  const gasWei = (80_000n + 30_000n * n) * gasPriceWei * 2n;
  return { paymentWei, gasWei, totalWei: paymentWei + gasWei };
}

// Wei that are missing for the purchase: 0n if the balance covers it.
export function shortfallWei(balanceWei: bigint, cost: PurchaseCost): bigint {
  const missing = cost.totalWei - balanceWei;
  return missing > 0n ? missing : 0n;
}
