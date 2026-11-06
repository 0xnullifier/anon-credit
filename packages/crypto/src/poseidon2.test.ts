// Check the TypeScript circuit hash against the Noir reference vectors.

import { describe, expect, it } from "vitest";
import { decodeFixedHex } from "@anon-credit/protocol";
import fixtureJson from "../../../fixtures/protocol/poseidon2.json" with { type: "json" };
import { poseidon2FixtureSchema } from "../scripts/noir-vectors.ts";
import { batchId, batchLeaf, commitment, sessionBinding } from "./batch.ts";
import { FieldError, bytes32ToLimbs, fieldFromBytes, fieldFromHex, fieldToHex } from "./field.ts";
import { internalNode, leafNode, rootFromSlots } from "./mmr.ts";
import { hash, permutation } from "./poseidon2.ts";

const fixture = poseidon2FixtureSchema.parse(fixtureJson);

function fields(values: readonly string[]): bigint[] {
  return values.map(fieldFromHex);
}

function quad(values: readonly string[]): [bigint, bigint, bigint, bigint] {
  const [a, b, c, d] = fields(values);
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new RangeError("permutation vector must have 4 values");
  }
  return [a, b, c, d];
}

describe("poseidon2 permutation", () => {
  for (const vector of fixture.permutation) {
    it(`matches noir vector ${vector.name}`, () => {
      expect(permutation(quad(vector.input)).map(fieldToHex)).toEqual(vector.output);
    });
  }
});

describe("poseidon2 sponge", () => {
  for (const vector of [...fixture.hash, ...fixture.constructions]) {
    it(`matches noir vector ${vector.name}`, () => {
      expect(fieldToHex(hash(fields(vector.inputs)))).toBe(vector.output);
    });
  }
});

describe("mmr hash rules", () => {
  for (const vector of fixture.constructions) {
    const inputs = fields(vector.inputs);
    switch (vector.kind) {
      case "mmr_leaf":
        it(`leaf node ${vector.name}`, () => {
          expect(fieldToHex(leafNode(inputs[1] ?? 0n))).toBe(vector.output);
        });
        break;
      case "mmr_node":
        it(`internal node ${vector.name}`, () => {
          const height = Number.parseInt(vector.name.replace("height_", ""), 10);
          expect(fieldToHex(internalNode(height, inputs[1] ?? 0n, inputs[2] ?? 0n))).toBe(vector.output);
        });
        break;
      case "mmr_root":
        it(`root ${vector.name}`, () => {
          // Input 2 + (31 - h) holds slot h.
          const slots = inputs.slice(2).toReversed();
          expect(fieldToHex(rootFromSlots(Number(inputs[1] ?? 0n), slots))).toBe(vector.output);
        });
        break;
      default:
        break;
    }
  }
});

describe("batch constructions", () => {
  for (const entry of fixture.batch_cases) {
    it(`match noir case ${entry.name}`, () => {
      const deploymentId = decodeFixedHex(entry.deployment_id, 32);
      const gatewayId = decodeFixedHex(entry.gateway_id, 32);
      const k = decodeFixedHex(entry.k, 32);
      const sessionPub = decodeFixedHex(entry.session_pub, 32);
      const c = commitment(deploymentId, k);
      expect(fieldToHex(c)).toBe(entry.expected.commitment);
      const leaf = batchLeaf(c, BigInt(entry.expiry));
      expect(fieldToHex(leaf)).toBe(entry.expected.leaf);
      expect(fieldToHex(leafNode(leaf))).toBe(entry.expected.mmr_leaf_node);
      expect(fieldToHex(batchId(deploymentId, k))).toBe(entry.expected.batch_id);
      expect(fieldToHex(sessionBinding(gatewayId, sessionPub))).toBe(entry.expected.binding);
    });
  }
});

describe("encoding", () => {
  for (const entry of fixture.encoding.limbs) {
    it(`splits ${entry.bytes} into limbs`, () => {
      const [hi, lo] = bytes32ToLimbs(decodeFixedHex(entry.bytes, 32));
      expect([fieldToHex(hi), fieldToHex(lo)]).toEqual([entry.hi, entry.lo]);
    });
  }
  for (const entry of fixture.encoding.field_accept) {
    it(`accepts ${entry.wire}`, () => {
      expect(fieldFromHex(entry.wire).toString(10)).toBe(entry.value);
      expect(fieldToHex(fieldFromHex(entry.wire))).toBe(entry.wire);
    });
  }
  for (const entry of fixture.encoding.field_reject) {
    it(`rejects ${entry.wire} (${entry.reason})`, () => {
      expect(() => fieldFromHex(entry.wire)).toThrow(FieldError);
      try {
        fieldFromHex(entry.wire);
      } catch (error) {
        expect(error instanceof FieldError ? error.reason : "other").toBe(entry.reason);
      }
    });
  }
  it("rejects out-of-range bytes", () => {
    expect(() => fieldFromBytes(new Uint8Array(32).fill(0xff))).toThrow(FieldError);
  });
  it("rejects hash inputs that are not field elements", () => {
    expect(() => hash([-1n])).toThrow(FieldError);
  });
});
