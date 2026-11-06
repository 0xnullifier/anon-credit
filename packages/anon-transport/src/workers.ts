// Anon-RPC workers from adopters.json5 (ethereum/anon-rpc, main). The SDK uses Nox.
//
// "chainId" is the chain of the specifier contract. The bootstrap RPC must read the contract
// from that chain. It is not the chain that the anonymized fetch reaches.

import { z } from "zod";

export const workerIdSchema = z.enum(["nox"]);
export type WorkerId = z.infer<typeof workerIdSchema>;

export interface WorkerEntry {
  // Specifier contract address.
  readonly specifier: string;
  // Chain of the specifier contract.
  readonly chainId: number;
  // Only anonymizing workers are in this table. The passthrough worker is not.
  readonly anonymizes: true;
}

// Nox specifier contract and its chain (Sepolia).
export const NOX_SPECIFIER = "0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A";
export const NOX_SPECIFIER_CHAIN_ID = 11_155_111;

// Default Anon-RPC worker.
export const DEFAULT_WORKER: WorkerId = "nox";

export const WORKERS: Readonly<Record<WorkerId, WorkerEntry>> = {
  nox: { specifier: NOX_SPECIFIER, chainId: NOX_SPECIFIER_CHAIN_ID, anonymizes: true },
};

// Public bootstrap RPCs without an API key, one for each specifier chain.
export const BOOTSTRAP_RPC_URLS: Readonly<Record<number, string>> = {
  [NOX_SPECIFIER_CHAIN_ID]: "https://ethereum-sepolia-rpc.publicnode.com",
};
