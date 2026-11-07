import { ERROR_CODES } from "@anon-credit/protocol";
import { LostResultError, SdkError, ServiceError } from "@anon-credit/sdk";
import { describe, expect, it } from "vitest";
import { explain, explainServiceCode, isServiceCode } from "./explain.ts";

describe("explain", () => {
  it("has one sentence for every protocol error code", () => {
    for (const code of ERROR_CODES) {
      expect(explainServiceCode(code).length).toBeGreaterThan(10);
      expect(isServiceCode(code)).toBe(true);
    }
    expect(isServiceCode("nope")).toBe(false);
  });

  it("keeps the stable code of a service error", () => {
    const explained = explain(new ServiceError("insufficient_units", 402, "no units", false));
    expect(explained.code).toBe("insufficient_units");
    expect(explained.text).toContain("HTTP 402");
    expect(explained.retryable).toBe(false);
    expect(explain(new ServiceError("busy", 503, "later", true)).retryable).toBe(true);
  });

  it("explains SDK and lost-result errors", () => {
    expect(explain(new SdkError("transport_failed", "no tunnel")).code).toBe("transport_failed");
    expect(explain(new LostResultError(4n, undefined)).text).toContain("Sequence 4");
    expect(explain(new Error("plain")).code).toBe("error");
    expect(explain("text").text).toBe("text");
  });
});
