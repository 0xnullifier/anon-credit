// Purchase coordination for the Node runner (not the browser).
//
// The runner holds the test payer key. It receives only commitments from the browser. Batch
// secrets and session keys never leave the browser.
//
// 1. checkFunding: the payer balance covers batch_price_wei * n and the gas.
// 2. submitPurchase: CreditSale.buy(commitments) with exactly batch_price_wei * n (viem).
//    Return the transaction hash and the log index of the Purchased event.
// 3. registerTopup: POST /v1/topups {tx_hash, log_index} to the issuer.
// 4. waitForIssuance: GET /v1/topups/:tx_hash/:log_index until the status is issued.

import {
  MAX_BATCHES_PER_PURCHASE,
  fieldHexTextSchema,
  issuerPaths,
  topupResponseSchema,
  type Issuance,
  type TopupResponse,
} from "@anon-credit/protocol";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  parseAbi,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { SdkError, ServiceError } from "./errors.ts";
import { serviceError } from "./http.ts";

// The part of the CreditSale ABI that the runner uses (contracts/src/CreditSale.sol).
export const creditSaleAbi = parseAbi([
  "function buy(bytes32[] commitments) payable returns (uint256 purchaseId)",
  "function batchPriceWei() view returns (uint256)",
  "event Purchased(address indexed payer, uint256 indexed purchaseId, bytes32[] commitments, uint256 amount)",
]);

const hexSchema = z.string().regex(/^0x[0-9a-f]*$/);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const privateKeySchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "the payer key must be 0x and 64 hex digits");

function asHex(text: string): Hex {
  const parsed = hexSchema.parse(text.toLowerCase());
  if (!parsed.startsWith("0x")) throw new SdkError("invalid_response", "not hex");
  return `0x${parsed.slice(2)}`;
}

function commitmentList(commitments: readonly string[]): Hex[] {
  if (commitments.length < 1 || commitments.length > MAX_BATCHES_PER_PURCHASE) {
    throw new SdkError("invalid_response", `a purchase has 1 to ${MAX_BATCHES_PER_PURCHASE} commitments`);
  }
  return commitments.map((commitment) => asHex(fieldHexTextSchema.parse(commitment)));
}

// Calldata of CreditSale.buy(commitments).
export function buyCalldata(commitments: readonly string[]): Hex {
  return encodeFunctionData({ abi: creditSaleAbi, functionName: "buy", args: [commitmentList(commitments)] });
}

export interface PurchaseChain {
  // Payment chain RPC URL. Secret if it has a key; never print it.
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly saleAddress: string;
}

function publicClient(chain: PurchaseChain): PublicClient {
  return createPublicClient({ transport: http(chain.rpcUrl) });
}

