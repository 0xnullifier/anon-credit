// Rendering tests of the proof and privacy panel.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sharedPrices, sharedRoots, sharedSnapshot } from "../testing/shared.ts";
import { PrivacyPanel, priceHashMatches, sameRoots, verifierKeyMatches } from "./PrivacyPanel.tsx";

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

  it("checks the price table hash of the snapshot", () => {
    expect(priceHashMatches(sharedSnapshot)).toBe(true);
  });

  it("compares the sidecar verifier key with the deployment pin", () => {
    expect(verifierKeyMatches(sharedSnapshot)).toBe(false);
    const pinned = { ...sharedSnapshot, verifier: { ...sharedSnapshot.verifier, pkv_sha256: sharedSnapshot.verifier_artifact_hash.slice(2) } };
    expect(verifierKeyMatches(pinned)).toBe(true);
  });

  it("shows the snapshot values and says that the public API agrees", () => {
    const html = renderToStaticMarkup(
      <PrivacyPanel
        snapshot={sharedSnapshot}
        prices={{ state: "ready", value: sharedPrices, at: 1 }}
        roots={{ state: "ready", value: sharedRoots, at: 1 }}
        onReload={() => {}}
      />,
    );
    expect(sameRoots(sharedRoots.roots, sharedSnapshot.accepted_roots)).toBe(true);
    expect(html.match(/agrees with the snapshot/g)?.length).toBe(2);
    expect(html).toContain("Epoch length");
    expect(html).toContain("off (DEMO_IP_LOGGING=false)");
    expect(html).toContain("differs from the pin");
  });

  it("says when the public roots differ from the snapshot", () => {
    const other = { ...sharedRoots, roots: [] };
    const html = renderToStaticMarkup(
      <PrivacyPanel snapshot={sharedSnapshot} prices={{ state: "idle" }} roots={{ state: "ready", value: other, at: 1 }} onReload={() => {}} />,
    );
    expect(html).toContain("differs from the snapshot");
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
    expect(html).toContain("Public GET /v1/roots: loading");
    // The snapshot values stay on the page.
    expect(html).toContain("eth_getBalance");
    expect(html).toContain("1 accepted roots in a window of 96 source epochs");
  });
});
