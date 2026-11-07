// The ten public inputs of the batch-open proof, in circuit order
// (fixtures/protocol/batch-open-public-inputs.json), each with a short label.

export interface PublicInputLabel {
  readonly name: string;
  readonly meaning: string;
}

export const PUBLIC_INPUT_LABELS: readonly PublicInputLabel[] = [
  { name: "circuit_id", meaning: "which statement was proven" },
  { name: "deployment_id hi", meaning: "upper 16 bytes of the deployment identity" },
  { name: "deployment_id lo", meaning: "lower 16 bytes" },
  { name: "gateway_id hi", meaning: "upper 16 bytes of the gateway identity" },
  { name: "gateway_id lo", meaning: "lower 16 bytes" },
  { name: "root", meaning: "MMR root that holds the leaf" },
  { name: "leaf_count", meaning: "leaves under that root" },
  { name: "proof_epoch", meaning: "epoch the proof was made for" },
  { name: "batch_id", meaning: "H(k) under the id domain; the only thing that names the batch" },
  { name: "binding", meaning: "hash of the gateway id and the session public key" },
];

export interface LabeledInput extends PublicInputLabel {
  readonly value: string;
}

export function labelPublicInputs(values: readonly string[]): LabeledInput[] {
  return PUBLIC_INPUT_LABELS.map((label, index) => ({ ...label, value: values[index] ?? "" }));
}
