// Check the TypeScript open and status encoders against the shared vectors.
// The Rust crate runs the same vectors in crates/protocol/tests/gateway_fixtures.rs.

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import openFixture from "../../../fixtures/protocol/open-message.json" with { type: "json" };
import statusFixture from "../../../fixtures/protocol/status-message.json" with { type: "json" };
import { bytes32Schema, encodeHex, EncodingError, hexBytesSchema, u64DecimalSchema } from "./bytes.ts";
import { OPEN_DOMAIN, STATUS_DOMAIN } from "./domain.ts";
import { encodeOpenMessage, OPEN_MESSAGE_LENGTH, openMessageDigest } from "./open.ts";
import { encodeStatusMessage, STATUS_MESSAGE_LENGTH, statusMessageDigest } from "./status.ts";
import { PROTOCOL_VERSION } from "./version.ts";

const expectedSchema = z.strictObject({
  message: z.string(),
  digest: z.string(),
  signature: hexBytesSchema,
});

function fileSchema<T extends z.ZodType>(input: T) {
  return z.object({
    protocol_version: z.number(),
    operation_domain: z.string(),
    message_length: z.number(),
    test_signing_key: z.object({ public_key: bytes32Schema }),
    cases: z.array(z.object({ name: z.string(), input, expected: expectedSchema })).min(1),
  });
}

const openVectors = fileSchema(
  z.strictObject({
    deployment_id: bytes32Schema,
    gateway_id: bytes32Schema,
    batch_id: bytes32Schema,
    root: bytes32Schema,
    leaf_count: z.number().int(),
    proof_epoch: u64DecimalSchema,
    session_pub: bytes32Schema,
    price_table_hash: bytes32Schema,
  }),
).parse(openFixture);

const statusVectors = fileSchema(
  z.strictObject({
    deployment_id: bytes32Schema,
    gateway_id: bytes32Schema,
    batch_id: bytes32Schema,
    nonce: bytes32Schema,
  }),
).parse(statusFixture);

describe("open message shared vectors", () => {
  it("uses the same version, domain, and length", () => {
    expect(openVectors.protocol_version).toBe(PROTOCOL_VERSION);
    expect(openVectors.operation_domain).toBe(encodeHex(OPEN_DOMAIN));
    expect(openVectors.message_length).toBe(OPEN_MESSAGE_LENGTH);
  });

  for (const vector of openVectors.cases) {
    it(`matches case ${vector.name}`, () => {
      const message = {
        deploymentId: vector.input.deployment_id,
        gatewayId: vector.input.gateway_id,
        batchId: vector.input.batch_id,
        root: vector.input.root,
        leafCount: vector.input.leaf_count,
        proofEpoch: vector.input.proof_epoch,
        sessionPub: vector.input.session_pub,
        priceTableHash: vector.input.price_table_hash,
      };
      expect(encodeHex(encodeOpenMessage(message))).toBe(vector.expected.message);
      const digest = openMessageDigest(message);
      expect(encodeHex(digest)).toBe(vector.expected.digest);
      expect(ed25519.verify(vector.expected.signature, digest, openVectors.test_signing_key.public_key)).toBe(true);
    });
  }

  it("rejects a leaf count outside u32", () => {
    const first = openVectors.cases[0];
    expect(first).toBeDefined();
    const base = {
      deploymentId: new Uint8Array(32),
      gatewayId: new Uint8Array(32),
      batchId: new Uint8Array(32),
      root: new Uint8Array(32),
      leafCount: 2 ** 32,
      proofEpoch: 0n,
      sessionPub: new Uint8Array(32),
      priceTableHash: new Uint8Array(32),
    };
    expect(() => encodeOpenMessage(base)).toThrow(EncodingError);
    expect(() => encodeOpenMessage({ ...base, leafCount: 1, root: new Uint8Array(31) })).toThrow(EncodingError);
  });
});

describe("status message shared vectors", () => {
  it("uses the same version, domain, and length", () => {
    expect(statusVectors.protocol_version).toBe(PROTOCOL_VERSION);
    expect(statusVectors.operation_domain).toBe(encodeHex(STATUS_DOMAIN));
    expect(statusVectors.message_length).toBe(STATUS_MESSAGE_LENGTH);
  });

  for (const vector of statusVectors.cases) {
    it(`matches case ${vector.name}`, () => {
      const message = {
        deploymentId: vector.input.deployment_id,
        gatewayId: vector.input.gateway_id,
        batchId: vector.input.batch_id,
        nonce: vector.input.nonce,
      };
      expect(encodeHex(encodeStatusMessage(message))).toBe(vector.expected.message);
      const digest = statusMessageDigest(message);
      expect(encodeHex(digest)).toBe(vector.expected.digest);
      expect(ed25519.verify(vector.expected.signature, digest, statusVectors.test_signing_key.public_key)).toBe(true);
    });
  }
});
