// Public inputs of the batch-open circuit. The same order as crates/crypto/src/public_inputs.rs
// and the parameters of main in circuits/batch-open/src/main.nr.
//
// The gateway does not accept public inputs from the client. It builds them from the open
// request, its configuration, and the root record with batchOpenPublicInputs.

import { requireLength, requireU64 } from "@anon-credit/protocol";
import { CIRCUIT_ID, MAX_LEAVES } from "./constants.generated.ts";
import { bytes32ToLimbs, requireField } from "./field.ts";
import { sessionBinding } from "./batch.ts";

export const PUBLIC_INPUT_NAMES: readonly string[] = [
  "circuit_id",
  "deployment_id_hi",
  "deployment_id_lo",
  "gateway_id_hi",
  "gateway_id_lo",
  "root",
  "leaf_count",
  "proof_epoch",
  "batch_id",
  "binding",
];

export const PUBLIC_INPUT_COUNT = 10;

export interface OpenPublicValues {
  readonly deploymentId: Uint8Array;
  readonly gatewayId: Uint8Array;
  // Selected published MMR root.
  readonly root: bigint;
  // Leaf count of the selected root.
  readonly leafCount: number;
  readonly proofEpoch: bigint;
  readonly batchId: bigint;
  // Ed25519 session public key. The binding is calculated from it.
  readonly sessionPub: Uint8Array;
}

// The public-input vector in circuit order.
export function batchOpenPublicInputs(values: OpenPublicValues): bigint[] {
  requireLength(values.deploymentId, 32, "deployment_id");
  requireLength(values.gatewayId, 32, "gateway_id");
  requireLength(values.sessionPub, 32, "session_pub");
  requireField(values.root, "root");
  requireField(values.batchId, "batch_id");
  requireU64(values.proofEpoch, "proof_epoch");
  if (!Number.isInteger(values.leafCount) || values.leafCount < 0 || values.leafCount > MAX_LEAVES) {
    throw new RangeError("leaf_count must be an unsigned 32-bit integer");
  }
  const [deploymentHi, deploymentLo] = bytes32ToLimbs(values.deploymentId);
  const [gatewayHi, gatewayLo] = bytes32ToLimbs(values.gatewayId);
  return [
    CIRCUIT_ID,
    deploymentHi,
    deploymentLo,
    gatewayHi,
    gatewayLo,
    values.root,
    BigInt(values.leafCount),
    values.proofEpoch,
    values.batchId,
    sessionBinding(values.gatewayId, values.sessionPub),
  ];
}
