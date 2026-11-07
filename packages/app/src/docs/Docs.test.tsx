import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Docs } from "./Docs.tsx";
import { DOCS_SECTIONS, sectionHash, sectionOfHash } from "./sections.ts";

describe("docs view", () => {
  const html = renderToStaticMarkup(<Docs activeSection="" />);

  it("renders every section heading with its anchor and index entry", () => {
    expect(DOCS_SECTIONS).toHaveLength(11);
    for (const section of DOCS_SECTIONS) {
      expect(html).toContain(`id="docs-${section.id}"`);
      expect(html).toContain(`</span> ${section.title}</a></h2>`);
      // The sticky index and the heading both link to the section.
      expect(html.split(`href="${sectionHash(section.id)}"`).length - 1).toBe(2);
    }
  });

  it("shows the live Sepolia addresses and the real circuit numbers", () => {
    expect(html).toContain("0x121f911867ac81aeba7d41ddfbfadec2a1787acb");
    expect(html).toContain("0xa7804062bfe4b4205b8597a477e3b039981fb7e8");
    expect(html).toContain("14,416");
    expect(html).toContain("819");
    expect(html).toContain("26.2 ms");
    expect(html).toContain("318,335 bytes");
  });

  it("maps hashes to sections", () => {
    expect(sectionOfHash("")).toBeNull();
    expect(sectionOfHash("#other")).toBeNull();
    expect(sectionOfHash("#docs")).toBe("");
    expect(sectionOfHash("#docs/tree")).toBe("tree");
    expect(sectionOfHash("#docs/nope")).toBe("");
  });
});
