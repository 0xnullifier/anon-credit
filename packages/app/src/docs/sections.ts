// The sections of the docs view, in order. The index, the headings, and the test use this list.

export interface DocsSection {
  readonly id: string;
  readonly title: string;
}

export const DOCS_SECTIONS: readonly DocsSection[] = [
  { id: "claim", title: "the problem and the claim" },
  { id: "architecture", title: "architecture" },
  { id: "credentials", title: "credentials" },
  { id: "tree", title: "the tree" },
  { id: "proving", title: "the proving system" },
  { id: "epochs", title: "epochs, finality, and the first-use delay" },
  { id: "sessions", title: "sessions and spending" },
  { id: "transport", title: "transport" },
  { id: "threats", title: "threat model and limits" },
  { id: "road", title: "the road ahead" },
  { id: "stack", title: "stack and pins" },
];

// The hash of the docs view and of one of its sections.
export const DOCS_HASH = "#docs";

export function sectionHash(id: string): string {
  return `${DOCS_HASH}/${id}`;
}

// The section id of a location hash, or null when the hash is not a docs hash.
export function sectionOfHash(hash: string): string | null {
  if (hash !== DOCS_HASH && !hash.startsWith(`${DOCS_HASH}/`)) return null;
  const id = hash.slice(DOCS_HASH.length + 1);
  return DOCS_SECTIONS.some((section) => section.id === id) ? id : "";
}
