// Small display parts: step lines, key-value lists, hex with copy, section frames.

import { Fragment, useState, type ReactNode } from "react";
import { clock, duration, shortHex } from "../lib/format.ts";
import { elapsedMs, type StepRecord, type StepState } from "../lib/tracker.ts";

function glyph(state: StepState): string {
  switch (state) {
    case "pending":
      return "[ ]";
    case "running":
      return "[~]";
    case "done":
      return "[x]";
    case "failed":
      return "[!]";
  }
}

// The time column of a step: elapsed while running, the end time when finished.
function timeText(step: StepRecord, now: number): string {
  switch (step.state) {
    case "pending":
      return "";
    case "running":
      return `${duration(elapsedMs(step, now) ?? 0)} …`;
    case "done":
    case "failed": {
      const elapsed = elapsedMs(step, now);
      return `${step.endedAt === null ? "" : clock(step.endedAt)}${elapsed === null ? "" : ` (${duration(elapsed)})`}`;
    }
  }
}

export function StepLines({ steps, now }: { readonly steps: readonly StepRecord[]; readonly now: number }) {
  return (
    <ul className="lines">
      {steps.map((step) => (
        <li key={step.id} className={step.state}>
          <span className="glyph">{glyph(step.state)}</span>
          <span className="label">
            <span>{step.label}</span>
            <span className="time">{timeText(step, now)}</span>
          </span>
          {step.detail.map((line, index) => (
            <span key={index} className="detail">
              {line}
            </span>
          ))}
          {step.error === "" ? null : <span className="detail error">{step.error}</span>}
        </li>
      ))}
    </ul>
  );
}

export function Hex({ value, head = 10, tail = 6, full = false }: { readonly value: string; readonly head?: number; readonly tail?: number; readonly full?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="hex" title={value}>
      {full ? value : shortHex(value, head, tail)}{" "}
      <button type="button" className="quiet copy" onClick={copy} aria-label="copy">
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}

export interface KvRow {
  readonly k: string;
  readonly v: ReactNode;
  readonly tone?: "dim" | "bad";
}

export function Kv({ rows }: { readonly rows: readonly KvRow[] }) {
  return (
    <dl className="kv">
      {rows.map((row) => (
        <Fragment key={row.k}>
          <dt>{row.k}</dt>
          <dd className={row.tone ?? ""}>{row.v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}


export type SectionState = "locked" | "idle" | "running" | "done" | "failed";

function stateWords(state: SectionState): string {
  switch (state) {
    case "locked":
      return "waits for the step before";
    case "idle":
      return "ready";
    case "running":
      return "in progress";
    case "done":
      return "done";
    case "failed":
      return "failed";
  }
}

export function Section({
  n,
  title,
  state,
  children,
}: {
  readonly n: number;
  readonly title: string;
  readonly state: SectionState;
  readonly children: ReactNode;
}) {
  return (
    <section className={`step ${state === "locked" ? "locked" : ""}`} id={`step-${n}`}>
      <header>
        <span className="n">{n}</span>
        <h2>{title}</h2>
        <span className={`state ${state}`}>{stateWords(state)}</span>
      </header>
      {children}
    </section>
  );
}
