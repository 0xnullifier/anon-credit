// Session status signing message. The client signs keccak256(message) with the session
// Ed25519 key. The layout is the same as crates/protocol/src/status.rs.
//
// offset size field
//      0   32 operation domain (STATUS_DOMAIN)
//     32    2 protocol version (u16)
//     34   32 deployment_id
//     66   32 gateway_id
//     98   32 batch_id
//    130   32 nonce (32 random bytes)

import { keccak_256 } from "@noble/hashes/sha3.js";
import { requireLength } from "./bytes.ts";
import { STATUS_DOMAIN } from "./domain.ts";
import { PROTOCOL_VERSION } from "./version.ts";

export const STATUS_MESSAGE_LENGTH = 162;

export interface StatusMessage {
  // Digest of the deployment configuration.
  readonly deploymentId: Uint8Array;
  // Random gateway identity from the deployment.
  readonly gatewayId: Uint8Array;
  // Public batch ID of the session.
  readonly batchId: Uint8Array;
  // Random client nonce. Use a new nonce for each request.
  readonly nonce: Uint8Array;
}

// Encode the status message bytes.
export function encodeStatusMessage(message: StatusMessage): Uint8Array {
  requireLength(message.deploymentId, 32, "deploymentId");
  requireLength(message.gatewayId, 32, "gatewayId");
  requireLength(message.batchId, 32, "batchId");
  requireLength(message.nonce, 32, "nonce");

  const out = new Uint8Array(STATUS_MESSAGE_LENGTH);
  const view = new DataView(out.buffer);
  out.set(STATUS_DOMAIN, 0);
  view.setUint16(32, PROTOCOL_VERSION, false);
  out.set(message.deploymentId, 34);
  out.set(message.gatewayId, 66);
  out.set(message.batchId, 98);
  out.set(message.nonce, 130);
  return out;
}

// Calculate the digest that the session key signs: keccak256(encodeStatusMessage(message)).
export function statusMessageDigest(message: StatusMessage): Uint8Array {
  return keccak_256(encodeStatusMessage(message));
}
