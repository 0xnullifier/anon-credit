// Batch secrets, batch values, and session keys.
//
// - The batch secret k is 32 random bytes from WebCrypto. It never leaves the browser.
// - The commitment, batch_id, and leaf come from @anon-credit/crypto (Poseidon2 rules).
// - Each batch has its own Ed25519 session key pair (@noble/curves). The session key signs
//   keccak256 of the open, spend, and status messages.

import { batchId, commitment, fieldToHex } from "@anon-credit/crypto";
import { decodeFixedHex, encodeHex } from "@anon-credit/protocol";
import { ed25519 } from "@noble/curves/ed25519.js";
import { webCryptoRandom, type RandomSource } from "./random.ts";

export const BATCH_SECRET_BYTES = 32;

// A new random batch secret k.
export function createBatchSecret(random: RandomSource = webCryptoRandom): Uint8Array {
  const k = random(BATCH_SECRET_BYTES);
  if (k.length !== BATCH_SECRET_BYTES) throw new Error("random source returned the wrong length");
  return k;
}

export interface BatchValues {
  // Purchase commitment c as a field hex value. The runner sends it to CreditSale.buy.
  readonly commitment: string;
  // Public batch ID as a field hex value. It is also the isolation key of the batch.
  readonly batchId: string;
}

// The commitment and the batch ID of a secret in one deployment.
export function batchValues(deploymentId: Uint8Array, k: Uint8Array): BatchValues {
  return {
    commitment: fieldToHex(commitment(deploymentId, k)),
    batchId: fieldToHex(batchId(deploymentId, k)),
  };
}

export interface SessionKey {
  // 32-byte Ed25519 secret key (seed). Keep it in encrypted storage only.
  readonly secretKey: Uint8Array;
  // 32-byte Ed25519 public key.
  readonly publicKey: Uint8Array;
}

// A new session key pair.
export function createSessionKey(random: RandomSource = webCryptoRandom): SessionKey {
  const secretKey = random(32);
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

// The key pair of a stored secret key.
export function sessionKeyFromSecret(secretKey: Uint8Array): SessionKey {
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

// Sign a 32-byte message digest with the session key.
export function signDigest(key: SessionKey, digest: Uint8Array): Uint8Array {
  return ed25519.sign(digest, key.secretKey);
}

export function hexOf(bytes: Uint8Array): string {
  return encodeHex(bytes);
}

export function bytes32(text: string): Uint8Array {
  return decodeFixedHex(text, 32);
}
