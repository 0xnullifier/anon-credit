// Spend signing message. The client signs keccak256(message) with the session Ed25519 key.
// All integers are big-endian. All IDs have a fixed size.
//
// offset size field
//      0   32 operation domain (SPEND_DOMAIN)
//     32    2 protocol version (u16)
//     34   32 deployment_id
//     66   32 gateway_id
//     98   32 batch_id
//    130   32 price_table_hash
//    162    8 seq (u64)
//    170    8 units_total (u64)
//    178    4 rpc_byte_length (u32)
//    182    n rpc_bytes

import { keccak_256 } from "@noble/hashes/sha3.js";
import { EncodingError, MAX_U32, requireLength, requireU64 } from "./bytes.ts";
import { SPEND_DOMAIN } from "./domain.ts";
import { PROTOCOL_VERSION } from "./version.ts";

export const SPEND_MESSAGE_HEADER_LENGTH = 182;

export interface SpendMessage {
  // Digest of the deployment configuration.
  readonly deploymentId: Uint8Array;
  // Random gateway identity from the deployment.
  readonly gatewayId: Uint8Array;
  // Public batch ID from the open proof.
  readonly batchId: Uint8Array;
  // Hash of the price table frozen at open.
  readonly priceTableHash: Uint8Array;
  // Sequence number. The first request has sequence zero.
  readonly seq: bigint;
  // Cumulative units charged, including this request.
  readonly unitsTotal: bigint;
  // Exact UTF-8 bytes of one JSON-RPC object. Keep these bytes for retries.
  readonly rpcBytes: Uint8Array;
}

// Encode the spend message bytes.
export function encodeSpendMessage(message: SpendMessage): Uint8Array {
  requireLength(message.deploymentId, 32, "deploymentId");
  requireLength(message.gatewayId, 32, "gatewayId");
  requireLength(message.batchId, 32, "batchId");
  requireLength(message.priceTableHash, 32, "priceTableHash");
  requireU64(message.seq, "seq");
  requireU64(message.unitsTotal, "unitsTotal");
  if (message.rpcBytes.length > MAX_U32) {
    throw new EncodingError("rpcBytes is longer than 2^32 - 1 bytes");
  }

  const out = new Uint8Array(SPEND_MESSAGE_HEADER_LENGTH + message.rpcBytes.length);
  const view = new DataView(out.buffer);
  out.set(SPEND_DOMAIN, 0);
  view.setUint16(32, PROTOCOL_VERSION, false);
  out.set(message.deploymentId, 34);
  out.set(message.gatewayId, 66);
  out.set(message.batchId, 98);
  out.set(message.priceTableHash, 130);
  view.setBigUint64(162, message.seq, false);
  view.setBigUint64(170, message.unitsTotal, false);
  view.setUint32(178, message.rpcBytes.length, false);
  out.set(message.rpcBytes, SPEND_MESSAGE_HEADER_LENGTH);
  return out;
}

// Calculate the digest that the session key signs: keccak256(encodeSpendMessage(message)).
export function spendMessageDigest(message: SpendMessage): Uint8Array {
  return keccak_256(encodeSpendMessage(message));
}
