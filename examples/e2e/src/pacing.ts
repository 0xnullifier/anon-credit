// The waits of one end-to-end run. They follow the block tag that the services report in
// GET /v1/config (BLOCK_TAG).
//
// - latest (testnet demo): no first-use delay and short polls. The epoch cadence is the only
//   pacing: a purchase opens after the current epoch closes plus chain latency. latest trades
//   reorg safety for speed: testnet only.
// - safe and finalized: the production first-use delay (0 to 3 epochs) and the chain waits.

import type { BlockTag } from "@anon-credit/protocol";

// Sepolia block time in seconds.
const BLOCK_SECONDS = 12;

export interface Pacing {
  readonly blockTag: BlockTag;
  // Largest first-use delay in epochs (ClientConfig.maxFirstUseDelayEpochs).
  readonly maxFirstUseDelayEpochs: number;
  // Time between eligibility checks in the page.
  readonly eligiblePollMs: number;
  // Time between issuance status reads.
  readonly issuancePollMs: number;
  // Progress lines that state the expected waits.
  readonly issuanceWait: string;
  readonly rootWait: string;
}

// The pacing for `blockTag` with an epoch of `epochSeconds`.
export function pacingFor(blockTag: BlockTag, epochSeconds: number): Pacing {
  switch (blockTag) {
    case "latest":
      return {
        blockTag,
        maxFirstUseDelayEpochs: 0,
        eligiblePollMs: 5_000,
        issuancePollMs: 3_000,
        issuanceWait: `issuance: expected at once after the purchase is mined (block tag latest; about ${BLOCK_SECONDS} s)`,
        rootWait:
          `eligible root: expected in at most one epoch (${epochSeconds} s) for the epoch to close, ` +
          `plus about ${2 * BLOCK_SECONDS} s for postRoot to be mined and read (block tag latest); first-use delay 0 epochs`,
      };
    case "safe":
      return {
        blockTag,
        maxFirstUseDelayEpochs: 3,
        eligiblePollMs: 15_000,
        issuancePollMs: 15_000,
        issuanceWait: "issuance: expected after the purchase block is safe (block tag safe; about 7 minutes)",
        rootWait:
          `eligible root: expected after the epoch closes (${epochSeconds} s) and postRoot is safe (about 7 minutes), ` +
          `plus a random first-use delay of 0 to 3 epochs (up to ${3 * epochSeconds} s)`,
      };
    case "finalized":
      return {
        blockTag,
        maxFirstUseDelayEpochs: 3,
        eligiblePollMs: 15_000,
        issuancePollMs: 15_000,
        issuanceWait: "issuance: expected after Sepolia finality of the purchase (block tag finalized; about 13 minutes)",
        rootWait:
          `eligible root: expected after the epoch closes (${epochSeconds} s) and postRoot is finalized (about 13 minutes), ` +
          `plus a random first-use delay of 0 to 3 epochs (up to ${3 * epochSeconds} s)`,
      };
  }
}
