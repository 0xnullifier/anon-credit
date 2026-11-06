// Batch constructions of the batch-open statement. The same as crates/crypto/src/batch.rs.
//
//   c        = H(DOM_COMMITMENT, deployment_id_hi, deployment_id_lo, k_hi, k_lo)
//   leaf     = H(DOM_LEAF, c, K, expiry)                     K = 100
//   batch_id = H(DOM_BATCH_ID, deployment_id_hi, deployment_id_lo, k_hi, k_lo)
//   binding  = H(DOM_BINDING, gateway_id_hi, gateway_id_lo, session_pub_hi, session_pub_lo)

import { requireU64 } from "@anon-credit/protocol";
import { BATCH_UNITS_K, DOM_BATCH_ID, DOM_BINDING, DOM_COMMITMENT, DOM_LEAF } from "./constants.generated.ts";
import { bytes32ToLimbs, requireField } from "./field.ts";
import { hash } from "./poseidon2.ts";

function taggedPair(tag: bigint, a: Uint8Array, b: Uint8Array): bigint {
  const [aHi, aLo] = bytes32ToLimbs(a);
  const [bHi, bLo] = bytes32ToLimbs(b);
  return hash([tag, aHi, aLo, bHi, bLo]);
}

// Purchase commitment c. The client sends it to the sale contract.
export function commitment(deploymentId: Uint8Array, k: Uint8Array): bigint {
  return taggedPair(DOM_COMMITMENT, deploymentId, k);
}

// Tree leaf from the commitment and the expiry epoch that the issuer set.
export function batchLeaf(commitmentValue: bigint, expiry: bigint): bigint {
  requireField(commitmentValue, "commitment");
  requireU64(expiry, "expiry");
  return hash([DOM_LEAF, commitmentValue, BATCH_UNITS_K, expiry]);
}

// Public batch ID. The client reveals it to the gateway at open.
export function batchId(deploymentId: Uint8Array, k: Uint8Array): bigint {
  return taggedPair(DOM_BATCH_ID, deploymentId, k);
}

// Public session binding. The gateway calculates it from its ID and the received session key.
export function sessionBinding(gatewayId: Uint8Array, sessionPub: Uint8Array): bigint {
  return taggedPair(DOM_BINDING, gatewayId, sessionPub);
}
