// Tests of the live state reducer: counting of discarded events.

import { describe, expect, it } from "vitest";
import { makeEvent } from "../testing/shared.ts";
import { INITIAL_LIVE, liveReducer, type LiveAction } from "./live-state.ts";

describe("liveReducer", () => {
  it("counts accepted, invalid, and duplicate events and keeps only real events", () => {
    const actions: LiveAction[] = [
      { type: "seed", events: [makeEvent(1), makeEvent(2)] },
      { type: "stream", state: "open", detail: null },
      { type: "events", events: [makeEvent(3)] },
      { type: "invalid", reason: "event data is not JSON" },
      { type: "invalid", reason: "event does not match the protocol schema (kind: Invalid option)" },
      { type: "duplicate" },
      { type: "events", events: [makeEvent(4), makeEvent(5)] },
    ];
    const state = actions.reduce(liveReducer, INITIAL_LIVE);
    expect(state.events.map((event) => event.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(state.stream).toEqual({
      state: "open",
      detail: null,
      received: 3,
      invalid: 2,
      lastInvalid: "event does not match the protocol schema (kind: Invalid option)",
      duplicates: 1,
      lastEventId: "5",
    });
  });
});
