// Small display parts of the docs view: a table from rows, and a section frame.

import type { ReactNode } from "react";
import { sectionHash, type DocsSection } from "./sections.ts";

export function Table({ head, rows }: { readonly head: readonly string[]; readonly rows: readonly (readonly ReactNode[])[] }) {
  return (
    <table className="doc-table">
      <thead>
        <tr>
          {head.map((cell) => (
            <th key={cell}>{cell}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, column) => (
              <td key={column}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DocSection({ section, n, children }: { readonly section: DocsSection; readonly n: number; readonly children: ReactNode }) {
  return (
    <section className="doc-section" id={`docs-${section.id}`}>
      <h2>
        <a href={sectionHash(section.id)}>
          <span className="n">{n}</span> {section.title}
        </a>
      </h2>
      {children}
    </section>
  );
}

// A source line under a section: which file of the repository the content comes from.
export function Source({ files }: { readonly files: readonly string[] }) {
  return <p className="doc-source">source: {files.join(", ")}</p>;
}
