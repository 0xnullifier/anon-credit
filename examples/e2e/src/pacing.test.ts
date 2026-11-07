import { describe, expect, it } from "vitest";
import { pacingFor } from "./pacing.ts";

describe("pacing", () => {
  it("has no first-use delay and no finality wait at the latest tag", () => {
    const demo = pacingFor("latest", 30);
    expect(demo.maxFirstUseDelayEpochs).toBe(0);
    expect(demo.eligiblePollMs).toBeLessThanOrEqual(5_000);
    expect(demo.rootWait).toContain("at most one epoch (30 s)");
    expect(demo.issuanceWait).not.toContain("minutes");
  });

  it("keeps the production delay and states the finality wait at the finalized tag", () => {
    const production = pacingFor("finalized", 900);
    expect(production.maxFirstUseDelayEpochs).toBe(3);
    expect(production.issuanceWait).toContain("about 13 minutes");
    expect(production.rootWait).toContain("0 to 3 epochs");
  });
});
