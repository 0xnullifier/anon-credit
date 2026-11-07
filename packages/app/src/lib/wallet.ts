// Signers with viem: an injected wallet (EIP-6963 or window.ethereum), a local key pair from the
// encrypted store, or the development key of the environment. The signer sends
// CreditSale.buy(commitments) with exactly batch_price_wei * n. Only commitments leave the
// browser; the batch secrets stay in the encrypted store.

import { buyCalldata, creditSaleAbi } from "@anon-credit/sdk/purchase";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  defineChain,
  http,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export type SignerKind = "injected" | "local" | "dev";

export interface Signer {
  readonly kind: SignerKind;
  // Wallet name (injected), "local key pair", or "dev key".
  readonly name: string;
  readonly address: Address;
  readonly chainId: number;
  readonly wallet: WalletClient;
  readonly reader: PublicClient;
}

function chainFor(chainId: number, rpcUrl: string | null): Chain {
  switch (chainId) {
    case sepolia.id:
      return rpcUrl === null ? sepolia : { ...sepolia, rpcUrls: { default: { http: [rpcUrl] } } };
    default:
      return defineChain({
        id: chainId,
        name: `chain ${chainId}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: rpcUrl === null ? [] : [rpcUrl] } },
      });
  }
}

const hexPattern = /^0x[0-9a-fA-F]+$/;

function requireHex(value: string, what: string): Hex {
  if (!hexPattern.test(value)) throw new Error(`${what} is not hex`);
  return `0x${value.slice(2)}`;
}

// Bring the wallet to the payment chain: switch, or add the chain and switch again.
async function ensureChain(wallet: WalletClient, chain: Chain): Promise<void> {
  const current = await wallet.getChainId();
  if (current === chain.id) return;
  try {
    await wallet.switchChain({ id: chain.id });
  } catch (switchError) {
    if (chain.rpcUrls.default.http.length === 0) throw switchError;
    await wallet.addChain({ chain });
    await wallet.switchChain({ id: chain.id });
  }
  const after = await wallet.getChainId();
  if (after !== chain.id) throw new Error(`the wallet is on chain ${after}, the deployment needs ${chain.id}`);
}

// Connect an EIP-1193 provider: request accounts, then switch or add the payment chain.
export async function connectProvider(provider: EIP1193Provider, name: string, chainId: number, rpcUrl: string | null): Promise<Signer> {
  const chain = chainFor(chainId, rpcUrl);
  const wallet = createWalletClient({ chain, transport: custom(provider) });
  const reader = createPublicClient({ chain, transport: custom(provider) });
  const [address] = await wallet.requestAddresses();
  if (address === undefined) throw new Error("the wallet gave no account");
  await ensureChain(wallet, chain);
  return { kind: "injected", name, address, chainId, wallet, reader };
}

// The plain window.ethereum provider, for a wallet that does not announce itself.
export function windowProvider(): EIP1193Provider | null {
  return window.ethereum ?? null;
}

// A signer from a private key over an HTTP RPC: a local key pair or the dev key.
export async function connectPrivateKey(privateKey: string, rpcUrl: string, chainId: number, kind: "local" | "dev"): Promise<Signer> {
  const account = privateKeyToAccount(requireHex(privateKey, "the private key"));
  const chain = chainFor(chainId, rpcUrl);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const reader = createPublicClient({ chain, transport: http(rpcUrl) });
  const current = await reader.getChainId();
  if (current !== chainId) throw new Error(`the RPC is on chain ${current}, the deployment needs ${chainId}`);
  return { kind, name: kind === "local" ? "local key pair" : "dev key", address: account.address, chainId, wallet, reader };
}

// Balance of any address through the signer's RPC.
export function readBalanceOf(reader: PublicClient, address: string): Promise<bigint> {
  return reader.getBalance({ address: requireHex(address, "address") });
}

export async function readBalance(signer: Signer): Promise<bigint> {
  return signer.reader.getBalance({ address: signer.address });
}

export async function readGasPrice(signer: Signer): Promise<bigint> {
  return signer.reader.getGasPrice();
}

export async function readBatchPrice(signer: Signer, saleAddress: string): Promise<bigint> {
  return signer.reader.readContract({ address: requireHex(saleAddress, "sale address"), abi: creditSaleAbi, functionName: "batchPriceWei" });
}

export interface Purchase {
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly purchaseId: bigint;
  readonly amountWei: bigint;
}

// Send CreditSale.buy and return the transaction hash as soon as the signer signs it. An
// injected wallet signs with eth_sendTransaction; a key signer signs locally and broadcasts.
export async function sendBuy(signer: Signer, saleAddress: string, commitments: readonly string[], priceWei: bigint): Promise<Hex> {
  const account = signer.wallet.account ?? signer.address;
  return signer.wallet.sendTransaction({
    account,
    chain: signer.wallet.chain,
    to: requireHex(saleAddress, "sale address"),
    data: buyCalldata(commitments),
    value: priceWei * BigInt(commitments.length),
  });
}

// Wait for the receipt and read the Purchased log of the sale contract.
export async function waitForPurchase(signer: Signer, saleAddress: string, hash: Hex): Promise<Purchase> {
  const receipt = await signer.reader.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  const sale = saleAddress.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== sale) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: creditSaleAbi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (decoded.eventName !== "Purchased") continue;
    return {
      txHash: hash.toLowerCase(),
      logIndex: log.logIndex,
      blockNumber: receipt.blockNumber,
      purchaseId: decoded.args.purchaseId,
      amountWei: decoded.args.amount,
    };
  }
  throw new Error(`transaction ${hash} has no Purchased event`);
}
