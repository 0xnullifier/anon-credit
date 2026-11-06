// Registry (issuer) client. Membership proofs come through a separate isolation key, and the
// SDK checks each proof locally with @anon-credit/crypto before it uses it.

import { batchLeaf, checkMembershipProof, fieldFromHex, fieldToHex, membershipProofSchema, type MembershipProof } from "@anon-credit/crypto";
import {
  issuerConfigResponseSchema,
  issuerPaths,
  issuerRootsResponseSchema,
  treePathResponseSchema,
  type IssuerConfigResponse,
  type IssuerRootRecord,
} from "@anon-credit/protocol";
import { SdkError } from "./errors.ts";
import { getJson, type Endpoint } from "./http.ts";

// Isolation key of registry reads for one batch. It is never the batch key.
export function registryIsolationKey(batchId: string): string {
  return `registry:${batchId}`;
}

// Isolation key of configuration reads that belong to no batch.
export const CONFIG_ISOLATION_KEY = "config";

export interface VerifiedPath {
  readonly root: string;
  readonly epoch: bigint;
  readonly leaf: string;
  readonly proof: MembershipProof;
}

export interface RegistryClient {
  readonly config: () => Promise<IssuerConfigResponse>;
  // Root publication records with the status "finalized", in ascending epoch order.
  readonly finalizedRoots: (isolationKey: string) => Promise<IssuerRootRecord[]>;
  // The membership proof of `leafIndex` against `root`, checked against `expectedLeaf`.
  readonly path: (leafIndex: number, root: string, expectedLeaf: string, isolationKey: string) => Promise<VerifiedPath>;
}

export function registryClient(endpoint: Endpoint): RegistryClient {
  return {
    config: () => getJson(endpoint, issuerPaths.config(), issuerConfigResponseSchema, CONFIG_ISOLATION_KEY),
    finalizedRoots: async (isolationKey) => {
      const response = await getJson(endpoint, issuerPaths.roots(), issuerRootsResponseSchema, isolationKey);
      return response.roots.filter((record) => record.status === "finalized");
    },
    path: async (leafIndex, root, expectedLeaf, isolationKey) => {
      const response = await getJson(endpoint, issuerPaths.treePath(leafIndex, root), treePathResponseSchema, isolationKey);
      return verifyPath(response.root, response.epoch, response.leaf, response.proof, { leafIndex, root, expectedLeaf });
    },
  };
}

interface Expected {
  readonly leafIndex: number;
  readonly root: string;
  readonly expectedLeaf: string;
}

// Check a path response locally. Throw proof_check_failed if any check fails.
export function verifyPath(
  root: string,
  epoch: string,
  leaf: string,
  proofJson: object,
  expected: Expected,
): VerifiedPath {
  if (root !== expected.root) throw new SdkError("proof_check_failed", "the path is for a different root");
  if (leaf !== expected.expectedLeaf) throw new SdkError("proof_check_failed", "the path is for a different leaf");
  const parsed = membershipProofSchema.safeParse(proofJson);
  if (!parsed.success) throw new SdkError("proof_check_failed", `the membership proof is not valid JSON: ${parsed.error.message}`);
  const proof = parsed.data;
  if (proof.leafIndex !== expected.leafIndex) throw new SdkError("proof_check_failed", "the proof is for a different leaf index");
  const check = checkMembershipProof(fieldFromHex(root), proof, fieldFromHex(leaf));
  if (!check.ok) throw new SdkError("proof_check_failed", `the membership proof does not verify: ${check.reason}`);
  return { root, epoch: BigInt(epoch), leaf, proof };
}

// The leaf of a batch: H(DOM_LEAF, c, K, expiry).
export function expectedLeaf(commitmentHex: string, expiry: bigint): string {
  return fieldToHex(batchLeaf(fieldFromHex(commitmentHex), expiry));
}
