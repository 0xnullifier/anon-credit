// Check the TypeScript deployment encoder against the shared vectors.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import fixture from "../../../fixtures/protocol/deployment-id.json" with { type: "json" };
import { encodeHex } from "./bytes.ts";
import { deploymentConfigSchema, deploymentId, encodeDeployment } from "./deployment.ts";

const fixtureSchema = z.object({
  cases: z
    .array(
      z.object({
        name: z.string(),
        input: deploymentConfigSchema,
        expected: z.strictObject({ encoding: z.string(), deployment_id: z.string() }),
      }),
    )
    .min(1),
});

const vectors = fixtureSchema.parse(fixture);

describe("deployment id shared vectors", () => {
  for (const vector of vectors.cases) {
    it(`matches case ${vector.name}`, () => {
      expect(encodeHex(encodeDeployment(vector.input))).toBe(vector.expected.encoding);
      expect(encodeHex(deploymentId(vector.input))).toBe(vector.expected.deployment_id);
    });
  }
});

describe("deployment schema", () => {
  const first = fixture.cases[0];

  it("rejects unknown fields", () => {
    expect(deploymentConfigSchema.safeParse({ ...first?.input, extra: 1 }).success).toBe(false);
  });

  it("rejects uppercase hex", () => {
    const input = { ...first?.input, gateway_id: first?.input.gateway_id.toUpperCase().replace("0X", "0x") };
    expect(deploymentConfigSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an unsupported protocol version", () => {
    expect(deploymentConfigSchema.safeParse({ ...first?.input, protocol_version: 2 }).success).toBe(false);
  });
});
