// Payment with viem: an injected wallet (the normal case) or the local anvil test key (the
// dev stack only). The wallet sends CreditSale.buy(commitments) with exactly
// batch_price_wei * n. Only commitments leave the browser; the batch secrets stay in the
// encrypted store.

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

export type PayerKind = "injected" | "dev-key";

export interface Payer {
  readonly kind: PayerKind;
  readonly address: Address;
  readonly chainId: number;
  readonly wallet: WalletClient;
  readonly reader: PublicClient;
}

function chainFor(chainId: number, rpcUrl: string | null): Chain {
  switch (chainId) {
    case sepolia.id:
      return sepolia;
    default:
      return defineChain({
        id: chainId,
        name: `chain ${chainId}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: rpcUrl === null ? [] : [rpcUrl] } },
      });
  }
}

const hexSchema = /^0x[0-9a-fA-F]+$/;

function requireHex(value: string, what: string): Hex {
  if (!hexSchema.test(value)) throw new Error(`${what} is not hex`);
  return `0x${value.slice(2)}`;
}

// Connect the injected wallet and bring it to the payment chain.
export async function connectInjected(chainId: number): Promise<Payer> {
  const provider = window.ethereum;
  if (provider === undefined) throw new Error("no injected wallet (window.ethereum) in this browser");
  const chain = chainFor(chainId, null);
  const wallet = createWalletClient({ chain, transport: custom(provider) });
  const reader = createPublicClient({ chain, transport: custom(provider) });
  const [address] = await wallet.requestAddresses();
  if (address === undefined) throw new Error("the wallet gave no account");
  const current = await wallet.getChainId();
  if (current !== chainId) {
    await wallet.switchChain({ id: chainId });
    const after = await wallet.getChainId();
    if (after !== chainId) throw new Error(`the wallet is on chain ${after}, the deployment needs ${chainId}`);
  }
  return { kind: "injected", address, chainId, wallet, reader };
}

// The local anvil test payer. Its key is public and holds only local test ETH.
export async function connectDevKey(privateKey: string, rpcUrl: string, chainId: number): Promise<Payer> {
  const account = privateKeyToAccount(requireHex(privateKey, "the dev payer key"));
  const chain = chainFor(chainId, rpcUrl);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const reader = createPublicClient({ chain, transport: http(rpcUrl) });
  const current = await reader.getChainId();
  if (current !== chainId) throw new Error(`the dev RPC is on chain ${current}, the deployment needs ${chainId}`);
  return { kind: "dev-key", address: account.address, chainId, wallet, reader };
}

export async function readBatchPrice(payer: Payer, saleAddress: string): Promise<bigint> {
  return payer.reader.readContract({ address: requireHex(saleAddress, "sale address"), abi: creditSaleAbi, functionName: "batchPriceWei" });
}

export async function readBalance(payer: Payer): Promise<bigint> {
  return payer.reader.getBalance({ address: payer.address });
}

export interface Purchase {
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly purchaseId: bigint;
  readonly amountWei: bigint;
}

// Send CreditSale.buy and return the transaction hash as soon as the wallet signs it.
export async function sendBuy(payer: Payer, saleAddress: string, commitments: readonly string[], priceWei: bigint): Promise<Hex> {
  const account = payer.wallet.account ?? payer.address;
  return payer.wallet.sendTransaction({
    account,
    chain: payer.wallet.chain,
    to: requireHex(saleAddress, "sale address"),
    data: buyCalldata(commitments),
    value: priceWei * BigInt(commitments.length),
  });
}

// Wait for the receipt and read the Purchased log of the sale contract.
export async function waitForPurchase(payer: Payer, saleAddress: string, hash: Hex): Promise<Purchase> {
  const receipt = await payer.reader.waitForTransactionReceipt({ hash, timeout: 600_000 });
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
