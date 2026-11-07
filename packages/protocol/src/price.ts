// Price table and price_table_hash. The rules are the same as crates/protocol/src/price.rs.
//
// Canonical encoding: compact UTF-8 JSON, no white space, object keys in ascending byte order:
//   {"units":{"eth_blockNumber":1,"eth_call":3,"eth_chainId":1,"eth_getBalance":2,"eth_getTransactionReceipt":2},"version":2}
// Method names have 1 to 64 characters from A-Z, a-z, 0-9, and "_". Thus no name needs an escape.
// price_table_hash = keccak256(canonical encoding).

import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";
import { MAX_U32 } from "./bytes.ts";

const positiveU32 = z.number().int().min(1).max(MAX_U32);

export const methodNameSchema = z.string().regex(/^[A-Za-z0-9_]{1,64}$/, "method name is not valid");

export const priceTableSchema = z.strictObject({
  units: z.record(methodNameSchema, positiveU32).refine((units) => Object.keys(units).length > 0, "price table has no methods"),
  version: positiveU32,
});

export type PriceTable = z.output<typeof priceTableSchema>;

// The initial table, version 1. The gateway does not serve it. It stays for the history of the hash.
export const INITIAL_PRICE_TABLE: PriceTable = {
  units: { eth_blockNumber: 1, eth_chainId: 1, eth_getBalance: 2 },
  version: 1,
};

// The current table, version 2: the initial methods at the same units, eth_call 3, and
// eth_getTransactionReceipt 2. The gateway serves this table (PriceTable::current() in Rust).
export const CURRENT_PRICE_TABLE: PriceTable = {
  units: { eth_blockNumber: 1, eth_call: 3, eth_chainId: 1, eth_getBalance: 2, eth_getTransactionReceipt: 2 },
  version: 2,
};

// Compare two ASCII strings in byte order.
function byteOrder(a: string, b: string): number {
  switch (true) {
    case a < b:
      return -1;
    case a > b:
      return 1;
    default:
      return 0;
  }
}

// The canonical encoding of a valid table.
export function canonicalPriceTableJson(table: PriceTable): string {
  const parsed = priceTableSchema.parse(table);
  const entries = Object.entries(parsed.units)
    .sort(([a], [b]) => byteOrder(a, b))
    .map(([method, units]) => `"${method}":${units}`);
  return `{"units":{${entries.join(",")}},"version":${parsed.version}}`;
}

// Bytes of ASCII text. The canonical encoding has only ASCII characters.
function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

// Calculate price_table_hash = keccak256(canonical encoding).
export function priceTableHash(table: PriceTable): Uint8Array {
  return keccak_256(asciiBytes(canonicalPriceTableJson(table)));
}
