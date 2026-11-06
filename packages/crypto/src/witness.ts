// Full input set of the batch-open circuit. The same as crates/registry/src/witness.rs.
//
// siblings[j] is the sibling at level j below the peak, else zero (32 slots).
// peaks[h] is the peak of height h if bit h of leaf_count is 1, else zero (32 slots).

import { CIRCUIT_ID, MAX_HEIGHT } from "./constants.generated.ts";
import { batchId, batchLeaf, commitment } from "./batch.ts";
import { bytes32ToLimbs, fieldToHex } from "./field.ts";
import { checkMembershipProof, peakSlots } from "./mmr.ts";
import type { MembershipProof, ProofErrorReason } from "./mmr.ts";
import { batchOpenPublicInputs } from "./public-inputs.ts";

export interface OpenSecrets {
  readonly deploymentId: Uint8Array;
  readonly gatewayId: Uint8Array;
  // Batch secret k.
  readonly k: Uint8Array;
  // Ed25519 session public key.
  readonly sessionPub: Uint8Array;
  // Activation expiry epoch of the leaf. The issuer set it at insertion.
  readonly expiry: bigint;
  readonly proofEpoch: bigint;
}

export type Limbs = readonly [bigint, bigint];

export interface BatchOpenWitness {
  readonly circuitId: bigint;
  readonly deploymentId: Limbs;
  readonly gatewayId: Limbs;
  readonly root: bigint;
  readonly leafCount: number;
  readonly proofEpoch: bigint;
  readonly batchId: bigint;
  readonly binding: bigint;
  readonly k: Limbs;
  readonly expiry: bigint;
  readonly leafIndex: number;
  readonly siblings: readonly bigint[];
  readonly peaks: readonly bigint[];
  readonly sessionPub: Limbs;
}

// JSON form. The keys are the parameter names of main in circuits/batch-open/src/main.nr.
export interface BatchOpenWitnessJson {
  readonly circuit_id: string;
  readonly deployment_id: readonly [string, string];
  readonly gateway_id: readonly [string, string];
  readonly root: string;
  readonly leaf_count: number;
  readonly proof_epoch: string;
  readonly batch_id: string;
  readonly binding: string;
  readonly k: readonly [string, string];
  readonly expiry: string;
  readonly leaf_index: number;
  readonly siblings: readonly string[];
  readonly peaks: readonly string[];
  readonly session_pub: readonly [string, string];
}

export type WitnessErrorReason = "expired" | ProofErrorReason;

// Error for a witness that would not satisfy the circuit.
export class WitnessError extends Error {
  override readonly name = "WitnessError";
  readonly reason: WitnessErrorReason;

  constructor(reason: WitnessErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

// Build the witness from a membership proof for a selected root. The function checks the
// proof and the expiry, so a returned witness satisfies the circuit.
export function buildBatchOpenWitness(secrets: OpenSecrets, root: bigint, proof: MembershipProof): BatchOpenWitness {
  if (secrets.proofEpoch > secrets.expiry) {
    throw new WitnessError("expired", `proof epoch ${secrets.proofEpoch} is after expiry ${secrets.expiry}`);
  }
  const leaf = batchLeaf(commitment(secrets.deploymentId, secrets.k), secrets.expiry);
  const check = checkMembershipProof(root, proof, leaf);
  if (!check.ok) {
    throw new WitnessError(check.reason, `membership proof is not valid for this leaf: ${check.reason}`);
  }
  const siblings: bigint[] = new Array<bigint>(MAX_HEIGHT).fill(0n);
  proof.siblings.forEach((sibling, level) => {
    siblings[level] = sibling;
  });
  const id = batchId(secrets.deploymentId, secrets.k);
  const publicInputs = batchOpenPublicInputs({
    deploymentId: secrets.deploymentId,
    gatewayId: secrets.gatewayId,
    root,
    leafCount: proof.leafCount,
    proofEpoch: secrets.proofEpoch,
    batchId: id,
    sessionPub: secrets.sessionPub,
  });
  return {
    circuitId: CIRCUIT_ID,
    deploymentId: bytes32ToLimbs(secrets.deploymentId),
    gatewayId: bytes32ToLimbs(secrets.gatewayId),
    root,
    leafCount: proof.leafCount,
    proofEpoch: secrets.proofEpoch,
    batchId: id,
    binding: publicInputs[9] ?? 0n,
    k: bytes32ToLimbs(secrets.k),
    expiry: secrets.expiry,
    leafIndex: proof.leafIndex,
    siblings,
    peaks: peakSlots(proof.leafCount, proof.peaks),
    sessionPub: bytes32ToLimbs(secrets.sessionPub),
  };
}

// The public-input vector of a witness in circuit order.
export function witnessPublicInputs(witness: BatchOpenWitness): bigint[] {
  return [
    witness.circuitId,
    witness.deploymentId[0],
    witness.deploymentId[1],
    witness.gatewayId[0],
    witness.gatewayId[1],
    witness.root,
    BigInt(witness.leafCount),
    witness.proofEpoch,
    witness.batchId,
    witness.binding,
  ];
}

function limbsJson(limbs: Limbs): readonly [string, string] {
  return [fieldToHex(limbs[0]), fieldToHex(limbs[1])];
}

// The JSON form of a witness (the same form as the Rust serde output).
export function witnessToJson(witness: BatchOpenWitness): BatchOpenWitnessJson {
  return {
    circuit_id: fieldToHex(witness.circuitId),
    deployment_id: limbsJson(witness.deploymentId),
    gateway_id: limbsJson(witness.gatewayId),
    root: fieldToHex(witness.root),
    leaf_count: witness.leafCount,
    proof_epoch: witness.proofEpoch.toString(10),
    batch_id: fieldToHex(witness.batchId),
    binding: fieldToHex(witness.binding),
    k: limbsJson(witness.k),
    expiry: witness.expiry.toString(10),
    leaf_index: witness.leafIndex,
    siblings: witness.siblings.map(fieldToHex),
    peaks: witness.peaks.map(fieldToHex),
    session_pub: limbsJson(witness.sessionPub),
  };
}
