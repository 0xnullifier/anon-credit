// A small MMR builder for tests. The SDK package does not append leaves; the issuer does.

import { internalNode, leafNode, peakHeights, rootFromPeaks, type MembershipProof } from "@anon-credit/crypto";

interface Tree {
  readonly offset: number;
  readonly height: number;
  readonly levels: bigint[][];
}

export interface TestMmr {
  readonly root: bigint;
  readonly leafCount: number;
  readonly proof: (leafIndex: number) => MembershipProof;
}

export function buildMmr(leaves: readonly bigint[]): TestMmr {
  const heights = peakHeights(leaves.length);
  const trees: Tree[] = [];
  let offset = 0;
  for (const height of heights) {
    const levels: bigint[][] = [leaves.slice(offset, offset + 2 ** height).map(leafNode)];
    for (let level = 1; level <= height; level += 1) {
      const below = levels[level - 1] ?? [];
      const nodes: bigint[] = [];
      for (let index = 0; index < below.length; index += 2) {
        nodes.push(internalNode(level, below[index] ?? 0n, below[index + 1] ?? 0n));
      }
      levels.push(nodes);
    }
    trees.push({ offset, height, levels });
    offset += 2 ** height;
  }
  const peaks = trees.map((tree) => tree.levels[tree.height]?.[0] ?? 0n);
  return {
    root: rootFromPeaks(leaves.length, peaks),
    leafCount: leaves.length,
    proof: (leafIndex) => {
      const position = trees.findIndex((tree) => leafIndex >= tree.offset && leafIndex < tree.offset + 2 ** tree.height);
      const tree = trees[position];
      if (tree === undefined) throw new RangeError("leaf index is not in the MMR");
      const siblings: bigint[] = [];
      let index = leafIndex - tree.offset;
      for (let level = 0; level < tree.height; level += 1) {
        siblings.push(tree.levels[level]?.[index ^ 1] ?? 0n);
        index >>= 1;
      }
      return { leafIndex, leafCount: leaves.length, peakPosition: position, siblings, peaks };
    },
  };
}
