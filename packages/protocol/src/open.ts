// Open signing message. The client signs keccak256(message) with the session Ed25519 key.
// All integers are big-endian. All IDs have a fixed size. The layout is the same as
// crates/protocol/src/open.rs.
//
// offset size field
//      0   32 operation domain (OPEN_DOMAIN)
//     32    2 protocol version (u16)
//     34   32 deployment_id
//     66   32 gateway_id
//     98   32 batch_id (field element)
//    130   32 root (field element)
//    162    4 leaf_count (u32)
//    166    8 proof_epoch (u64)
//    174   32 session_pub (Ed25519 public key)
//    206   32 price_table_hash

import { keccak_256 } from "@noble/hashes/sha3.js";
import { EncodingError, MAX_U32, requireLength, requireU64 } from "./bytes.ts";
import { OPEN_DOMAIN } from "./domain.ts";
import { PROTOCOL_VERSION } from "./version.ts";

export const OPEN_MESSAGE_LENGTH = 238;

export interface OpenMessage {
  // Digest of the deployment configuration.
  readonly deploymentId: Uint8Array;
  // Random gateway identity from the deployment.
  readonly gatewayId: Uint8Array;
  // Public batch ID of the proof.
  readonly batchId: Uint8Array;
  // Selected published MMR root.
  readonly root: Uint8Array;
  // Leaf count of the selected root.
  readonly leafCount: number;
  // Epoch of the proof.
  readonly proofEpoch: bigint;
  // Session Ed25519 public key.
  readonly sessionPub: Uint8Array;
  // Hash of the price table that the session freezes.
  readonly priceTableHash: Uint8Array;
}

// Encode the open message bytes.
export function encodeOpenMessage(message: OpenMessage): Uint8Array {
  requireLength(message.deploymentId, 32, "deploymentId");
  requireLength(message.gatewayId, 32, "gatewayId");
  requireLength(message.batchId, 32, "batchId");
  requireLength(message.root, 32, "root");
  requireLength(message.sessionPub, 32, "sessionPub");
  requireLength(message.priceTableHash, 32, "priceTableHash");
  requireU64(message.proofEpoch, "proofEpoch");
  if (!Number.isInteger(message.leafCount) || message.leafCount < 0 || message.leafCount > MAX_U32) {
    throw new EncodingError("leafCount must be an unsigned 32-bit integer");
  }

  const out = new Uint8Array(OPEN_MESSAGE_LENGTH);
  const view = new DataView(out.buffer);
  out.set(OPEN_DOMAIN, 0);
  view.setUint16(32, PROTOCOL_VERSION, false);
  out.set(message.deploymentId, 34);
  out.set(message.gatewayId, 66);
  out.set(message.batchId, 98);
  out.set(message.root, 130);
  view.setUint32(162, message.leafCount, false);
  view.setBigUint64(166, message.proofEpoch, false);
  out.set(message.sessionPub, 174);
  out.set(message.priceTableHash, 206);
  return out;
}

// Calculate the digest that the session key signs: keccak256(encodeOpenMessage(message)).
export function openMessageDigest(message: OpenMessage): Uint8Array {
  return keccak_256(encodeOpenMessage(message));
}
