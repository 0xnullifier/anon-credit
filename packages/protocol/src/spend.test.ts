// Check the TypeScript spend encoder against the shared vectors.
// The Rust crate runs the same vectors in crates/protocol/tests/fixtures.rs.

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import fixture from "../../../fixtures/protocol/spend-message.json" with { type: "json" };
import { bytes32Schema, encodeHex, EncodingError, hexBytesSchema, u64DecimalSchema } from "./bytes.ts";
import { SPEND_DOMAIN } from "./domain.ts";
import { encodeSpendMessage, SPEND_MESSAGE_HEADER_LENGTH, spendMessageDigest } from "./spend.ts";
import { PROTOCOL_VERSION } from "./version.ts";

const fixtureSchema = z.object({
  protocol_version: z.number(),
  operation_domain: z.string(),
  test_signing_key: z.object({ public_key: bytes32Schema }),
  cases: z
    .array(
      z.object({
        name: z.string(),
        input: z.strictObject({
          deployment_id: bytes32Schema,
          gateway_id: bytes32Schema,
          batch_id: bytes32Schema,
          price_table_hash: bytes32Schema,
          seq: u64DecimalSchema,
          units_total: u64DecimalSchema,
          rpc_bytes: hexBytesSchema,
        }),
        expected: z.strictObject({
          message: z.string(),
          digest: z.string(),
          signature: hexBytesSchema,
        }),
      }),
    )
    .min(1),
});

const vectors = fixtureSchema.parse(fixture);

describe("spend message shared vectors", () => {
  it("uses the same version and domain", () => {
    expect(vectors.protocol_version).toBe(PROTOCOL_VERSION);
    expect(vectors.operation_domain).toBe(encodeHex(SPEND_DOMAIN));
  });

  for (const vector of vectors.cases) {
    it(`matches case ${vector.name}`, () => {
      const message = {
        deploymentId: vector.input.deployment_id,
        gatewayId: vector.input.gateway_id,
        batchId: vector.input.batch_id,
        priceTableHash: vector.input.price_table_hash,
        seq: vector.input.seq,
        unitsTotal: vector.input.units_total,
        rpcBytes: vector.input.rpc_bytes,
      };
      expect(encodeHex(encodeSpendMessage(message))).toBe(vector.expected.message);
      const digest = spendMessageDigest(message);
      expect(encodeHex(digest)).toBe(vector.expected.digest);
      expect(ed25519.verify(vector.expected.signature, digest, vectors.test_signing_key.public_key)).toBe(true);
    });
  }
});

describe("spend message checks", () => {
  const base = {
    deploymentId: new Uint8Array(32),
    gatewayId: new Uint8Array(32),
    batchId: new Uint8Array(32),
    priceTableHash: new Uint8Array(32),
    seq: 0n,
    unitsTotal: 1n,
    rpcBytes: new Uint8Array(0),
  };

  it("has the fixed header length", () => {
    expect(encodeSpendMessage(base).length).toBe(SPEND_MESSAGE_HEADER_LENGTH);
  });

  it("rejects a short ID", () => {
    expect(() => encodeSpendMessage({ ...base, batchId: new Uint8Array(31) })).toThrow(EncodingError);
  });

  it("rejects integers outside u64", () => {
    expect(() => encodeSpendMessage({ ...base, seq: -1n })).toThrow(EncodingError);
    expect(() => encodeSpendMessage({ ...base, unitsTotal: 1n << 64n })).toThrow(EncodingError);
  });
});
