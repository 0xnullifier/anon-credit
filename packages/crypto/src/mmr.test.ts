// Check the TypeScript MMR verifier against the Rust registry vectors.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import fixtureJson from "../../../fixtures/protocol/mmr.json" with { type: "json" };
import { fieldHexSchema, fieldToHex } from "./field.ts";
import { checkMembershipProof, membershipProofSchema, peakHeights, rootFromPeaks, verifyMembershipProof } from "./mmr.ts";

const fixtureSchema = z.strictObject({
  description: z.string(),
  leaves: z.array(fieldHexSchema).min(1),
  snapshots: z
    .array(
      z.strictObject({
        leaf_count: z.number().int().nonnegative(),
        peak_heights: z.array(z.number().int().nonnegative()),
        peaks: z.array(fieldHexSchema),
        root: fieldHexSchema,
      }),
    )
    .min(1),
  proofs: z.array(z.strictObject({ root: fieldHexSchema, leaf: fieldHexSchema, proof: membershipProofSchema })).min(1),
  invalid_proofs: z
    .array(
      z.strictObject({
        name: z.string(),
        reason: z.enum([
          "index_out_of_range",
          "wrong_sibling_count",
          "wrong_peak_count",
          "wrong_peak_position",
          "peak_mismatch",
          "root_mismatch",
        ]),
        root: fieldHexSchema,
        leaf: fieldHexSchema,
        proof: membershipProofSchema,
      }),
    )
    .min(1),
});

const fixture = fixtureSchema.parse(fixtureJson);

describe("mmr snapshots", () => {
  for (const snapshot of fixture.snapshots) {
    it(`root of ${snapshot.leaf_count} leaves`, () => {
      expect(peakHeights(snapshot.leaf_count)).toEqual(snapshot.peak_heights);
      expect(fieldToHex(rootFromPeaks(snapshot.leaf_count, snapshot.peaks))).toBe(fieldToHex(snapshot.root));
    });
  }
});

describe("mmr membership proofs", () => {
  for (const entry of fixture.proofs) {
    it(`accepts leaf ${entry.proof.leafIndex} of ${entry.proof.leafCount}`, () => {
      expect(checkMembershipProof(entry.root, entry.proof, entry.leaf)).toEqual({ ok: true });
    });
  }
  for (const entry of fixture.invalid_proofs) {
    it(`rejects ${entry.name}`, () => {
      expect(checkMembershipProof(entry.root, entry.proof, entry.leaf)).toEqual({ ok: false, reason: entry.reason });
      expect(verifyMembershipProof(entry.root, entry.proof, entry.leaf)).toBe(false);
    });
  }
  it("rejects a proof with unknown fields", () => {
    const first = fixtureJson.proofs[0]?.proof;
    expect(membershipProofSchema.safeParse({ ...first, extra: 1 }).success).toBe(false);
  });
  it("rejects a leaf count above 2^32 - 1", () => {
    const first = fixtureJson.proofs[0]?.proof;
    expect(membershipProofSchema.safeParse({ ...first, leaf_count: 2 ** 32 }).success).toBe(false);
  });
});
