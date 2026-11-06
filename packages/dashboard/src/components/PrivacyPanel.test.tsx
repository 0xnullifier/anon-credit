// Rendering tests of the proof and privacy panel.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sharedPrices, sharedRoots, sharedSnapshot } from "../testing/shared.ts";
import { PrivacyPanel, priceHashMatches } from "./PrivacyPanel.tsx";

describe("PrivacyPanel", () => {
  it("checks the price table hash against the canonical encoding", () => {
    expect(priceHashMatches(sharedPrices)).toBe(true);
    const changed = { ...sharedPrices, price_table: { ...sharedPrices.price_table, version: 2 } };
    expect(priceHashMatches(changed)).toBe(false);
  });

  it("shows digests, the price table, roots, and the routing statement", () => {
    const html = renderToStaticMarkup(
      <PrivacyPanel
        snapshot={sharedSnapshot}
        prices={{ state: "ready", value: sharedPrices, at: 1 }}
        roots={{ state: "ready", value: sharedRoots, at: 1 }}
        onReload={() => {}}
      />,
    );
    expect(html).toContain("matches the canonical encoding");
    expect(html).toContain("eth_getBalance");
    expect(html).toContain(sharedSnapshot.verifier.pkv_sha256.slice(0, 8));
    expect(html).toContain("1 accepted roots in a window of 96 source epochs");
    expect(html).toContain("evidence of routing");
    expect(html.toLowerCase()).not.toContain("verified anonymous");
  });

  it("shows a failed public read", () => {
    const html = renderToStaticMarkup(
      <PrivacyPanel
        snapshot={sharedSnapshot}
        prices={{ state: "failed", error: "prices: network error or CORS refusal" }}
        roots={{ state: "loading" }}
        onReload={() => {}}
      />,
    );
    expect(html).toContain("prices: network error or CORS refusal");
    expect(html).toContain("Accepted roots: loading");
  });
});
