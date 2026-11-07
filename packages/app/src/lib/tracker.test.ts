import { describe, expect, it } from "vitest";
import { elapsedMs, failStep, finishStep, noteStep, pendingStep, replaceStep, startStep } from "./tracker.ts";

describe("tracker", () => {
  it("moves a step through pending, running, done with real times", () => {
    const step = pendingStep("a", "first");
    expect(step.state).toBe("pending");
    expect(elapsedMs(step, 10)).toBeNull();
    const running = startStep(step, 1000, ["GET /x"]);
    expect(running.state).toBe("running");
    expect(elapsedMs(running, 1500)).toBe(500);
    const done = finishStep(running, 1800, ["answered"]);
    expect(done.state).toBe("done");
    expect(done.endedAt).toBe(1800);
    expect(elapsedMs(done, 9999)).toBe(800);
    expect(done.detail).toEqual(["answered"]);
  });

  it("keeps the detail and records the error of a failure", () => {
    const failed = failStep(startStep(pendingStep("b", "second"), 5, ["tx 0x1"]), 9, "busy: try again");
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("busy: try again");
    expect(failed.detail).toEqual(["tx 0x1"]);
    expect(noteStep(failed, ["x"]).detail).toEqual(["x"]);
  });

  it("replaces one step by id", () => {
    const steps = [pendingStep("a", "a"), pendingStep("b", "b")];
    const next = replaceStep(steps, startStep(steps[1] ?? pendingStep("b", "b"), 1));
    expect(next.map((step) => step.state)).toEqual(["pending", "running"]);
  });
});
