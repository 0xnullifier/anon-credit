// Check the issuer API schemas against the shared examples in fixtures/protocol/issuer-api.json.
// The Rust crate runs the same examples in crates/issuer/tests/issuer_fixtures.rs.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import fixture from "../../../fixtures/protocol/issuer-api.json" with { type: "json" };
import { encodeHex } from "./bytes.ts";
import { deploymentId } from "./deployment.ts";
import {
  BN254_FIELD_MODULUS,
  deploymentFromIssuerConfig,
  epochResponseSchema,
  fieldHexTextSchema,
  issuerConfigResponseSchema,
  issuerErrorBodySchema,
  issuerPaths,
  issuerRootsResponseSchema,
  leafEventsResponseSchema,
  rootEventsResponseSchema,
  topupRequestSchema,
  topupResponseSchema,
  treePathResponseSchema,
} from "./issuer-api.ts";

const fileSchema = z.object({
  description: z.string(),
  valid: z.record(z.string(), z.json()),
  invalid: z.array(z.object({ name: z.string(), type: z.string(), value: z.json() })).min(1),
});

const file = fileSchema.parse(fixture);

type Json = z.output<ReturnType<typeof z.json>>;

interface Outcome {
  readonly success: boolean;
  readonly data: object | null;
}

// Keep only the parsed value of a parse result.
function outcome<T extends object>(result: z.ZodSafeParseResult<T>): Outcome {
  switch (result.success) {
    case true:
      return { success: true, data: result.data };
    case false:
      return { success: false, data: null };
  }
}

// Parse a value with the schema of its envelope type.
function parseAs(kind: string, value: Json): Outcome {
  switch (kind.replace(/_(issued|pending|rejected)$/, "")) {
    case "config_response":
      return outcome(issuerConfigResponseSchema.safeParse(value));
    case "topup_request":
      return outcome(topupRequestSchema.safeParse(value));
    case "topup_response":
      return outcome(topupResponseSchema.safeParse(value));
    case "roots_response":
      return outcome(issuerRootsResponseSchema.safeParse(value));
    case "tree_path_response":
      return outcome(treePathResponseSchema.safeParse(value));
    case "epoch_response":
      return outcome(epochResponseSchema.safeParse(value));
    case "leaf_events_response":
      return outcome(leafEventsResponseSchema.safeParse(value));
    case "root_events_response":
      return outcome(rootEventsResponseSchema.safeParse(value));
    case "error_body":
      return outcome(issuerErrorBodySchema.safeParse(value));
    default:
      throw new Error(`unknown envelope type ${kind}`);
  }
}

describe("issuer api shared examples", () => {
  it("has examples of every envelope", () => {
    expect(Object.keys(file.valid).length).toBeGreaterThanOrEqual(11);
  });

  for (const [kind, value] of Object.entries(file.valid)) {
    it(`parses valid ${kind} without change`, () => {
      const result = parseAs(kind, value);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(value);
    });
  }

  for (const vector of file.invalid) {
    it(`rejects ${vector.type} case ${vector.name}`, () => {
      expect(parseAs(vector.type, vector.value).success).toBe(false);
    });
  }

  it("has a deployment_id that matches the deployment encoding", () => {
    const config = issuerConfigResponseSchema.parse(file.valid["config_response"]);
    expect(encodeHex(deploymentId(deploymentFromIssuerConfig(config)))).toBe(config.deployment_id);
  });

  it("has an issuance with consistent epochs and leaf indices", () => {
    const response = topupResponseSchema.parse(file.valid["topup_response_issued"]);
    expect(response.status).toBe("issued");
    expect(response.pending_reason).toBeNull();
    const issuance = response.issuance;
    expect(issuance).not.toBeNull();
    const insertion = BigInt(issuance?.insertion_epoch ?? "0");
    expect(BigInt(issuance?.eligible_epoch ?? "0")).toBe(insertion + 1n);
    expect(issuance?.leaves.map((leaf) => leaf.leaf_index)).toEqual([0, 1, 2]);
  });

  it("has a path to a root in the roots list", () => {
    const path = treePathResponseSchema.parse(file.valid["tree_path_response"]);
    const roots = issuerRootsResponseSchema.parse(file.valid["roots_response"]);
    const record = roots.roots.find((entry) => entry.root === path.root);
    expect(record?.leaf_count).toBe(path.proof.leaf_count);
  });
});

describe("issuer api helpers", () => {
  it("rejects a field value at the modulus", () => {
    const modulus = `0x${BN254_FIELD_MODULUS.toString(16).padStart(64, "0")}`;
    const below = `0x${(BN254_FIELD_MODULUS - 1n).toString(16).padStart(64, "0")}`;
    expect(fieldHexTextSchema.safeParse(modulus).success).toBe(false);
    expect(fieldHexTextSchema.safeParse(below).success).toBe(true);
  });

  it("builds checked paths", () => {
    const root = `0x${"0".repeat(63)}1`;
    const hash = `0x${"ab".repeat(32)}`;
    expect(issuerPaths.treePath(3, root)).toBe(`/v1/tree/path/3?root=${root}`);
    expect(issuerPaths.topup(hash, 2)).toBe(`/v1/topups/${hash}/2`);
    expect(issuerPaths.leafEvents(0, 100)).toBe("/v1/events/leaves?from=0&limit=100");
    expect(() => issuerPaths.treePath(-1, root)).toThrow();
    expect(() => issuerPaths.topup(hash.toUpperCase(), 2)).toThrow();
  });
});
