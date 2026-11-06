// State of the live event view: the received events and the stream status.

import type { GatewayEvent } from "@anon-credit/protocol";
import type { StreamState } from "./event-stream.ts";
import { MAX_EVENTS, mergeEvents } from "./events-model.ts";

export interface StreamStatus {
  readonly state: StreamState;
  readonly detail: string | null;
  // Events accepted from the stream.
  readonly received: number;
  // Events discarded because they were not JSON or did not match the schema.
  readonly invalid: number;
  readonly lastInvalid: string | null;
  // Events discarded because their ID was not new.
  readonly duplicates: number;
  readonly lastEventId: string | null;
}

export interface LiveState {
  readonly events: readonly GatewayEvent[];
  readonly stream: StreamStatus;
}

export type LiveAction =
  | { readonly type: "seed"; readonly events: readonly GatewayEvent[] }
  | { readonly type: "events"; readonly events: readonly GatewayEvent[] }
  | { readonly type: "invalid"; readonly reason: string }
  | { readonly type: "duplicate" }
  | { readonly type: "stream"; readonly state: StreamState; readonly detail: string | null };

export const INITIAL_LIVE: LiveState = {
  events: [],
  stream: { state: "stopped", detail: null, received: 0, invalid: 0, lastInvalid: null, duplicates: 0, lastEventId: null },
};

function lastId(events: readonly GatewayEvent[], fallback: string | null): string | null {
  return events.at(-1)?.id ?? fallback;
}

export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case "seed": {
      // Events of a snapshot. They are real gateway events, but not stream events.
      const events = mergeEvents(state.events, action.events, MAX_EVENTS);
      return { ...state, events };
    }
    case "events": {
      const events = mergeEvents(state.events, action.events, MAX_EVENTS);
      return {
        events,
        stream: {
          ...state.stream,
          received: state.stream.received + action.events.length,
          lastEventId: lastId(action.events, state.stream.lastEventId),
        },
      };
    }
    case "invalid":
      return { ...state, stream: { ...state.stream, invalid: state.stream.invalid + 1, lastInvalid: action.reason } };
    case "duplicate":
      return { ...state, stream: { ...state.stream, duplicates: state.stream.duplicates + 1 } };
    case "stream":
      return { ...state, stream: { ...state.stream, state: action.state, detail: action.detail } };
  }
}
