// The wallet connector: injected wallets (EIP-6963), local key pairs from the encrypted store,
// and the dev key of the environment. Every balance shown comes from an RPC read.

import { useEffect, useState } from "react";
import { createPublicClient, http } from "viem";
import { discoverProviders, reduceAnnouncements, type AnnouncedProvider } from "../lib/eip6963.ts";
import { explainLine } from "../lib/explain.ts";
import { eth, explorerAddress, shortHex } from "../lib/format.ts";
import { createLocalKey, importLocalKey, listLocalKeys, readLocalKey, type LocalKeyRecord } from "../lib/key-store.ts";
import { devPayer, localRpcUrl } from "../lib/settings.ts";
import { connectPrivateKey, connectProvider, readBalanceOf, windowProvider, type Signer } from "../lib/wallet.ts";
import type { Workbench } from "../lib/workbench.ts";

const BALANCE_POLL_MS = 10_000;

interface BalanceRead {
  readonly wei: bigint | null;
  readonly at: number;
  readonly error: string;
}

export function WalletModal({
  workbench,
  onConnected,
  onClose,
}: {
  readonly workbench: Workbench;
  readonly onConnected: (signer: Signer) => void;
  readonly onClose: () => void;
}) {
  const chainId = workbench.client.deployment.payment_chain_id;
  const rpcUrl = localRpcUrl();
  const dev = devPayer();
  const [announced, setAnnounced] = useState<AnnouncedProvider[]>([]);
  const [keys, setKeys] = useState<LocalKeyRecord[]>([]);
  const [balances, setBalances] = useState<Record<string, BalanceRead>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [importText, setImportText] = useState("");
  // The key whose private key is shown, after a confirm click.
  const [revealed, setRevealed] = useState<LocalKeyRecord | null>(null);
  const [revealArmed, setRevealArmed] = useState<string | null>(null);

  useEffect(() => discoverProviders((item) => setAnnounced((list) => reduceAnnouncements(list, item))), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const reloadKeys = async (): Promise<void> => {
    setKeys(await listLocalKeys(workbench.appStore));
  };
  useEffect(() => {
    listLocalKeys(workbench.appStore).then(setKeys, (err) => setError(explainLine(err)));
  }, [workbench]);

  // Balances of the local keys, every 10 s, through the configured RPC.
  useEffect(() => {
    if (rpcUrl === null || keys.length === 0) return;
    const reader = createPublicClient({ transport: http(rpcUrl) });
    let stopped = false;
    const read = async (): Promise<void> => {
      for (const key of keys) {
        try {
          const wei = await readBalanceOf(reader, key.address);
          if (!stopped) setBalances((map) => ({ ...map, [key.address]: { wei, at: Date.now(), error: "" } }));
        } catch (err) {
          if (!stopped) setBalances((map) => ({ ...map, [key.address]: { wei: null, at: Date.now(), error: explainLine(err) } }));
        }
      }
    };
    read();
    const timer = setInterval(read, BALANCE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [keys, rpcUrl]);

  const run = async (label: string, action: () => Promise<Signer>): Promise<void> => {
    setBusy(label);
    setError("");
    try {
      onConnected(await action());
    } catch (err) {
      setError(explainLine(err));
    } finally {
      setBusy("");
    }
  };

  const fallback = windowProvider();
  const showFallback = announced.length === 0 && fallback !== null;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="connect a wallet" onClick={(event) => event.stopPropagation()}>
        <header>
          <span>connect a wallet</span>
          <button type="button" className="quiet" onClick={onClose} aria-label="close">
            close
          </button>
        </header>

        <h3>injected wallets</h3>
        <ul className="rows">
          {announced.map((item) => (
            <li key={item.uuid}>
              <button type="button" disabled={busy !== ""} onClick={() => run(item.uuid, () => connectProvider(item.provider, item.name, chainId, null))}>
                <img src={item.icon} alt="" width={16} height={16} />
                {item.name}
              </button>
              <span className="meta">{item.rdns}</span>
            </li>
          ))}
          {showFallback ? (
            <li>
              <button type="button" disabled={busy !== ""} onClick={() => run("window", () => connectProvider(fallback, "window.ethereum", chainId, null))}>
                window.ethereum
              </button>
              <span className="meta">no EIP-6963 announcement; plain provider</span>
            </li>
          ) : null}
          {announced.length === 0 && fallback === null ? <li className="empty">no wallet extension found in this browser</li> : null}
        </ul>

        <h3>local key pairs</h3>
        {rpcUrl === null ? (
          <p className="note">A local key needs an HTTP RPC to read the chain and to broadcast. Set VITE_DEV_RPC_URL and reload.</p>
        ) : (
          <p className="note">Made in this browser with viem, stored in the encrypted store under your passphrase. Send Sepolia ETH to the address to buy batches; one batch costs 0.0001 ETH plus gas.</p>
        )}
        <ul className="rows">
          {keys.map((key) => {
            const balance = balances[key.address];
            const link = explorerAddress(chainId, key.address);
            return (
              <li key={key.address} className="key">
                <button type="button" disabled={busy !== "" || rpcUrl === null} onClick={() => run(key.address, () => connectPrivateKey(key.private_key, rpcUrl ?? "", chainId, "local"))}>
                  {shortHex(key.address, 8, 6)}
                </button>
                <span className="meta">
                  {balanceWords(balance)} · {key.origin}
                  {link === null ? null : (
                    <>
                      {" · "}
                      <a href={link} target="_blank" rel="noreferrer">
                        etherscan
                      </a>
                    </>
                  )}
                  {" · "}
                  <button
                    type="button"
                    className="quiet"
                    onClick={async () => {
                      if (revealArmed !== key.address) {
                        setRevealArmed(key.address);
                        setRevealed(null);
                        return;
                      }
                      const record = await readLocalKey(workbench.appStore, key.address);
                      setRevealed(record ?? null);
                      setRevealArmed(null);
                    }}
                  >
                    {revealArmed === key.address ? "confirm: reveal the private key" : "export"}
                  </button>
                </span>
                {revealed?.address === key.address ? (
                  <span className="secret">
                    {revealed.private_key}{" "}
                    <button type="button" className="quiet" onClick={() => setRevealed(null)}>
                      hide
                    </button>
                  </span>
                ) : null}
              </li>
            );
          })}
          {keys.length === 0 ? <li className="empty">no local key pair yet</li> : null}
        </ul>
        <div className="row">
          <button
            type="button"
            disabled={busy !== ""}
            onClick={async () => {
              setError("");
              try {
                await createLocalKey(workbench.appStore);
                await reloadKeys();
              } catch (err) {
                setError(explainLine(err));
              }
            }}
          >
            new key pair
          </button>
          <label>
            import a private key
            <input type="password" autoComplete="off" spellCheck={false} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="0x…" />
          </label>
          <span className="actions">
            <button
              type="button"
              disabled={busy !== "" || importText.trim() === ""}
              onClick={async () => {
                setError("");
                try {
                  await importLocalKey(workbench.appStore, importText);
                  setImportText("");
                  await reloadKeys();
                } catch (err) {
                  setError(explainLine(err));
                }
              }}
            >
              import
            </button>
          </span>
        </div>

        {dev === null ? null : (
          <>
            <h3>environment</h3>
            <ul className="rows">
              <li>
                <button type="button" disabled={busy !== ""} onClick={() => run("dev", () => connectPrivateKey(dev.privateKey, dev.rpcUrl, chainId, "dev"))}>
                  dev key from the environment
                </button>
                <span className="meta">VITE_DEV_PAYER_KEY over VITE_DEV_RPC_URL; a build-time value, not a wallet</span>
              </li>
            </ul>
          </>
        )}

        {busy === "" ? null : <p className="note">connecting… (the wallet may ask for approval)</p>}
        {error === "" ? null : <p className="note bad">{error}</p>}
      </div>
    </div>
  );
}

function balanceWords(balance: BalanceRead | undefined): string {
  if (balance === undefined) return "balance: reading…";
  const wei = balance.wei;
  if (wei === null) return `balance: ${balance.error}`;
  return `${eth(wei)} at ${new Date(balance.at).toISOString().slice(11, 19)}`;
}
