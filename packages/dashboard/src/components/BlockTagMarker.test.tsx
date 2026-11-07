// Rendering tests of the block tag marker: visible for the demo tags, hidden for finalized.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlockTagMarker } from "./DashboardView.tsx";

describe("BlockTagMarker", () => {
  it("shows the demo marker for latest and safe", () => {
    expect(renderToStaticMarkup(<BlockTagMarker blockTag="latest" />)).toContain("block tag: latest (demo)");
    expect(renderToStaticMarkup(<BlockTagMarker blockTag="safe" />)).toContain("block tag: safe (demo)");
  });

  it("shows nothing for finalized or an unknown config", () => {
    expect(renderToStaticMarkup(<BlockTagMarker blockTag="finalized" />)).toBe("");
    expect(renderToStaticMarkup(<BlockTagMarker blockTag={null} />)).toBe("");
  });
});
