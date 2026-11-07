// Step 3: prove and open. The path fetch, the proof, each upload chunk, and the open request
// are shown from the transport events and the SDK results.

import type { OpenResponse } from "@anon-credit/protocol";
import { ServiceError, type OpenUploadMode, type PreparedOpen, type UploadStats } from "@anon-credit/sdk";
import { useEffect, useRef, useState } from "react";
import { explainLine } from "../lib/explain.ts";
import { bytes, duration } from "../lib/format.ts";
import { applyChunkEvent, type ChunkView, type RequestEvent } from "../lib/observe.ts";
import { labelPublicInputs } from "../lib/public-inputs.ts";
import { failStep, finishStep, noteStep, pendingStep, replaceStep, startStep, type StepRecord } from "../lib/tracker.ts";
import type { Workbench } from "../lib/workbench.ts";
import type { InclusionResult } from "./InclusionStep.tsx";
import { Hex, Kv, Section, StepLines, type SectionState } from "./primitives.tsx";

const IDS = { path: "path", prove: "prove", upload: "upload", open: "open" } as const;

function initialSteps(): StepRecord[] {
  return [
    pendingStep(IDS.path, "fetch the membership path and check it locally"),
    pendingStep(IDS.prove, "prove in the browser (ProveKit, hiding witness)"),
    pendingStep(IDS.upload, "upload the proof"),
    pendingStep(IDS.open, "gateway verifies the proof and opens the session"),
  ];
}

export interface OpenResult {
  readonly batchId: string;
  readonly prepared: PreparedOpen;
  readonly response: OpenResponse;
  readonly upload: UploadStats | null;
  readonly openMs: number;
}

function sectionState(steps: readonly StepRecord[], ready: boolean): SectionState {
  switch (true) {
    case !ready:
      return "locked";
    case steps.some((step) => step.state === "failed"):
      return "failed";
    case steps.every((step) => step.state === "done"):
      return "done";
    case steps.some((step) => step.state === "running"):
      return "running";
    default:
      return "idle";
  }
}

function uploadChoice(text: string): OpenUploadMode {
  switch (text) {
    case "chunked":
      return "chunked";
    case "inline":
      return "inline";
    default:
      return "auto";
  }
}

function chunkGlyph(chunk: ChunkView): string {
  switch (chunk.state) {
    case "waiting":
      return "·";
    case "sent":
      return "↑";
    case "acknowledged":
      return chunk.ms === null ? "ok" : `${Math.round(chunk.ms)}`;
    case "failed":
      return "!";
  }
}

