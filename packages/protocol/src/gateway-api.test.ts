// Check the gateway API schemas against the shared examples in fixtures/protocol/gateway-api.json.
// The Rust crate runs the same examples in crates/protocol/tests/gateway_fixtures.rs.

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import fixture from "../../../fixtures/protocol/gateway-api.json" with { type: "json" };
import { adminSnapshotSchema, gatewayEventSchema, sessionDetailSchema } from "./admin-api.ts";
import { encodeHex } from "./bytes.ts";
import {
  demoPeerResponseSchema,
  gatewayConfigResponseSchema,
  gatewayErrorBodySchema,
  OPEN_CHUNK_BODY_LIMIT_BYTES,
  OPEN_CHUNK_MAX_BYTES,
  openChunkPath,
  openChunkPathSchema,
  openChunkResponseSchema,
  openMessageFromRequest,
  openRequestSchema,
  openResponseSchema,
  parseOpenChunkPath,
  pricesResponseSchema,
  readSpendResponseHeaders,
  rootsResponseSchema,
  SPEND_RESPONSE_HEADERS,
  spendRequestSchema,
  statusRequestSchema,
  statusResponseSchema,
} from "./gateway-api.ts";
import { openMessageDigest } from "./open.ts";
import { canonicalPriceTableJson, CURRENT_PRICE_TABLE, INITIAL_PRICE_TABLE, priceTableHash, priceTableSchema } from "./price.ts";
import { decodeBase64, encodeBase64, isCanonicalBase64 } from "./wire.ts";

