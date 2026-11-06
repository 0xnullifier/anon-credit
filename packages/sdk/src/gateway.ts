// Gateway client. Open, spend, and status use the isolation key of the batch.

import {
  PROTOCOL_VERSION,
  decodeFixedHex,
  encodeBase64,
  encodeHex,
  gatewayConfigResponseSchema,
  openChunkResponseSchema,
  openResponseSchema,
  priceTableHash,
  pricesResponseSchema,
  rootsResponseSchema,
  statusMessageDigest,
  statusResponseSchema,
  type GatewayConfigResponse,
  type OpenChunkRequest,
  type OpenChunkResponse,
  type OpenRequest,
  type OpenResponse,
  type PricesResponse,
  type RootsResponse,
  type SpendRequest,
  type StatusRequest,
  type StatusResponse,
} from "@anon-credit/protocol";
import { SdkError } from "./errors.ts";
import { JSON_HEADERS, getJson, postJson, putJson, send, type Endpoint } from "./http.ts";
import { signDigest, type SessionKey } from "./keys.ts";
import type { RandomSource } from "./random.ts";
import { CONFIG_ISOLATION_KEY } from "./registry.ts";

export interface GatewayClient {
  readonly config: () => Promise<GatewayConfigResponse>;
  // The price table. The SDK checks the hash with the canonical encoding.
  readonly prices: () => Promise<PricesResponse>;
  readonly roots: (isolationKey: string) => Promise<RootsResponse>;
  readonly open: (request: OpenRequest, isolationKey: string) => Promise<OpenResponse>;
  // Send one chunk of a proof upload (PUT /v1/open/chunks).
  readonly openChunk: (request: OpenChunkRequest, isolationKey: string) => Promise<OpenChunkResponse>;
  // Send a spend request. Return the raw response: the caller reads the headers and the body.
  readonly spend: (request: SpendRequest, isolationKey: string) => Promise<Response>;
  readonly status: (request: StatusRequest, isolationKey: string) => Promise<StatusResponse>;
}

export function gatewayClient(endpoint: Endpoint): GatewayClient {
  return {
    config: () => getJson(endpoint, "/v1/config", gatewayConfigResponseSchema, CONFIG_ISOLATION_KEY),
    prices: async () => {
      const prices = await getJson(endpoint, "/v1/prices", pricesResponseSchema, CONFIG_ISOLATION_KEY);
      if (encodeHex(priceTableHash(prices.price_table)) !== prices.price_table_hash) {
        throw new SdkError("invalid_response", "the price table hash does not match the canonical encoding");
      }
      return prices;
    },
    roots: (isolationKey) => getJson(endpoint, "/v1/roots", rootsResponseSchema, isolationKey),
    open: (request, isolationKey) => postJson(endpoint, "/v1/open", request, openResponseSchema, isolationKey),
    openChunk: (request, isolationKey) => putJson(endpoint, "/v1/open/chunks", request, openChunkResponseSchema, isolationKey),
    spend: (request, isolationKey) =>
      send(endpoint, "/v1/rpc", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(request) }, isolationKey),
    status: (request, isolationKey) => postJson(endpoint, "/v1/session/status", request, statusResponseSchema, isolationKey),
  };
}

export interface StatusIdentity {
  readonly deploymentId: string;
  readonly gatewayId: string;
  readonly batchId: string;
}

// A signed status request with a new random nonce.
export function buildStatusRequest(identity: StatusIdentity, key: SessionKey, random: RandomSource): StatusRequest {
  const nonce = random(32);
  const digest = statusMessageDigest({
    deploymentId: decodeFixedHex(identity.deploymentId, 32),
    gatewayId: decodeFixedHex(identity.gatewayId, 32),
    batchId: decodeFixedHex(identity.batchId, 32),
    nonce,
  });
  return {
    protocol_version: PROTOCOL_VERSION,
    deployment_id: identity.deploymentId,
    gateway_id: identity.gatewayId,
    batch_id: identity.batchId,
    nonce: encodeHex(nonce),
    signature: encodeBase64(signDigest(key, digest)),
  };
}
