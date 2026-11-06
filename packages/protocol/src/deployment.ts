// Immutable deployment configuration and deployment_id.
// deployment_id = keccak256(encodeDeployment(config)).
// The layout is the same as crates/protocol/src/deployment.rs.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";
import { addressSchema, bytes32Schema, MAX_U32 } from "./bytes.ts";
import { DEPLOYMENT_DOMAIN } from "./domain.ts";
import { PROTOCOL_VERSION } from "./version.ts";

export const DEPLOYMENT_ENCODING_LENGTH = 242;
export const SEPOLIA_CHAIN_ID = 11_155_111;
export const BATCH_SIZE = 100;
export const CREDIT_LIFETIME_EPOCHS = 35_040;
export const ROOT_WINDOW_EPOCHS = 96;
export const EPOCH_SECONDS_TESTNET = 30;
export const EPOCH_SECONDS_PRODUCTION = 900;

const positiveU32 = z.number().int().min(1).max(MAX_U32);

// Schema of the JSON form. Unknown fields are rejected. Hex fields become bytes.
export const deploymentConfigSchema = z.strictObject({
  protocol_version: z.literal(PROTOCOL_VERSION),
  payment_chain_id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sale_address: addressSchema,
  root_registry_address: addressSchema,
  issuer_address: addressSchema,
  gateway_id: bytes32Schema,
  batch_size: positiveU32,
  epoch_seconds: positiveU32,
  credit_lifetime_epochs: positiveU32,
  circuit_id: bytes32Schema,
  verifier_artifact_hash: bytes32Schema,
  prover_manifest_hash: bytes32Schema,
});

export type DeploymentConfig = z.output<typeof deploymentConfigSchema>;

// Encode the configuration in its fixed binary form.
export function encodeDeployment(config: DeploymentConfig): Uint8Array {
  const out = new Uint8Array(DEPLOYMENT_ENCODING_LENGTH);
  const view = new DataView(out.buffer);
  out.set(DEPLOYMENT_DOMAIN, 0);
  view.setUint16(32, config.protocol_version, false);
  view.setBigUint64(34, BigInt(config.payment_chain_id), false);
  out.set(config.sale_address, 42);
  out.set(config.root_registry_address, 62);
  out.set(config.issuer_address, 82);
  out.set(config.gateway_id, 102);
  view.setUint32(134, config.batch_size, false);
  view.setUint32(138, config.epoch_seconds, false);
  view.setUint32(142, config.credit_lifetime_epochs, false);
  out.set(config.circuit_id, 146);
  out.set(config.verifier_artifact_hash, 178);
  out.set(config.prover_manifest_hash, 210);
  return out;
}

// Calculate deployment_id = keccak256(encodeDeployment(config)).
export function deploymentId(config: DeploymentConfig): Uint8Array {
  return keccak_256(encodeDeployment(config));
}