function chainDefinition(chain: PurchaseChain) {
  return {
    id: chain.chainId,
    name: `chain-${chain.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [chain.rpcUrl] } },
  };
}

export interface FundingCheck {
  readonly payer: string;
  readonly chainId: number;
  readonly balanceWei: bigint;
  readonly priceWei: bigint;
  // batch price * n
  readonly paymentWei: bigint;
  // Gas limit estimate * gas price, with a 2x margin.
  readonly gasWei: bigint;
  readonly ok: boolean;
}

// Read the chain ID, the sale price, and the payer balance. Do not send anything.
export async function checkFunding(chain: PurchaseChain, payerKey: string, commitments: readonly string[]): Promise<FundingCheck> {
  const account = privateKeyToAccount(asHex(privateKeySchema.parse(payerKey)));
  const client = publicClient(chain);
  const chainId = await client.getChainId();
  if (chainId !== chain.chainId) {
    throw new SdkError("deployment_mismatch", `the payment RPC is on chain ${chainId}, the deployment has ${chain.chainId}`);
  }
  const sale = asHex(addressSchema.parse(chain.saleAddress));
  const priceWei = await client.readContract({ address: sale, abi: creditSaleAbi, functionName: "batchPriceWei" });
  const paymentWei = priceWei * BigInt(commitments.length);
  const balanceWei = await client.getBalance({ address: account.address });
  const gasPrice = await client.getGasPrice();
  const gasLimit = 80_000n + 30_000n * BigInt(commitments.length);
  const gasWei = gasLimit * gasPrice * 2n;
  return {
    payer: account.address.toLowerCase(),
    chainId,
    balanceWei,
    priceWei,
    paymentWei,
    gasWei,
    ok: balanceWei >= paymentWei + gasWei,
  };
}

export interface PurchaseResult {
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly purchaseId: bigint;
  readonly amountWei: bigint;
}

// Send CreditSale.buy and wait for the receipt. Return the Purchased log of the sale contract.
export async function submitPurchase(
  chain: PurchaseChain,
  payerKey: string,
  commitments: readonly string[],
  priceWei: bigint,
): Promise<PurchaseResult> {
  const account = privateKeyToAccount(asHex(privateKeySchema.parse(payerKey)));
  const sale = asHex(addressSchema.parse(chain.saleAddress));
  const wallet = createWalletClient({ account, chain: chainDefinition(chain), transport: http(chain.rpcUrl) });
  const value = priceWei * BigInt(commitments.length);
  const hash = await wallet.sendTransaction({ to: sale, data: buyCalldata(commitments), value });
  const receipt = await publicClient(chain).waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (receipt.status !== "success") throw new SdkError("invalid_response", `purchase transaction ${hash} reverted`);
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
  throw new SdkError("invalid_response", `purchase transaction ${hash} has no Purchased event`);
}

export interface IssuerHttp {
  // Issuer base URL without a trailing slash.
  readonly issuerUrl: string;
  // Default: globalThis.fetch.
  readonly fetch?: typeof fetch;
}

async function readTopup(response: Response): Promise<TopupResponse> {
  if (!response.ok) throw await serviceError(response);
  const parsed = topupResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new SdkError("invalid_response", `topup response is not valid: ${parsed.error.message}`);
  return parsed.data;
}

// POST /v1/topups. The issuer reads the log from the chain itself.
export async function registerTopup(issuer: IssuerHttp, txHash: string, logIndex: number): Promise<TopupResponse> {
  const fetchFn = issuer.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetchFn(`${issuer.issuerUrl}${issuerPaths.topups()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx_hash: txHash, log_index: logIndex }),
  });
  return readTopup(response);
}

export interface IssuanceWait {
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly onProgress?: (topup: TopupResponse) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly nowMs?: () => number;
}

// Poll GET /v1/topups/:tx_hash/:log_index until the status is issued. Throw on rejected.
export async function waitForIssuance(issuer: IssuerHttp, txHash: string, logIndex: number, wait: IssuanceWait = {}): Promise<Issuance> {
  const fetchFn = issuer.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = wait.nowMs ?? (() => Date.now());
  const deadline = now() + (wait.timeoutMs ?? 7_200_000);
  for (;;) {
    let topup: TopupResponse | undefined;
    try {
      topup = await readTopup(await fetchFn(`${issuer.issuerUrl}${issuerPaths.topup(txHash, logIndex)}`));
    } catch (error) {
      // The issuer forgets untracked payments; register again on not_found.
      if (!(error instanceof ServiceError && error.serviceCode === "not_found")) throw error;
      topup = await registerTopup(issuer, txHash, logIndex);
    }
    wait.onProgress?.(topup);
    switch (topup.status) {
      case "issued":
        if (topup.issuance === null) throw new SdkError("invalid_response", "issued topup has no issuance");
        return topup.issuance;
      case "rejected":
        throw new SdkError("invalid_response", `the issuer rejected the payment: ${topup.reject_reason ?? "unknown"}`);
      case "pending":
        break;
    }
    if (now() >= deadline) throw new SdkError("timeout", "the payment was not issued before the timeout");
    await sleep(wait.pollMs ?? 5000);
  }
}
