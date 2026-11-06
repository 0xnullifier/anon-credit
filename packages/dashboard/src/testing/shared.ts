// Test data from the shared protocol examples (fixtures/protocol/gateway-api.json).
// The Rust gateway crate checks the same examples, so these shapes are the real wire shapes.

import {
  adminSnapshotSchema,
  demoPeerResponseSchema,
  gatewayEventSchema,
  pricesResponseSchema,
  rootsResponseSchema,
  sessionDetailSchema,
  type AdminSnapshot,
  type DemoPeerResponse,
  type GatewayEvent,
  type PricesResponse,
  type RootsResponse,
  type SessionDetail,
} from "@anon-credit/protocol";
import fixture from "../../../../fixtures/protocol/gateway-api.json" with { type: "json" };

export const sharedEvent: GatewayEvent = gatewayEventSchema.parse(fixture.valid.gateway_event);
export const sharedDemoEvent: GatewayEvent = gatewayEventSchema.parse(fixture.valid.gateway_event_demo);
export const sharedSnapshot: AdminSnapshot = adminSnapshotSchema.parse(fixture.valid.admin_snapshot);
export const sharedSessionDetail: SessionDetail = sessionDetailSchema.parse(fixture.valid.session_detail);
export const sharedDemoPeer: DemoPeerResponse = demoPeerResponseSchema.parse(fixture.valid.demo_peer_response);
export const sharedPrices: PricesResponse = pricesResponseSchema.parse(fixture.valid.prices_response);
export const sharedRoots: RootsResponse = rootsResponseSchema.parse(fixture.valid.roots_response);

// An event with a new ID and other changes.
export function makeEvent(id: number, changes: Partial<GatewayEvent> = {}): GatewayEvent {
  return gatewayEventSchema.parse({ ...sharedEvent, ...changes, id: String(id) });
}

// The SSE text of events, in the gateway format ("id: N", "data: JSON", empty line).
export function sseText(events: readonly GatewayEvent[]): string {
  return events.map((event) => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

// A response with a body that gives the chunks one by one.
export function streamResponse(chunks: readonly string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Headers;
}
