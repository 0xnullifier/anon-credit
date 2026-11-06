// Check the TypeScript error codes against the shared list.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import fixture from "../../../fixtures/protocol/error-codes.json" with { type: "json" };
import { ERROR_CODES, errorBodySchema, errorCodeSchema, isRetryable } from "./errors.ts";

const fixtureSchema = z.object({
  codes: z.array(z.strictObject({ code: errorCodeSchema, retryable: z.boolean() })),
});

const vectors = fixtureSchema.parse(fixture);

describe("error codes", () => {
  it("match the shared list in order", () => {
    expect(vectors.codes.map((entry) => entry.code)).toEqual(ERROR_CODES);
  });

  it("match the shared retryable flags", () => {
    for (const entry of vectors.codes) {
      expect(isRetryable(entry.code)).toBe(entry.retryable);
    }
  });

  it("reject an unknown code in an error body", () => {
    expect(errorBodySchema.safeParse({ code: "nope", message: "m", retryable: false }).success).toBe(false);
  });

  it("reject unknown fields in an error body", () => {
    expect(errorBodySchema.safeParse({ code: "busy", message: "m", retryable: true, x: 1 }).success).toBe(false);
  });
});
