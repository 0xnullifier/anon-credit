// Clients of the gateway admin API (private listener, bearer token) and of the public
// gateway API (no credentials).
//
// Rules:
// - The admin token goes only in the Authorization header. Never in a URL.
// - Requests to the public API have no Authorization header and no cookies.
// - Each response body is checked with the schema from @anon-credit/protocol.

import {
  adminSnapshotSchema,
  demoPeerResponseSchema,
  gatewayConfigResponseSchema,
  hex32TextSchema,
  pricesResponseSchema,
  rootsResponseSchema,
  sessionDetailSchema,
  type AdminSnapshot,
  type DemoPeerResponse,
  type GatewayConfigResponse,
  type PricesResponse,
  type RootsResponse,
  type SessionDetail,
} from "@anon-credit/protocol";
import { getJson, joinUrl, RequestFailure, type FetchLike } from "./http.ts";

export const SNAPSHOT_PATH = "/admin/v1/snapshot";
export const EVENTS_PATH = "/admin/v1/events";
export const SESSION_PATH = "/admin/v1/sessions/";
export const DEMO_PEER_PATH = "/v1/demo/peer";
export const PRICES_PATH = "/v1/prices";
export const ROOTS_PATH = "/v1/roots";
export const CONFIG_PATH = "/v1/config";

// Where the dashboard connects. The token is a secret.
export interface Connection {
  readonly adminUrl: string;
  readonly gatewayUrl: string;
  readonly token: string;
}

// Headers of an admin request.
export function adminHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

function adminInit(connection: Connection, signal: AbortSignal | null): RequestInit {
  return { headers: adminHeaders(connection.token), credentials: "omit", signal };
}

function publicInit(signal: AbortSignal | null): RequestInit {
  return { headers: { Accept: "application/json" }, credentials: "omit", signal };
}

// GET /admin/v1/snapshot.
export function fetchSnapshot(
  fetchFn: FetchLike,
  connection: Connection,
  signal: AbortSignal | null = null,
): Promise<AdminSnapshot> {
  return getJson(fetchFn, joinUrl(connection.adminUrl, SNAPSHOT_PATH), adminInit(connection, signal), adminSnapshotSchema, "snapshot");
}

// GET /admin/v1/sessions/{batch_id}. The batch ID must be canonical hex.
export function fetchSession(
  fetchFn: FetchLike,
  connection: Connection,
  batchId: string,
  signal: AbortSignal | null = null,
): Promise<SessionDetail> {
  const id = hex32TextSchema.safeParse(batchId);
  if (!id.success) {
    return Promise.reject(new RequestFailure("invalid", "batch ID is not canonical hex"));
  }
  const url = joinUrl(connection.adminUrl, `${SESSION_PATH}${encodeURIComponent(id.data)}`);
  return getJson(fetchFn, url, adminInit(connection, signal), sessionDetailSchema, "session");
}

// GET /v1/demo/peer on the public gateway: the direct probe. It sends no admin token.
export function probePeer(fetchFn: FetchLike, gatewayUrl: string, signal: AbortSignal | null = null): Promise<DemoPeerResponse> {
  return getJson(fetchFn, joinUrl(gatewayUrl, DEMO_PEER_PATH), publicInit(signal), demoPeerResponseSchema, "direct probe");
}

// GET /v1/prices on the public gateway.
export function fetchPrices(fetchFn: FetchLike, gatewayUrl: string, signal: AbortSignal | null = null): Promise<PricesResponse> {
  return getJson(fetchFn, joinUrl(gatewayUrl, PRICES_PATH), publicInit(signal), pricesResponseSchema, "prices");
}

// GET /v1/config on the public gateway.
export function fetchConfig(fetchFn: FetchLike, gatewayUrl: string, signal: AbortSignal | null = null): Promise<GatewayConfigResponse> {
  return getJson(fetchFn, joinUrl(gatewayUrl, CONFIG_PATH), publicInit(signal), gatewayConfigResponseSchema, "config");
}

// GET /v1/roots on the public gateway.
export function fetchRoots(fetchFn: FetchLike, gatewayUrl: string, signal: AbortSignal | null = null): Promise<RootsResponse> {
  return getJson(fetchFn, joinUrl(gatewayUrl, ROOTS_PATH), publicInit(signal), rootsResponseSchema, "roots");
}
