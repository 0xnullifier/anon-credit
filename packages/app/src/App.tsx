// The customer app: one page, six steps, every state from a real request or event.

import type { BatchSummary } from "@anon-credit/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackupStep } from "./components/BackupStep.tsx";
import { BuyStep, type PurchaseRecord } from "./components/BuyStep.tsx";
import { GatewayView } from "./components/GatewayView.tsx";
import { InclusionStep, type InclusionResult } from "./components/InclusionStep.tsx";
import { OpenStep, type OpenResult } from "./components/OpenStep.tsx";
import { Setup, type SetupLine } from "./components/Setup.tsx";
import { SpendStep } from "./components/SpendStep.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { Hex } from "./components/primitives.tsx";
import { explainLine } from "./lib/explain.ts";
import { clock } from "./lib/format.ts";
import { defaultSettings, type Settings, type TransportChoice } from "./lib/settings.ts";
import { useNow } from "./lib/use-now.ts";
import { buildWorkbench, type Workbench } from "./lib/workbench.ts";

const MAX_LOG_LINES = 80;

export function App() {
  const now = useNow(250);
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [passphrase, setPassphrase] = useState("");
  const [workbench, setWorkbench] = useState<Workbench | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [setupLog, setSetupLog] = useState<SetupLine[]>([]);
  const [setupError, setSetupError] = useState("");
  const [transportLog, setTransportLog] = useState<SetupLine[]>([]);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [purchase, setPurchase] = useState<PurchaseRecord | null>(null);
  const [inclusion, setInclusion] = useState<InclusionResult | null>(null);
  const [opened, setOpened] = useState<OpenResult | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [light, setLight] = useState(false);
  const current = useRef<Workbench | null>(null);

  useEffect(() => {
    document.documentElement.dataset["theme"] = light ? "light" : "dark";
  }, [light]);

  const refreshBatches = useCallback(async (): Promise<void> => {
    const wb = current.current;
    if (wb === null) return;
    try {
      setBatches(await wb.client.batches());
    } catch (error) {
      setSetupError(explainLine(error));
    }
  }, []);

  const connect = async (next: Settings, phrase: string): Promise<void> => {
    setConnecting(true);
    setSetupError("");
    setSetupLog([]);
    const log = (text: string): void => setSetupLog((lines) => [...lines, { atMs: Date.now(), text }].slice(-MAX_LOG_LINES));
    try {
      current.current?.close();
      current.current = null;
      setWorkbench(null);
      const built = await buildWorkbench(next, phrase, {
        onPhase: log,
        onOpenProgress: (progress) => log(`batch ${progress.batchId.slice(0, 10)}…: waiting (${progress.phase}), epoch ${progress.currentEpoch}, open epoch ${progress.targetEpoch}`),
        onTransportLog: (text) => setTransportLog((lines) => [...lines, { atMs: Date.now(), text }].slice(-MAX_LOG_LINES)),
      });
      current.current = built;
      setWorkbench(built);
      setPassphrase(phrase);
      log(`ready: deployment ${built.client.deployment.deployment_id.slice(0, 18)}…, ${built.client.deployment.epoch_seconds} s epochs, block tag ${built.gatewayConfig.block_tag}`);
      setBatches(await built.client.batches());
    } catch (error) {
      setSetupError(explainLine(error));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = (): void => {
    current.current?.close();
    current.current = null;
    setWorkbench(null);
    setBatches([]);
    setPurchase(null);
    setInclusion(null);
    setOpened(null);
    setSetupLog([]);
  };

  // A transport change rebuilds the workbench on the same store. Sessions and secrets stay.
  const changeTransport = (choice: TransportChoice): void => {
    const next = { ...settings, transport: choice };
    setSettings(next);
    if (workbench !== null && passphrase !== "") {
      setInclusion(null);
      setOpened(null);
      connect(next, passphrase);
    }
  };

  const onPurchase = useCallback((record: PurchaseRecord): void => {
    setPurchase(record);
    setInclusion(null);
    setOpened(null);
    setSelectedBatchId(record.batches[0]?.batchId ?? null);
    refreshBatches();
  }, [refreshBatches]);

  const onEligible = useCallback((result: InclusionResult): void => {
    setInclusion(result);
    refreshBatches();
  }, [refreshBatches]);

  const onOpened = useCallback((result: OpenResult): void => {
    setOpened(result);
    setSelectedBatchId(result.batchId);
    refreshBatches();
  }, [refreshBatches]);

  const activeBatch = batches.find((batch) => batch.batchId === selectedBatchId) ?? null;
  const spendBatchId = opened?.batchId ?? batches.find((batch) => batch.state === "active")?.batchId ?? null;

  return (
    <div className="page">
      <TopBar workbench={workbench} now={now} transport={settings.transport} onTransport={changeTransport} busy={connecting} />
      <p className="intro">
        <strong>Prepaid RPC without an identity.</strong> Buy 100 units with a wallet. Prove in this browser that you hold one unspent batch,
        without saying which. Open a session at the gateway through the Nox mixnet. Spend with signed requests. The gateway never learns who
        paid.
      </p>
      <Setup
        settings={settings}
        onSettings={setSettings}
        onConnect={(phrase) => connect(settings, phrase)}
        onDisconnect={disconnect}
        workbench={workbench}
        connecting={connecting}
        log={setupLog}
        error={setupError}
      />
      {batches.length === 0 ? null : (
        <div className="batches" aria-label="batches in this store">
          {batches.map((batch) => (
            <button
              key={batch.batchId}
              type="button"
              aria-pressed={batch.batchId === selectedBatchId}
              onClick={() => setSelectedBatchId(batch.batchId)}
              title={batch.batchId}
            >
              {batch.batchId.slice(0, 10)}… {batch.state}
              {batch.remaining === null ? "" : ` ${batch.remaining}u`}
            </button>
          ))}
        </div>
      )}
      <BuyStep workbench={workbench} now={now} onPurchase={onPurchase} />
      <InclusionStep workbench={workbench} purchase={purchase} now={now} onEligible={onEligible} />
      <OpenStep workbench={workbench} inclusion={inclusion} now={now} onOpened={onOpened} />
      <SpendStep workbench={workbench} batchId={spendBatchId} now={now} onSpent={refreshBatches} />
      <BackupStep workbench={workbench} passphrase={passphrase} onRestored={refreshBatches} />
      <GatewayView workbench={workbench} purchase={purchase} opened={opened} batch={activeBatch} />
      {workbench === null ? null : (
        <details>
          <summary>transport log ({workbench.transport.logs.length} lines, {workbench.transport.isolationKeys().length} isolation keys)</summary>
          <pre className="log">
            {transportLog.length === 0
              ? workbench.transport.logs.slice(-MAX_LOG_LINES).map((line) => `+${(line.atMs / 1000).toFixed(1)} s  ${line.level}  ${line.text}`).join("\n")
              : transportLog.map((line) => `${clock(line.atMs)}  ${line.text}`).join("\n")}
          </pre>
          <p className="note">
            isolation keys used: {workbench.transport.isolationKeys().map((key) => key.slice(0, 24)).join(", ") || "none"}
          </p>
        </details>
      )}
      <footer className="foot">
        <span>
          anon-credit · {workbench === null ? "" : <>gateway id <Hex value={workbench.client.deployment.gateway_id} /> · </>}
        </span>
        <button type="button" className="quiet" onClick={() => setLight((value) => !value)}>
          {light ? "dark" : "light"} mode
        </button>
      </footer>
    </div>
  );
}
