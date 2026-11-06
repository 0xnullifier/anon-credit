// MMR hash rules and membership proof verification. The same rules as
// crates/crypto/src/mmr_hash.rs and crates/registry/src/proof.rs. This package does not append.
//
//   leaf_node = H(DOM_MMR_LEAF, leaf)
//   node      = H(DOM_MMR_NODE * 2^32 + height, left, right)    height = parent height
//   root      = H(DOM_MMR_ROOT, leaf_count, slot[31], slot[30], ..., slot[0])
//
// slot[h] is the peak of height h if bit h of leaf_count is 1, else zero.
// Path rule: the peak height of leaf i in an MMR of n leaves is the highest bit in which i and n
// are different. At level j below the peak, bit j of i is 1 if the node is the right child.
// The verifier calculates the peak and each decision. It does not take them from the proof.

import { z } from "zod";
import { DOM_MMR_LEAF, DOM_MMR_NODE, DOM_MMR_ROOT, MAX_LEAVES, MAX_PEAKS } from "./constants.generated.ts";
import { fieldHexSchema, requireField } from "./field.ts";
import { hash } from "./poseidon2.ts";

const TWO_POW_32 = 1n << 32n;

// A complete membership proof of one leaf against one root snapshot.
export interface MembershipProof {
  readonly leafIndex: number;
  readonly leafCount: number;
  // Position of the leaf's peak in `peaks` (0 is the left, highest peak).
  readonly peakPosition: number;
  // Siblings from the leaf level upward. Length: the peak height.
  readonly siblings: readonly bigint[];
  // All peaks of the snapshot, in descending height order.
  readonly peaks: readonly bigint[];
}

const u32Schema = z.number().int().min(0).max(MAX_LEAVES);

// Schema of the JSON proof (the same field names as the Rust serde form). Output: MembershipProof.
export const membershipProofSchema = z
  .strictObject({
    leaf_index: u32Schema,
    leaf_count: u32Schema,
    peak_position: u32Schema,
    siblings: z.array(fieldHexSchema).max(MAX_PEAKS),
    peaks: z.array(fieldHexSchema).max(MAX_PEAKS),
  })
  .transform(
    (raw): MembershipProof => ({
      leafIndex: raw.leaf_index,
      leafCount: raw.leaf_count,
      peakPosition: raw.peak_position,
      siblings: raw.siblings,
      peaks: raw.peaks,
    }),
  );

function requireU32(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_LEAVES) {
    throw new RangeError(`${field} must be an unsigned 32-bit integer`);
  }
}

// Domain value of an internal node of height `height`.
export function nodeDomain(height: number): bigint {
  return DOM_MMR_NODE * TWO_POW_32 + BigInt(height);
}

export function leafNode(leaf: bigint): bigint {
  return hash([DOM_MMR_LEAF, leaf]);
}

export function internalNode(height: number, left: bigint, right: bigint): bigint {
  return hash([nodeDomain(height), left, right]);
}

// Peak heights of an MMR with `leafCount` leaves, in descending order.
export function peakHeights(leafCount: number): number[] {
  requireU32(leafCount, "leaf count");
  const heights: number[] = [];
  for (let height = 31; height >= 0; height -= 1) {
    if (Math.floor(leafCount / 2 ** height) % 2 === 1) {
      heights.push(height);
    }
  }
  return heights;
}

// Height-indexed peak slots from the occupied peaks in descending height order.
export function peakSlots(leafCount: number, peaks: readonly bigint[]): bigint[] {
  const heights = peakHeights(leafCount);
  if (heights.length !== peaks.length) {
    throw new RangeError(`leaf count ${leafCount} has ${heights.length} peaks, found ${peaks.length}`);
  }
  const slots: bigint[] = new Array<bigint>(MAX_PEAKS).fill(0n);
  heights.forEach((height, position) => {
    slots[height] = peaks[position] ?? 0n;
  });
  return slots;
}

// Root from height-indexed peak slots. The empty slots must be zero.
export function rootFromSlots(leafCount: number, slots: readonly bigint[]): bigint {
  requireU32(leafCount, "leaf count");
  if (slots.length !== MAX_PEAKS) {
    throw new RangeError(`peak slots must have ${MAX_PEAKS} entries`);
  }
  return hash([DOM_MMR_ROOT, BigInt(leafCount), ...slots.toReversed()]);
}

// Root from the occupied peaks in descending height order.
export function rootFromPeaks(leafCount: number, peaks: readonly bigint[]): bigint {
  return rootFromSlots(leafCount, peakSlots(leafCount, peaks));
}

// Height of the peak that has leaf `leafIndex`, or undefined if leafIndex >= leafCount.
export function peakHeightOf(leafIndex: number, leafCount: number): number | undefined {
  requireU32(leafIndex, "leaf index");
  requireU32(leafCount, "leaf count");
  if (leafIndex >= leafCount) {
    return undefined;
  }
  return 31 - Math.clz32((leafIndex ^ leafCount) >>> 0);
}

// Peak hash from a leaf, its index, and the siblings from the leaf level upward.
export function pathPeak(leaf: bigint, leafIndex: number, siblings: readonly bigint[]): bigint {
  let node = leafNode(leaf);
  siblings.forEach((sibling, level) => {
    const isRight = Math.floor(leafIndex / 2 ** level) % 2 === 1;
    node = isRight ? internalNode(level + 1, sibling, node) : internalNode(level + 1, node, sibling);
  });
  return node;
}

export type ProofErrorReason =
  | "index_out_of_range"
  | "wrong_sibling_count"
  | "wrong_peak_count"
  | "wrong_peak_position"
  | "peak_mismatch"
  | "root_mismatch";

export type ProofCheck = { readonly ok: true } | { readonly ok: false; readonly reason: ProofErrorReason };

// Check a membership proof of `leaf` against `root`. The checks run in the same order as Rust.
export function checkMembershipProof(root: bigint, proof: MembershipProof, leaf: bigint): ProofCheck {
  requireField(root, "root");
  requireField(leaf, "leaf");
  const height = peakHeightOf(proof.leafIndex, proof.leafCount);
  if (height === undefined) {
    return { ok: false, reason: "index_out_of_range" };
  }
  if (proof.siblings.length !== height) {
    return { ok: false, reason: "wrong_sibling_count" };
  }
  const heights = peakHeights(proof.leafCount);
  if (proof.peaks.length !== heights.length) {
    return { ok: false, reason: "wrong_peak_count" };
  }
  if (heights.indexOf(height) !== proof.peakPosition) {
    return { ok: false, reason: "wrong_peak_position" };
  }
  if (proof.peaks[proof.peakPosition] !== pathPeak(leaf, proof.leafIndex, proof.siblings)) {
    return { ok: false, reason: "peak_mismatch" };
  }
  if (rootFromPeaks(proof.leafCount, proof.peaks) !== root) {
    return { ok: false, reason: "root_mismatch" };
  }
  return { ok: true };
}

// Tell if a membership proof of `leaf` against `root` is valid.
export function verifyMembershipProof(root: bigint, proof: MembershipProof, leaf: bigint): boolean {
  return checkMembershipProof(root, proof, leaf).ok;
}