export function OpenStep({
  workbench,
  inclusion,
  now,
  onOpened,
}: {
  readonly workbench: Workbench | null;
  readonly inclusion: InclusionResult | null;
  readonly now: number;
  readonly onOpened: (result: OpenResult) => void;
}) {
  const [steps, setSteps] = useState<StepRecord[]>(initialSteps);
  const [chunks, setChunks] = useState<ChunkView[]>([]);
  const [prepared, setPrepared] = useState<PreparedOpen | null>(null);
  const [result, setResult] = useState<OpenResult | null>(null);
  const [uploadMode, setUploadMode] = useState<OpenUploadMode>("auto");
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const sentAt = useRef(new Map<number, number>());
  const busy = steps.some((step) => step.state === "running");

  useEffect(() => {
    setSteps(initialSteps());
    setChunks([]);
    setPrepared(null);
    setResult(null);
  }, [inclusion?.batchId]);

  const set = (next: StepRecord): void => {
    stepsRef.current = replaceStep(stepsRef.current, next);
    setSteps(stepsRef.current);
  };
  const get = (id: string): StepRecord => stepsRef.current.find((step) => step.id === id) ?? pendingStep(id, id);

  // Transport events of this batch while the open runs.
  useEffect(() => {
    if (workbench === null || inclusion === null) return;
    return workbench.transport.subscribe((event: RequestEvent) => {
      if (!busy) return;
      switch (event.kind) {
        case "path":
          switch (event.phase) {
            case "sent":
              set(noteStep(get(IDS.path), [`GET ${event.path.slice(0, 40)}… on isolation key ${event.isolationKey.slice(0, 20)}…`]));
              return;
            case "answered":
              set(noteStep(get(IDS.path), [`issuer answered HTTP ${event.httpStatus}; checking the proof against the root`]));
              return;
            case "failed":
              return;
          }
        case "chunk":
          setChunks((list) => applyChunkEvent(list, event, sentAt.current));
          return;
        case "open":
          switch (event.phase) {
            case "sent":
              set(startStep(get(IDS.open), event.atMs, [`POST /v1/open${event.bodyBytes === null ? "" : ` (${bytes(event.bodyBytes)})`} on isolation key ${event.isolationKey.slice(0, 20)}…`]));
              return;
            case "answered":
              set(noteStep(get(IDS.open), [...get(IDS.open).detail, `gateway answered HTTP ${event.httpStatus}`]));
              return;
            case "failed":
              return;
          }
        default:
          return;
      }
    });
  }, [workbench, inclusion, busy]);

  if (workbench === null || inclusion === null) {
    return (
      <Section n={3} title="open a session" state="locked">
        <p className="note">Starts when a root with the leaf is eligible.</p>
      </Section>
    );
  }

  const run = async (): Promise<void> => {
    const fresh = initialSteps();
    setSteps(fresh);
    stepsRef.current = fresh;
    setChunks([]);
    setResult(null);
    sentAt.current = new Map();
    const batchId = inclusion.batchId;
    // Path and proof: one SDK call. The path step ends when the issuer answers (transport event);
    // the proof step runs from then until the call returns.
    let made: PreparedOpen;
    const unsubscribe = workbench.transport.subscribe((event) => {
      if (event.kind === "path" && event.phase === "answered") {
        set(finishStep(get(IDS.path), event.atMs, [`issuer answered HTTP ${event.httpStatus}; path checked locally with @anon-credit/crypto`]));
        set(startStep(get(IDS.prove), event.atMs, [`${workbench.prover.info.mode} build, ${workbench.prover.info.threads} thread(s)`]));
      }
    });
    try {
      set(startStep(get(IDS.path), Date.now()));
      made = await workbench.client.prepareOpen(batchId, inclusion.root);
      setPrepared(made);
      set(
        finishStep(get(IDS.prove), Date.now(), [
          `witness ${duration(made.witnessMs)}, proving ${duration(made.proveMs - made.witnessMs)}, total ${duration(made.proveMs)}`,
          `proof ${bytes(made.proofBytes)} (JSON)${made.wasmMemoryBytes === null ? "" : `, WASM memory ${bytes(made.wasmMemoryBytes)}`}, proof epoch ${made.request.proof_epoch}`,
        ]),
      );
    } catch (error) {
      const failing = get(IDS.prove).state === "running" ? IDS.prove : IDS.path;
      set(failStep(get(failing), Date.now(), explainLine(error)));
      return;
    } finally {
      unsubscribe();
    }
    const submit = async (request: PreparedOpen): Promise<void> => {
      set(startStep(get(IDS.upload), Date.now()));
      const start = performance.now();
      let outcome;
      try {
        outcome = await workbench.client.submitOpen(batchId, request.request, { upload: uploadMode });
      } catch (error) {
        if (error instanceof ServiceError && error.serviceCode === "proof_epoch_stale") {
          set(noteStep(get(IDS.open), [...get(IDS.open).detail, "proof_epoch_stale: the gateway wants the current epoch; proving again"]));
          const again = await workbench.client.prepareOpen(batchId, inclusion.root);
          setPrepared(again);
          return submit(again);
        }
        const failing = get(IDS.open).state === "running" ? IDS.open : IDS.upload;
        set(failStep(get(failing), Date.now(), explainLine(error)));
        return;
      }
      const openMs = performance.now() - start;
      const stats = outcome.upload;
      set(
        finishStep(
          get(IDS.upload),
          Date.now(),
          stats === null
            ? [`inline: the proof went inside POST /v1/open (${workbench.transport.kind} transport, no body limit)`]
            : [
                `${stats.encoding}: ${bytes(stats.proofBytes)} → ${bytes(stats.uploadBytes)} in ${stats.chunks} chunks, ${stats.parallel} in flight, ${stats.sends} PUT request(s)${stats.fellBack ? ", sequential fallback used" : ""}, ${duration(stats.totalMs)}`,
              ],
        ),
      );
      const session = outcome.response.session;
      set(
        finishStep(get(IDS.open), Date.now(), [
          ...get(IDS.open).detail,
          `${outcome.response.existing ? "existing session returned (exact retry)" : "proof verified, session opened"}: ${session.remaining} units, next seq ${session.next_seq}, open epoch ${session.open_epoch}, deadline epoch ${session.deadline_epoch}`,
        ]),
      );
      const done: OpenResult = { batchId, prepared: request, response: outcome.response, upload: stats, openMs };
      setResult(done);
      onOpened(done);
    };
    await submit(made);
  };

  const inputs = prepared === null ? [] : labelPublicInputs(prepared.publicInputs);
  return (
    <Section n={3} title="open a session" state={sectionState(steps, true)}>
      <p className="note">
        The proof shows that one leaf under the root belongs to this batch and binds the session key, without the leaf index, the commitment,
        or the secret. The gateway rebuilds the ten public inputs itself and verifies the proof in its sidecar.
      </p>
      <div className="row">
        <label className="short">
          upload
          <select value={uploadMode} disabled={busy} onChange={(event) => setUploadMode(uploadChoice(event.target.value))}>
            <option value="auto">auto</option>
            <option value="chunked">chunked</option>
            <option value="inline">inline</option>
          </select>
        </label>
        <span className="actions">
          <button type="button" className="primary" onClick={run} disabled={busy}>
            {result === null ? "prove and open" : "prove and open again"}
          </button>
        </span>
        <span className="note">auto: chunked through Nox (40 KB body limit), inline on the direct transport.</span>
      </div>
      <StepLines steps={steps} now={now} />
      {chunks.length === 0 ? null : (
        <>
          <p className="note">
            chunks: · waiting, ↑ sent, number = acknowledged (ms), r = sent again, ! failed. Each PUT carries up to 40,000 raw bytes on the
            batch isolation key.
          </p>
          <div className="chunks">
            {chunks.map((chunk) => (
              <span key={chunk.index} className={`chunk ${chunk.state} ${chunk.sends > 1 ? "retried" : ""}`} title={`chunk ${chunk.index}: ${chunk.state}, ${chunk.sends} send(s)${chunk.bytes === null ? "" : `, ${chunk.bytes} bytes`}`}>
                <span className="idx">#{chunk.index}</span>
                {chunkGlyph(chunk)}
              </span>
            ))}
          </div>
        </>
      )}
      {prepared === null ? null : (
        <>
          <p className="note">The ten public inputs, in circuit order. Everything else in the witness is private.</p>
          <table className="inputs">
            <tbody>
              {inputs.map((input, index) => (
                <tr key={input.name}>
                  <td className="i">{index}</td>
                  <td className="name">{input.name}</td>
                  <td className="meaning">{input.meaning}</td>
                  <td className="value">{input.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {result === null ? null : (
        <Kv
          rows={[
            { k: "session key", v: <Hex value={result.response.session.session_pub} /> },
            { k: "price table frozen", v: <Hex value={result.response.session.price_table_hash} /> },
            { k: "open round trip", v: `${duration(result.openMs)} (upload and POST /v1/open)` },
          ]}
        />
      )}
    </Section>
  );
}