const fileSchema = z.object({
  price_table: z.object({ table: priceTableSchema, canonical_json: z.string(), price_table_hash: z.string() }),
  spend_response_headers: z.array(z.string()),
  open_chunk_paths: z.object({
    valid: z.array(z.object({ path: z.string(), target: openChunkPathSchema })).min(1),
    invalid: z.array(z.object({ name: z.string(), path: z.string() })).min(1),
  }),
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
  switch (kind.replace(/_with(out)?_receipt$/, "").replace(/_demo$/, "").replace(/_upload$/, "")) {
    case "open_request":
      return outcome(openRequestSchema.safeParse(value));
    case "open_chunk_path":
      return outcome(openChunkPathSchema.safeParse(value));
    case "open_chunk_response":
      return outcome(openChunkResponseSchema.safeParse(value));
    case "open_response":
      return outcome(openResponseSchema.safeParse(value));
    case "spend_request":
      return outcome(spendRequestSchema.safeParse(value));
    case "status_request":
      return outcome(statusRequestSchema.safeParse(value));
    case "status_response":
      return outcome(statusResponseSchema.safeParse(value));
    case "error_body":
      return outcome(gatewayErrorBodySchema.safeParse(value));
    case "config_response":
      return outcome(gatewayConfigResponseSchema.safeParse(value));
    case "prices_response":
      return outcome(pricesResponseSchema.safeParse(value));
    case "roots_response":
      return outcome(rootsResponseSchema.safeParse(value));
    case "demo_peer_response":
      return outcome(demoPeerResponseSchema.safeParse(value));
    case "gateway_event":
      return outcome(gatewayEventSchema.safeParse(value));
    case "admin_snapshot":
      return outcome(adminSnapshotSchema.safeParse(value));
    case "session_detail":
      return outcome(sessionDetailSchema.safeParse(value));
    default:
      throw new Error(`unknown envelope type ${kind}`);
  }
}

describe("gateway api shared examples", () => {
  it("has examples of every envelope", () => {
    expect(Object.keys(file.valid).length).toBeGreaterThanOrEqual(10);
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

  it("has the same response header names", () => {
    expect(file.spend_response_headers).toEqual(SPEND_RESPONSE_HEADERS);
  });

  it("has a valid open request signature", () => {
    const request = openRequestSchema.parse(file.valid["open_request"]);
    const digest = openMessageDigest(openMessageFromRequest(request));
    const sessionPub = openMessageFromRequest(request).sessionPub;
    expect(ed25519.verify(decodeBase64(request.signature), digest, sessionPub)).toBe(true);
  });

  it("signs the same open message with an upload reference", () => {
    const inline = openRequestSchema.parse(file.valid["open_request"]);
    const upload = openRequestSchema.parse(file.valid["open_request_upload"]);
    expect(openMessageDigest(openMessageFromRequest(upload))).toEqual(openMessageDigest(openMessageFromRequest(inline)));
    expect("proof_upload" in upload && !("proof" in upload)).toBe(true);
  });

  it("renders and parses the shared chunk paths", () => {
    for (const vector of file.open_chunk_paths.valid) {
      expect(openChunkPath(vector.target)).toBe(vector.path);
      expect(parseOpenChunkPath(vector.path)).toEqual(vector.target);
    }
    for (const vector of file.open_chunk_paths.invalid) {
      expect(parseOpenChunkPath(vector.path), vector.name).toBeNull();
    }
  });

  it("keeps the chunk body and the path below the Nox margin", () => {
    // The body is the raw chunk. The path and the headers must fit in 48,000 - 40,000 bytes.
    expect(OPEN_CHUNK_BODY_LIMIT_BYTES).toBe(OPEN_CHUNK_MAX_BYTES);
    expect(OPEN_CHUNK_BODY_LIMIT_BYTES).toBeLessThanOrEqual(44_000);
    const largest = openChunkPath({
      batch_id: `0x${"ff".repeat(32)}`,
      proof_sha256: `0x${"ff".repeat(32)}`,
      total_bytes: 4_294_967_295,
      chunk_count: 4_294_967_295,
      chunk_index: 4_294_967_295,
    });
    expect(largest.length).toBeLessThan(200);
  });
});

describe("price table", () => {
  it("matches the shared canonical encoding and hash", () => {
    expect(file.price_table.table).toEqual(CURRENT_PRICE_TABLE);
    expect(canonicalPriceTableJson(file.price_table.table)).toBe(file.price_table.canonical_json);
    expect(encodeHex(priceTableHash(file.price_table.table))).toBe(file.price_table.price_table_hash);
    expect(file.price_table.canonical_json).toBe(
      '{"units":{"eth_blockNumber":1,"eth_call":3,"eth_chainId":1,"eth_getBalance":2,"eth_getTransactionReceipt":2},"version":2}',
    );
    expect(file.price_table.price_table_hash).toBe("0x5a43e7886a8b605be5873140f6682098b51d69af2c46f2ccc5ac6670a8408f08");
  });

  it("keeps the initial methods at their units and the version 1 hash", () => {
    for (const [method, units] of Object.entries(INITIAL_PRICE_TABLE.units)) {
      expect(CURRENT_PRICE_TABLE.units[method]).toBe(units);
    }
    expect(encodeHex(priceTableHash(INITIAL_PRICE_TABLE))).toBe("0xda98f5f3639aec038cc4eafa8881883249966a89123bd2fb42111d30b123f72f");
  });

  it("sorts keys in byte order", () => {
    const table = {
      units: { eth_getTransactionReceipt: 2, eth_getBalance: 2, eth_chainId: 1, eth_call: 3, eth_blockNumber: 1 },
      version: 2,
    };
    expect(canonicalPriceTableJson(table)).toBe(file.price_table.canonical_json);
  });

  it("rejects bad method names and zero units", () => {
    expect(priceTableSchema.safeParse({ units: { 'eth_"x': 1 }, version: 1 }).success).toBe(false);
    expect(priceTableSchema.safeParse({ units: { eth_x: 0 }, version: 1 }).success).toBe(false);
    expect(priceTableSchema.safeParse({ units: {}, version: 1 }).success).toBe(false);
  });
});

describe("wire encodings", () => {
  it("round trips base64 and rejects non-canonical forms", () => {
    for (const length of [0, 1, 2, 3, 4, 63, 64, 65]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37 + 11) & 255);
      expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    }
    expect(isCanonicalBase64("AQ==")).toBe(true);
    expect(isCanonicalBase64("AQ")).toBe(false);
    expect(isCanonicalBase64("AR==")).toBe(false);
    expect(isCanonicalBase64("-_-_")).toBe(false);
    expect(isCanonicalBase64("AQID\n")).toBe(false);
  });

  it("reads spend response headers", () => {
    const headers = new Map([
      ["x-anon-remaining", "96"],
      ["x-anon-next-seq", "3"],
      ["x-anon-replayed", "false"],
    ]);
    const read = readSpendResponseHeaders({ get: (name) => headers.get(name) ?? null });
    expect(read).toEqual({ remaining: 96, next_seq: 3n, replayed: false });
    expect(() => readSpendResponseHeaders({ get: () => null })).toThrow();
  });
});
