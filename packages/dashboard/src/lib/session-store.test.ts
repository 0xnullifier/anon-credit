// Tests of the tab storage of the connection settings.

import { describe, expect, it } from "vitest";
import { forgetToken, loadSettings, saveConnection, type KeyValueStore } from "./session-store.ts";

const defaults = { adminUrl: "http://127.0.0.1:8082", gatewayUrl: "http://127.0.0.1:8081" };

function memoryStore(): KeyValueStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const throwing: KeyValueStore = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("session store", () => {
  it("keeps and forgets the token", () => {
    const store = memoryStore();
    expect(loadSettings(store, defaults)).toEqual({ ...defaults, token: null });
    saveConnection(store, { adminUrl: "http://a", gatewayUrl: "http://g", token: "t0123456789abcdef" });
    expect(loadSettings(store, defaults)).toEqual({ adminUrl: "http://a", gatewayUrl: "http://g", token: "t0123456789abcdef" });
    forgetToken(store);
    expect(loadSettings(store, defaults)).toEqual({ adminUrl: "http://a", gatewayUrl: "http://g", token: null });
  });

  it("works when storage throws or is absent", () => {
    expect(() => saveConnection(throwing, { ...defaults, token: "x" })).not.toThrow();
    expect(() => forgetToken(throwing)).not.toThrow();
    expect(loadSettings(throwing, defaults)).toEqual({ ...defaults, token: null });
    expect(loadSettings(null, defaults)).toEqual({ ...defaults, token: null });
  });
});
