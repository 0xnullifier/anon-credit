// Small shared parts of the dashboard views.

import { useState, type ReactNode } from "react";
import { shortHex } from "../lib/format.ts";
import type { Tone } from "../lib/events-model.ts";

// State of a value that the dashboard loads.
export type Load<T> =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly value: T; readonly at: number }
  | { readonly state: "failed"; readonly error: string };

export const IDLE: Load<never> = { state: "idle" };

// Copy text to the clipboard. The clipboard can be blocked; then nothing happens.
function copyText(text: string, done: (ok: boolean) => void): void {
  try {
    navigator.clipboard.writeText(text).then(
      () => done(true),
      () => done(false),
    );
  } catch {
    done(false);
  }
}

// A short hex ID with a copy button. With onSelect, the ID is a button.
export function HexId(props: { readonly value: string; readonly onSelect?: ((value: string) => void) | undefined }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const { value, onSelect } = props;
  return (
    <span className="hex-id">
      {onSelect === undefined ? (
        <code title={value}>{shortHex(value)}</code>
      ) : (
        <button type="button" className="link" title={`Show session ${value}`} onClick={() => onSelect(value)}>
          <code>{shortHex(value)}</code>
        </button>
      )}
      <button
        type="button"
        className="copy"
        aria-label={`Copy ${value}`}
        title="Copy the full ID"
        onClick={() => copyText(value, setCopied)}
      >
        {copied === true ? "copied" : "copy"}
      </button>
    </span>
  );
}

// A label and a value in a definition grid.
export function Field(props: { readonly label: string; readonly children: ReactNode; readonly tone?: Tone | undefined }) {
  return (
    <div className="field">
      <dt>{props.label}</dt>
      <dd className={props.tone === undefined ? undefined : `tone-${props.tone}`}>{props.children}</dd>
    </div>
  );
}

// A panel with a heading.
export function Panel(props: {
  readonly id: string;
  readonly title: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={`panel ${props.className ?? ""}`} aria-labelledby={`${props.id}-title`}>
      <header className="panel-head">
        <h2 id={`${props.id}-title`}>{props.title}</h2>
        {props.actions}
      </header>
      {props.children}
    </section>
  );
}

// A small colored label.
export function Pill(props: { readonly tone: Tone; readonly children: ReactNode }) {
  return <span className={`pill tone-${props.tone}`}>{props.children}</span>;
}

// The text of a load that is not ready.
export function LoadNote(props: { readonly load: Load<object>; readonly what: string }) {
  switch (props.load.state) {
    case "idle":
      return <p className="muted">{props.what}: not loaded.</p>;
    case "loading":
      return <p className="muted">{props.what}: loading…</p>;
    case "failed":
      return <p className="tone-error">{props.what}: {props.load.error}</p>;
    case "ready":
      return null;
  }
}
