import { describe, expect, it } from "vitest";
import { parseAnnouncement, reduceAnnouncements, type AnnouncedProvider } from "./eip6963.ts";

const provider = { request: async () => null };

function announced(uuid: string, name: string): AnnouncedProvider {
  const parsed = parseAnnouncement({ info: { uuid, name, icon: "data:image/svg+xml;base64,PHN2Zy8+", rdns: `io.${name}` }, provider });
  if (parsed === null) throw new Error("announcement did not parse");
  return parsed;
}

describe("parseAnnouncement", () => {
  it("accepts an announcement with info and a request function", () => {
    const item = announced("u1", "walletA");
    expect(item.name).toBe("walletA");
    expect(item.rdns).toBe("io.walletA");
  });

  it("rejects a detail without a provider, with a non-data icon, or that is not an object", () => {
    expect(parseAnnouncement({ info: { uuid: "u", name: "n", icon: "data:x", rdns: "r" } })).toBeNull();
    expect(parseAnnouncement({ info: { uuid: "u", name: "n", icon: "https://x/icon.png", rdns: "r" }, provider })).toBeNull();
    expect(parseAnnouncement({ info: { uuid: "u", name: "n", icon: "data:x", rdns: "r" }, provider: {} })).toBeNull();
    expect(parseAnnouncement(null)).toBeNull();
    expect(parseAnnouncement("text")).toBeNull();
  });
});

describe("reduceAnnouncements", () => {
  it("adds new providers and replaces a repeated uuid in place", () => {
    let list = reduceAnnouncements([], announced("u1", "walletA"));
    list = reduceAnnouncements(list, announced("u2", "walletB"));
    expect(list.map((item) => item.name)).toEqual(["walletA", "walletB"]);
    list = reduceAnnouncements(list, announced("u1", "walletA2"));
    expect(list.map((item) => item.name)).toEqual(["walletA2", "walletB"]);
    expect(list).toHaveLength(2);
  });
});
